// Приложение целиком на настоящем вендорном рантайме: display.js Display + renderd.js + record.js +
// gauges.js + sheet.js (как в пакете, kit разложен как build.py --language ru), против фальшивого
// mgu-render 0.6.21 (1920 × 720) на unix-сокете. Касания идут от «рендерера» (TOUCH в логических px,
// пересчитанных из экранных по присланному PLACE) — ни одного cv.own = true из заглушки.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, before, describe, it } from 'node:test';
import { inputNote, startApp, type AppHandle } from '../src/app';
import { PRODUCTION, type DevAccess } from '../src/devAccess';
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
interface Display extends Omit<DisplayApi, 'own'> {
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
  openSheet(sh: object): boolean;
  pageTargets: (Rect & { key: string })[] | null;
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
  /** Картинки, отданные в собственный image-компонент HMI (программный путь). */
  softImages: { d: Uint8Array; w: number; h: number }[];
  render(): Promise<void>;
  /** Тап по экранной точке (sx, sy): renderer пересчитывает её в логические px по последнему PLACE. */
  tapScreen(sx: number, sy: number): Promise<void>;
  tapLogical(x: number, y: number): Promise<void>;
  lastPlace(): { x: number; y: number; w: number; h: number; scale: number; ox: number; oy: number };
  close(): Promise<void>;
}

const center = (r: Rect) => [r.x + r.w / 2, r.y + r.h / 2] as const;

async function rig(opts: { native: boolean; touch?: boolean; dev?: DevAccess; caps?: number }): Promise<Rig> {
  const srv = await FakeRenderer.start({ native: opts.native, touch: opts.touch ?? true, caps: opts.caps ?? 1 | 8 });
  const saved: Env = { MGU_RENDERD_SOCKET: process.env.MGU_RENDERD_SOCKET, MGU_RENDERD_PROTO: process.env.MGU_RENDERD_PROTO };
  const env: Env = { MGU_RENDERD_SOCKET: srv.path };
  selectRenderTarget(env); // как main.js: диалект не задаётся
  delete process.env.MGU_RENDERD_PROTO;
  process.env.MGU_RENDERD_SOCKET = env.MGU_RENDERD_SOCKET;
  const kit = stageVendorKit();
  const record = kit.req('./record.js') as { setImage: Kit['record']['setImage'] };
  const { Display } = kit.req('./display.js') as { Display: new (...a: unknown[]) => Display };
  const G = kit.req('./gauges.js') as Kit['G'];
  const spec = buildManifest() as { id: string; title: string; version: string; screens: { buttons: [string, string][] }[]; settings: SettingSpec[] };

  // Кнопки HMI (RHMI-компоненты): нажатие — событие 'action', как у SDK.
  const comps = new Map<string, EventEmitter>();
  for (const [id] of spec.screens[0].buttons) comps.set(id, new EventEmitter());
  const hmiVisible: Record<string, boolean> = {};
  const softImages: { d: Uint8Array; w: number; h: number }[] = [];
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

  let loopFn: (() => unknown) | null = null;
  const ctx: MguCtx = {
    ui: {
      image: (name, cv) => display.present(name, cv, (_n: string, c: unknown) => (softImages.push(c as { d: Uint8Array; w: number; h: number }), Promise.resolve())),
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
    sheet: (sh) => display.openSheet(sh),
    display: display as unknown as DisplayApi,
  };
  let t = 1000;
  const app = startApp(ctx, { mgu: { run: () => undefined }, G, record }, syntheticAssets(), () => (t += 50), opts.dev ?? PRODUCTION);
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
    softImages,
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
    assert.deepEqual(Object.keys(r.hmiVisible), [], 'кнопок HMI у экрана нет вовсе');
    assert.equal(inputNote(d.own(), d as unknown as DisplayApi), null);
  });

  it('шапка в кадре рендереру: полосы + «Terrain Monitor» / «xDrive Offroad Pro» целиком, затем 5 вкладок; ни «Настроек», ни бейджа режима', async () => {
    const d = r.display;
    assert.equal(d.brand, HEADER_BRAND);
    const tabs = d.chromeRec!.tabRects;
    assert.equal(tabs.length, TAB_LABELS.length, 'вкладки «Настройки» нет');
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

  it('обычный запуск: на страницах нет кнопки диагностики, лист не открывается', async () => {
    const d = r.display;
    for (const i of [0, 1, 2, 3, 4]) {
      r.app.setPage(i);
      await r.render();
      assert.ok(!(d.pageTargets || []).some((q) => q.key === 'dev-diagnostics'), `страница ${i}`);
    }
    assert.equal(r.app.openDiagnostics(), false);
    assert.equal(d.sheet, null);
    r.app.setPage(0);
    await r.render();
  });

  it('ширина шапки: знак и 5 вкладок без бейджа, до угла статуса', async () => {
    const d = r.display;
    await r.render();
    assert.equal(d.chromeRec!.tabRects.length, TAB_LABELS.length);
    assert.ok(d.headEnd <= STATUS_X);
    assertBrandVisible(r, d.chromeRec!.words(), 'автомобиль');
  });
});

describe('XOP_DEV=demo,diag: демо помечено, лист диагностики касанием', () => {
  let r: Rig;
  before(async () => {
    r = await rig({ native: true, dev: { demo: true, scenario: null, diagnostics: true } });
    await r.render();
  });
  after(() => r.close());

  it('бейджи ДЕМО (+ ПАУЗА) помещаются в шапку со знаком и 5 вкладками', async () => {
    const d = r.display;
    for (const paused of [false, true]) {
      r.app.model.setPaused(paused);
      await r.render();
      assert.equal(d.headBadges, true, `бейджи в шапке (пауза ${paused})`);
      assert.ok(d.headEnd <= STATUS_X);
      assertBrandVisible(r, d.chromeRec!.words(), 'демо');
    }
    r.app.model.setPaused(false);
  });

  it('«Системы» → кнопка «Диагностика» → лист; «Назад» закрывает; вкладка над листом — к странице', async () => {
    const d = r.display;
    r.app.setPage(3);
    await r.render();
    const btn = (d.pageTargets || []).find((q) => q.key === 'dev-diagnostics');
    assert.ok(btn, 'кнопка есть');
    await r.tapLogical(...center(btn!));
    const sh = d.sheet as unknown as { title: string; lines: { label: string }[] } | null;
    assert.ok(sh && sh.title === DIAG.title, 'лист открыт');
    assert.deepEqual(sh!.lines.map((l) => l.label).slice(-1), [DIAG.demo], 'в демо снимка чтения нет');
    await r.tapLogical(...center(d.sheetTargets![0]));
    assert.equal(d.sheet, null, '«Назад» закрыл');
    await r.tapLogical(...center(btn!));
    assert.ok(d.sheet);
    const camTab = d.chromeRec!.tabRects.find((q) => q.i === 4)!;
    await r.tapScreen(...center(camTab));
    assert.equal(d.sheet, null);
    assert.equal(r.app.page(), 4);
    await r.render();
  });
});

describe('запасной путь: рендерер без mgu-render/1 (только READY)', () => {
  let r: Rig;
  before(async () => {
    r = await rig({ native: false });
    await r.render();
  });
  after(() => r.close());

  it('kit не ведёт экран: и здесь НИКАКОЙ панели HMI «Далее»/«Назад» (у экрана нет кнопок); причина — в журнал (inputNote)', () => {
    const d = r.display;
    assert.equal(d.gpu!.native, false);
    assert.equal(d.own(), false);
    assert.deepEqual(d.buttons(), [], 'кнопок панели нет');
    assert.deepEqual(Object.keys(r.hmiVisible), [], 'ни одна кнопка HMI не показана');
    assert.equal(inputNote(d.own(), d as unknown as DisplayApi), T.native.input.upstream);
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
      for (const badges of [[{ text: T.native.badge.demo }, { text: T.native.badge.paused }], []]) {
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

/* ---------------- потеря рендерера: запасной путь без панели HMI ---------------- */

describe('рендерер пропал / перезапуск / штатный экран сверху: страница не пропадает, панели HMI «Далее»/«Назад» нет никогда', () => {
  /** Картинка в image-компоненте HMI — кадр страницы (не пустой фон). */
  const drawn = (c: { d: Uint8Array; w: number; h: number } | undefined) => {
    if (!c) return false;
    let other = 0;
    for (let i = 0; i < c.d.length; i += 4 * 97) if (!(c.d[i] === 0x04 && c.d[i + 1] === 0x06 && c.d[i + 2] === 0x0a)) other++;
    return other > 50;
  };
  const noPager = (r: Rig) => {
    assert.deepEqual(r.display.buttons(), [], 'кнопок панели нет');
    assert.ok(!Object.keys(r.hmiVisible).some((k) => r.hmiVisible[k]), 'ни одна кнопка HMI не включена');
  };

  const hasTabs = (r: Rig) => {
    const cv = r.softImages[r.softImages.length - 1];
    assert.ok(cv, 'программный кадр получен');
    // Подчёркивание активной вкладки в строке G.frame, отсутствующее в GPU-only chrome.
    let accent = 0;
    for (let x = 16; x < 250; x++) {
      const p = (34 * cv.w + x) * 4;
      if (cv.d[p] === 0x81 && cv.d[p + 1] === 0xc4 && cv.d[p + 2] === 0xff) accent++;
    }
    assert.ok(accent > 50, 'в сохранённом кадре восстановлена строка вкладок');
  };

  it('обрыв соединения: в HMI — сам кадр страницы (без панели), переподключение: снова kit ведёт экран, кадр сразу', async () => {
    const r = await rig({ native: true });
    try {
      await r.render();
      noPager(r);
      const places = r.srv.of(MSG.PLACE).length;
      r.srv.drop();
      await r.srv.until(() => !r.display.gpu!.ready, 'обрыв замечен');
      await flush();
      noPager(r);
      assert.ok(drawn(r.softImages[r.softImages.length - 1]), 'страница в HMI, не пустой экран');
      hasTabs(r);
      await r.render();
      assert.ok(drawn(r.softImages[r.softImages.length - 1]), 'кадры идут в HMI и во время потери');
      await r.srv.until(() => r.srv.of(MSG.PLACE).length > places && !!r.display.gpu!.ready, 'переподключение', 6000);
      await flush();
      assert.ok(r.display.own());
      noPager(r);
      const before = r.srv.msgs.length;
      await r.render();
      await new Promise((ok) => setTimeout(ok, 50));
      assert.ok(r.srv.of(MSG.FRAME).some((m) => r.srv.msgs.indexOf(m) >= before), 'после переподключения кадр уходит рендереру');
    } finally {
      await r.close();
    }
  });

  it('нет подтверждения кадров после запуска: запасной кадр содержит вкладки, восстановление GPU не блокируется', async () => {
    const r = await rig({ native: true });
    try {
      await r.render();
      const d = r.display as unknown as { shownT: number; tickT: number; softDone: boolean; _softIfNoTick(): void };
      d.shownT = Date.now() - 2100;
      d.tickT = 0;
      d.softDone = false;
      d._softIfNoTick();
      await flush();
      hasTabs(r);
      noPager(r);
      assert.ok(r.display.own(), 'запасная картинка сама по себе не отнимает экран у рендерера');
    } finally { await r.close(); }
  });

  it('после успешного кадра остановка подтверждений обновляет запасную страницу при смене раздела, затем возвращает GPU', async () => {
    const r = await rig({ native: true });
    try {
      await r.render();
      r.srv.send(MSG.TICK, Buffer.alloc(8));
      await flush();
      const d = r.display as unknown as { shownT: number; tickT: number; softDone: boolean; _softIfNoTick(): void };
      d.shownT = Date.now() - 5000;
      d.tickT = Date.now() - 2100;
      d._softIfNoTick();
      await flush();
      hasTabs(r);
      assert.ok(drawn(r.softImages[r.softImages.length - 1]), 'потеря кадров после запуска тоже включает программный кадр');
      const terrain = Buffer.from(r.softImages[r.softImages.length - 1].d);
      const count = r.softImages.length;
      r.app.setPage(2);
      await r.render();
      d._softIfNoTick();
      await flush();
      assert.ok(r.softImages.length > count, 'смена раздела обновила запасной кадр');
      const suspension = r.softImages[r.softImages.length - 1];
      assert.ok(drawn(suspension));
      assert.ok(!terrain.equals(Buffer.from(suspension.d)), 'видна новая страница подвески');
      assert.ok(d.softDone);
      r.srv.send(MSG.TICK, Buffer.alloc(8));
      await flush();
      assert.equal(d.softDone, false, 'свежее подтверждение восстанавливает GPU');
      await r.render();
      assert.equal(drawn(r.softImages[r.softImages.length - 1]), false, 'под GPU снова чистый фон HMI');
      noPager(r);
    } finally { await r.close(); }
  });

  it('зависший скрытый рендерер переподключается только при подтверждённом foreground приложения', async () => {
    const r = await rig({ native: true, caps: 1 | 2 | 4 | 8 | 16 });
    try {
      await r.render();
      const video = r.display.gpu as unknown as { video(id: number, path: string): boolean };
      assert.ok(video.video(101, '/dev/shm/mgu-video-xop-test'));
      const d = r.display as unknown as { shownT: number; tickT: number; rendererFront: boolean | null; renderRetryT: number; _softIfNoTick(): void };
      const state = (front: number) => {
        const p = Buffer.alloc(12);
        p.writeUInt32LE(front, 8);
        r.srv.send(0x4d520102, p);
      };
      state(0);
      await flush();
      d.shownT = Date.now() - 7000; d.tickT = 0;
      const connections = r.srv.conns.length;
      d._softIfNoTick();
      await flush();
      assert.equal(r.srv.conns.length, connections, 'поверх другого экрана переподключения нет');
      state(1);
      await flush();
      d._softIfNoTick();
      await r.srv.until(() => r.srv.conns.length > connections && !!r.display.gpu!.ready, 'восстановление соединения');
      assert.ok(d.renderRetryT > 0);
      const places = r.srv.of(MSG.PLACE).length;
      await r.render();
      await r.srv.until(() => r.srv.of(MSG.FRAME).some((m) => m.conn === connections), 'кадр после восстановления');
      assert.ok(r.srv.of(MSG.PLACE).length >= places);
      assert.ok(r.srv.of(MSG.ATLAS, connections).length, 'шрифты пересланы');
      assert.ok(r.srv.of(MSG.TEN, connections).length, 'растры пересланы');
      assert.ok(r.srv.of(13, connections).length, 'регистрация VIDEO переслана');
      d.shownT = Date.now() - 7000; d.tickT = 0;
      state(1);
      await flush();
      d._softIfNoTick();
      await flush();
      assert.equal(r.srv.conns.length, connections + 1, 'повторное переподключение ограничено по времени');
      assert.ok(r.display.own());
      noPager(r);
    } finally { await r.close(); }
  });

  it('рендерер ушёл насовсем: программный путь рисует страницу, панели HMI нет (сколько бы ни прошло)', async () => {
    const r = await rig({ native: true });
    try {
      await r.render();
      (r.display.gpu as unknown as { closed: boolean }).closed = true; // без переподключения
      r.srv.drop();
      await r.srv.until(() => !r.display.gpu!.ready, 'обрыв замечен');
      for (let i = 0; i < 3; i++) await r.render();
      noPager(r);
      assert.ok(drawn(r.softImages[r.softImages.length - 1]));
      assert.equal(inputNote(r.display.own(), r.display as unknown as DisplayApi), T.native.input.waiting);
    } finally {
      await r.close();
    }
  });

  it('штатный экран сверху (рендерер: «не в фокусе»): kit экран не держит, панели HMI нет; снова в фокусе — снова свой', async () => {
    const r = await rig({ native: true, caps: 1 | 4 | 8 });
    try {
      await r.render();
      const state = (on: number, front: number) => {
        const p = Buffer.alloc(12);
        p.writeUInt32LE(on, 4);
        p.writeUInt32LE(front, 8);
        r.srv.send(0x4d520102, p);
      };
      state(0, 0);
      await new Promise((ok) => setTimeout(ok, 1700));
      await flush();
      assert.equal((r.display as unknown as { blocked: boolean }).blocked, true);
      assert.equal(r.display.own(), false, 'kit не держит экран поверх штатного');
      noPager(r);
      state(1, 1);
      await new Promise((ok) => setTimeout(ok, 100));
      await flush();
      assert.equal(r.display.own(), true);
      noPager(r);
    } finally {
      await r.close();
    }
  });
});
