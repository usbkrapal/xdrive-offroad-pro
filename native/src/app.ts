// Связка рантайма kit с моделью и отрисовкой. Без React/DOM.
// Обычный запуск: данные автомобиля (только чтение), без демо, без вкладки «Настройки», без бейджа режима и без нижней
// строки статуса. На mgu-render/1 с касанием (раскладка «Весь экран») kit сам ведёт экран (cv.own): вкладки касанием,
// панели HMI нет. Без этого (программная отрисовка, рендерер без mgu-render/1, стандартная раскладка) — запасной путь:
// программный кадр страницы без кнопок панели HMI; почему касания нет — в журнал приложения.
// Доступ разработчика (демо, лист диагностики) — только переменной окружения XOP_DEV при запуске (devAccess.ts).

import type { ScenarioId } from '../../src/domain/types';
import { ImageRegistry } from './assets/registry';
import { IMAGE_ID, type AssetsModule } from './assets/spec';
import type { Now } from './clock';
import { devAccess, type DevAccess } from './devAccess';
import { isScenario, NativeModel, type DataMode } from './model/model';
import type { Kit } from './platform/kit';
import type { DisplayApi, LoopHandle, MguCtx, SettingsApi, Surface } from './platform/kitTypes';
import { drawPageBrand, HEADER_BRAND } from './render/brand';
import { badges } from './render/chrome';
import { diagnosticsSheet, type DiagLine } from './render/diagnostics';
import { SupportTaps, supportLines } from './render/support';
import { APP_VERSION } from './version';
import { DialTexture } from './render/dial';
import { Phases, stageRates } from './render/drivetrain';
import { H, W } from './render/layout';
import { C } from './render/palette';
import { PAGES, type PageEnv } from './render/pages';
import { T, TAB_LABELS } from './strings';
import type { TasuSignals } from './vehicle/uds/tasu';
import * as fs from 'fs';
import * as net from 'net';
import type { PollingView } from './vehicle/uds/reader';
import type { CameraId } from '../../src/screens/cameraPresentation';
import { CameraFeeds, VIDEO_ID, type FeedDeps } from './camera/feeds';
import { camPolicy, CameraRequest, type CamApi, type CamPolicy } from './camera/request';

/** Настоящие сокет моста и чтение заголовков файлов кадров (в тестах — подмена). */
export function realFeedDeps(now: Now, log: { info(...a: unknown[]): void }): FeedDeps {
  return {
    connect(path, on) {
      const s = net.createConnection(path);
      let err: string | null = null;
      s.setEncoding('utf8');
      s.on('connect', () => on.connect());
      s.on('data', (d: string) => on.data(d));
      s.on('error', (e) => (err = String((e as Error).message || e)));
      s.on('close', () => on.close(err));
      return { write: (l) => void (!s.destroyed && s.write(l)), end: () => s.end() };
    },
    readHeader(path) {
      let fd: number | null = null;
      try {
        fd = fs.openSync(path, 'r');
        const st = fs.fstatSync(fd);
        const b = Buffer.alloc(64);
        fs.readSync(fd, b, 0, 64, 0);
        return { bytes: b, uid: st.uid, isFile: st.isFile(), size: st.size };
      } catch {
        return null;
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
    },
    now,
    setTimer(fn, ms) {
      const t = setTimeout(fn, ms);
      if (t.unref) t.unref();
      return () => clearTimeout(t);
    },
    log: (l) => log.info(l),
  };
}

/** Камеры: подмены для тестов (без них — настоящие сокет, файлы и SOME/IP). */
export interface CameraDeps {
  readonly feeds?: FeedDeps;
  /** null — запрос вида выключен (например, нет proxy/call в ctx.signals). */
  readonly api?: CamApi | null;
  /** Правила запроса вида (тесты); иначе — из окружения разработчика (XOP_CAM_REQUEST / XOP_CAM_BUSY). */
  readonly camPolicy?: CamPolicy;
}

export const SCREEN = 'MAIN';
export const GRAPHIC = 'MAIN_GFX';
/** Частота программного пути (без GPU-рендерера); с рендерером kit вызывает отрисовку каждый кадр дисплея. */
export const SOFTWARE_FPS = 10;
/** Индекс страницы «Камеры» (PAGES). */
export const CAMERA_PAGE = 4;
/** Индекс страницы «Системы» (PAGES). */
export const SYSTEMS_PAGE = 3;

/** Значения скрытых настроек, которые ведёт приложение (интерфейса настроек нет). */
export const SETTING_VALUES = { dataSource: 'vehicle', layout: 'full', renderer: 'auto' } as const;

/**
 * Перенос сохранённых настроек прежних версий: «Демо», «Стандартная» раскладка и «Программная» отрисовка больше
 * нельзя выбрать — без переноса приложение навсегда осталось бы в них. Пишется только то, что отличается.
 * Программную отрисовку для проверки даёт MGU_RENDERER=software (display.js), демо — XOP_DEV=demo; ни то ни другое
 * не сохраняется.
 */
export function migrateSettings(settings: SettingsApi): string[] {
  const changed: string[] = [];
  (Object.keys(SETTING_VALUES) as (keyof typeof SETTING_VALUES)[]).forEach((k) => {
    if (settings.get(k) !== SETTING_VALUES[k]) {
      settings.set(k, SETTING_VALUES[k]);
      changed.push(k);
    }
  });
  return changed;
}

/**
 * Почему касания нет (null — kit ведёт экран, всё касанием). Только по тому, что сообщил рендерер:
 * без display (заглушка head unit) или без соединения — программный путь.
 */
export function inputNote(own: boolean, display: DisplayApi | undefined): string | null {
  if (own) return null;
  const s = T.native.input;
  const g = display && display.gpu;
  if (!g) return s.software;
  if (!g.ready) return s.waiting;
  if (!g.native) return s.upstream;
  if (!g.touch) return s.noTouch;
  if (display && display.layout && display.layout() !== 'full') return s.standard;
  return s.waiting;
}

/**
 * Строки листа диагностики о рендерере и управлении (для разбора всплывающего меню HMI): кто держит контроллер iDrive,
 * ведёт ли kit экран. Только то, что сообщил рендерер (X_READY), без догадок.
 */
export function inputLines(display: DisplayApi | undefined): DiagLine[] {
  const g = display && display.gpu;
  const own = !!(display && display.own && display.own());
  const ctl = g && g.info ? g.info.controller : undefined;
  const yesNo = (v: boolean | null | undefined) => v === undefined || v === null ? 'не сообщил' : v ? 'да' : 'нет';
  const p = display && display.place;
  return [
    { label: 'Рендерер и управление', value: '', tone: 'head' },
    { label: 'Рендерер', value: !g ? 'нет (программная отрисовка)' : !g.ready ? 'подключение' : g.native ? `mgu-render/1 · касания ${g.touch ? 'да' : 'нет'}` : 'без mgu-render/1', tone: 'dim' },
    { label: 'Экран ведёт kit (касание)', value: own ? 'да' : `нет — ${inputNote(false, display) ?? ''}`, tone: own ? 'dim' : 'warn' },
    { label: 'Изображение рендерера', value: `на экране: ${yesNo(g && g.onScreen)} · показ запрошен: ${yesNo(g && g.visible)}`, tone: 'dim' },
    { label: 'Полноэкранный вывод', value: `настройка: ${display?.layout?.() ?? '—'} · уступил штатному экрану: ${yesNo(display?.blocked)}`, tone: display?.blocked ? 'warn' : 'dim' },
    { label: 'Размер экрана / область приложения', value: `${g?.screen ? `${g.screen.w}×${g.screen.h}` : '—'} / ${p ? `${p.w}×${p.h} (${p.x},${p.y}) · ${p.full ? 'весь экран' : 'стандартная'}` : '—'}`, tone: 'dim' },
    {
      label: 'Контроллер iDrive',
      value: ctl === undefined ? 'рендерер не сообщил' : ctl ? (own ? 'удерживается kit (поворот/нажатие — приложению)' : 'шлюз есть, kit не удерживает') : 'шлюза контроллера нет — поворот, нажатие и наклоны обрабатывает HMI',
      tone: ctl ? 'dim' : 'warn',
    },
    { label: 'Рендерер: видео', value: g && g.info ? (g.info.video ? 'принимает (VIDEO, op 19)' : 'не принимает') : 'рендерер не сообщил', tone: g && g.info && g.info.video ? 'dim' : 'warn' },
  ];
}

/** Камеры в листе диагностики: мост, источник, каждый вид и запрос вида у блока камер. */
export function cameraLines(feeds: CameraFeeds, req: CameraRequest | null): DiagLine[] {
  const d = feeds.diagnostics();
  const b = d.bridge;
  const out: DiagLine[] = [
    { label: 'Камеры', value: '', tone: 'head' },
    { label: 'Мост xop-camera-bridge', value: d.connected ? (b ? `${b.state}${b.producer ? ` · ${b.producer} [${b.views.join(',')}]` : ''}${b.reason ? ` · ${b.reason}` : ''}` : 'подключён') : d.bridgeError ?? (d.wanted ? 'подключение' : 'не нужен (страница не на экране)'), tone: b && b.state === 'running' ? 'dim' : 'warn' },
  ];
  (Object.keys(d.views) as CameraId[]).forEach((id) => out.push({ label: `   ${id}`, value: d.views[id].live ? 'живой' : d.views[id].reason, tone: d.views[id].live ? 'ok' : 'warn' }));
  if (req) {
    const s = req.state;
    out.push({ label: 'Блок камер (currentState)', value: s ? `${req.stateSource ?? '—'} · ${s.application}/${s.mode}/${s.perspective}` : 'нет состояния', tone: 'dim' });
    out.push({ label: 'Запрос вида', value: `${req.reason || '—'}${req.ownCookie !== null ? ` · свой cookie ${req.ownCookie}` : ''}`, tone: 'dim' });
  } else out.push({ label: 'Запрос вида', value: 'выключен: нет proxy/call в ctx.signals', tone: 'warn' });
  return out;
}

/**
 * Только эти четыре функции kit signals.js нужны узкому транспорту чтения (vehicle/uds/tasu.ts); весь объект
 * signals в модель не передаётся. Нет их (заглушка head unit) — диагностического чтения нет.
 */
export function tasuSignals(ctx: MguCtx): TasuSignals | undefined {
  const s = ctx.signals;
  if (!s.proxy || !s.call || !s.on || !s.onAvailable) return undefined;
  return { proxy: s.proxy, call: s.call, on: s.on, onAvailable: s.onAvailable };
}

export interface AppHandle {
  readonly model: NativeModel;
  readonly dev: DevAccess;
  render(): unknown;
  page(): number;
  setPage(i: number): void;
  /** Лист диагностики (только XOP_DEV=diag); false — недоступен. */
  openDiagnostics(): boolean;
  /** Закрытие; обещание — когда свой cookie камер отпущен (не дольше ~1,5 с). */
  dispose(): Promise<void>;
}

export function startApp(ctx: MguCtx, kit: Kit, assets: AssetsModule | null, now: Now, dev: DevAccess = devAccess(process.env), camDeps: CameraDeps = {}): AppHandle {
  const { settings, log } = ctx;
  const migrated = migrateSettings(settings);
  if (migrated.length) log.info(`settings migrated to defaults: ${migrated.join(', ')}`);
  // Источник данных — только по доступу разработчика при запуске; сохранённое значение не выбирает демо.
  const mode: DataMode = dev.demo ? 'demo' : 'vehicle';
  const savedScenario = settings.get('scenario');
  const scenario: ScenarioId = dev.scenario ?? (isScenario(savedScenario) ? savedScenario : 'mountainTrail');
  if (dev.demo || dev.diagnostics) log.warn(`developer access: ${dev.demo ? `demo data (${scenario})` : 'vehicle data'}${dev.diagnostics ? ', diagnostics' : ''}`);
  const model = new NativeModel(
    // пятый аргумент (опрос геттерами, потеря провайдера) — до вендорного signals.js (native/src/vehicle/INTEGRATION.md)
    { now, watch: (iface, inst, handlers, l, opts) => ctx.signals.watch(iface, inst, handlers, l, opts), log, tasu: tasuSignals(ctx) },
    mode,
    scenario,
  );
  const images = new ImageRegistry(assets, (id, w, h, d) => kit.record.setImage(id, w, h, d), log);
  const pitchSprite = images.raw('pitchSprite');
  const rollSprite = images.raw('rollSprite');
  const setImage = (id: number, w: number, h: number, d: Uint8Array) => kit.record.setImage(id, w, h, d);
  const dials = {
    pitch: pitchSprite ? new DialTexture('pitch', IMAGE_ID.dialPitch, pitchSprite, setImage) : null,
    roll: rollSprite ? new DialTexture('roll', IMAGE_ID.dialRoll, rollSprite, setImage) : null,
  };
  const phases = new Phases();
  let page = 0;
  let lastFrame: number | null = null;
  let lastNote: string | null | undefined;
  let disposed = false;
  let loop: LoopHandle | null = null;

  const kick = () => loop && loop.kick && loop.kick();
  const newSession = () => {
    model.newSession();
    kick();
  };
  // Камеры: мост (кадры) и запрос вида (ICAM2Proxy) — только с данными автомобиля, на странице «Камеры», при видимом экране
  const feeds = new CameraFeeds(camDeps.feeds ?? realFeedDeps(now, log));
  const sig = ctx.signals;
  const camApi: CamApi | null =
    camDeps.api !== undefined ? camDeps.api : sig.proxy && sig.call ? { proxy: sig.proxy, call: sig.call, watch: (i, n, h, l, o) => sig.watch(i, n, h, l, o) } : null;
  const camReq = camApi
    ? new CameraRequest(camApi, now, (fn, ms) => {
        const t = setTimeout(fn, ms);
        if (t.unref) t.unref();
        return () => clearTimeout(t);
      }, log, camDeps.camPolicy ?? camPolicy(process.env))
    : null;
  let screenVisible = ctx.ui.isVisible ? ctx.ui.isVisible(SCREEN) : true;
  const videoSent = new Set<number>();
  const updateCameras = () => {
    const on = !disposed && mode === 'vehicle' && page === CAMERA_PAGE && screenVisible;
    feeds.setWanted(on);
    if (camReq) camReq.setWanted(on);
    if (!on && videoSent.size) dropVideos();
  };
  const dropVideos = () => {
    const g = ctx.display && ctx.display.gpu;
    videoSent.forEach((id) => g && g.dropVideo && g.dropVideo(id));
    videoSent.clear();
  };
  const liveCamera = (id: CameraId, x: number, y: number, w: number, h: number, cv: Surface): boolean => {
    const v = feeds.view(id);
    const g = ctx.display && ctx.display.gpu;
    if (!v.live || !v.path || !g || !g.video || !cv.video || !cv.videoOk) return false;
    if (!g.video(VIDEO_ID[id], v.path)) return false;
    videoSent.add(VIDEO_ID[id]);
    return cv.video(VIDEO_ID[id], x, y, w, h, 2);
  };
  // Скрытый лист поддержки (render/support.ts): 5 касаний уже открытой вкладки «Системы» или «Камеры» за 3 с.
  // Страница не меняется (на «Камерах» запрос/кадры остаются как есть — лист их не запускает и не останавливает).
  const supportTaps = new SupportTaps();
  const openSupport = (kind: 'systems' | 'cameras'): boolean => {
    if (!ctx.sheet) return false;
    log.info(`support sheet opened (${kind})`);
    return ctx.sheet(
      diagnosticsSheet(
        () => model.diagnostics(),
        () => supportLines(kind, model.diagnostics(), cameraLines(feeds, camReq), inputLines(ctx.display), APP_VERSION),
      ),
    );
  };
  const openDiagnostics = (): boolean => {
    if (!dev.diagnostics || !ctx.sheet) return false;
    return ctx.sheet(diagnosticsSheet(() => model.diagnostics(), () => inputLines(ctx.display).concat(cameraLines(feeds, camReq))));
  };

  const render = () => {
    const cv = ctx.canvas(W, H);
    cv.clear(C.bg);
    const theme = ctx.theme();
    const state = model.getState();
    const t = now();
    if (mode === 'vehicle' && page === CAMERA_PAGE) {
      feeds.poll();
      if (camReq) camReq.setNeed(feeds.need());
    }
    // Фазы идут по реальному времени; в паузе стоят (dt = 0).
    const dt = lastFrame === null || state.paused ? 0 : (t - lastFrame) / 1000;
    lastFrame = t;
    phases.advance(stageRates(state.snapshot.signals), dt);
    const bdg = badges(state);
    kit.G.frame(cv, theme, TAB_LABELS, page, bdg);
    // Полноэкранная раскладка: бренд в шапке рисует kit (display.brand); иначе — в полосе вкладок страницы.
    if (!cv.chrome) drawPageBrand(cv, cv.tabRects, bdg, W);
    const button: PageEnv['button'] = cv.own
      ? (x, y, w, h, label, run, key, primary) => kit.G.button(cv, theme, x, y, w, h, label, run, { key, primary })
      : null;
    const env: PageEnv = {
      cv,
      state,
      phases,
      images,
      dials,
      layer: (key, w, h, draw) => kit.G.layer(key, w, h, draw, (cv as Surface).textScale),
      nowMs: t,
      button,
      newSession,
      openDiagnostics: dev.diagnostics && ctx.sheet ? () => (openDiagnostics(), null) : null,
      liveCamera: mode === 'vehicle' ? (id, x, y, w, h) => liveCamera(id, x, y, w, h, cv) : null,
    };
    try {
      PAGES[page](env);
    } catch (e) {
      log.error('page ' + page, e);
    }
    // Причина запасного пути без касания — в журнал, только при смене.
    const note = inputNote(!!cv.own, ctx.display);
    if (note !== lastNote) {
      lastNote = note;
      log.info(`input: ${note ?? 'touch (kit runs the screen)'}`);
    }
    return ctx.ui.image(GRAPHIC, cv);
  };

  const setPage = (i: number) => {
    page = ((i % PAGES.length) + PAGES.length) % PAGES.length;
    const views: readonly PollingView[] = ['terrain', 'traction', 'suspension', 'systems', 'cameras'];
    model.setView(views[page]);
    updateCameras();
    kick();
  };

  ctx.onTab((i, closedSheet) => {
    // касание вкладки, закрывшее лист, — не счёт; другая вкладка — сброс счёта
    const eligible = !closedSheet && (page === SYSTEMS_PAGE || page === CAMERA_PAGE);
    if (supportTaps.tap(i, page, eligible, now())) {
      openSupport(page === CAMERA_PAGE ? 'cameras' : 'systems');
      return;
    }
    if (i !== page) setPage(i);
  });
  // Знак приложения в начале шапки (вендорная правка display.js; без неё свойство ни на что не влияет).
  if (ctx.display) ctx.display.brand = HEADER_BRAND;

  loop = ctx.loop(SCREEN, SOFTWARE_FPS, render);

  // process 'exit': асинхронный detach уже не уйдёт (Node не выполняет ввод-вывод после обработчиков exit) —
  // cookie отпускается при уходе со страницы и в 'shutdown'; здесь только записать, если он ещё держится
  const onExit = () => {
    if (camReq && camReq.ownCookie !== null) log.warn(`camera: exiting with cookie ${camReq.ownCookie} still attached (detach cannot be sent from process exit)`);
    void dispose();
  };
  let disposing: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    disposed = true;
    process.removeListener('exit', onExit);
    if (loop) loop.stop();
    feeds.dispose();
    const released = camReq ? camReq.dispose() : Promise.resolve();
    dropVideos();
    model.dispose();
    disposing = Promise.race([released.catch(() => undefined), new Promise<void>((r) => setTimeout(r, 1500).unref?.())]).then(() => undefined);
    return disposing;
  };
  if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('shutdown', dispose);
  // Диагностическое чтение — только пока экран приложения виден
  if (ctx.ui.isVisible) model.setVisible(ctx.ui.isVisible(SCREEN));
  if (ctx.ui.onVisible)
    ctx.ui.onVisible((name, v) => {
      if (name !== SCREEN) return;
      model.setVisible(v);
      screenVisible = v;
      updateCameras();
    });
  process.once('exit', onExit);

  return {
    model,
    dev,
    render,
    page: () => page,
    setPage,
    openDiagnostics,
    dispose,
  };
}
