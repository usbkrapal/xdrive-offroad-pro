// Строки, которых нет в общем словаре браузера (src/i18n/ru.ts): заголовки нативных кнопок,
// бейджи режима, настройки. Остальные подписи берутся из src/i18n/ru.ts без копирования.
// Структура повторяет ru.ts, чтобы позже добавить en частичным словарём, как в src/i18n/en.ts.

import { ru } from '../../src/i18n/ru';

export const nativeRu = {
  app: {
    title: 'xDrive Offroad Pro',
  },
  badge: {
    demo: 'ДЕМО',
    vehicleNoData: 'ЧТЕНИЕ · НЕТ ДАННЫХ',
    vehicle: 'ЧТЕНИЕ · ЧАСТИЧНО',
    paused: 'ПАУЗА',
  },
  /** Кнопки на странице (G.button, только когда kit сам ведёт экран). */
  buttons: {
    pause: 'Пауза',
    resume: 'Продолжить',
    newSession: 'Новая сессия',
    scenario: 'Сценарий',
    showLarge: 'Показать крупно',
  },
  /**
   * Пять кнопок панели HMI: коротко, чтобы панель не прокручивалась (ширина кнопки — подпись + 180 px
   * от x 132 до 1920, display.js HMI7.btn; проверяет manifest.test).
   */
  bar: {
    next: 'Далее',
    prev: 'Назад',
    pause: 'Пауза',
    resume: 'Пуск',
    session: 'Сброс',
    settings: 'Настройки',
  },
  settings: {
    dataSource: 'Источник данных',
    primaryCamera: 'Основная камера',
    dataDemo: 'Демо (смоделированные данные)',
    dataVehicle: 'Автомобиль (только чтение, кандидат)',
    scenario: 'Сценарий демо',
    layout: 'Раскладка экрана',
    layoutFull: 'Весь экран',
    layoutStandard: 'Стандартная',
    renderer: 'Отрисовка',
    rendererAuto: 'GPU 60 кадров/с (по умолчанию)',
    rendererSoftware: 'Программная',
  },
  toolbar: {
    demoTitle: 'СЦЕНАРИЙ ДЕМО',
    vehicleTitle: 'АВТОМОБИЛЬ · ТОЛЬКО ЧТЕНИЕ',
    vehicleWaiting: 'Ожидание данных автомобиля. Поддержано: обороты, скорость, момент, температуры ДВС, ускорения, передача.',
    vehicleCandidate: 'Кандидат, на G07 не проверен. Остальные показатели — «Нет данных».',
    vehicleErrors: 'Нет подписки:',
    simTime: 'Время симуляции',
    sessionTime: 'Время сессии',
  },
  cameras: {
    vehicleNote: 'Камеры автомобиля в режиме чтения недоступны. Демонстрационные снимки показываются только в демо.',
    vehicleUnavailable: 'Нет изображения: камера автомобиля не подключена',
  },
} as const;

export type NativeStrings = typeof nativeRu;

/** Словарь браузера + нативные строки; язык сборки фиксирован (build.py --language ru). */
export const T = { ...ru, native: nativeRu };
export type Dict = typeof T;

export const TAB_LABELS: readonly string[] = [ru.tabs.terrain, ru.tabs.traction, ru.tabs.suspension, ru.tabs.systems, ru.tabs.cameras];
