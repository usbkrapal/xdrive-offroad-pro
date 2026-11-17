// Протокол mgu-render 0.6.21 (work/research/mgu-render-0.6.21/PROTOCOL.md) на настоящем вендорном
// клиенте: kit/runtime/renderd.js RenderClient + record.js Recorder (то, что уходит в пакет), против
// локального фальшивого рендерера на unix-сокете (fakeRenderer.ts). Без сети и без машины.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FakeRenderer, MSG, premultiplied, u32, walkOps, type RenderMsg } from './fakeRenderer';
import { stageVendorKit } from './helpers';
import type { Surface } from '../src/platform/kitTypes';

interface Rec extends Surface {
  words(): Uint32Array;
  card(x: number, y: number, w: number, h: number, r: number, stops: readonly (readonly [number, string])[]): Rec;
  rampRect(x: number, y: number, w: number, h: number, r: number, stops: readonly string[]): Rec;
  xf(s?: number, ox?: number, oy?: number): Rec;
}
interface Layer {
  layerId: number;
  w: number;
  h: number;
  words: Uint32Array;
}
interface RecordModule {
  Recorder: new (w: number, h: number, o?: unknown) => Rec;
  setImage(id: number, w: number, h: number, d: Uint8Array): { ver: number };
  makeLayer(w: number, h: number, draw: (r: Rec) => void): Layer;
}
interface Client {
  native: boolean;
  touch: boolean;
  ready: boolean;
  info: { touch: boolean; pixmaps: boolean; pixmapMax: number } | null;
  connect(): Client;
  place(p: object): void;
  show(on: boolean): void;
  frame(r: Rec): boolean;
  claim(rects: { x: number; y: number; w: number; h: number }[]): void;
  reconnect(): boolean;
  close(): void;
  on(ev: string, fn: (...a: unknown[]) => void): void;
  once(ev: string, fn: (...a: unknown[]) => void): void;
}
type ClientCtor = new (id: string, log: object, opts: object) => Client;

const OP_IMAGE = 18;
const IMG_A = 0x584f7001;
const IMG_B = 0x584f7002;
const IMG_BIG = 0x584f7003;

/** Прямой (не премультиплицированный) RGBA с разными альфами, включая 0 и 255. */
function straight(w: number, h: number, salt: number): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  const alphas = [255, 128, 0, 77, 200, 1];
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = (37 * i + salt) & 255;
    d[i * 4 + 1] = (91 * i + 3 * salt) & 255;
    d[i * 4 + 2] = 250 - ((i * 13) % 200);
    d[i * 4 + 3] = alphas[(i + salt) % alphas.length];
  }
  return d;
}

const log = () => {
  const out = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  return {
    out,
    info: (m: unknown) => out.info.push(String(m)),
    warn: (m: unknown) => out.warn.push(String(m)),
    error: (m: unknown) => out.error.push(String(m)),
  };
};

const imageMsgs = (srv: FakeRenderer, type: number, conn?: number) =>
  srv.of(type, conn).map((m) => ({ id: m.payload.readUInt32LE(0), w: m.payload.readUInt32LE(4), h: m.payload.readUInt32LE(8), px: m.payload.subarray(12), len: m.payload.length }));

/** Слова кадра/слоя, присланные рендереру, против записанных: op 18 переставлен, остальное — слово в слово. */
function assertTranslated(sent: Uint32Array, recorded: Uint32Array, what: string): number {
  assert.equal(sent.length, recorded.length, `${what}: столько же слов`);
  const ops = walkOps(recorded);
  assert.deepEqual(walkOps(sent).map((o) => [o.op, o.at, o.n]), ops.map((o) => [o.op, o.at, o.n]), `${what}: те же операции на тех же местах`);
  let images = 0;
  for (const o of ops) {
    const a = o.at;
    if (o.op === OP_IMAGE) {
      images++;
      // upstream: id ver x y w h → native: x y w h r id
      assert.deepEqual([...sent.subarray(a + 1, a + 5)], [...recorded.subarray(a + 3, a + 7)], `${what}: op 18 x y w h (как float-слова)`);
      assert.equal(new Float32Array(sent.buffer, sent.byteOffset + (a + 5) * 4, 1)[0], 0, `${what}: op 18 r = 0`);
      assert.equal(sent[a + 6], recorded[a + 1], `${what}: op 18 id последним словом`);
    } else {
      assert.deepEqual([...sent.subarray(a, a + o.n)], [...recorded.subarray(a, a + o.n)], `${what}: op ${o.op} @${a} без изменений`);
    }
  }
  return images;
}

const layerMsgs = (srv: FakeRenderer, conn?: number) =>
  srv.of(MSG.LAYER, conn).map((m) => ({ id: m.payload.readUInt32LE(0), w: m.payload.readFloatLE(4), h: m.payload.readFloatLE(8), words: u32(m.payload, 12) }));

/** Порядок: сообщение a пришло раньше b (на одном соединении). */
const before_ = (srv: FakeRenderer, a: (m: RenderMsg) => boolean, b: (m: RenderMsg) => boolean) => srv.msgs.findIndex(a) >= 0 && srv.msgs.findIndex(a) < srv.msgs.findIndex(b);

describe('mgu-render/1: настоящий вендорный RenderClient + Recorder', () => {
  const kit = stageVendorKit();
  const rec = kit.req('./record.js') as RecordModule;
  const { RenderClient } = kit.req('./renderd.js') as { RenderClient: ClientCtor };
  let srv: FakeRenderer;
  let gpu: Client;
  const lg = log();
  let layer: Layer;
  let frameRec: Rec;
  let dataA = straight(3, 2, 1);
  const dataB = straight(2, 2, 5);

  const drawFrame = () => {
    const r = frameRec;
    (r as unknown as { reset(): void }).reset();
    r.clear('#04060a');
    r.fillRect(1.5, 2.5, 100, 40, '#81c4ffcc');
    r.gradientRect(0, 0, 50, 20, [[0, '#000000'], [0.5, '#ffffff'], [1, '#ff0000']]);
    r.card(5, 5, 60, 30, 6, [[0, '#101217'], [1, '#2a2e35']]);
    r.roundRect(10, 10, 20, 20, 4, '#ef2b2d');
    r.strokeRoundRect(10, 10, 20, 20, 4, 2, '#ffffff');
    r.rampRect(0, 40, 200, 10, 3, ['#16588e', '#e7222e']);
    r.arc(300, 200, 40, 50, -90, 90, '#ffffff', { round: true, ramp: ['#81c4ff', '#ef2b2d'] });
    r.text('Рельеф 12.5°', 20, 80, 22, '#ffffff', { literal: true });
    r.image(IMG_A, 10.25, 20.5, 300, 200);
    r.fill([[0, 0], [40, 0], [20, 30], [10, 10]], '#7fdcff');
    r.quad([[0, 0], [10, 0], [10, 10], [0, 10]], '#ffffff');
    r.alpha(0.5);
    r.line(0, 0, 100, 100, 3, '#ffffff');
    r.alpha(1);
    r.clip(0, 0, 800, 400);
    r.blit(layer as never, 33.4, 44.6);
    r.noclip();
    r.xf(1, 0, 0);
    r.image(IMG_A, 1, 2, 3, 4);
    r.xf();
    return r;
  };

  before(async () => {
    srv = await FakeRenderer.start({ native: true, touch: true, caps: 1 | 8, pixmapMax: 2048 });
    rec.setImage(IMG_A, 3, 2, dataA);
    rec.setImage(IMG_B, 2, 2, dataB);
    layer = rec.makeLayer(40, 30, (r) => {
      r.fillRect(0, 0, 40, 30, '#101217');
      r.image(IMG_B, 1, 2, 30, 20);
    });
    frameRec = new rec.Recorder(1600, 520);
    gpu = new RenderClient('xop_test', lg, { native: true, socket: srv.path });
    const ready = new Promise((ok) => gpu.once('ready', ok));
    gpu.connect();
    await ready;
  });
  after(async () => {
    gpu.close();
    await srv.close();
    kit.cleanup();
  });

  it('HELLO с proto=mgu-render/1, X_READY → READY: соединение native, касание и pixmaps', async () => {
    const hello = srv.of(MSG.HELLO)[0].payload.toString('utf8').replace(/\0+$/, '');
    assert.equal(hello, 'xop_test\0proto=mgu-render/1');
    assert.equal(gpu.native, true);
    assert.equal(gpu.touch, true);
    assert.deepEqual({ touch: gpu.info!.touch, pixmaps: gpu.info!.pixmaps, pixmapMax: gpu.info!.pixmapMax }, { touch: true, pixmaps: true, pixmapMax: 2048 });
    await srv.until(() => srv.of(MSG.X_MODE).length > 0, 'X_MODE');
    assert.equal(srv.of(MSG.X_MODE)[0].payload.readUInt32LE(0), 1, 'X_MODE layer');
  });

  it('кадр: растры IMAGE 10 премультиплицированы ровно один раз, op 18 переставлен в кадре и в слое, запись не тронута', async () => {
    gpu.place({ x: 0, y: 0, w: 1920, h: 720, scale: 1.165, ox: 84, oy: 50 });
    gpu.show(true);
    const r = drawFrame();
    const recorded = Uint32Array.from(r.words());
    // (frame() отдаёт результат socket.write: false — лишь буфер сокета полон, не отказ)
    gpu.frame(r);
    await srv.until(() => srv.of(MSG.FRAME).length === 1, 'FRAME');
    assert.deepEqual([...r.words()], [...recorded], 'Recorder: слова кадра не изменены отправкой (программный путь их проигрывает)');

    const pics = imageMsgs(srv, MSG.TEN);
    assert.deepEqual(pics.map((p) => p.id).sort(), [IMG_A, IMG_B].sort(), 'оба растра (кадр и слой), по одному разу');
    for (const p of pics) {
      const src = p.id === IMG_A ? dataA : dataB;
      assert.equal(p.len, 12 + p.w * p.h * 4);
      assert.deepEqual([...p.px], [...premultiplied(src)], `IMAGE ${p.id}: премультиплицированный RGBA`);
      assert.notDeepEqual([...p.px], [...src], 'не прямой RGBA');
    }
    assert.equal(srv.of(MSG.NINE).length, 0, 'ни одного сообщения 9 (в mgu-render/1 это CLAIM)');

    const L = layerMsgs(srv);
    assert.equal(L.length, 1);
    assert.equal(L[0].id, layer.layerId);
    assert.equal(assertTranslated(L[0].words, layer.words, 'LAYER'), 1);
    assert.ok(before_(srv, (m) => m.type === MSG.TEN && m.payload.readUInt32LE(0) === IMG_B, (m) => m.type === MSG.LAYER), 'растр слоя загружен раньше слоя');

    const sent = u32(srv.of(MSG.FRAME)[0].payload);
    assert.equal(assertTranslated(sent, recorded, 'FRAME'), 2);
    assert.ok(before_(srv, (m) => m.type === MSG.TEN && m.payload.readUInt32LE(0) === IMG_A, (m) => m.type === MSG.FRAME), 'растр кадра загружен раньше кадра');
    assert.ok(srv.of(MSG.ATLAS).length >= 1 && srv.of(MSG.RAMP).length >= 1, 'атласы и рампы ушли');
    assert.deepEqual(lg.out.warn.filter((w) => /pixel images/.test(w)), []);
  });

  it('новая версия растра — загрузка заново (одного этого растра), без изменений — ничего', async () => {
    gpu.frame(drawFrame());
    await srv.until(() => srv.of(MSG.FRAME).length === 2, 'FRAME 2');
    assert.equal(imageMsgs(srv, MSG.TEN).length, 2, 'тот же кадр: растры не загружаются снова');
    dataA = straight(3, 2, 9);
    rec.setImage(IMG_A, 3, 2, dataA);
    gpu.frame(drawFrame());
    await srv.until(() => srv.of(MSG.FRAME).length === 3, 'FRAME 3');
    const pics = imageMsgs(srv, MSG.TEN);
    assert.equal(pics.length, 3);
    assert.equal(pics[2].id, IMG_A);
    assert.deepEqual([...pics[2].px], [...premultiplied(dataA)]);
    assert.equal(layerMsgs(srv).length, 1, 'слой не переотправлен');
  });

  it('CLAIM (9) вместе с растрами, TOUCH (105) приходит событием touch', async () => {
    gpu.claim([{ x: 0, y: 0, w: 1600, h: 520 }, { x: 10.5, y: -60, w: 300, h: 60 }]);
    await srv.until(() => srv.of(MSG.NINE).length === 1, 'CLAIM');
    const c = srv.of(MSG.NINE)[0].payload;
    assert.equal(c.readUInt32LE(0), 2);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((i) => c.readFloatLE(i * 4)), [0, 0, 1600, 520, 10.5, -60, 300, 60]);
    const got: unknown[][] = [];
    gpu.on('touch', (...a) => got.push(a));
    srv.touch(1, 100.5, 200.25);
    srv.touch(3, 100.5, 200.25);
    await srv.until(() => got.length === 2, 'touch events');
    assert.deepEqual(got, [[1, 100.5, 200.25], [3, 100.5, 200.25]]);
  });

  it('переподключение: снова X_READY/READY, все растры, слой, атласы и рампы — заново', async () => {
    const ready = new Promise((ok) => gpu.once('ready', ok));
    assert.equal(gpu.reconnect(), true);
    await ready;
    assert.equal(gpu.native, true);
    const conn = srv.conns.length - 1;
    assert.equal(conn, 1);
    gpu.frame(drawFrame());
    await srv.until(() => srv.of(MSG.FRAME, conn).length === 1, 'FRAME on the new connection');
    assert.deepEqual(imageMsgs(srv, MSG.TEN, conn).map((p) => p.id).sort(), [IMG_A, IMG_B].sort());
    assert.deepEqual([...imageMsgs(srv, MSG.TEN, conn).find((p) => p.id === IMG_A)!.px], [...premultiplied(dataA)]);
    assert.equal(layerMsgs(srv, conn).length, 1);
    assert.ok(srv.of(MSG.ATLAS, conn).length >= 1 && srv.of(MSG.RAMP, conn).length >= 1);
    assert.equal(srv.of(MSG.PLACE, conn).length >= 1, true, 'PLACE снова');
  });

  it('растр больше 1024: X_PIXMAP + X_PIXELS (премультиплицированные), где рендерер их предлагает', async () => {
    const big = straight(1500, 3, 2);
    rec.setImage(IMG_BIG, 1500, 3, big);
    const r = new rec.Recorder(1600, 520);
    r.image(IMG_BIG, 0, 0, 1500, 3);
    gpu.frame(r);
    const conn = srv.conns.length - 1;
    await srv.until(() => srv.of(MSG.FRAME, conn).length === 2, 'FRAME with the big image');
    const pm = srv.of(MSG.X_PIXMAP, conn);
    assert.equal(pm.length, 1);
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => pm[0].payload.readUInt32LE(i * 4)), [IMG_BIG, 1500, 3, 1, 1], 'id w h, premultiplied, linear');
    const px = srv.of(MSG.X_PIXELS, conn);
    const rows: Buffer[] = [];
    let y = 0;
    for (const m of px) {
      const p = m.payload;
      assert.equal(p.readUInt32LE(0), IMG_BIG);
      assert.equal(p.readUInt32LE(4), 1);
      assert.deepEqual([p.readUInt32LE(8), p.readUInt32LE(12), p.readUInt32LE(16)], [0, y, 1500]);
      y += p.readUInt32LE(20);
      rows.push(p.subarray(24));
    }
    assert.equal(y, 3, 'все строки');
    assert.deepEqual([...Buffer.concat(rows)], [...premultiplied(big)]);
    assert.equal(imageMsgs(srv, MSG.TEN, conn).filter((p) => p.id === IMG_BIG).length, 0);
  });
});

describe('mgu-render/1 без pixmaps: растр больше 1024 — ошибка в журнале и событие, не молчаливая потеря', () => {
  it('imageError и log.error; кадр всё равно уходит', async () => {
    const kit = stageVendorKit();
    const rec = kit.req('./record.js') as RecordModule;
    const { RenderClient } = kit.req('./renderd.js') as { RenderClient: ClientCtor };
    const srv = await FakeRenderer.start({ native: true, touch: true, caps: 1 });
    const lg = log();
    const gpu = new RenderClient('xop_test', lg, { native: true, socket: srv.path });
    try {
      const ready = new Promise((ok) => gpu.once('ready', ok));
      gpu.connect();
      await ready;
      const errs: unknown[][] = [];
      gpu.on('imageError', (...a) => errs.push(a));
      rec.setImage(IMG_BIG, 1100, 2, straight(1100, 2, 0));
      gpu.place({ x: 0, y: 0, w: 1920, h: 720, scale: 1, ox: 0, oy: 0 });
      const r = new rec.Recorder(1600, 520);
      r.image(IMG_BIG, 0, 0, 100, 2);
      gpu.frame(r);
      await srv.until(() => srv.of(MSG.FRAME).length === 1, 'FRAME');
      assert.equal(errs.length, 1);
      assert.equal(errs[0][0], IMG_BIG);
      assert.match(lg.out.error.join('\n'), /image .* not sent: over 1024 px a side and the renderer offers no pixmaps/);
      assert.equal(srv.of(MSG.TEN).length + srv.of(MSG.X_PIXMAP).length, 0);
    } finally {
      gpu.close();
      await srv.close();
      kit.cleanup();
    }
  });
});

describe('запасной путь: старый рендерер (только READY) — upstream-диалект', () => {
  it('IMAGE 9 с прямым RGBA, op 18 как записан, CLAIM после растров не посылается', async () => {
    const kit = stageVendorKit();
    const rec = kit.req('./record.js') as RecordModule;
    const { RenderClient } = kit.req('./renderd.js') as { RenderClient: ClientCtor };
    const srv = await FakeRenderer.start({ native: false, touch: true });
    const gpu = new RenderClient('xop_test', log(), { native: true, socket: srv.path });
    try {
      const ready = new Promise((ok) => gpu.once('ready', ok));
      gpu.connect();
      await ready;
      assert.equal(gpu.native, false, 'X_READY не было');
      const data = straight(3, 2, 4);
      rec.setImage(IMG_A, 3, 2, data);
      const layer = rec.makeLayer(10, 10, (r) => r.image(IMG_A, 0, 0, 10, 10));
      gpu.place({ x: 124, y: 82, w: 1600, h: 520, scale: 1, ox: 0, oy: 0 });
      const r = new rec.Recorder(1600, 520);
      r.fillRect(0, 0, 10, 10, '#ffffff');
      r.image(IMG_A, 5, 6, 30, 20);
      r.blit(layer as never, 0, 0);
      const recorded = Uint32Array.from(r.words());
      gpu.frame(r);
      await srv.until(() => srv.of(MSG.FRAME).length === 1, 'FRAME');
      const pics = imageMsgs(srv, MSG.NINE);
      assert.equal(pics.length, 1, 'растр — один раз (и для кадра, и для слоя)');
      assert.deepEqual([pics[0].id, pics[0].w, pics[0].h], [IMG_A, 3, 2]);
      assert.deepEqual([...pics[0].px], [...data], 'upstream IMAGE: прямой RGBA, как записан');
      assert.deepEqual([...u32(srv.of(MSG.FRAME)[0].payload)], [...recorded], 'op 18 upstream: id ver x y w h');
      assert.deepEqual([...layerMsgs(srv)[0].words], [...layer.words]);
      assert.equal(srv.of(MSG.TEN).length, 0);
      gpu.claim([{ x: 0, y: 0, w: 10, h: 10 }]);
      gpu.frame(r);
      await srv.until(() => srv.of(MSG.FRAME).length === 2, 'FRAME 2');
      assert.equal(srv.of(MSG.NINE).length, 1, 'claim не послан: в upstream 9 — это IMAGE');
    } finally {
      gpu.close();
      await srv.close();
      kit.cleanup();
    }
  });
});

describe('запись в файл (MGU_RENDERD_FILE) с native: тот же перевод op 18', () => {
  it('кадр в файле — native-раскладка op 18 и IMAGE 10', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const kit = stageVendorKit();
    const rec = kit.req('./record.js') as RecordModule;
    const { RenderClient } = kit.req('./renderd.js') as { RenderClient: ClientCtor };
    const dir = mkdtempSync(join(tmpdir(), 'xop-rdf-'));
    const file = join(dir, 'out.rd');
    const gpu = new RenderClient('xop_test', log(), { native: true, file });
    try {
      const ready = new Promise((ok) => gpu.once('ready', ok));
      gpu.connect();
      await ready;
      rec.setImage(IMG_A, 3, 2, straight(3, 2, 7));
      gpu.place({ x: 0, y: 0, w: 1920, h: 720, scale: 1, ox: 0, oy: 0 });
      const r = new rec.Recorder(1600, 520);
      r.image(IMG_A, 1, 2, 3, 4);
      const recorded = Uint32Array.from(r.words());
      gpu.frame(r);
      gpu.close();
      const b = readFileSync(file);
      const msgs: { type: number; payload: Buffer }[] = [];
      for (let i = 0; i + 8 <= b.length; ) {
        const len = b.readUInt32LE(i + 4);
        msgs.push({ type: b.readUInt32LE(i), payload: b.subarray(i + 8, i + 8 + len) });
        i += 8 + len;
      }
      assert.ok(msgs.some((m) => m.type === MSG.TEN && m.payload.readUInt32LE(0) === IMG_A));
      assertTranslated(u32(msgs.find((m) => m.type === MSG.FRAME)!.payload), recorded, 'FRAME (file)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      kit.cleanup();
    }
  });
});

describe('растры приложения в пределах mgu-render/1 и иконка', () => {
  it('каждый растр, который приложение загружает (ресурсы, циферблаты, миниатюры), ≤ 1024 по стороне', async () => {
    const { ASSETS } = await import('../src/assets/spec');
    const { FACE_TEX } = await import('../src/render/dial');
    const { CAMERA_THUMB, TEX_SCALE } = await import('../src/render/layout');
    for (const a of ASSETS) assert.ok(a.w <= 1024 && a.h <= 1024, `${a.key}: ${a.w}×${a.h}`);
    assert.ok(FACE_TEX <= 1024, `циферблат ${FACE_TEX}`);
    assert.ok(Math.round(CAMERA_THUMB.w * TEX_SCALE) <= 1024);
  });

  it('icon.png: выбранный знак (app-icon-terrain.png), уменьшенный до 140 × 140 PNG ≤ 128 KiB, детерминированно; build кладёт его в APP_FILES', async () => {
    const { renderIcon, ICON_FILE, ICON_SIZE, ICON_SOURCE } = await import('../scripts/icon');
    const { APP_FILES } = await import('../scripts/build');
    const { decodePng, resizeArea } = await import('../src/assets/codec');
    const { readFileSync } = await import('node:fs');
    const png = renderIcon();
    assert.equal(ICON_SIZE, 140);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [ICON_SIZE, ICON_SIZE]);
    assert.equal(png[25], 6, 'RGBA');
    assert.ok(png.length <= 128 << 10);
    assert.ok(renderIcon().equals(png), 'одинаковый при повторной сборке');
    assert.ok((APP_FILES as readonly string[]).includes(ICON_FILE));

    // пиксели в файле — ровно resizeArea исходника целиком (без кадрирования и перерисовки)
    const src = decodePng(readFileSync(ICON_SOURCE));
    const got = decodePng(png);
    assert.deepEqual([got.w, got.h], [ICON_SIZE, ICON_SIZE]);
    assert.ok(Buffer.from(got.data).equals(Buffer.from(resizeArea(src, ICON_SIZE, ICON_SIZE).data)), 'icon = resizeArea(source, 140, 140)');

    // и это действительно усреднение по площади: независимый расчёт нескольких пикселей (углы, центр, края)
    const sx = src.w / ICON_SIZE;
    const sy = src.h / ICON_SIZE;
    for (const [x, y] of [[0, 0], [139, 0], [0, 139], [139, 139], [70, 70], [35, 100], [110, 20]]) {
      const acc = [0, 0, 0, 0];
      let area = 0;
      for (let yy = Math.floor(y * sy); yy < Math.ceil((y + 1) * sy); yy++) {
        const wy = Math.min((y + 1) * sy, yy + 1) - Math.max(y * sy, yy);
        for (let xx = Math.floor(x * sx); xx < Math.ceil((x + 1) * sx); xx++) {
          const k = (Math.min((x + 1) * sx, xx + 1) - Math.max(x * sx, xx)) * wy;
          for (let c = 0; c < 4; c++) acc[c] += src.data[(yy * src.w + xx) * 4 + c] * k;
          area += k;
        }
      }
      for (let c = 0; c < 4; c++) {
        const v = got.data[(y * ICON_SIZE + x) * 4 + c];
        assert.ok(Math.abs(v - acc[c] / area) <= 1, `pixel ${x},${y} ch${c}: ${v} vs ${(acc[c] / area).toFixed(2)}`);
      }
    }
  });

  it('icon.png: нет исходника или он битый — понятная ошибка, а не пустая иконка', async () => {
    const { renderIcon } = await import('../scripts/icon');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'xop-icon-'));
    try {
      assert.throws(() => renderIcon(join(dir, 'missing.png')), /icon: source .*missing\.png is unavailable/);
      writeFileSync(join(dir, 'bad.png'), Buffer.from('not a png'));
      assert.throws(() => renderIcon(join(dir, 'bad.png')), /icon: source .*bad\.png is not a usable PNG: png: bad signature/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
