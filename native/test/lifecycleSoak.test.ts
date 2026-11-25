// Серия переключений на настоящем вендорном рантайме (display.js + renderd.js + record.js + gauges.js + sheet.js)
// против фальшивого mgu-render (1920 × 720, касание, контроллер, front gate, pixmaps, видео):
// все вкладки касанием и контроллером, лист поддержки (вход/выход), выбор/увеличение каждой камеры, потеря и возврат
// фокуса HMI (всплывающее окно), уход с экрана и возврат, STATE(false) → STATE(true), обрыв и переподключение рендерера.
// После каждого шага и паузы проверяется одно и то же: рендерер показывает полноэкранную поверхность (не уменьшенную
// картинку HMI), последний кадр отправлен для текущего подключения и размещения и содержит текущую вкладку, нет
// ожидающего кадра, на «Камерах» — видеослои в своих прямоугольниках с сохранением пропорций.
//
// UI-заглушка повторяет состояние mgu.js UI (_setVisible, _setFocus, hasFocus, onFocus), ctx.loop — цикл mgu.js
// (тик рендерера, 250/16 мс страховка, программный путь по fps). Кадры камер — заголовки MGVF с растущим seq.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startApp, type AppHandle } from '../src/app';
import { PRODUCTION, type DevAccess } from '../src/devAccess';
import { buildManifest } from '../src/manifest';
import type { Kit } from '../src/platform/kit';
import type { DisplayApi, MguCtx, Surface } from '../src/platform/kitTypes';
import { selectRenderTarget, type Env } from '../src/renderTarget';
import { encodeMgvf, videoPath } from '../src/camera/mgvf';
import { encodeLine } from '../src/camera/ctl';
import type { FeedDeps } from '../src/camera/feeds';
import { VIDEO_ID } from '../src/camera/feeds';
import { FakeRenderer, MSG, u32, walkOps } from './fakeRenderer';
import { FakeTransport, flush, stageVendorKit, syntheticAssets, THEME } from './helpers';

const X_STATE = 0x4d520102;
const X_CCU = 0x4d520103;
const VIDEO_MSG = 13;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

interface Rect { x: number; y: number; w: number; h: number }
interface SettingSpec { key: string; default: unknown; options?: [string, string][] }

/** Состояние экрана HMI как в mgu.js UI. */
class HmiUi {
  readonly visibleMap: Record<string, boolean> = {};
  readonly focusMap: Record<string, boolean> = {};
  private readonly visHandlers: ((n: string, v: boolean) => void)[] = [];
  private readonly focusHandlers: ((n: string, v: boolean) => void)[] = [];
  readonly comps = new Map<string, { on(ev: string, fn: (e?: unknown) => void): void; emit(ev: string, e?: unknown): void }>();
  readonly hmiVisible: Record<string, boolean> = {};
  closes = 0;
  isVisible = (n: string) => !!this.visibleMap[n];
  hasFocus = (n: string) => this.focusMap[n] !== false;
  onFocus = (fn: (n: string, v: boolean) => void) => void this.focusHandlers.push(fn);
  onVisible = (fn: (n: string, v: boolean) => void) => void this.visHandlers.push(fn);
  _invalidate = () => undefined;
  _setFocus = (n: string, on: boolean) => {
    if (this.hasFocus(n) === on) return;
    this.focusMap[n] = on;
    this.focusHandlers.forEach((fn) => fn(n, on));
  };
  _setVisible = (n: string, on: boolean) => {
    if (!!this.visibleMap[n] === on) return;
    this.visibleMap[n] = on;
    if (on) this.focusMap[n] = true;
    this.visHandlers.forEach((fn) => fn(n, on));
  };
  rhmi = { getByName: (n: string) => this.comps.get(n) ?? null };
  visible = (id: string, on: boolean) => void (this.hmiVisible[id] = on);
  close = () => { this.closes++; return Promise.resolve(); };
}

type DisplayLike = DisplayApi & {
  gpu: (NonNullable<DisplayApi['gpu']> & { ready: boolean; visible: boolean; native: boolean; waiting: boolean; close(): void }) | null;
  place: { full: boolean; scale: number; ox: number; oy: number; w: number; h: number; x: number; y: number } | null;
  blocked: boolean;
  sheet: object | null;
  pendingFrame: unknown;
  last: { gpu: unknown; placement: unknown; tabs: { sel: number } | null; frame: { words(): Uint32Array } } | null;
  chromeRec: { tabRects: (Rect & { i: number })[] } | null;
  pageTargets: (Rect & { key: string })[] | null;
  keepTimer: NodeJS.Timeout | null;
  sheetTimer: NodeJS.Timeout | null;
  frontTimer: NodeJS.Timeout | null;
  frontRecovery: NodeJS.Timeout | null;
  showTimer: NodeJS.Timeout | null;
  own(): boolean;
  active(): boolean;
  canvas(w: number, h: number): Surface;
  present(name: string, r: Surface, soft: (n: string, c: unknown) => unknown): Promise<unknown>;
  label(id: string, s: string): void;
  openSheet(sh: object): boolean;
  closeSheet(): void;
  onTick(fn: () => void): void;
  _gpuCompatible(l: unknown): boolean;
};

/** Мост камер: сразу подключён, отдаёт три вида; заголовки кадров с растущим seq (кадры идут). */
function liveFeeds(now: () => number): FeedDeps & { stop(): void } {
  let seq = 1;
  let stopped = false;
  return {
    connect(_path, on) {
      setImmediate(() => {
        on.connect();
        on.data(encodeLine({ ev: 'state', state: 'running', producer: 'camrx', views: ['front', 'left', 'right'], reason: '', frames: 10, accept: [1], request: 0 } as never) as string);
      });
      return { write: () => undefined, end: () => undefined };
    },
    readHeader(path) {
      if (stopped || !/mgu-video-xop-(front|left|right)$/.test(path)) return null;
      const bytes = encodeMgvf({ w: 1280, h: 480, seq: seq++, slot: 0, nslot: 3, matrix: 0, range: 1 });
      return { bytes, uid: 0, isFile: true, size: 64 + 3 * 1280 * 480 * 1.5 };
    },
    now,
    setTimer(fn, ms) {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    },
    stop: () => void (stopped = true),
  };
}

interface Soak {
  srv: FakeRenderer;
  ui: HmiUi;
  d: DisplayLike;
  app: AppHandle;
  errors: string[];
  logs: string[];
  softImages: unknown[];
  close(): Promise<void>;
}

async function soakRig(dev: DevAccess = PRODUCTION, screen = { w: 1920, h: 720 }): Promise<Soak> {
  const srv = await FakeRenderer.start({ native: true, autoTick: true, touch: true, caps: 1 | 2 | 4 | 8 | 16, screen });
  const saved: Env = { MGU_RENDERD_SOCKET: process.env.MGU_RENDERD_SOCKET, MGU_RENDERD_PROTO: process.env.MGU_RENDERD_PROTO };
  selectRenderTarget({ MGU_RENDERD_SOCKET: srv.path });
  delete process.env.MGU_RENDERD_PROTO;
  process.env.MGU_RENDERD_SOCKET = srv.path;
  const kit = stageVendorKit();
  const record = kit.req('./record.js') as { setImage: Kit['record']['setImage'] };
  const { Display } = kit.req('./display.js') as { Display: new (...a: unknown[]) => DisplayLike };
  const G = kit.req('./gauges.js') as Kit['G'];
  const spec = buildManifest() as { screens: { name: string; buttons: [string, string][] }[]; settings: SettingSpec[] };
  const { EventEmitter } = await import('node:events');
  const ui = new HmiUi();
  for (const [id] of spec.screens[0].buttons) ui.comps.set(id, new EventEmitter() as never);
  const values: Record<string, unknown> = {};
  for (const s of spec.settings) values[s.key] = s.default;
  const fns: ((k: string, v: unknown) => void)[] = [];
  const settings = { get: (k: string) => values[k], set: (k: string, v: unknown) => { values[k] = v; fns.forEach((f) => f(k, v)); }, onChange: (f: (k: string, v: unknown) => void) => void fns.push(f) };
  const errors: string[] = [];
  const logs: string[] = [];
  const log = { info: (s: string) => logs.push(String(s)), warn: (s: string) => logs.push('W ' + String(s)), error: (...a: unknown[]) => errors.push(a.map(String).join(' ')), debug: () => undefined };
  // Экран открыт: как mgu.js по applicationStackChanged
  ui._setVisible('MAIN', true);
  const display = new Display(ui, log, spec, settings, () => THEME);
  const softImages: unknown[] = [];
  /** ctx.loop — как mgu.js loop(): тик рендерера, страховка 250/16 мс, иначе fps. */
  const loop: MguCtx['loop'] = (stateName, fps, fn) => {
    let timer: NodeJS.Timeout | null = null, on = false, running = false, stopped = false;
    const gpuOn = () => display.active();
    const tick = async () => {
      timer = null;
      if (!on || running || stopped) return;
      running = true;
      try { await fn(); } catch (e) { errors.push('loop ' + String(e)); }
      running = false;
      schedule();
    };
    const schedule = () => {
      if (!on || timer !== null || running || stopped) return;
      if (gpuOn()) timer = setTimeout(tick, display.gpu!.waiting ? 250 : 16);
      else timer = setTimeout(tick, Math.max(15, 1000 / fps));
    };
    display.onTick(() => {
      if (!on || running || stopped) return;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (gpuOn()) void tick(); else schedule();
    });
    const set = (v: boolean) => {
      on = v;
      if (on && timer === null && !running) timer = setTimeout(tick, 0);
      if (!on && timer !== null) { clearTimeout(timer); timer = null; }
    };
    ui.onVisible((n, v) => { if (n === stateName) set(v); });
    if (ui.isVisible(stateName)) set(true);
    return { stop: () => { stopped = true; set(false); }, kick: () => { if (on && !running) { if (timer !== null) clearTimeout(timer); timer = setTimeout(tick, 0); } } };
  };
  const ctx: MguCtx = {
    ui: {
      image: (name, cv) => display.present(name, cv, (_n: string, c: unknown) => (softImages.push(c), Promise.resolve())),
      text: (id, s) => display.label(id, s),
      onClick: (name, fn) => ui.comps.get(name)?.on('action', fn as never),
      enabled: () => undefined,
      isVisible: ui.isVisible,
      onVisible: ui.onVisible,
    } as MguCtx['ui'],
    settings,
    log,
    signals: { watch: new FakeTransport().watch },
    theme: () => THEME,
    canvas: (w, h) => display.canvas(w, h),
    loop,
    onTab: (fn) => ((display as unknown as { onTab: unknown }).onTab = fn),
    sheet: (sh) => display.openSheet(sh),
    display: display as unknown as DisplayApi,
  };
  const feeds = liveFeeds(Date.now);
  const app = startApp(ctx, { mgu: { run: () => undefined }, G, record }, syntheticAssets(), Date.now, dev, { feeds, api: null });
  await srv.until(() => !!display.gpu && display.gpu.ready && !!display.place, 'renderer ready');
  return {
    srv, ui, d: display, app, errors, logs, softImages,
    close: async () => {
      feeds.stop();
      display.closeSheet();
      await app.dispose();
      if (display.gpu) display.gpu.close();
      for (const t of [display.keepTimer, display.sheetTimer]) if (t) clearInterval(t);
      for (const t of [display.frontTimer, display.frontRecovery, display.showTimer]) if (t) clearTimeout(t);
      await srv.close();
      kit.cleanup();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** Логическая точка → TOUCH рендерера (он шлёт логические px). */
async function tap(s: Soak, x: number, y: number): Promise<void> {
  s.srv.touch(1, x, y);
  s.srv.touch(3, x, y);
  await sleep(40);
  await flush();
}
async function tapTab(s: Soak, i: number): Promise<void> {
  const pl = s.d.place!;
  const r = s.d.chromeRec!.tabRects.find((q) => q.i === i)!;
  await tap(s, (r.x + r.w / 2 - pl.ox) / pl.scale, (r.y + r.h / 2 - pl.oy) / pl.scale);
}
let knob = 1000;
let ccuSeq = 0;
function ccu(s: Soak, turn: number, press = false): void {
  const send = (pb: number) => {
    const b = Buffer.alloc(8);
    b[0] = ++ccuSeq & 0xff;
    b.writeUInt16BE(knob & 0xffff, 1);
    b[3] = pb;
    b[4] = 0;
    s.srv.send(X_CCU, b);
  };
  knob += turn;
  send(0);
  if (press) { send(1); send(0); }
}
function rendererState(s: Soak, onScreen: boolean, front: boolean): void {
  const p = Buffer.alloc(12);
  p.writeUInt32LE(1, 0);
  p.writeUInt32LE(onScreen ? 1 : 0, 4);
  p.writeUInt32LE(front ? 1 : 0, 8);
  s.srv.send(X_STATE, p);
}

/** Видео-операции (op 19) последнего кадра: id и прямоугольник в логических px. */
function videoOps(words: Uint32Array): { id: number; x: number; y: number; w: number; h: number }[] {
  const f = (w: number) => new Float32Array(new Uint32Array([w]).buffer)[0];
  // op 19: x y w h r id
  return walkOps(words).filter((o) => o.op === 19).map((o) => ({ id: words[o.at + 6], x: f(words[o.at + 1]), y: f(words[o.at + 2]), w: f(words[o.at + 3]), h: f(words[o.at + 4]) }));
}

/** Инвариант «полноэкранный интерфейс на месте» после шага и паузы. */
async function settled(s: Soak, what: string, expectPage: number): Promise<void> {
  await sleep(700);
  await flush();
  const d = s.d;
  const g = d.gpu!;
  assert.ok(g.ready, `${what}: рендерер подключён`);
  assert.equal(d.blocked, false, `${what}: не уступил HMI`);
  assert.ok(d.place && d.place.full, `${what}: полноэкранное размещение`);
  assert.ok(d.own(), `${what}: kit ведёт экран`);
  assert.equal(g.visible, true, `${what}: поверхность показана (SHOW 1)`);
  assert.equal(s.app.page(), expectPage, `${what}: страница`);
  const conn = s.srv.conns.length - 1;
  const shows = s.srv.of(MSG.SHOW, conn);
  assert.ok(shows.length && shows[shows.length - 1].payload.readUInt32LE(0) === 1, `${what}: последний SHOW на текущем соединении — 1`);
  assert.ok(d.last && d._gpuCompatible(d.last), `${what}: последний кадр записан для текущего подключения и размещения`);
  assert.equal(d.last!.tabs?.sel, expectPage, `${what}: в кадре выбрана текущая вкладка`);
  assert.equal(d.pendingFrame, null, `${what}: нет зависшего ожидающего кадра`);
  const frames = s.srv.of(MSG.FRAME, conn);
  assert.ok(frames.length > 0, `${what}: кадры на текущем соединении`);
  // свежесть: кадр уходит хотя бы раз в секунду (сторож рендерера скрывает молчащее приложение через 3 с)
  const before = s.srv.of(MSG.FRAME, conn).length;
  await s.srv.until(() => s.srv.of(MSG.FRAME, conn).length > before, `${what}: следующий кадр`, 1500);
  assert.deepEqual(s.errors, [], `${what}: без ошибок`);
}

/** На «Камерах»: видеослои текущего вида — внутри области страницы, по одному на вид, видео зарегистрировано. */
function assertCameraVideos(s: Soak, what: string, expanded: boolean, selected: 'front' | 'left' | 'right'): void {
  const conn = s.srv.conns.length - 1;
  const last = u32(s.srv.of(MSG.FRAME, conn).slice(-1)[0].payload);
  const vids = videoOps(last);
  const ids = vids.map((v) => v.id).sort();
  if (expanded) assert.deepEqual(ids, [VIDEO_ID[selected]], `${what}: развёрнут один вид`);
  else assert.deepEqual(ids, [1, 2, 3], `${what}: три вида`);
  const reg = s.srv.of(VIDEO_MSG, conn).map((m) => m.payload.subarray(4).toString('utf8').replace(/\0+$/, ''));
  for (const v of vids) {
    assert.ok(reg.length > 0, `${what}: VIDEO зарегистрировано на этом соединении`);
    assert.ok(v.w > 50 && v.h > 50, `${what}: прямоугольник видео ${v.id} не пустой`);
    // в логических px страницы 1600 × (520 + extra)
    assert.ok(v.x >= 0 && v.x + v.w <= 1600 + 0.5, `${what}: видео ${v.id} по ширине внутри страницы`);
    assert.ok(v.y >= 0, `${what}: видео ${v.id} ниже шапки`);
  }
  const main = vids.find((v) => v.id === VIDEO_ID[selected])!;
  for (const v of vids) if (v !== main) assert.ok(v.w * v.h < main.w * main.h, `${what}: выбранный вид крупнее`);
  assert.ok(reg.includes(videoPath(selected)), `${what}: путь выбранного вида зарегистрирован`);
}

/**
 * Страховка mgu-render (0.6.20+, у владельца 0.6.21; README: «An app whose picture stays as it was through 4 touches or
 * controller turns in a row gets neither for 10 s (a layer app is taken off meanwhile)»). Повтор по исходнику
 * robertnisipeanu/mgu-store@37702a8 native/mgu-render/src/main.c note_input/answered: касание (фаза 1) в зонах
 * приложения и движение контроллера (не чаще раза в 300 мс) — ввод; кадр с другими словами — ответ; с
 * зарегистрированным видео не считается. 4 ввода без ответа за 10 с — слой снят на 10 с.
 */
class DeafMonitor {
  private unanswered = 0;
  private since = 0;
  private hash = '';
  private ccuAt = -Infinity;
  private lastFrame = '';
  private videos = new Set<number>();
  private conn = -1;
  deafEvents: string[] = [];
  constructor(srv: FakeRenderer) {
    srv.listeners.push((m) => {
      if (m.conn !== this.conn) { this.conn = m.conn; this.unanswered = 0; this.videos.clear(); this.lastFrame = ''; }
      if (m.type === MSG.FRAME) {
        this.lastFrame = m.payload.toString('base64');
        if (this.unanswered && this.lastFrame !== this.hash) this.unanswered = 0;
      }
      if (m.type === VIDEO_MSG) this.videos.add(m.payload.readUInt32LE(0));
      if (m.type === 14) this.videos.delete(m.payload.readUInt32LE(0));
    });
  }
  input(what: string, ccu = false): void {
    const t = Date.now();
    if (ccu) { if (t - this.ccuAt < 300) return; this.ccuAt = t; }
    if (this.videos.size) return;
    if (!this.unanswered || t - this.since > 10000) { this.unanswered = 0; this.since = t; this.hash = this.lastFrame; }
    if (++this.unanswered < 4) return;
    this.unanswered = 0;
    this.deafEvents.push(what);
  }
}

describe('ввод всегда даёт видимый ответ: mgu-render не снимает слой «как зависшее приложение»', () => {
  let s: Soak;
  let mon: DeafMonitor;
  before(async () => {
    s = await soakRig({ ...PRODUCTION });
    mon = new DeafMonitor(s.srv);
  });
  after(() => s.close());

  const tapCounted = async (x: number, y: number, what: string) => {
    mon.input(what);
    await tap(s, x, y);
    await sleep(120);
  };

  it('касания панелей без кнопок (данных нет — картинка неподвижна)', async () => {
    await settled(s, 'запуск', 0);
    for (const [x, y] of [[200, 200], [800, 300], [1400, 200], [600, 450], [200, 200], [210, 205]]) await tapCounted(x, y, `касание ${x},${y}`);
    assert.deepEqual(mon.deafEvents, [], 'нет четырёх касаний подряд без изменения картинки');
  });

  it('повторные касания уже открытой вкладки', async () => {
    const pl = s.d.place!;
    const r = s.d.chromeRec!.tabRects.find((q) => q.i === 0)!;
    for (let k = 0; k < 4; k++) await tapCounted((r.x + r.w / 2 - pl.ox) / pl.scale, (r.y + r.h / 2 - pl.oy) / pl.scale, `вкладка 0 снова (${k})`);
    assert.deepEqual(mon.deafEvents, []);
    await sleep(3200); // лист поддержки не открыт (это только «Системы»/«Камеры»): окно 3 с истекло
  });

  it('контроллер: поворот на выбранную вкладку, упор в конец ряда, нажатие на открытую вкладку', async () => {
    const turn = async (d: number, press = false, what = '') => {
      mon.input(what || `поворот ${d}`, true);
      ccu(s, d, press);
      await sleep(350);
    };
    await turn(1, false, 'первый поворот'); // ложится на выбранную вкладку
    for (let k = 0; k < 4; k++) await turn(-1, false, `упор влево ${k}`); // левее первой вкладки ничего нет
    for (let k = 0; k < 3; k++) await turn(0, true, `нажатие на открытую ${k}`);
    assert.deepEqual(mon.deafEvents, []);
    assert.ok(s.d.own() && s.d.gpu!.visible, 'интерфейс на месте');
  });
});

describe('рендерер сам снимает слой (covered / yield / deaf): без переподключений, затем полная поверхность', () => {
  let s: Soak;
  let mon: DeafMonitor;
  before(async () => {
    s = await soakRig({ ...PRODUCTION });
    mon = new DeafMonitor(s.srv);
  });
  after(() => s.close());

  /** Слой снят рендерером: STATE(0, 1), кадры не подтверждаются (нет TICK), ms; затем STATE(1, 1) и тики снова. */
  const offScreen = async (ms: number, popup: boolean) => {
    s.srv.opts.autoTick = false;
    rendererState(s, false, true);
    if (popup) s.ui._setFocus('MAIN', false);
    await sleep(ms);
    if (popup) s.ui._setFocus('MAIN', true);
    rendererState(s, true, true);
    s.srv.opts.autoTick = true;
    s.srv.send(MSG.TICK, Buffer.alloc(8));
  };

  it('пять касаний открытой «Системы» открывают лист поддержки: ни одно касание не остаётся без ответа', async () => {
    await settled(s, 'запуск', 0);
    await tapTab(s, 3);
    await settled(s, 'системы', 3);
    await sleep(3100); // окно жеста после перехода истекло
    for (let k = 0; k < 5; k++) {
      mon.input(`жест ${k}`);
      await tapTab(s, 3);
      await sleep(80);
    }
    assert.deepEqual(mon.deafEvents, [], 'mgu-render не перевёл бы ввод в HMI');
    assert.ok(s.d.sheet, 'лист поддержки открыт пятым касанием');
    s.d.closeSheet();
    await settled(s, 'лист закрыт', 3);
  });

  it('всплывающее окно HMI (covered): рендерер снял слой на 2,5 с — переподключений нет, затем полная поверхность', async () => {
    const conns = s.srv.conns.length;
    await offScreen(2500, true);
    await settled(s, 'после всплывающего окна', 3);
    assert.equal(s.srv.conns.length, conns, 'переподключений нет');
  });

  it('камера HMI (yield) или 10 с «глухоты» (deaf): слой снят 7 с — дольше прежнего порога переподключения 6 с', async () => {
    for (const page of [0, 4]) {
      await tapTab(s, page);
      await settled(s, `вкладка ${page}`, page);
      const conns = s.srv.conns.length;
      const soft = s.softImages.length;
      await offScreen(7000, false);
      await settled(s, `слой вернулся на ${page}`, page);
      assert.equal(s.srv.conns.length, conns, `${page}: переподключений нет (0.1.7 переподключался через 6 с)`);
      assert.ok(s.softImages.length - soft <= 2, `${page}: в HMI не более одной картинки (+ фон после возврата): ${s.softImages.length - soft}`);
      if (page === 4) assertCameraVideos(s, 'камеры после возврата слоя', false, 'front');
    }
  });
});

describe('полноэкранная раскладка: все вкладки на одном месте', () => {
  let s: Soak;
  before(async () => {
    s = await soakRig({ ...PRODUCTION });
  });
  after(() => s.close());

  it('PLACE (смещение страницы) не меняется при переходах между вкладками', async () => {
    await settled(s, 'запуск', 0);
    const oys: number[] = [];
    for (const i of [0, 1, 2, 3, 4, 0, 4]) {
      await tapTab(s, i);
      await settled(s, `вкладка ${i}`, i);
      oys.push(s.d.place!.oy);
    }
    assert.equal(new Set(oys).size, 1, `смещение страницы одинаково на всех вкладках: ${oys.join(', ')}`);
  });
});

describe('серия переключений: интерфейс не пропадает и не уменьшается', () => {
  let s: Soak;
  before(async () => {
    s = await soakRig({ ...PRODUCTION });
  });
  after(() => s.close());

  it('все вкладки касанием, затем контроллером', async () => {
    await settled(s, 'запуск', 0);
    for (const i of [1, 2, 3, 4, 0, 4, 2, 3, 1, 0]) {
      await tapTab(s, i);
      await settled(s, `вкладка ${i} касанием`, i);
    }
    // контроллер: первый поворот — на текущую вкладку, дальше по одной, нажатие открывает
    ccu(s, 1);
    await sleep(30);
    for (let i = 1; i <= 4; i++) {
      ccu(s, 1, true);
      await settled(s, `вкладка ${i} контроллером`, i);
    }
  });

  it('камеры: выбор каждой касанием, увеличение и возврат; контроллером', async () => {
    await tapTab(s, 4);
    await settled(s, 'камеры', 4);
    assertCameraVideos(s, 'три окна', false, 'front');
    for (const id of ['left', 'right', 'front'] as const) {
      const t = s.d.pageTargets!.find((q) => q.key === `camera:${id}`)!;
      assert.ok(t, `цель камеры ${id}`);
      await tap(s, t.x + t.w / 2, t.y + t.h / 2);
      await settled(s, `выбрана ${id}`, 4);
      assertCameraVideos(s, `выбрана ${id}`, false, id);
      const main = s.d.pageTargets!.find((q) => q.key === `camera:${id}`)!;
      await tap(s, main.x + main.w / 2, main.y + main.h / 2);
      await settled(s, `развёрнута ${id}`, 4);
      assertCameraVideos(s, `развёрнута ${id}`, true, id);
      const back = s.d.pageTargets!.find((q) => q.key === `camera:${id}`)!;
      await tap(s, back.x + back.w / 2, back.y + back.h / 2);
      await settled(s, `возврат к трём (${id})`, 4);
      assertCameraVideos(s, `возврат к трём (${id})`, false, id);
    }
    // контроллер: вкладки → цели страницы; нажатие на большом окне разворачивает
    const ring = () => (s.d as unknown as { focusKey: string | null }).focusKey;
    for (let k = 0; k < 12 && ring() !== 'tgt:camera:front'; k++) { ccu(s, 1); await sleep(20); }
    assert.equal(ring(), 'tgt:camera:front', 'контроллер дошёл до большого окна');
    ccu(s, 0, true);
    await settled(s, 'развёрнута контроллером', 4);
    assertCameraVideos(s, 'развёрнута контроллером', true, 'front');
    ccu(s, 0, true);
    await settled(s, 'свёрнута контроллером', 4);
    assertCameraVideos(s, 'свёрнута контроллером', false, 'front');
  });

  it('всплывающее окно HMI (фокус) на каждой вкладке и возврат', async () => {
    for (const i of [0, 3, 4, 1]) {
      await tapTab(s, i);
      await settled(s, `вкладка ${i}`, i);
      s.ui._setFocus('MAIN', false);
      await sleep(400);
      assert.equal(s.d.gpu!.visible, false, 'под всплывающим окном поверхность скрыта');
      s.ui._setFocus('MAIN', true);
      await settled(s, `фокус вернулся на вкладке ${i}`, i);
    }
  });

  it('уход с экрана (Домой) и возврат; камеры не держат видео в фоне', async () => {
    await tapTab(s, 4);
    await settled(s, 'камеры', 4);
    s.ui._setVisible('MAIN', false);
    await sleep(500);
    assert.equal(s.d.gpu!.visible, false);
    s.ui._setVisible('MAIN', true);
    await settled(s, 'возврат на камеры', 4);
    assertCameraVideos(s, 'возврат на камеры', false, 'front');
  });

  it('лист поддержки: вход и выход на «Системах» и «Камерах», затем любая вкладка', async () => {
    for (const page of [3, 4]) {
      await tapTab(s, page);
      await settled(s, `вкладка ${page}`, page);
      for (let k = 0; k < 5; k++) await tapTab(s, page);
      assert.ok(s.d.sheet, 'лист открыт');
      await sleep(300);
      assert.equal(s.d.gpu!.visible, true, 'лист на полноэкранной поверхности');
      await tapTab(s, page === 3 ? 0 : 2);
      assert.equal(s.d.sheet, null, 'вкладка закрыла лист');
      await settled(s, `после листа на ${page}`, page === 3 ? 0 : 2);
    }
    // лист открыт, всплывающее окно HMI: лист закрывается, страница возвращается
    await tapTab(s, 3);
    for (let k = 0; k < 5; k++) await tapTab(s, 3);
    assert.ok(s.d.sheet);
    s.ui._setFocus('MAIN', false);
    await sleep(300);
    s.ui._setFocus('MAIN', true);
    await settled(s, 'лист + всплывающее окно', 3);
    if (s.d.sheet) s.d.closeSheet();
    await settled(s, 'лист закрыт', 3);
  });

  it('рендерер: STATE(false) кратко, затем снова в фокусе — интерфейс не уменьшается', async () => {
    for (const i of [0, 4]) {
      await tapTab(s, i);
      await settled(s, `вкладка ${i}`, i);
      rendererState(s, false, false);
      await sleep(300);
      rendererState(s, true, true);
      await settled(s, `короткий STATE(false) на ${i}`, i);
    }
  });

  it('рендерер перезапущен на каждой вкладке, в развёрнутой камере и с листом', async () => {
    for (const i of [0, 1, 2, 3, 4]) {
      await tapTab(s, i);
      await settled(s, `вкладка ${i}`, i);
      const conns = s.srv.conns.length;
      s.srv.drop();
      await s.srv.until(() => s.srv.conns.length > conns && !!s.d.gpu!.ready, 'переподключение', 6000);
      await settled(s, `переподключение на ${i}`, i);
      if (i === 4) assertCameraVideos(s, 'камеры после переподключения', false, 'front');
    }
    const main = s.d.pageTargets!.find((q) => q.key === 'camera:front')!;
    await tap(s, main.x + main.w / 2, main.y + main.h / 2);
    await settled(s, 'развёрнута', 4);
    const conns = s.srv.conns.length;
    s.srv.drop();
    await s.srv.until(() => s.srv.conns.length > conns && !!s.d.gpu!.ready, 'переподключение', 6000);
    await settled(s, 'переподключение в развёрнутой камере', 4);
    assertCameraVideos(s, 'развёрнутая после переподключения', true, 'front');
    // лист поддержки открыт во время переподключения
    await tapTab(s, 3);
    for (let k = 0; k < 5; k++) await tapTab(s, 3);
    assert.ok(s.d.sheet);
    const c2 = s.srv.conns.length;
    s.srv.drop();
    await s.srv.until(() => s.srv.conns.length > c2 && !!s.d.gpu!.ready, 'переподключение', 6000);
    await sleep(500);
    assert.equal(s.d.gpu!.visible, true, 'лист снова на поверхности');
    await tapTab(s, 1);
    await settled(s, 'вкладка после листа и переподключения', 1);
  });
});
