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
  /** Вкладки, нарисованные G.frame на этой поверхности (без chrome). */
  tabRects?: readonly { i: number; x: number; y: number; w: number; h: number }[] | null;
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
  /** Видео id (RenderConnection.video), op 19 — только где запись это допускает (videoOk); false — не записано. */
  video?(id: number, x: number, y: number, w: number, h: number, r?: number): boolean;
  /** display.js: этот кадр может нести видео (mgu-render/1 с видео, GPU-путь показывает экран). */
  videoOk?: boolean;
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
  /** Сколько раз провайдер пропадал (вендорный signals.js; у upstream нет). */
  losses?: number;
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
/** Пятый аргумент watch вендорного kit/runtime/signals.js (без него — поведение upstream). */
export interface WatchOpts {
  pollMs?: number;
  fieldPollMs?: Record<string, number>;
  onAvailability?: (available: boolean) => void;
}

export type WatchFn = (iface: string, instance: string, handlers: Record<string, FieldHandler>, log?: Log, opts?: WatchOpts) => Promise<WatchResult>;

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

/** Соединение с рендерером (renderd.js RenderClient) — только то, что читает статус управления. */
export interface RenderConnection {
  readonly ready?: boolean;
  /** mgu-render/1 (пришёл X_READY). */
  readonly native?: boolean;
  /** Рендерер маршрутизирует касания (четвёртое слово READY). */
  readonly touch?: boolean;
  /** X_READY mgu-render/1: возможности рендерера (controller — у HMI есть шлюз контроллера iDrive; video — кадры из /dev/shm). */
  readonly info?: { readonly controller?: boolean; readonly video?: boolean } | null;
  /** Рендерер принимает видео на этом соединении. */
  readonly videoOk?: boolean;
  /** Фактическое состояние X_STATE; null — рендерер его ещё не сообщил. */
  readonly onScreen?: boolean | null;
  readonly visible?: boolean;
  readonly screen?: { readonly w: number; readonly h: number };
  /** Назвать файл кадров видео id (/dev/shm/mgu-video-*); false — отклонено. */
  video?(id: number, path: string): boolean;
  dropVideo?(id: number): void;
}

/** kit/runtime/display.js Display (ctx.display) — только используемое. */
export interface DisplayApi {
  /** Знак приложения в начале шапки полноэкранной раскладки (вендорная правка display.js). */
  brand?: { width(c: Surface): number; draw(c: Surface, x: number, y: number, w: number, h: number, theme: Theme): void } | null;
  /** Бейджи в шапке поместились рядом с брендом и всеми вкладками (иначе kit убрал их из шапки). */
  readonly headBadges?: boolean;
  readonly gpu?: RenderConnection | null;
  readonly blocked?: boolean;
  readonly place?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly full: boolean } | null;
  layout?(): string;
  /** kit сам ведёт экран (mgu-render/1 с касанием, «Весь экран»). */
  own?(): boolean;
  /** Вендорная правка display.js 0.1.8: что сообщал и делал рендерер (лист поддержки). */
  readonly stats2?: RendererEvents | null;
}

export interface RendererEvents {
  /** Последний X_STATE: на экране, в фронте, время (Date.now). */
  readonly state: { readonly on: boolean; readonly front: boolean; readonly t: number } | null;
  readonly tickT: number;
  readonly readies: number;
  readonly closes: number;
  /** Переподключения kit (только upstream-повтор ради контроллера; ради фронта/видимости — никогда). */
  readonly reconnects: number;
  /** Рендерер снял слой при приложении в фронте (перекрыто HMI, безответный ввод, камера HMI, молчание). */
  readonly offScreen: number;
  /** Рисование в HMI: приложение не в фронте дольше 1,5 с при открытом экране. */
  readonly blocked: number;
  readonly lost: number;
  readonly softFrames: number;
  /** Видимые ответы на касание / контроллер. */
  readonly acks: number;
}

/** ctx из kit/mgu.js (и заглушки kit/tools/hu-stub.js). */
export interface MguCtx {
  /** На машине есть всегда; в заглушке head unit — нет. */
  display?: DisplayApi;
  ui: UiApi;
  settings: SettingsApi;
  log: Log;
  /** proxy/call/on/onAvailable — vendor signals.js; используются ТОЛЬКО узким транспортом чтения vehicle/uds/tasu.ts. */
  signals: {
    watch: WatchFn;
    proxy?(iface: string, instance: string): Promise<unknown>;
    call?(p: unknown, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    on?(p: unknown, name: string, fn: (v: unknown) => void, log?: unknown): Promise<unknown>;
    onAvailable?(p: unknown, fn: (a: boolean) => void): Promise<unknown>;
  };
  theme(): Theme;
  canvas(w: number, h: number): Surface;
  loop(screen: string, fps: number, fn: () => unknown): LoopHandle;
  onTab(fn: (i: number, closedSheet?: boolean) => unknown): void;
  /** Лист (sheet.js) поверх страницы; false — нельзя (программный путь, другой рендерер). */
  sheet?(sh: object): boolean;
  /** На машине — OnlineApp SDK; в заглушке head unit его нет. */
  app?: { on?(ev: string, fn: () => void): void };
}

export interface MguApi {
  run(impl: { start(ctx: MguCtx): unknown }): unknown;
}
