// app.json для upstream kit/tools/build.py. Генерируется сборкой (native/scripts/build.ts),
// "signals" — строго из vehicle/allowlist.ts. Только MGU iDrive 7, без автозапуска.

import { SCENARIO_IDS } from '../../src/domain/types';
import { ru } from '../../src/i18n/ru';
import { CAMERA_IDS, DEFAULT_PRIMARY_CAMERA } from '../../src/screens/cameraPresentation';
import { BUTTONS, SCREEN } from './app';
import { DATA_MODES, DEFAULT_MODE } from './model/model';
import { nativeRu } from './strings';
import { manifestSignals } from './vehicle/allowlist';

export const APP_ID = 'xdrive_offroad_pro';
export const APP_TITLE = 'xDrive Offroad Pro';
/** Свободный 4-символьный тег журнала (upstream: OA1x у BMW, OA93–OA9F у приложений kit). */
export const LOGGING_ID = 'XOP1';
export const APP_VERSION = '0.1.0';
/**
 * Рендерер, установленный у пользователя: компонент MGU Store mgu-render 0.6.21 (его component.json:
 * id "mgu-render", version "0.6.21"). Приложение говорит с ним upstream-диалектом (renderTarget.ts).
 */
export const REQUIRES = { 'mgu-render': '0.6.21' } as const;

export function buildManifest(): Record<string, unknown> {
  const s = nativeRu.settings;
  const modeLabel = { demo: s.dataDemo, vehicle: s.dataVehicle } as const;
  return {
    id: APP_ID,
    title: APP_TITLE,
    description: 'Офроуд-монитор: рельеф, сцепление, подвеска, системы, камеры. Демо по умолчанию; режим чтения автомобиля — кандидат.',
    version: APP_VERSION,
    vendor: 'custom',
    loggingId: LOGGING_ID,
    iconGlyph: 'XOP',
    mguHmi: ['ID7'],
    requires: { ...REQUIRES },
    signals: manifestSignals(),
    screens: [
      {
        name: SCREEN,
        kind: 'canvas',
        title: APP_TITLE,
        buttons: [
          [BUTTONS.next, nativeRu.bar.next],
          [BUTTONS.prev, nativeRu.bar.prev],
          [BUTTONS.action, nativeRu.bar.pause],
          [BUTTONS.session, nativeRu.bar.session],
          [BUTTONS.settings, nativeRu.bar.settings],
        ],
      },
    ],
    settings: [
      { key: 'dataSource', label: s.dataSource, type: 'choice', default: DEFAULT_MODE, options: DATA_MODES.map((m) => [m, modeLabel[m]]) },
      { key: 'scenario', label: s.scenario, type: 'choice', default: 'mountainTrail', options: SCENARIO_IDS.map((id) => [id, ru.scenarios[id].name]) },
      // Выбор основного вида камер без кнопок на странице (их нет, когда kit не ведёт экран сам).
      { key: 'primaryCamera', label: s.primaryCamera, type: 'choice', default: DEFAULT_PRIMARY_CAMERA, options: CAMERA_IDS.map((id) => [id, ru.cameras.names[id]]) },
      { key: 'layout', label: s.layout, type: 'choice', default: 'full', options: [['full', s.layoutFull], ['standard', s.layoutStandard]] },
      { key: 'renderer', label: s.renderer, type: 'choice', default: 'auto', options: [['auto', s.rendererAuto], ['software', s.rendererSoftware]] },
    ],
  };
}
