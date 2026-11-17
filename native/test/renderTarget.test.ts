import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startApp } from '../src/app';
import type { Kit } from '../src/platform/kit';
import type { Surface } from '../src/platform/kitTypes';
import { IMAGE_ID } from '../src/assets/spec';
import { RENDER_SOCKET, selectRenderTarget, type Env } from '../src/renderTarget';
import { fakeCtx, FakeTransport, flush, stageVendorKit, syntheticAssets } from './helpers';

const KEYS = ['MGU_RENDERD_PROTO', 'MGU_RENDERD_SOCKET'] as const;
const HELLO = 1;
const IMAGE_UPSTREAM = 9; // upstream IMAGE (mgu-render 0.6.21 PROTOCOL.md: 9 = IMAGE для upstream-соединения)
const IMAGE_NATIVE = 10; // iterio / mgu-render/1 IMAGE (premultiplied RGBA)
const X_MODE = 0x4d520001; // mgu-render/1

describe('selectRenderTarget: только окружение процесса', () => {
  it('диалект не навязывается (kit просит mgu-render/1); сокет mgu-render, если не задан снаружи', () => {
    const env: Env = {};
    selectRenderTarget(env);
    assert.deepEqual(env, { MGU_RENDERD_SOCKET: '/run/mgu-render/render.sock' });
    assert.equal(RENDER_SOCKET, '/run/mgu-render/render.sock');
    const emu: Env = { MGU_RENDERD_SOCKET: '/tmp/emu/render.sock', MGU_RENDERD_FILE: '/tmp/x.rd', MGU_RENDERER: 'software' };
    selectRenderTarget(emu);
    assert.deepEqual(emu, { MGU_RENDERD_SOCKET: '/tmp/emu/render.sock', MGU_RENDERD_FILE: '/tmp/x.rd', MGU_RENDERER: 'software' });
    const forced: Env = { MGU_RENDERD_PROTO: 'upstream' };
    selectRenderTarget(forced);
    assert.equal(forced.MGU_RENDERD_PROTO, 'upstream', 'явный upstream снаружи (отладка) сохраняется');
  });
});

interface Msg {
  type: number;
  payload: Buffer;
}

interface GpuConnection {
  place(p: object): void;
  frame(r: unknown): boolean;
  close(): void;
}

function parse(b: Buffer): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i + 8 <= b.length; ) {
    const type = b.readUInt32LE(i);
    const len = b.readUInt32LE(i + 4);
    out.push({ type, payload: b.subarray(i + 8, i + 8 + len) });
    i += 8 + len + ((4 - (len & 3)) & 3);
  }
  return out;
}

/**
 * Кадр «Рельефа» (рендер привода и приборы — растровые изображения) записывается настоящим Recorder и
 * отправляется соединением, которое создаёт Display.prototype._startGpu ВЕНДОРНОГО display.js (то, что уходит
 * в пакет) — в режиме записи в файл (как MGU_RENDERD_FILE / kit/tools/preview.js --gpu). Окружение — как его
 * выставит main.js.
 */
async function recordFrame(env: Env, tab = 0): Promise<{ msgs: Msg[]; drawn: number[]; warnings: string[] }> {
  const saved: Env = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const dir = mkdtempSync(join(tmpdir(), 'xop-rd-'));
  const vk = stageVendorKit();
  try {
    const up = { record: vk.req('./record.js'), G: vk.req('./gauges.js') };
    const display = vk.req('./display.js');
    const kit: Kit = { mgu: { run: () => undefined }, G: up.G, record: { setImage: up.record.setImage } };
    const ctx = fakeCtx(new FakeTransport(), {}, { own: false });
    ctx.canvas = () => new up.record.Recorder(1600, 520) as Surface;
    let t = 0;
    let gpu: GpuConnection | null = null;
    const app = startApp(ctx, kit, syntheticAssets(), () => (t += 50));
    try {
      ctx.tab!(tab);
      await ctx.loopFn!();
      const rec = ctx.shown[ctx.shown.length - 1].cv as unknown as { images: Set<number> };
      const drawn = [...rec.images];

      const warnings: string[] = [];
      const log = { info: () => undefined, warn: (m: unknown) => warnings.push(String(m)), error: () => undefined };
      const self: Record<string, unknown> = {
        screen: { name: 'MAIN' }, // как в нашем app.json: без "chrome": false
        spec: { id: 'xdrive_offroad_pro' },
        log,
        tickHandlers: [],
        grabbing: false,
        _place: () => undefined,
        _syncVisible: () => undefined,
        _grab: () => undefined,
      };
      const file = join(dir, 'frame.rd');
      display.Display.prototype._startGpu.call(self, file);
      const conn = self.gpu as GpuConnection;
      gpu = conn;
      await flush();
      conn.place({ x: 124, y: 82, w: 1600, h: 520, scale: 1, ox: 0, oy: 0 });
      assert.equal(conn.frame(rec), true);
      return { msgs: parse(readFileSync(file)), drawn, warnings };
    } finally {
      try {
        gpu?.close();
      } finally {
        app.dispose();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    vk.cleanup();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('запись кадра настоящим вендорным display.js/renderd.js (MIT kit/runtime)', () => {
  const images = (msgs: Msg[], type: number) => msgs.filter((m) => m.type === type).map((m) => ({ id: m.payload.readUInt32LE(0), w: m.payload.readUInt32LE(4), h: m.payload.readUInt32LE(8), len: m.payload.length, px: m.payload.subarray(12) }));

  it('с окружением main.js: HELLO mgu-render/1, все растры кадра уходят IMAGE 10, предупреждения о потере нет', async () => {
    const env: Env = {};
    selectRenderTarget(env);
    const { msgs, drawn, warnings } = await recordFrame(env);
    assert.deepEqual([...drawn].sort((a, b) => a - b), [IMAGE_ID.xray, IMAGE_ID.dialPitch, IMAGE_ID.dialRoll].sort((a, b) => a - b), `кадр Terrain: xray + 2 шкалы (${drawn.join(',')})`);
    assert.match(msgs.find((m) => m.type === HELLO)!.payload.toString('utf8'), /^xdrive_offroad_pro\0proto=mgu-render\/1/);
    assert.ok(msgs.some((m) => m.type === X_MODE), 'X_MODE (mgu-render/1)');
    const pics = images(msgs, IMAGE_NATIVE);
    const uploaded = pics.map((i) => i.id);
    for (const id of drawn) assert.ok(uploaded.includes(id), `растр ${id} кадра загружен (${uploaded.join(',')})`);
    assert.equal(new Set(uploaded).size, uploaded.length, 'каждый растр — один раз');
    for (const im of pics) {
      assert.ok(im.w <= 1024 && im.h <= 1024, `IMAGE ${im.id}: ${im.w}×${im.h} ≤ 1024`);
      assert.equal(im.len, 12 + im.w * im.h * 4, `IMAGE ${im.id}: ${im.w}×${im.h} RGBA`);
      assert.ok(im.px.some((b) => b !== 0), `IMAGE ${im.id}: пиксели не пусты`);
    }
    assert.equal(images(msgs, IMAGE_UPSTREAM).length, 0, 'в mgu-render/1 сообщение 9 — CLAIM, не растр');
    assert.ok(!warnings.some((w) => /pixel images/.test(w)), warnings.join('; '));
  });

  it('Traction: xray загружен IMAGE 10', async () => {
    const env: Env = {};
    selectRenderTarget(env);
    const { msgs, drawn } = await recordFrame(env, 1);
    assert.ok(drawn.includes(IMAGE_ID.xray), `кадр Traction рисует xray: ${drawn.join(',')}`);
    assert.ok(images(msgs, IMAGE_NATIVE).some((i) => i.id === IMAGE_ID.xray));
  });

  it('явный MGU_RENDERD_PROTO=upstream (отладка): обычный HELLO, растры — IMAGE 9', async () => {
    const { msgs, drawn } = await recordFrame({ MGU_RENDERD_PROTO: 'upstream' });
    assert.equal(msgs.find((m) => m.type === HELLO)!.payload.toString('utf8').replace(/\0+$/, ''), 'xdrive_offroad_pro');
    assert.ok(!msgs.some((m) => m.type === X_MODE));
    const uploaded = images(msgs, IMAGE_UPSTREAM).map((i) => i.id);
    for (const id of drawn) assert.ok(uploaded.includes(id));
    assert.equal(images(msgs, IMAGE_NATIVE).length, 0);
  });
});
