// Связка рантайма kit с моделью и отрисовкой. Без React/DOM.
// Управление. На mgu-render/1 с касанием (раскладка «Весь экран») kit сам ведёт экран (cv.own): вкладки и
// «Настройки» в шапке касанием, нижней панели нет (кнопки HMI скрыты: листание — вкладки, пауза и новая
// сессия — строки «Настроек», hideButton), сценарий и основная камера — выбор в «Настройках», «Показать
// крупно» — кнопки на странице. Контроллер iDrive kit берёт сам только на это время (display.js), приложение
// его не захватывает. Без этого (программная отрисовка, рендерер без mgu-render/1, стандартная раскладка)
// управление — пять кнопок HMI и настройки HMI; строка статуса объясняет, почему касания нет.

import type { ScenarioId } from '../../src/domain/types';
import { CAMERA_IDS, DEFAULT_PRIMARY_CAMERA, type CameraId } from '../../src/screens/cameraPresentation';
import { ImageRegistry } from './assets/registry';
import { IMAGE_ID, type AssetsModule } from './assets/spec';
import type { Now } from './clock';
import { DEFAULT_MODE, isMode, isScenario, NativeModel, type DataMode } from './model/model';
import type { Kit } from './platform/kit';
import type { DisplayApi, LoopHandle, MguCtx, Surface } from './platform/kitTypes';
import { drawPageBrand, HEADER_BRAND } from './render/brand';
import { badges, toolbar } from './render/chrome';
import { DIAG, diagnosticsSheet } from './render/diagnostics';
import { DialTexture } from './render/dial';
import { Phases, stageRates } from './render/drivetrain';
import { H, W } from './render/layout';
import { C } from './render/palette';
import { PAGES, type PageEnv } from './render/pages';
import { T, TAB_LABELS } from './strings';

export const SCREEN = 'MAIN';
export const GRAPHIC = 'MAIN_GFX';
export const BUTTONS = { next: 'BTN_PAGE', prev: 'BTN_PREV', action: 'BTN_ACTION', session: 'BTN_SESSION', settings: 'BTN_SETTINGS' } as const;
/** Частота программного пути (без GPU-рендерера); с рендерером kit вызывает отрисовку каждый кадр дисплея. */
export const SOFTWARE_FPS = 10;

export const isCameraId = (v: unknown): v is CameraId => typeof v === 'string' && (CAMERA_IDS as readonly string[]).indexOf(v) >= 0;

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

export interface AppHandle {
  readonly model: NativeModel;
  render(): unknown;
  page(): number;
  setPage(i: number): void;
  dispose(): void;
}

export function startApp(ctx: MguCtx, kit: Kit, assets: AssetsModule | null, now: Now): AppHandle {
  const { settings, log } = ctx;
  const savedMode = settings.get('dataSource');
  const savedScenario = settings.get('scenario');
  const model = new NativeModel(
    // пятый аргумент (опрос геттерами, потеря провайдера) — до вендорного signals.js (native/src/vehicle/INTEGRATION.md)
    { now, watch: (iface, inst, handlers, l, opts) => ctx.signals.watch(iface, inst, handlers, l, opts), log },
    isMode(savedMode) ? savedMode : DEFAULT_MODE,
    isScenario(savedScenario) ? savedScenario : 'mountainTrail',
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
  const savedCamera = settings.get('primaryCamera');
  let primaryCamera: CameraId = isCameraId(savedCamera) ? savedCamera : DEFAULT_PRIMARY_CAMERA;
  let lastFrame: number | null = null;
  let lastMode: DataMode = model.dataMode;
  let disposed = false;
  let loop: LoopHandle | null = null;

  const kick = () => loop && loop.kick && loop.kick();
  // Пауза — только у демо; в режиме чтения кнопка остаётся «Пауза», но недоступна (новая сессия — BTN_SESSION).
  const actionLabel = () => (model.getState().paused ? T.native.bar.resume : T.native.bar.pause);
  const syncAction = () => {
    try {
      void ctx.ui.text(BUTTONS.action, actionLabel());
      if (ctx.ui.enabled) void ctx.ui.enabled(BUTTONS.action, model.dataMode === 'demo');
    } catch (e) {
      log.warn('action label', e);
    }
  };

  const actions = {
    togglePause: () => {
      model.togglePause();
      syncAction();
      kick();
    },
    newSession: () => {
      model.newSession();
      kick();
    },
  };

  const render = () => {
    const cv = ctx.canvas(W, H);
    cv.clear(C.bg);
    const theme = ctx.theme();
    const state = model.getState();
    const t = now();
    if (state.mode !== lastMode) {
      phases.reset();
      lastMode = state.mode;
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
      primaryCamera,
      button,
      // Кнопки «Показать крупно» (только own) идут через ту же настройку, что и выбор в настройках.
      selectCamera: (id) => settings.set('primaryCamera', id),
    };
    try {
      PAGES[page](env);
    } catch (e) {
      log.error('page ' + page, e);
    }
    toolbar(cv, state, inputNote(!!cv.own, ctx.display));
    return ctx.ui.image(GRAPHIC, cv);
  };

  const setPage = (i: number) => {
    page = ((i % PAGES.length) + PAGES.length) % PAGES.length;
    kick();
  };

  ctx.onTab((i) => setPage(i));
  ctx.ui.onClick(BUTTONS.next, () => setPage(page + 1));
  ctx.ui.onClick(BUTTONS.prev, () => setPage(page - 1));
  ctx.ui.onClick(BUTTONS.action, () => {
    if (model.dataMode === 'demo') actions.togglePause();
  });
  ctx.ui.onClick(BUTTONS.session, () => actions.newSession());
  // Только где kit сам ведёт экран (own): строки внизу его «Настроек» (касание / контроллер); там кнопки
  // панели «Пауза» и «Сброс» не нужны (листание и «Настройки» kit убирает сам): ни одной кнопки, нет панели.
  // Иначе (программный путь, рендерер без mgu-render/1) — панель HMI со всеми пятью.
  const rows = T.native.rows;
  if (ctx.settingsRow) {
    ctx.settingsRow({
      label: rows.demo,
      value: () => (model.dataMode !== 'demo' ? rows.demoVehicle : model.getState().paused ? rows.demoPaused : rows.demoRunning),
      open: () => {
        if (model.dataMode === 'demo') actions.togglePause();
        return null;
      },
    });
    ctx.settingsRow({ label: rows.newSession, value: rows.newSessionValue, open: () => (actions.newSession(), null) });
    // Диагностика чтения: лист со снимком адаптера (по открытию / «Обновить»), только в режиме «Автомобиль».
    ctx.settingsRow({
      label: DIAG.row,
      value: () => (model.dataMode === 'vehicle' ? DIAG.rowOpen : DIAG.rowDemo),
      open: () => diagnosticsSheet(() => model.diagnostics()),
    });
    // Строки есть только там, где управление касанием (kit рисует «Настройки» сам).
    ctx.settingsRow({ label: rows.input, value: rows.inputTouch });
  }
  // Знак приложения в начале шапки (вендорная правка display.js; без неё свойство ни на что не влияет).
  if (ctx.display) ctx.display.brand = HEADER_BRAND;
  if (ctx.hideButton) {
    ctx.hideButton(BUTTONS.action);
    ctx.hideButton(BUTTONS.session);
  }

  settings.onChange((key, value) => {
    if (key === 'dataSource' && isMode(value)) {
      model.setMode(value);
      log.info(`data source: ${value}`);
      syncAction();
      kick();
    } else if (key === 'scenario' && isScenario(value)) {
      model.setScenario(value as ScenarioId);
      kick();
    } else if (key === 'primaryCamera' && isCameraId(value)) {
      primaryCamera = value;
      kick();
    }
  });

  loop = ctx.loop(SCREEN, SOFTWARE_FPS, render);
  syncAction();

  const onExit = () => dispose();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    process.removeListener('exit', onExit);
    if (loop) loop.stop();
    model.dispose();
  };
  if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('shutdown', dispose);
  process.once('exit', onExit);

  return {
    model,
    render,
    page: () => page,
    setPage,
    dispose,
  };
}
