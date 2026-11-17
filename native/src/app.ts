// Связка рантайма kit с моделью и отрисовкой. Без React/DOM.
// Управление: вкладки в заголовке и iDrive-контроллер — средствами kit (контроллер не захватывается);
// пять кнопок HMI: следующий/предыдущий экран, пауза демо, новая сессия, настройки. С upstream-диалектом
// (renderTarget.ts) kit не ведёт экран сам (cv.own = false): кнопок на странице и строк ctx.settingsRow нет,
// поэтому всё нужное — на панели HMI и в настройках (основная камера).

import { SCENARIO_IDS, type ScenarioId } from '../../src/domain/types';
import { CAMERA_IDS, DEFAULT_PRIMARY_CAMERA, type CameraId } from '../../src/screens/cameraPresentation';
import { ImageRegistry } from './assets/registry';
import { IMAGE_ID, type AssetsModule } from './assets/spec';
import type { Now } from './clock';
import { DEFAULT_MODE, isMode, isScenario, NativeModel, type DataMode } from './model/model';
import type { Kit } from './platform/kit';
import type { LoopHandle, MguCtx, Surface } from './platform/kitTypes';
import { badges, toolbar, type ToolbarButton } from './render/chrome';
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
    { now, watch: (iface, inst, handlers, l) => ctx.signals.watch(iface, inst, handlers, l), log },
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
    nextScenario: () => {
      const i = SCENARIO_IDS.indexOf(model.getState().scenarioId);
      settings.set('scenario', SCENARIO_IDS[(i + 1) % SCENARIO_IDS.length]);
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
    kit.G.frame(cv, theme, TAB_LABELS, page, badges(state));
    const button: ToolbarButton | null = cv.own
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
    toolbar(cv, state, button, actions);
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
  // Только где kit сам ведёт экран (own): строка в его настройках и кнопки на странице (полоса внизу);
  // там кнопки панели «Пауза» и «Сброс» не нужны. Иначе (upstream-диалект, программный путь) — панель HMI.
  if (ctx.settingsRow) ctx.settingsRow({ label: T.native.buttons.newSession, value: '', open: () => (actions.newSession(), null) });
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
