// Серверная сторона протокола cluster-render, версия 1 — ровно столько, сколько нужно, чтобы принять видео от
// mgu-camcluster на СОБСТВЕННЫЙ (частный) сокет моста, а не на приборную панель. Написано по описанию протокола
// (robertnisipeanu/idrive-apps native/cluster-render/PROTOCOL.md, MPL-2.0; копия: work/research/camera-interop),
// код клиента/сервиса оттуда не берётся.
//
//   сообщение: u32 LE длина (байты после неё) | u8 тип | тело; не больше 5 529 664 байт
//   J — плоский объект JSON (op у клиента, ev у сервиса); F — u32 ref, u64 номер кадра, u16 число прямоугольников,
//   прямоугольники, пиксели. Видео: прямоугольников нет, атлас 4:2:0 — Y (w×h), затем строки h/2, в каждой U (w/2)
//   и V (w/2) рядом: w·h·3/2 байт. M (геометрия) мосту не нужен.
// Мост объявляет одну цель (`target`) своего размера и одну видео-раскладку; всё прочее (картинки, ассеты, шейдеры,
// сцены, хосты) отклоняется событием error — ничего не исполняется и не ищется по путям клиента.

export const MAX_MESSAGE = 5529664;
/** JSON у клиента — плоский объект; больше мосту не нужно. */
export const MAX_JSON = 64 * 1024;

export type Message = { readonly type: number; readonly body: Buffer };

/** Разбор потока на сообщения с проверкой границ. Ошибка — соединение закрывается. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  push(d: Buffer): Message[] | string {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    const out: Message[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len < 1 || len > MAX_MESSAGE) return `длина сообщения ${len}`;
      if (this.buf.length < 4 + len) break;
      out.push({ type: this.buf[4], body: this.buf.slice(5, 4 + len) });
      this.buf = this.buf.slice(4 + len);
    }
    // недочитанное сообщение не может быть больше предела (проверено выше), буфер ограничен им
    return out;
  }
}

export function encodeJson(obj: Record<string, string | number>): Buffer {
  const j = Buffer.from(JSON.stringify(obj), 'utf8');
  const b = Buffer.alloc(5 + j.length);
  b.writeUInt32LE(1 + j.length, 0);
  b[4] = 0x4a;
  j.copy(b, 5);
  return b;
}

/** Атлас кадра (Y, затем строки «U | V») → I420 (Y, U, V подряд). w кратно 4, h чётно. */
export function atlasToI420(src: Buffer, w: number, h: number, dst: Buffer = Buffer.allocUnsafe((w * h * 3) / 2)): Buffer {
  const ySize = w * h;
  const cw = w / 2;
  const ch = h / 2;
  src.copy(dst, 0, 0, ySize);
  const u0 = ySize;
  const v0 = ySize + cw * ch;
  for (let r = 0; r < ch; r++) {
    const row = ySize + r * w;
    src.copy(dst, u0 + r * cw, row, row + cw);
    src.copy(dst, v0 + r * cw, row + cw, row + w);
  }
  return dst;
}

export interface SessionOptions {
  /** Поколение головного устройства, которое мост сообщает (camcluster сверяет его со своим). */
  readonly backend: 'id7' | 'id8';
  readonly target: string;
  readonly targetW: number;
  readonly targetH: number;
}

export interface VideoFrame {
  readonly ref: number;
  readonly w: number;
  readonly h: number;
  /** Кадр I420 (w·h·3/2). */
  readonly i420: Buffer;
}

export interface Output {
  readonly send: Buffer[];
  readonly frame?: VideoFrame;
  /** Нарушение протокола — закрыть соединение (с причиной для журнала). */
  readonly close?: string;
  /** Для журнала моста (без пикселей). */
  readonly note?: string;
}

interface VideoLayer {
  readonly ref: number;
  readonly w: number;
  readonly h: number;
  visible: boolean;
}

const isRef = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 0x80000000;
const UNSUPPORTED = 'not supported by xop-camera-bridge (video layers only)';

/** Состояние одного соединения клиента cluster-render. */
export class ClusterSession {
  private hello = false;
  private readonly layers = new Map<number, VideoLayer>();
  private scratch: Buffer | null = null;
  constructor(private readonly opts: SessionOptions) {}

  get videoLayer(): { ref: number; w: number; h: number } | null {
    const v = this.layers.values().next();
    return v.done ? null : { ref: v.value.ref, w: v.value.w, h: v.value.h };
  }

  handle(m: Message): Output {
    if (m.type === 0x4a) return this.json(m.body);
    if (m.type === 0x46) return this.frame(m.body);
    if (m.type === 0x4d) return { send: [encodeJson({ ev: 'error', op: 'mesh', ref: 0, reason: UNSUPPORTED })] };
    return { send: [], close: `тип сообщения 0x${m.type.toString(16)}` };
  }

  private error(op: string, ref: number, reason: string): Output {
    return { send: [encodeJson({ ev: 'error', op, ref, reason })] };
  }

  private json(body: Buffer): Output {
    if (body.length > MAX_JSON) return { send: [], close: `JSON ${body.length} байт` };
    let o: unknown;
    try {
      o = JSON.parse(body.toString('utf8'));
    } catch {
      return { send: [], close: 'JSON не разобран' };
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { send: [], close: 'JSON не объект' };
    const j = o as Record<string, unknown>;
    const op = typeof j.op === 'string' ? j.op.slice(0, 32) : '';
    const ref = isRef(j.ref) ? j.ref : 0;
    if (op === 'hello') {
      if (j.proto !== 1) return { send: [], close: `proto ${String(j.proto).slice(0, 16)}` };
      this.hello = true;
      return {
        send: [encodeJson({ ev: 'hello', proto: 1, backend: this.opts.backend, targets: `${this.opts.target}:${this.opts.targetW}x${this.opts.targetH}`, repeat: 0, always_packed: 0 })],
        note: `hello from ${typeof j.app === 'string' ? j.app.replace(/[^\x20-\x7e]/g, '?').slice(0, 40) : '?'}`,
      };
    }
    if (!this.hello) return { send: [], close: `${op} до hello` };
    switch (op) {
      case 'layer':
        return this.layer(j, ref);
      case 'set': {
        const L = this.layers.get(ref);
        if (!L) return this.error(op, ref, 'no such layer');
        if (j.visible === 0 || j.visible === 1) L.visible = j.visible === 1;
        return { send: [encodeJson({ ev: 'layer', ref, state: L.visible ? 'shown' : 'hidden', reason: '' })] };
      }
      case 'drop':
        if (!this.layers.delete(ref)) return this.error(op, ref, 'no such layer');
        return { send: [], note: `video layer ${ref} dropped` };
      case 'status':
        return { send: [encodeJson({ ev: 'status', text: 'xop-camera-bridge: private target, video layers only' })] };
      default:
        return this.error(op || '?', ref, UNSUPPORTED);
    }
  }

  private layer(j: Record<string, unknown>, ref: number): Output {
    if (!ref) return this.error('layer', 0, 'bad ref');
    if (j.target !== this.opts.target) return this.error('layer', ref, `no target ${String(j.target).slice(0, 32)}`);
    if (j.kind !== 'video') return this.error('layer', ref, UNSUPPORTED);
    if (this.layers.has(ref)) return this.error('layer', ref, 'ref in use');
    if (this.layers.size >= 1) return this.error('layer', ref, 'too many video layers');
    const w = j.vw === undefined ? 1088 : j.vw;
    const h = j.vh === undefined ? 480 : j.vh;
    if (typeof w !== 'number' || typeof h !== 'number' || !Number.isInteger(w) || !Number.isInteger(h) || w % 4 || h % 2 || w < 16 || h < 16 || w > this.opts.targetW || h > this.opts.targetH)
      return this.error('layer', ref, `frame size ${String(w)}x${String(h)} not within ${this.opts.targetW}x${this.opts.targetH} (width a multiple of 4, height even)`);
    this.layers.set(ref, { ref, w, h, visible: j.visible !== 0 });
    return {
      send: [
        encodeJson({ ev: 'target', target: this.opts.target, state: 'shown', holder: '', reason: '', retry_in_ms: 0, rendering: 'verified', guide_disabled: 0, disabled: 0 }),
        encodeJson({ ev: 'layer', ref, state: 'shown', reason: '' }),
      ],
      note: `video layer ${ref} ${w}x${h}`,
    };
  }

  private frame(b: Buffer): Output {
    if (b.length < 14) return { send: [], close: `кадр ${b.length} байт` };
    const ref = b.readUInt32LE(0);
    const rects = b.readUInt16LE(12);
    const L = this.layers.get(ref);
    if (!L) return this.error('frame', ref, 'no such video layer');
    if (rects !== 0) return this.error('frame', ref, 'a video frame has no rects');
    const px = b.slice(14);
    const n = (L.w * L.h * 3) / 2;
    if (px.length !== n) return this.error('frame', ref, `video frame ${px.length} bytes, expected ${n}`);
    if (!L.visible) return { send: [] };
    if (!this.scratch || this.scratch.length !== n) this.scratch = Buffer.allocUnsafe(n);
    return { send: [], frame: { ref, w: L.w, h: L.h, i420: atlasToI420(px, L.w, L.h, this.scratch) } };
  }
}
