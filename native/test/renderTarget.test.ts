import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startApp } from '../src/app';
import type { Kit } from '../src/platform/kit';
import type { Surface } from '../src/platform/kitTypes';
import { IMAGE_ID } from '../src/assets/spec';
import { RENDER_PROTO, RENDER_SOCKET, selectRenderTarget, type Env } from '../src/renderTarget';
import { fakeCtx, FakeTransport, flush, hasUpstream, loadUpstream, loadUpstreamDisplay, syntheticAssets } from './helpers';

const KEYS = ['MGU_RENDERD_PROTO', 'MGU_RENDERD_SOCKET'] as const;
const HELLO = 1;
const IMAGE = 9; // upstream IMAGE (mgu-render 0.6.21 PROTOCOL.md: 9 = IMAGE для upstream-соединения)
const X_MODE = 0x4d520001; // mgu-render/1

describe('selectRenderTarget: только окружение процесса', () => {
  it('диалект всегда upstream; сокет mgu-render, если не задан снаружи', () => {
    const env: Env = {};
    selectRenderTarget(env);
    assert.deepEqual(env, { MGU_RENDERD_PROTO: 'upstream', MGU_RENDERD_SOCKET: '/run/mgu-render/render.sock' });
    assert.equal(RENDER_PROTO, 'upstream');
    assert.equal(RENDER_SOCKET, '/run/mgu-render/render.sock');
    const emu: Env = { MGU_RENDERD_SOCKET: '/tmp/emu/render.sock', MGU_RENDERD_PROTO: 'native', MGU_RENDERD_FILE: '/tmp/x.rd', MGU_RENDERER: 'software' };
    selectRenderTarget(emu);
    assert.deepEqual(emu, { MGU_RENDERD_SOCKET: '/tmp/emu/render.sock', MGU_RENDERD_PROTO: 'upstream', MGU_RENDERD_FILE: '/tmp/x.rd', MGU_RENDERER: 'software' });
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
 * отправляется соединением, которое создаёт Display.prototype._startGpu закреплённого display.js — в режиме
 * записи в файл (как MGU_RENDERD_FILE / kit/tools/preview.js --gpu). Окружение — как его выставит main.js.
 */
async function recordFrame(env: Env, tab = 0): Promise<{ msgs: Msg[]; drawn: number[]; warnings: string[] }> {
  const saved: Env = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const dir = mkdtempSync(join(tmpdir(), 'xop-rd-'));
  try {
    const up = loadUpstream();
    const { display } = loadUpstreamDisplay();
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
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('запись кадра настоящим display.js/renderd.js (MIT kit/runtime)', { skip: hasUpstream ? false : 'нет checkout idrive7-apps (MGU_UPSTREAM)' }, () => {
  it('с окружением main.js: HELLO без mgu-render/1, все растры кадра уходят сообщениями IMAGE с пикселями', async () => {
    const env: Env = {};
    selectRenderTarget(env);
    const { msgs, drawn, warnings } = await recordFrame(env);
    assert.deepEqual([...drawn].sort((a, b) => a - b), [IMAGE_ID.xray, IMAGE_ID.dialPitch, IMAGE_ID.dialRoll].sort((a, b) => a - b), `кадр Terrain: xray + 2 шкалы (${drawn.join(',')})`);
    const hello = msgs.find((m) => m.type === HELLO)!;
    assert.equal(hello.payload.toString('utf8').replace(/\0+$/, ''), 'xdrive_offroad_pro', 'обычный HELLO (upstream)');
    assert.ok(!msgs.some((m) => m.type === X_MODE), 'нет сообщений mgu-render/1');
    const images = msgs.filter((m) => m.type === IMAGE).map((m) => ({ id: m.payload.readUInt32LE(0), w: m.payload.readUInt32LE(4), h: m.payload.readUInt32LE(8), len: m.payload.length, px: m.payload.subarray(12) }));
    const uploaded = images.map((i) => i.id);
    for (const id of drawn) assert.ok(uploaded.includes(id), `растр ${id} кадра загружен (${uploaded.join(',')})`);
    assert.equal(new Set(uploaded).size, uploaded.length, 'каждый растр — один раз');
    for (const im of images) {
      assert.equal(im.len, 12 + im.w * im.h * 4, `IMAGE ${im.id}: ${im.w}×${im.h} RGBA`);
      assert.ok(im.px.some((b) => b !== 0), `IMAGE ${im.id}: пиксели не пусты`);
    }
    assert.ok(!warnings.some((w) => /pixel images need the upstream dialect/.test(w)), warnings.join('; '));
  });

  it('Traction: компактная схема — xray загружен в записи настоящим Recorder', async () => {
    const env: Env = {};
    selectRenderTarget(env);
    const { msgs, drawn } = await recordFrame(env, 1);
    assert.ok(drawn.includes(IMAGE_ID.xray), `кадр Traction рисует xray: ${drawn.join(',')}`);
    const uploaded = msgs.filter((m) => m.type === IMAGE).map((m) => m.payload.readUInt32LE(0));
    assert.ok(uploaded.includes(IMAGE_ID.xray), `xray загружен: ${uploaded.join(',')}`);
  });

  it('контроль: без выбора диалекта kit просит mgu-render/1 и растры теряются (то, от чего защищает bootstrap)', async () => {
    const { msgs, drawn, warnings } = await recordFrame({});
    assert.ok(drawn.includes(IMAGE_ID.xray));
    assert.match(msgs.find((m) => m.type === HELLO)!.payload.toString('utf8'), /proto=mgu-render\/1/);
    assert.equal(msgs.filter((m) => m.type === IMAGE).length, 0);
    assert.ok(warnings.some((w) => /pixel images need the upstream dialect/.test(w)));
  });
});
