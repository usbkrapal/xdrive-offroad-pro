// Тестовые двойники рантайма kit и транспорта SOME/IP.

import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FieldHandler, GaugesApi, Layer, MguCtx, Surface, Theme, WatchFn, WatchResult } from '../src/platform/kitTypes';
import type { Kit } from '../src/platform/kit';
import { encodeEmbedded, type EmbeddedImage } from '../src/assets/codec';
import { ASSETS, type AssetKey, type AssetsModule } from '../src/assets/spec';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Синтетические ресурсы в размерах спецификации (быстро; настоящие PNG проверяет assets.test). */
export function syntheticAssets(): AssetsModule {
  const images = {} as Record<AssetKey, EmbeddedImage>;
  for (const s of ASSETS) {
    const data = new Uint8Array(s.w * s.h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i / 4) % 251;
      data[i + 1] = 120;
      data[i + 2] = 200;
      data[i + 3] = s.flattenOn ? 255 : (i / 4) % s.w > s.w / 4 ? 255 : 0;
    }
    images[s.key] = encodeEmbedded({ w: s.w, h: s.h, data }, s.flattenOn ? 3 : 4);
  }
  return { format: 'xop-assets/1', images };
}

/* ---------------- SOME/IP ---------------- */

export interface FakeSub {
  iface: string;
  instance: string;
  handlers: Record<string, FieldHandler>;
  res: WatchResult & { shutdownCalls: number };
}

/** Фальшивый ctx.signals.watch: хранит обработчики, отвечает сразу или по команде (поздний ответ). */
export class FakeTransport {
  readonly subs: FakeSub[] = [];
  readonly calls: { iface: string; instance: string; fields: string[] }[] = [];
  private pending: (() => void)[] = [];
  deferred = false;
  errorFor = new Set<string>();

  readonly watch: WatchFn = (iface, instance, handlers) => {
    this.calls.push({ iface, instance, fields: Object.keys(handlers) });
    const res = {
      available: false,
      error: this.errorFor.has(iface) ? 'no SOME/IP config' : null,
      shutdownCalls: 0,
      shutdown() {
        res.shutdownCalls++;
        return Promise.resolve();
      },
    };
    const sub: FakeSub = { iface, instance, handlers, res };
    this.subs.push(sub);
    if (!this.deferred) return Promise.resolve(res);
    return new Promise<WatchResult>((ok) => this.pending.push(() => ok(res)));
  };

  /** Ответить на все отложенные подписки. */
  resolvePending(): void {
    const p = this.pending;
    this.pending = [];
    p.forEach((f) => f());
  }

  /** Уведомление поля, как от привязки someip (провайдер становится доступен). */
  feed(iface: string, field: string, value: unknown): number {
    let n = 0;
    for (const s of this.subs) {
      if (s.iface !== iface || !s.handlers[field]) continue;
      s.res.available = true;
      s.handlers[field](value);
      n++;
    }
    return n;
  }

  setAvailable(iface: string, on: boolean): void {
    for (const s of this.subs) if (s.iface === iface) s.res.available = on;
  }
}

export const flush = () => new Promise((r) => setImmediate(r));

/* ---------------- поверхность ---------------- */

/** Методы record.js Recorder (закреплённый коммит), которые может вызвать приложение. */
export const RECORDER_METHODS = [
  'image', 'clear', 'fillRect', 'gradientRect', 'card', 'roundRect', 'strokeRoundRect', 'rampRect', 'circle', 'arc', 'line',
  'polyline', 'quad', 'fill', 'stroke', 'fillUnder', 'alpha', 'xf', 'append', 'clip', 'noclip', 'text', 'textWidth', 'blit', 'target',
] as const;

export interface TextCall {
  s: string;
  font: string;
  literal: boolean;
  size: number;
  x: number;
  y: number;
}

/** Строгая поверхность: только методы Recorder; любой другой вызов — исключение. Считает вызовы. */
export function strictSurface(opts: { own?: boolean } = {}): Surface & { counts: Record<string, number>; texts: TextCall[]; images: number[] } {
  const counts: Record<string, number> = {};
  const texts: TextCall[] = [];
  const images: number[] = [];
  // tabRects: свойство Recorder (G.frame / display.canvas его выставляют); у заглушки G.frame вкладок нет
  const base: Record<string, unknown> = { w: 1600, h: 520, textScale: 1, extra: 0, own: !!opts.own, chrome: null, tabRects: null, counts, texts, images };
  const finite = (name: string, args: unknown[]) => {
    for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${name}: non-finite argument ${a}`);
  };
  const impl: Record<string, (...a: unknown[]) => unknown> = {
    text: (s, x, y, size, _c, o) => {
      const op = (o ?? {}) as { font?: string; literal?: boolean };
      texts.push({ s: String(s), font: op.font ?? 'label', literal: !!op.literal, size: Number(size), x: Number(x), y: Number(y) });
      return String(s).length * Number(size) * 0.55;
    },
    textWidth: (s, size) => String(s).length * Number(size) * 0.55,
    image: (id) => {
      images.push(Number(id));
      return proxy;
    },
    target: () => proxy,
  };
  const proxy: Surface = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      if (!(RECORDER_METHODS as readonly string[]).includes(prop)) throw new Error(`Surface has no method ${prop}`);
      return (...args: unknown[]) => {
        counts[prop] = (counts[prop] ?? 0) + 1;
        finite(prop, args);
        return impl[prop] ? impl[prop](...args) : proxy;
      };
    },
    set(target, prop, value) {
      (target as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
  }) as never;
  return proxy as never;
}

/* ---------------- kit ---------------- */

export const THEME: Theme = { bg: '#04060a', text: '#ffffff', dim: '#8a95a6', accent: '#81c4ff', warn: '#ffb020', crit: '#ef2b2d' };

export function fakeKit(): Kit & { setImageCalls: { id: number; w: number; h: number; len: number }[]; frames: unknown[]; buttons: string[]; presses: Record<string, () => unknown> } {
  const setImageCalls: { id: number; w: number; h: number; len: number }[] = [];
  const frames: unknown[] = [];
  const buttons: string[] = [];
  /** Нажатие кнопки на странице по её key (как цель cv.target у настоящего G.button). */
  const presses: Record<string, () => unknown> = {};
  let seq = 0;
  const layers = new Map<string, Layer>();
  const G: GaugesApi = {
    TOP: 44,
    BOTTOM: 512,
    frame: (_cv, _t, tabs, sel, badges) => frames.push({ tabs: tabs.slice(), sel, badges: badges.filter(Boolean) }),
    layer: (key, w, h, draw) => {
      let L = layers.get(key);
      if (!L) {
        const c = strictSurface();
        draw(c);
        L = { layerId: ++seq, w, h };
        layers.set(key, L);
      }
      return L;
    },
    button: (cv, _t, _x, _y, w, _h, label, run, opts) => {
      buttons.push(label);
      if (cv.own) presses[(opts && opts.key) || label] = run;
      return cv.own ? w : 0;
    },
  };
  return {
    mgu: { run: () => undefined },
    G,
    record: { setImage: (id, w, h, d) => setImageCalls.push({ id, w, h, len: d.length }) },
    setImageCalls,
    frames,
    buttons,
    presses,
  };
}

export interface FakeCtx extends MguCtx {
  clicks: Record<string, (ev: unknown) => unknown>;
  tab: ((i: number) => unknown) | null;
  loopFn: (() => unknown) | null;
  loopStopped: boolean;
  shown: { name: string; cv: Surface }[];
  shutdown: (() => void) | null;
  labels: Record<string, string>;
  /** Последнее ui.enabled(name, on) по каждой кнопке. */
  enabledState: Record<string, boolean>;
  values: Record<string, unknown>;
  /** Листы, открытые приложением (ctx.sheet). */
  sheets: object[];
}

export function fakeCtx(transport: FakeTransport, initial: Record<string, unknown> = {}, opts: { own?: boolean } = {}): FakeCtx {
  const listeners: ((k: string, v: unknown) => void)[] = [];
  // сохранённые настройки (как settings.json прежних версий): по умолчанию — ничего, кроме сценария
  const values: Record<string, unknown> = { scenario: 'mountainTrail', ...initial };
  const ctx: FakeCtx = {
    clicks: {},
    tab: null,
    loopFn: null,
    loopStopped: false,
    shown: [],
    shutdown: null,
    labels: {},
    enabledState: {},
    values,
    sheets: [],
    sheet: (sh) => (ctx.sheets.push(sh), true),
    ui: {
      image: (name, cv) => {
        ctx.shown.push({ name, cv });
        return Promise.resolve();
      },
      text: (name, s) => {
        ctx.labels[name] = s;
        return Promise.resolve();
      },
      enabled: (name, on) => {
        ctx.enabledState[name] = on;
        return Promise.resolve();
      },
      onClick: (name, fn) => {
        ctx.clicks[name] = fn;
      },
    },
    settings: {
      get: (k) => values[k],
      set: (k, v) => {
        values[k] = v;
        listeners.forEach((fn) => fn(k, v));
      },
      onChange: (fn) => listeners.push(fn),
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    signals: { watch: transport.watch },
    theme: () => THEME,
    canvas: () => strictSurface(opts),
    loop: (_screen, _fps, fn) => {
      ctx.loopFn = fn;
      return { stop: () => (ctx.loopStopped = true), kick: () => undefined };
    },
    onTab: (fn) => {
      ctx.tab = fn;
    },
    app: {
      on: (ev, fn) => {
        if (ev === 'shutdown') ctx.shutdown = fn;
      },
    },
  };
  return ctx;
}

/* ---------------- настоящий рантайм upstream (MIT), если checkout рядом ---------------- */

export const UPSTREAM = resolve(process.env.MGU_UPSTREAM ?? join(ROOT, '..', '..', 'work', 'research', 'idrive7-apps'));
export const upstreamRuntime = join(UPSTREAM, 'kit', 'runtime');
export const hasUpstream = existsSync(join(upstreamRuntime, 'record.js')) && existsSync(join(upstreamRuntime, 'gauges.js'));

export function loadUpstream(): { record: Record<string, unknown> & { Recorder: new (w: number, h: number, o?: unknown) => Surface; play: (words: Uint32Array, cv: unknown) => unknown; setImage: Kit['record']['setImage'] }; canvas: { Canvas: new (w: number, h: number) => unknown }; G: GaugesApi } {
  const req = createRequire(join(upstreamRuntime, 'record.js'));
  return { record: req('./record.js'), canvas: req('./canvas.js'), G: req('./gauges.js') };
}

export interface UpstreamDisplay {
  /** display.js: Display (prototype._startGpu выбирает диалект) и геометрия панели HMI7. */
  display: { Display: { prototype: Record<string, (...a: unknown[]) => unknown> }; HMI7: { screen: { w: number }; btn: { x: number; pad: number; size: number; k: number } } };
  fonts: { has(name: string): boolean };
}

/** display.js и fonts.js закреплённого рантайма. renderd.js читает MGU_RENDERD_SOCKET при первой загрузке. */
export function loadUpstreamDisplay(): UpstreamDisplay {
  const req = createRequire(join(upstreamRuntime, 'record.js'));
  return { display: req('./display.js'), fonts: req('./fonts.js') };
}

/* ---------------- вендорный рантайм (то, что уходит в пакет) ---------------- */

export const VENDOR_KIT = join(ROOT, 'vendor', 'idrive7-apps', 'kit');

/**
 * Копия вендорного kit/runtime, разложенная как её кладёт build.py --language ru (javascript/kit):
 * кириллический атлас fonts/cyrillic.json и locale.json { language: 'ru', strings }. Каждая копия — свой
 * каталог, значит и свой кэш модулей: renderd.js прочитает MGU_RENDERD_SOCKET, заданный до kit.req().
 */
export function stageVendorKit(): { dir: string; req: NodeRequire; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'xop-kit-'));
  const kit = join(dir, 'kit');
  cpSync(join(VENDOR_KIT, 'runtime'), kit, { recursive: true });
  copyFileSync(join(VENDOR_KIT, 'localization', 'fonts', 'cyrillic-ru.json'), join(kit, 'fonts', 'cyrillic.json'));
  const strings = JSON.parse(readFileSync(join(kit, 'locales', 'ru.json'), 'utf8')) as Record<string, string>;
  writeFileSync(join(kit, 'locale.json'), JSON.stringify({ language: 'ru', strings }));
  return { dir, req: createRequire(join(kit, 'record.js')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
