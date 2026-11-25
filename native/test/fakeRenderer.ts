// Фальшивый mgu-render 0.6.21 на локальном unix-сокете: только рамка сообщений и ответы на HELLO по
// work/research/mgu-render-0.6.21/PROTOCOL.md (без кода рендерера). Записывает всё, что прислал клиент.

import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

export const MSG = {
  HELLO: 1,
  PLACE: 2,
  SHOW: 3,
  ATLAS: 4,
  RAMP: 5,
  LAYER: 6,
  FRAME: 7,
  DROP_LAYER: 8,
  /** upstream: IMAGE; iterio/native: CLAIM */
  NINE: 9,
  /** upstream: GRAB; iterio/native: IMAGE */
  TEN: 10,
  READY: 101,
  TICK: 102,
  TOUCH: 105,
  CLOSED: 106,
  X_MODE: 0x4d520001,
  X_GRAB: 0x4d520002,
  X_PIXMAP: 0x4d520003,
  X_PIXELS: 0x4d520004,
  X_READY: 0x4d520101,
} as const;

export interface RenderMsg {
  conn: number;
  type: number;
  payload: Buffer;
}

export interface RendererOpts {
  /** Отвечать на "proto=mgu-render/1" (X_READY, затем READY); false — старый рендерер: только READY. */
  native: boolean;
  /** Send TICK after FRAME, as a running compositor does. Off for manual backpressure scenarios. */
  autoTick: boolean;
  /** READY, четвёртое слово: маршрутизация касаний. */
  touch: boolean;
  /** X_READY caps (1 касание, 2 контроллер, 4 front gate, 8 pixmaps). */
  caps: number;
  pixmapMax: number;
  screen: { w: number; h: number };
}

let seq = 0;

export class FakeRenderer {
  readonly msgs: RenderMsg[] = [];
  readonly conns: Socket[] = [];
  /** Вызывается на каждое сообщение клиента (по порядку прихода). */
  readonly listeners: ((m: RenderMsg) => void)[] = [];
  opts: RendererOpts;
  private waiters: (() => void)[] = [];

  private constructor(
    readonly path: string,
    private readonly server: Server,
    opts: Partial<RendererOpts>,
  ) {
    this.opts = { native: true, autoTick: false, touch: true, caps: 1 | 8, pixmapMax: 2048, screen: { w: 1920, h: 720 }, ...opts };
  }

  static start(opts: Partial<RendererOpts> = {}): Promise<FakeRenderer> {
    const path = join(tmpdir(), `xop-rd-${process.pid}-${++seq}.sock`);
    rmSync(path, { force: true });
    let self: FakeRenderer | null = null;
    const server = createServer((s) => self!.accept(s));
    self = new FakeRenderer(path, server, opts);
    return new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(path, () => ok(self!));
    });
  }

  private accept(s: Socket): void {
    const conn = this.conns.push(s) - 1;
    let buf = Buffer.alloc(0);
    s.on('error', () => undefined);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const type = buf.readUInt32LE(0);
        const len = buf.readUInt32LE(4);
        if (buf.length < 8 + len) break;
        const payload = Buffer.from(buf.subarray(8, 8 + len));
        buf = buf.subarray(8 + len);
        this.msgs.push({ conn, type, payload });
        for (const l of this.listeners) l({ conn, type, payload });
        if (type === MSG.HELLO) this.hello(s, payload);
        if (type === MSG.FRAME && this.opts.autoTick) s.write(frame(MSG.TICK, Buffer.alloc(8)));
      }
      const w = this.waiters;
      this.waiters = [];
      w.forEach((f) => f());
    });
  }

  private hello(s: Socket, payload: Buffer): void {
    const fields = payload.toString('utf8').split('\0');
    const o = this.opts;
    if (o.native && fields.slice(1).includes('proto=mgu-render/1')) {
      // X_READY: version, modes, caps, embed box x y w h, app area x y w h, largest pixmap side, refresh mHz
      const x = Buffer.alloc(52);
      [1, 1, o.caps, 0, 0, 0, 0, 0, 0, o.screen.w, o.screen.h, o.pixmapMax, 60000].forEach((v, i) => x.writeUInt32LE(v, i * 4));
      s.write(frame(MSG.X_READY, x));
    }
    const r = Buffer.alloc(16);
    [4, o.screen.w, o.screen.h, o.touch ? 1 : 0].forEach((v, i) => r.writeUInt32LE(v, i * 4));
    s.write(frame(MSG.READY, r));
  }

  /** Сообщение клиенту на последнем соединении. */
  send(type: number, payload: Buffer = Buffer.alloc(0)): void {
    this.conns[this.conns.length - 1].write(frame(type, payload));
  }

  /** TOUCH (iterio / native): phase 1 down, 2 move, 3 up; x, y — логические px. */
  touch(phase: 1 | 2 | 3, x: number, y: number): void {
    const b = Buffer.alloc(12);
    b.writeUInt32LE(phase, 0);
    b.writeFloatLE(x, 4);
    b.writeFloatLE(y, 8);
    this.send(MSG.TOUCH, b);
  }

  of(type: number, conn?: number): RenderMsg[] {
    return this.msgs.filter((m) => m.type === type && (conn === undefined || m.conn === conn));
  }

  /** Ждать, пока pred() не станет true (после каждого полученного куска данных). */
  async until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`fake renderer: timed out waiting for ${what}`);
      await new Promise<void>((ok) => {
        const t = setTimeout(ok, 20);
        this.waiters.push(() => {
          clearTimeout(t);
          ok();
        });
      });
    }
  }

  /** Обрыв всех соединений (рендерер перезапустился); сервер продолжает принимать новые. */
  drop(): void {
    for (const s of this.conns) s.destroy();
  }

  close(): Promise<void> {
    for (const s of this.conns) s.destroy();
    return new Promise((ok) => this.server.close(() => (rmSync(this.path, { force: true }), ok())));
  }
}

export function frame(type: number, payload: Buffer): Buffer {
  const pad = (4 - (payload.length & 3)) & 3;
  const b = Buffer.alloc(8 + payload.length + pad);
  b.writeUInt32LE(type, 0);
  b.writeUInt32LE(payload.length + pad, 4);
  payload.copy(b, 8);
  return b;
}

export function u32(b: Buffer, off = 0): Uint32Array {
  const c = Buffer.from(b.subarray(off));
  return new Uint32Array(c.buffer, c.byteOffset, c.length >> 2);
}

/**
 * Разбор потока операций по таблице «Draw ops» PROTOCOL.md (своя таблица теста, не код клиента).
 * Возвращает [{ op, at, n }] или бросает на неизвестной операции / обрезанном потоке.
 */
export function walkOps(u: Uint32Array): { op: number; at: number; n: number }[] {
  // 19: VIDEO x y w h r id (PROTOCOL.md «Video»)
  const fixed: Record<number, number> = { 1: 1, 2: 5, 4: 6, 5: 7, 7: 8, 8: 11, 9: 6, 12: 3, 13: 4, 14: 0, 15: 9, 16: 1, 17: 3, 18: 6, 19: 6 };
  const out: { op: number; at: number; n: number }[] = [];
  for (let i = 0; i < u.length; ) {
    const op = u[i];
    let n: number;
    if (op === 3) n = 5 + 2 * u[i + 5];
    else if (op === 6) n = 6 + 2 * u[i + 6];
    else if (op === 10) n = 1 + 9 * u[i + 1];
    else if (op === 11) n = 3 + 8 * u[i + 3];
    else if (op in fixed) n = fixed[op];
    else throw new Error(`unknown op ${op} at word ${i}`);
    if (i + 1 + n > u.length) throw new Error(`op ${op} at ${i} runs past the end`);
    out.push({ op, at: i, n: n + 1 });
    i += n + 1;
  }
  return out;
}

/** Ожидаемое премультиплицирование (PROTOCOL.md: premultiplied RGBA) — независимая формула теста. */
export function premultiplied(straight: Uint8Array): Uint8Array {
  const o = new Uint8Array(straight.length);
  for (let i = 0; i < straight.length; i += 4) {
    const a = straight[i + 3];
    for (let c = 0; c < 3; c++) o[i + c] = Math.round((straight[i + c] * a) / 255);
    o[i + 3] = a;
  }
  return o;
}
