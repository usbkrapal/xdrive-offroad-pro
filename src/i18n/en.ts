import type { Dictionary } from './ru';

type DeepPartial<T> = { readonly [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/**
 * Заготовка английского словаря. Неполная: отсутствующие ключи берутся из ru.
 * Переключателя языка в UI нет, пока словарь не заполнен целиком.
 */
export const en: DeepPartial<Dictionary> = {
  locale: 'en-GB',
  app: { demoBadge: 'DEMO · simulated data' },
  tabs: { ariaLabel: 'Monitor screens', terrain: 'Terrain', traction: 'Traction', suspension: 'Suspension', systems: 'Systems', cameras: 'Cameras' },
  cameras: {
    names: { front: 'Front camera', left: 'Left side camera', right: 'Right side camera' },
    demoLabel: 'Demonstration image',
    unavailable: 'Image unavailable',
    simulatedLoss: 'Simulated image loss',
    enlarge: 'Show large',
    primary: 'Main view',
  },
  quality: { valid: 'Valid', stale: 'Stale', unavailable: 'No data', invalid: 'Invalid' },
  demo: { title: 'Demo scenario', pause: 'Pause', resume: 'Resume', newSession: 'New session' },
};
