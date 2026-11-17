// Приложение целиком на настоящем вендорном рантайме: display.js Display + renderd.js + record.js +
// gauges.js + sheet.js (как в пакете, kit разложен как build.py --language ru), против фальшивого
// mgu-render 0.6.21 (1920 × 720) на unix-сокете. Касания идут от «рендерера» (TOUCH в логических px,
// пересчитанных из экранных по присланному PLACE) — ни одного cv.own = true из заглушки.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, before, describe, it } from 'node:test';
import { inputNote, startApp, type AppHandle } from '../src/app';
import { buildManifest } from '../src/manifest';
import type { Kit } from '../src/platform/kit';
import type { DisplayApi, MguCtx, Surface } from '../src/platform/kitTypes';
import { drawPageBrand, HEADER_BRAND, STRIPE_COLORS } from '../src/render/brand';
import { selectRenderTarget, type Env } from '../src/renderTarget';
import { DIAG } from '../src/render/diagnostics';
import { T, TAB_LABELS } from '../src/strings';
import { FakeRenderer, MSG, u32, walkOps } from './fakeRenderer';
import { FakeTransport, flush, stageVendorKit, syntheticAssets, THEME } from './helpers';

const SCREEN_W = 1920;
const BACK_COLUMN = 84; // display.js HMI7.left: колонка «Назад»/«Домой» HMI
const STATUS_X = 1340; // display.js HMI7.status.x: угол статуса HMI

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface SettingSpec {
  key: string;
  label: string;
  type: string;
  default: unknown;
  options?: [string, string][];
}
interface Sheet {
  settings?: boolean;
  open: SettingSpec | null;
  rows(): { label: string; value?: string }[];
}
interface Display extends DisplayApi {
  gpu: (DisplayApi['gpu'] & { close(): void; native: boolean; touch: boolean; ready: boolean }) | null;
  place: { x: number; y: number; w: number; h: number; scale: number; ox: number; oy: number; full: boolean } | null;
  sheet: Sheet | null;
  sheetTargets: (Rect & { i?: number })[] | null;
  chromeRec: { tabRects: (Rect & { i: number })[]; words(): Uint32Array } | null;
  headEnd: number;
  headBadges?: boolean;
  keepTimer: NodeJS.Timeout | null;
  onTab: unknown;
  own(): boolean;
  ownable(): boolean;
  buttons(): { id: string }[];
  barH(): number;
  canvas(w: number, h: number): Surface;
  present(name: string, r: Surface, soft: (n: string, c: unknown) => unknown): Promise<unknown>;
  label(id: string, text: string): void;
  hideButton(id: string): void;
  openSheet(sh: Sheet): boolean;
  closeSheet(): void;
}

/** Настройки как mgu.js Settings — только то, что читают display.js и sheet.js. */
class Settings {
  readonly values: Record<string, unknown> = {};
  private readonly fns: ((k: string, v: unknown) => void)[] = [];
  constructor(readonly schema: SettingSpec[]) {
    for (const s of schema) this.values[s.key] = s.default;
  }
  get(k: string) {
    return this.values[k];
  }
  set(k: string, v: unknown) {
    this.values[k] = v;
    this.fns.forEach((f) => f(k, v));
  }
  onChange(fn: (k: string, v: unknown) => void) {
    this.fns.push(fn);
  }
  display(k: string) {
    const s = this.schema.find((x) => x.key === k);
    const o = s && s.options && s.options.find((x) => x[0] === this.values[k]);
    return o ? o[1] : String(this.values[k]);
  }
}

type RecorderCtor = new (w: number, h: number, o?: unknown) => Surface & { words(): Uint32Array };

interface Rig {
  srv: FakeRenderer;
  Recorder: RecorderCtor;
  display: Display;
  app: AppHandle;
  settings: Settings;
  hmiVisible: Record<string, boolean>;
  rows: { label: string; value?: string | (() => string) }[];
  render(): Promise<void>;
  /** Тап по экранной точке (sx, sy): renderer пересчитывает её в логические px по последнему PLACE. */
  tapScreen(sx: number, sy: number): Promise<void>;
  tapLogical(x: number, y: number): Promise<void>;
  lastPlace(): { x: number; y: number; w: number; h: number; scale: number; ox: number; oy: number };
  close(): Promise<void>;
}

const center = (r: Rect) => [r.x + r.w / 2, r.y + r.h / 2] as const;

async function rig(opts: { native: boolean; touch?: boolean }): Promise<Rig> {
  const srv = await FakeRenderer.start({ native: opts.native, touch: opts.touch ?? true, caps: 1 | 8 });
  const saved: Env = { MGU_RENDERD_SOCKET: process.env.MGU_RENDERD_SOCKET, MGU_RENDERD_PROTO: process.env.MGU_RENDERD_PROTO };
  const env: Env = { MGU_RENDERD_SOCKET: srv.path };
  selectRenderTarget(env); // как main.js: диалект не задаётся
  delete process.env.MGU_RENDERD_PROTO;
  process.env.MGU_RENDERD_SOCKET = env.MGU_RENDERD_SOCKET;
  const kit = stageVendorKit();
  const record = kit.req('./record.js') as { setImage: Kit['record']['setImage'] };
  const { Display } = kit.req('./display.js') as { Display: new (...a: unknown[]) => Display };
  const { listSheet } = kit.req('./sheet.js') as { listSheet: (s: Settings, t: null, o: object) => Sheet };
  const G = kit.req('./gauges.js') as Kit['G'];
  const spec = buildManifest() as { id: string; title: string; version: string; screens: { buttons: [string, string][] }[]; settings: SettingSpec[] };

  // Кнопки HMI (RHMI-компоненты): нажатие — событие 'action', как у SDK.
  const comps = new Map<string, EventEmitter>();
  for (const [id] of spec.screens[0].buttons) comps.set(id, new EventEmitter());
  const hmiVisible: Record<string, boolean> = {};
  const ui = {
    onVisible: () => undefined,
    isVisible: (n: string) => n === 'MAIN',
    rhmi: { getByName: (n: string) => comps.get(n) ?? null },
    visible: (id: string, on: boolean) => (hmiVisible[id] = on),
    close: () => Promise.resolve(),
  };
  const settings = new Settings(spec.settings);
  const log = { info: () => undefined, warn: () => undefined, error: (...a: unknown[]) => console.error('[display]', ...a) };
  const display = new Display(ui, log, spec, settings, () => THEME);
  const rows: Rig['rows'] = [];
  // mgu.js wireSettings: BTN_SETTINGS — «Настройки» листом поверх страницы, где kit ведёт экран
  comps.get('BTN_SETTINGS')!.on('action', () => {
    if (display.sheet && display.sheet.settings) return display.closeSheet();
    const sh = listSheet(settings, null, { version: spec.version, extra: () => rows });
    sh.settings = true;
    if (!display.openSheet(sh)) hmiVisible.SETTINGS_SCREEN = true;
  });

  let loopFn: (() => unknown) | null = null;
  const ctx: MguCtx = {
    ui: {
      image: (name, cv) => display.present(name, cv, () => Promise.resolve()),
      text: (id, s) => display.label(id, s),
      onClick: (name, fn) => comps.get(name)?.on('action', fn),
      enabled: () => undefined,
    },
    settings,
    log: { info: () => undefined, warn: () => undefined, error: (...a) => console.error('[app]', ...a) },
    signals: { watch: new FakeTransport().watch },
    theme: () => THEME,
    canvas: (w, h) => display.canvas(w, h),
    loop: (_s, _f, fn) => {
      loopFn = fn;
      return { stop: () => undefined, kick: () => undefined };
    },
    onTab: (fn) => (display.onTab = fn),
    settingsRow: (row) => rows.push(row),
    hideButton: (id) => display.hideButton(id),
    display,
  };
  let t = 1000;
  const app = startApp(ctx, { mgu: { run: () => undefined }, G, record }, syntheticAssets(), () => (t += 50));
  await srv.until(() => !!display.gpu && display.gpu.ready && !!display.place, 'renderer ready + placement');

  const lastPlace = () => {
    const p = srv.of(MSG.PLACE).slice(-1)[0].payload;
    return { x: p.readInt32LE(0), y: p.readInt32LE(4), w: p.readInt32LE(8), h: p.readInt32LE(12), scale: p.readFloatLE(16), ox: p.readFloatLE(20), oy: p.readFloatLE(24) };
  };
  const tapLogical = async (x: number, y: number) => {
    srv.touch(1, x, y);
    srv.touch(3, x, y);
    await new Promise((ok) => setTimeout(ok, 30));
    await flush();
  };
  return {
    srv,
    Recorder: (kit.req('./record.js') as { Recorder: RecorderCtor }).Recorder,
    display,
    app,
    settings,
    hmiVisible,
    rows,
    render: async () => {
      await loopFn!();
      await flush();
    },
    tapScreen: (sx, sy) => {
      const pl = lastPlace();
      // PROTOCOL.md PLACE: device = logical × scale + (ox, oy); x, y — левый верхний угол поверхности
      return tapLogical((sx - pl.x - pl.ox) / pl.scale, (sy - pl.y - pl.oy) / pl.scale);
    },
    tapLogical,
    lastPlace,
    close: async () => {
      display.closeSheet();
      app.dispose();
      if (display.gpu) display.gpu.close();
      if (display.keepTimer) clearInterval(display.keepTimer);
      await srv.close();
      kit.cleanup();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** Операции op из потока слов (полностью, со словом op). */
const opsOf = (u: Uint32Array, op: number) => walkOps(u).filter((o) => o.op === op).map((o) => Array.from(u.subarray(o.at, o.at + o.n)));
/** needle — непрерывная часть haystack. */
function contains(haystack: Uint32Array, needle: readonly number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) if (haystack[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}
const f32 = (w: number) => new Float32Array(new Uint32Array([w]).buffer)[0];

/**
 * Бренд в шапке виден целиком: обе строки («Terrain Monitor», «xDrive Offroad Pro») — по глифу на каждый
 * непробельный символ — и три полосы ice/blue/red стоят в потоке слов words (кадр рендереру или запись шапки)
 * в той же раскладке, что рисует HEADER_BRAND, внутри шапки и левее первой вкладки.
 */
function assertBrandVisible(r: Rig, words: Uint32Array, what: string): void {
  const ref = new r.Recorder(SCREEN_W, 80);
  const bw = HEADER_BRAND.width(ref);
  HEADER_BRAND.draw(ref, BACK_COLUMN, 0, bw, 80, THEME);
  const runs = opsOf(ref.words(), 11);
  assert.equal(runs.length, 2, 'две строки текста');
  assert.deepEqual(runs.map((g) => g[3]), [T.app.title.replace(/ /g, '').length, T.app.subtitle.replace(/ /g, '').length], 'все символы обеих строк');
  assert.equal(T.app.title, 'Terrain Monitor');
  assert.equal(T.app.subtitle, 'xDrive Offroad Pro');
  const firstTab = Math.min(...r.display.chromeRec!.tabRects.map((q) => q.x));
  for (const g of runs) {
    assert.ok(contains(words, g), `${what}: строка бренда (${g[3]} глифов) в кадре`);
    for (let k = 0; k < g[3]; k++) {
      const [x, y, w, h] = [0, 1, 2, 3].map((j) => f32(g[4 + k * 8 + j]));
      assert.ok(x >= BACK_COLUMN && x + w <= firstTab, `${what}: глиф ${k} по x в зоне бренда (${x.toFixed(0)}..${(x + w).toFixed(0)}, вкладки с ${firstTab})`);
      assert.ok(y >= 0 && y + h <= 80, `${what}: глиф ${k} в высоте шапки (${y.toFixed(0)}..${(y + h).toFixed(0)})`);
    }
  }
  const quads = opsOf(ref.words(), 15);
  assert.equal(quads.length, 3, 'три полосы');
  const pack = (c: string) => parseInt(c.slice(1, 7) + 'ff', 16) >>> 0;
  assert.deepEqual(quads.map((q) => q[9]), STRIPE_COLORS.map((c) => pack(String(c))), 'цвета ice / m-blue / m-red');
  for (const q of quads) assert.ok(contains(words, q), `${what}: полоса в кадре`);
}

describe('mgu-render/1 с касанием, 1920 × 720: kit ведёт экран, всё касанием', () => {
  let r: Rig;
  before(async () => {
    r = await rig({ native: true });
    await r.render();
  });
  after(() => r.close());

  it('own: полноэкранная раскладка, НИ ОДНОЙ кнопки панели (высота панели 0), кнопки HMI скрыты', () => {
    const d = r.display;
    assert.equal(d.gpu!.native, true);
    assert.equal(d.own(), true);
    assert.equal(d.place!.full, true);
    assert.deepEqual(d.buttons(), []);
    assert.equal(d.barH(), 0);
    for (const id of ['BTN_PAGE', 'BTN_PREV', 'BTN_ACTION', 'BTN_SESSION', 'BTN_SETTINGS']) assert.equal(r.hmiVisible[id], false, `${id} скрыта в HMI`);
    assert.equal(inputNote(d.own(), d), null);
  });

  it('шапка в кадре рендереру: полосы + «Terrain Monitor» / «xDrive Offroad Pro» целиком, затем 5 вкладок + «Настройки», бейджи — до угла статуса', async () => {
    const d = r.display;
    assert.equal(d.brand, HEADER_BRAND);
    const tabs = d.chromeRec!.tabRects;
    assert.equal(tabs.length, TAB_LABELS.length + 1);
    assert.equal(d.headBadges, true, 'бейджи в шапке');
    assert.ok(d.headEnd <= STATUS_X, `шапка до угла статуса (${d.headEnd})`);
    await r.srv.until(() => r.srv.of(MSG.FRAME).length > 0, 'FRAME');
    assertBrandVisible(r, u32(r.srv.of(MSG.FRAME).slice(-1)[0].payload), 'FRAME');
  });

  it('CLAIM: шапка и страница, но не колонка «Назад/Домой» и не угол статуса HMI', async () => {
    await r.srv.until(() => r.srv.of(MSG.NINE).length > 0, 'CLAIM');
    const c = r.srv.of(MSG.NINE).slice(-1)[0].payload;
    const n = c.readUInt32LE(0);
    assert.ok(n >= 2);
    const pl = r.lastPlace();
    for (let i = 0; i < n; i++) {
      const [x, y, w] = [0, 1, 2].map((k) => c.readFloatLE(4 + i * 16 + k * 4));
      const sx = x * pl.scale + pl.ox + pl.x;
      const sy = y * pl.scale + pl.oy + pl.y;
      const ex = sx + w * pl.scale;
      assert.ok(sx >= BACK_COLUMN - 0.5, `claim ${i} начинается за колонкой «Назад» (${sx})`);
      if (sy < 76) assert.ok(ex <= STATUS_X + 0.5, `claim ${i} в полосе статуса кончается до угла статуса (${ex})`);
    }
  });

  it('растры на экране: IMAGE 10 (≤ 1024), кадры с op 18 в native-раскладке', () => {
    const pics = r.srv.of(MSG.TEN).map((m) => ({ id: m.payload.readUInt32LE(0), w: m.payload.readUInt32LE(4), h: m.payload.readUInt32LE(8) }));
    assert.ok(pics.length >= 3, `растры загружены (${pics.length})`);
    for (const p of pics) assert.ok(p.w <= 1024 && p.h <= 1024, `${p.id}: ${p.w}×${p.h}`);
    const frame = u32(r.srv.of(MSG.FRAME).slice(-1)[0].payload);
    const ids = new Set(pics.map((p) => p.id));
    const ops = walkOps(frame).filter((o) => o.op === 18);
    assert.ok(ops.length >= 3);
    for (const o of ops) assert.ok(ids.has(frame[o.at + 6]), `op 18 рисует загруженный растр (id последним словом: ${frame[o.at + 6]})`);
  });

  it('тап по каждой вкладке (экранные px шапки → PLACE) открывает её страницу; кадр уходит', async () => {
    for (const i of [1, 2, 3, 4, 0]) {
      const tab = r.display.chromeRec!.tabRects.find((q) => q.i === i)!;
      const before = r.srv.of(MSG.FRAME).length;
      const [sx, sy] = center(tab);
      await r.tapScreen(sx, sy);
      assert.equal(r.app.page(), i, `вкладка ${i} (${TAB_LABELS[i]})`);
      await r.render();
      await r.srv.until(() => r.srv.of(MSG.FRAME).length > before, `кадр страницы ${i}`);
    }
  });

  it('«Настройки» — вкладкой: лист настроек; все настройки и действия демо — касанием', async () => {
    const d = r.display;
    const settingsTab = d.chromeRec!.tabRects.find((q) => q.i === TAB_LABELS.length)!;
    await r.tapScreen(...center(settingsTab));
    assert.ok(d.sheet && d.sheet.settings, 'лист «Настройки» открыт');

    const tapRow = async (label: string) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const k = d.sheet!.rows().findIndex((x) => x.label === label);
        assert.ok(k >= 0, `строка «${label}» есть: ${d.sheet!.rows().map((x) => x.label).join(' | ')}`);
        const tgt = (d.sheetTargets || []).find((q) => q.i === k);
        if (tgt) return r.tapLogical(...center(tgt));
        // строка вне видимой части: протянуть список пальцем (вверх — к строкам ниже, вниз — к строкам выше)
        const list = (d.sheetTargets || []).filter((q) => q.i !== undefined);
        const below = k > Math.max(...list.map((q) => q.i!));
        const [x, y] = center(list[below ? list.length - 1 : 0]);
        const dir = below ? -1 : 1;
        r.srv.touch(1, x, y);
        for (let s = 1; s <= 5; s++) r.srv.touch(2, x, y + dir * s * 40);
        r.srv.touch(3, x, y + dir * 200);
        await new Promise((ok) => setTimeout(ok, 60));
      }
      assert.fail(`строка «${label}» не достижима касанием`);
    };

    // пауза демо — строкой «Демо»
    assert.equal(r.app.model.getState().paused, false);
    await tapRow(T.native.rows.demo);
    assert.equal(r.app.model.getState().paused, true, 'пауза касанием');
    await tapRow(T.native.rows.demo);
    assert.equal(r.app.model.getState().paused, false, 'продолжить касанием');

    // новая сессия
    let sessions = 0;
    const orig = r.app.model.newSession.bind(r.app.model);
    r.app.model.newSession = () => (sessions++, orig());
    await tapRow(T.native.rows.newSession);
    assert.equal(sessions, 1, 'новая сессия касанием');

    // выбор: сценарий и основная камера (списки значений — тоже касанием)
    const pick = async (key: string, value: string) => {
      const s = r.settings.schema.find((x) => x.key === key)!;
      await tapRow(s.label);
      assert.equal(d.sheet!.open && d.sheet!.open.key, key, `список «${s.label}» открыт`);
      await tapRow(s.options!.find((o) => o[0] === value)![1]);
      assert.equal(r.settings.get(key), value);
    };
    await pick('scenario', 'hdcDescent');
    assert.equal(r.app.model.getState().scenarioId, 'hdcDescent');
    await pick('primaryCamera', 'left');
    for (const key of ['dataSource', 'layout', 'renderer']) {
      await tapRow(r.settings.schema.find((x) => x.key === key)!.label);
      assert.equal(d.sheet!.open && d.sheet!.open.key, key, `${key}: список значений открывается касанием`);
      const back = d.sheetTargets![0];
      await r.tapLogical(...center(back)); // «Назад» (без выбора)
      assert.equal(d.sheet!.open, null);
    }
    assert.ok(d.sheet!.rows().some((x) => x.label === T.native.rows.input && x.value === T.native.rows.inputTouch), 'строка «Управление: касание»');

    // диагностика чтения: лист внутри настроек касанием (в демо — пояснение), «Назад» — обратно к настройкам
    await tapRow(DIAG.row);
    const child = (d.sheet as unknown as { child: { title: string; lines: { label: string }[] } | null }).child;
    assert.ok(child && child.title === DIAG.title, 'лист диагностики открыт');
    assert.deepEqual(child!.lines.map((l) => l.label), [DIAG.demo]);
    await r.tapLogical(...center(d.sheetTargets![0]));
    assert.equal((d.sheet as unknown as { child: unknown }).child, null, '«Назад» — к настройкам');
    assert.ok(d.sheet && d.sheet.settings);

    // вкладка поверх листа закрывает его и открывает страницу
    const camTab = d.chromeRec!.tabRects.find((q) => q.i === 4)!;
    await r.tapScreen(...center(camTab));
    assert.equal(d.sheet, null);
    assert.equal(r.app.page(), 4);
    await r.render();
  });

  it('ширина шапки: все бейджи режимов (ДЕМО+ПАУЗА, ЧТЕНИЕ…) — 6 вкладок и знак помещаются', async () => {
    const d = r.display;
    const check = async (what: string) => {
      await r.render();
      const tabs = d.chromeRec!.tabRects;
      assert.equal(tabs.length, TAB_LABELS.length + 1, `${what}: все вкладки`);
      assert.equal(d.headBadges, true, `${what}: бейджи остались в шапке`);
      assert.ok(d.headEnd <= STATUS_X, `${what}: до угла статуса`);
      assertBrandVisible(r, d.chromeRec!.words(), what);
    };
    r.app.model.togglePause();
    await check('ДЕМО + ПАУЗА');
    r.app.model.togglePause();
    r.settings.set('dataSource', 'vehicle');
    await check(T.native.badge.vehicleNoData);
    r.settings.set('dataSource', 'demo');
    await check('ДЕМО');
  });
});

describe('запасной путь: рендерер без mgu-render/1 (только READY)', () => {
  let r: Rig;
  before(async () => {
    r = await rig({ native: false });
    await r.render();
  });
  after(() => r.close());

  it('kit не ведёт экран: панель HMI (5 кнопок) остаётся, статус объясняет, почему касания нет', () => {
    const d = r.display;
    assert.equal(d.gpu!.native, false);
    assert.equal(d.own(), false);
    assert.equal(d.buttons().length, 5, 'листание, пауза, сброс, настройки — кнопками HMI');
    assert.equal(inputNote(d.own(), d), T.native.input.upstream);
  });

  it('шапка полноэкранной раскладки и здесь с брендом целиком и всеми вкладками', async () => {
    await r.srv.until(() => r.srv.of(MSG.FRAME).length > 0, 'FRAME');
    assert.equal(r.display.chromeRec!.tabRects.length, TAB_LABELS.length);
    assertBrandVisible(r, u32(r.srv.of(MSG.FRAME).slice(-1)[0].payload), 'upstream FRAME');
  });

  it('растры всё равно на экране: upstream IMAGE 9', async () => {
    await r.srv.until(() => r.srv.of(MSG.FRAME).length > 0, 'FRAME');
    assert.ok(r.srv.of(MSG.NINE).length >= 3);
    assert.equal(r.srv.of(MSG.TEN).length, 0);
  });
});

describe('inputNote: без рендерера / без касаний / стандартная раскладка', () => {
  it('объясняет каждую причину и никогда не обещает касание без own', () => {
    const s = T.native.input;
    assert.equal(inputNote(false, undefined), s.software);
    assert.equal(inputNote(false, { gpu: null }), s.software);
    assert.equal(inputNote(false, { gpu: { ready: false } }), s.waiting);
    assert.equal(inputNote(false, { gpu: { ready: true, native: false, touch: true } }), s.upstream);
    assert.equal(inputNote(false, { gpu: { ready: true, native: true, touch: false } }), s.noTouch);
    assert.equal(inputNote(false, { gpu: { ready: true, native: true, touch: true }, layout: () => 'standard' }), s.standard);
    assert.equal(inputNote(true, undefined), null);
  });
});

describe('программный путь / стандартная раскладка: бренд в полосе вкладок страницы', () => {
  it('G.frame без chrome (настоящий gauges.js): полосы и обе строки целиком между вкладками и бейджами', () => {
    const kit = stageVendorKit();
    try {
      const { Recorder } = kit.req('./record.js') as { Recorder: RecorderCtor };
      const G = kit.req('./gauges.js') as Kit['G'];
      for (const badges of [[{ text: T.native.badge.demo }, { text: T.native.badge.paused }], [{ text: T.native.badge.vehicleNoData }]]) {
        const cv = new Recorder(1600, 520);
        G.frame(cv, THEME, TAB_LABELS, 0, badges);
        const before = cv.words().length;
        const x = drawPageBrand(cv, cv.tabRects, badges, 1600);
        assert.ok(x !== null, 'место есть');
        const tabsEnd = Math.max(...cv.tabRects!.map((q) => q.x + q.w));
        assert.ok(x! > tabsEnd, `бренд правее вкладок (${x} > ${tabsEnd})`);
        const added = cv.words().subarray(before);
        const runs = opsOf(added, 11);
        assert.deepEqual(runs.map((g) => g[3]), [T.app.title.replace(/ /g, '').length, T.app.subtitle.replace(/ /g, '').length]);
        for (const g of runs) for (let k = 0; k < g[3]; k++) {
          const [gx, gy, gw, gh] = [0, 1, 2, 3].map((j) => f32(g[4 + k * 8 + j]));
          assert.ok(gy >= 0 && gy + gh <= 36 && gx + gw <= 1600 - 16, `глиф в полосе вкладок (${gx}, ${gy})`);
        }
        assert.equal(opsOf(added, 15).length, 3, 'три полосы');
      }
    } finally {
      kit.cleanup();
    }
  });
});
