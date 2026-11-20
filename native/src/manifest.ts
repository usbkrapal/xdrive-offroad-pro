// app.json для upstream kit/tools/build.py. Генерируется сборкой (native/scripts/build.ts),
// "signals" — строго из vehicle/allowlist.ts. Только MGU iDrive 7, без автозапуска.

import { SCENARIO_IDS } from '../../src/domain/types';
import { ru } from '../../src/i18n/ru';
import { SCREEN } from './app';
import { DATA_MODES, DEFAULT_MODE } from './model/model';
import { nativeRu } from './strings';
import { manifestSignals } from './vehicle/allowlist';
import { TASU_EVENT, TASU_IFACE, TASU_INSTANCE, TASU_METHOD } from './vehicle/uds/tasu';
import { ICAM2, XVIEW } from './camera/request';

/**
 * Живые камеры (camera/request.ts): состояние блока камер (чтение) и обычный запрос вида с его отменой — только свой
 * cookie, с уступкой штатным обзорам. Других методов камер (запись, настройка, VideoBuffer и т. п.) нет.
 */
export const CAMERA_SIGNALS = {
  icam: { _optional: 'живые камеры: состояние блока камер и запрос обычного вида', currentState: 'rs', _methods: ['changeState', 'clientAttach', 'clientDetach'] },
  xview: { _optional: 'живые камеры: текущий вид камер (штатные обзоры главнее)', CurrentState: 'rs' },
} as const;

/**
 * Диагностический транспорт головного устройства — так же, как в MIT idrive7-apps car_vitals/zf8hp: один метод
 * отправки запроса и событие ответа. Какие запросы приложение может по нему собрать, ограничивает только
 * vehicle/uds/tasu.ts (0x22 и пары из READ_ALLOWLIST).
 */
export const TASU_SIGNAL = {
  _optional: 'чтение диагностических значений (температура масла АКПП, скорости колёс, давление тормоза и др.)',
  _instances: TASU_INSTANCE,
  _methods: [TASU_METHOD],
  _broadcasts: [TASU_EVENT],
} as const;

export const APP_ID = 'xdrive_offroad_pro';
/**
 * Отображаемое имя — как в веб-шапке: «Terrain Monitor» (подзаголовок «xDrive Offroad Pro» — в шапке экрана).
 * id, тег журнала и пакет прежние: установленное приложение обновляется на месте.
 */
export const APP_TITLE = 'Terrain Monitor';
/** Свободный 4-символьный тег журнала (upstream: OA1x у BMW, OA93–OA9F у приложений kit). */
export const LOGGING_ID = 'XOP1';
import { APP_VERSION } from './version';
export { APP_VERSION };
/**
 * Рендерер, установленный у пользователя: компонент MGU Store mgu-render 0.6.21 (его component.json:
 * id "mgu-render", version "0.6.21"). Приложение говорит с ним диалектом mgu-render/1 (renderTarget.ts, вендорный renderd.js).
 */
export const REQUIRES = {
  'mgu-render': '0.6.21',
  // установщик MGU Store, который ставит инструменты (component.json: kind tool, units, recmgr) — как у пакета инструментов
  'mgu-deploy': '0.8.19',
  // мост камер (root-служба; сам требует свой приёмник xop-camrx 0.1.6) — native/packaging/xop-camera-bridge/component.json
  'xop-camera-bridge': '0.1.6',
} as const;

export function buildManifest(): Record<string, unknown> {
  const s = nativeRu.settings;
  const modeLabel = { demo: s.dataDemo, vehicle: s.dataVehicle } as const;
  return {
    id: APP_ID,
    title: APP_TITLE,
    description: 'xDrive Offroad Pro — офроуд-монитор: рельеф, сцепление, подвеска, системы, камеры. Только чтение данных автомобиля; неподтверждённые сигналы — «нет данных».',
    version: APP_VERSION,
    vendor: 'custom',
    loggingId: LOGGING_ID,
    iconGlyph: 'XOP',
    mguHmi: ['ID7'],
    requires: { ...REQUIRES },
    signals: {
      ...manifestSignals(),
      [TASU_IFACE]: { ...TASU_SIGNAL, _methods: [...TASU_SIGNAL._methods], _broadcasts: [...TASU_SIGNAL._broadcasts] },
      [ICAM2]: { ...CAMERA_SIGNALS.icam, _methods: [...CAMERA_SIGNALS.icam._methods] },
      [XVIEW]: { ...CAMERA_SIGNALS.xview },
    },
    screens: [
      {
        name: SCREEN,
        kind: 'canvas',
        title: '',
        // Ни одной кнопки панели HMI: листание — вкладками kit (касание, контроллер iDrive), выход — штатная «Назад»
        // HMI. Без кнопок у HMI нечего показать панелью «Далее»/«Назад» — ни при запуске без рендерера, ни при его
        // потере или перезапуске (раньше display.js возвращал их на запасном пути). Без BTN_SETTINGS — нет «Настроек».
        buttons: [],
      },
    ],
    // Все настройки скрыты (kit их не показывает, экрана настроек не открыть): значения ведёт приложение
    // (app.ts migrateSettings: автомобиль, весь экран, GPU). Демо — только XOP_DEV при запуске (devAccess.ts).
    settings: [
      { key: 'dataSource', label: s.dataSource, type: 'choice', hidden: true, default: DEFAULT_MODE, options: DATA_MODES.map((m) => [m, modeLabel[m]]) },
      { key: 'scenario', label: s.scenario, type: 'choice', hidden: true, default: 'mountainTrail', options: SCENARIO_IDS.map((id) => [id, ru.scenarios[id].name]) },
      { key: 'layout', label: s.layout, type: 'choice', hidden: true, default: 'full', options: [['full', s.layoutFull], ['standard', s.layoutStandard]] },
      { key: 'renderer', label: s.renderer, type: 'choice', hidden: true, default: 'auto', options: [['auto', s.rendererAuto], ['software', s.rendererSoftware]] },
    ],
  };
}
