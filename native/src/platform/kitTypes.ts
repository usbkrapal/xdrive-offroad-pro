// Типы той части MIT-рантайма upstream (kit/runtime: mgu.js, record.js, gauges.js, signals.js),
// которую использует приложение. Сам рантайм в сборку не входит: его кладёт build.py upstream
// рядом с main.js (javascript/kit/*), а бандл требует './kit/...' во время выполнения.

/** '#rrggbb', '#rrggbbaa' или [r, g, b, a] (0…255). */
export type Color = string | readonly number[];
export type Pt = readonly [number, number];

export interface TextOpts {
  font?: 'label' | 'bold' | 'num' | 'light' | 'gear';
  align?: 'left' | 'center' | 'right';
  spacing?: number;
  /** Не пропускать строку через kit/i18n t(): весь текст приложения уже на нужном языке. */
  literal?: boolean;
}

export interface ArcOpts {
  round?: boolean;
  ramp?: readonly Color[];
  rampFrom?: number;
  rampTo?: number;
}

export interface Layer {
  readonly layerId: number;
  readonly w: number;
  readonly h: number;
}

/** Поверхность кадра (record.js Recorder): методы, на которые опирается отрисовка. */
export interface Surface {
  readonly w: number;
  readonly h: number;
  readonly textScale?: number;
  /** Комната под страницей (display.js); чтение помечает страницу как «тянущуюся вниз». */
  extra?: number;
  /** Кит сам ведёт экран (кнопки на странице вместо панели HMI). */
  own?: boolean;
  chrome?: unknown;
  clear(c?: Color): Surface;
  fillRect(x: number, y: number, w: number, h: number, c: Color): Surface;
  gradientRect(x: number, y: number, w: number, h: number, stops: readonly (readonly [number, Color])[]): Surface;
  roundRect(x: number, y: number, w: number, h: number, r: number, c: Color): Surface;
  strokeRoundRect(x: number, y: number, w: number, h: number, r: number, width: number, c: Color): Surface;
  arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, c: Color, opts?: ArcOpts): Surface;
  circle(cx: number, cy: number, r: number, c: Color): Surface;
  line(xa: number, ya: number, xb: number, yb: number, width: number, c: Color): Surface;
  polyline(pts: readonly Pt[], width: number, c: Color): Surface;
  quad(pts: readonly Pt[], c: Color): Surface;
  fill(pts: readonly Pt[], c: Color, strip?: boolean): Surface;
  text(str: string, x: number, y: number, size: number, c: Color, opts?: TextOpts): number;
  textWidth(str: string, size: number, opts?: TextOpts): number;
  image(id: number, x: number, y: number, w: number, h: number): Surface;
  blit(layer: Layer, x: number, y: number): Surface;
  alpha(a: number): Surface;
  clip(x: number, y: number, w: number, h: number): Surface;
  noclip(): Surface;
  target(x: number, y: number, w: number, h: number, run: () => unknown, key: string, r?: number): Surface;
}

export interface Badge {
  text: string;
  color?: string;
}

export interface Theme {
  bg: string;
  text: string;
  dim: string;
  accent: string;
  warn: string;
  crit: string;
  [k: string]: unknown;
}

/** kit/gauges.js — только используемое. */
export interface GaugesApi {
  readonly TOP: number;
  readonly BOTTOM: number;
  frame(cv: Surface, t: Theme, tabs: readonly string[], sel: number, badges: readonly (Badge | null | false | undefined)[]): void;
  layer(key: string, w: number, h: number, draw: (c: Surface) => void, textScale?: number): Layer;
  button(cv: Surface, t: Theme, x: number, y: number, w: number, h: number, label: string, run: () => unknown, opts?: { key?: string; primary?: boolean; color?: string; busy?: boolean }): number;
}

/** kit/record.js — только используемое. */
export interface RecordApi {
  setImage(id: number, w: number, h: number, rgba: Uint8Array): unknown;
}

export interface WatchResult {
  available: boolean;
  error: string | null;
  shutdown(): Promise<unknown>;
}

/** Обработчик поля SOME/IP: структура поля, как её отдаёт привязка. */
export type FieldHandler = (value: unknown) => void;

export interface Log {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

/**
 * Единственная функция SOME/IP, которую вызывает приложение: подписка + чтение (r/s).
 * proxy/call/set/on (методы, запись, UDS) сознательно не входят в этот тип.
 */
export type WatchFn = (iface: string, instance: string, handlers: Record<string, FieldHandler>, log?: Log) => Promise<WatchResult>;

export interface SettingsApi {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  onChange(fn: (key: string, value: unknown) => void): void;
}

export interface UiApi {
  image(name: string, cv: Surface): Promise<unknown> | unknown;
  text(name: string, str: string): Promise<unknown> | unknown;
  onClick(name: string, fn: (ev: unknown) => unknown): void;
  /** Свойство Enabled компонента HMI (mgu.js ui.enabled). */
  enabled?(name: string, on: boolean): Promise<unknown> | unknown;
  onVisible?(fn: (name: string, visible: boolean) => void): void;
  isVisible?(name: string): boolean;
}

export interface LoopHandle {
  stop(): void;
  kick?(): void;
}

/** ctx из kit/mgu.js (и заглушки kit/tools/hu-stub.js). */
export interface MguCtx {
  ui: UiApi;
  settings: SettingsApi;
  log: Log;
  signals: { watch: WatchFn };
  theme(): Theme;
  canvas(w: number, h: number): Surface;
  loop(screen: string, fps: number, fn: () => unknown): LoopHandle;
  onTab(fn: (i: number, closedSheet?: boolean) => unknown): void;
  settingsRow?(row: { label: string; value?: string | (() => string); open?: () => unknown }): void;
  hideButton?(id: string): void;
  /** На машине — OnlineApp SDK; в заглушке head unit его нет. */
  app?: { on?(ev: string, fn: () => void): void };
}

export interface MguApi {
  run(impl: { start(ctx: MguCtx): unknown }): unknown;
}
