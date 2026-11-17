// Цвета утверждённого веб-интерфейса (src/styles.css :root), приведённые к сплошным цветам:
// фон панелей заранее смешан с фоном страницы, чтобы растровые ресурсы можно было залить
// ровно тем же цветом (программный drawImage kit не умеет прозрачность).

export const C = {
  bg: '#04060a',
  /** rgba(214,224,240,0.055) поверх --bg. */
  panel: '#101217',
  panelLine: '#2a2e35',
  hair: '#1b1e24',
  text: '#f4f7fb',
  dim: '#8a95a6',
  track: '#1b212b',
  tick: '#4c5666',
  ice: '#81c4ff',
  cold: '#7fd1ff',
  mBlue: '#16588e',
  mRed: '#e7222e',
  red: '#ef2b2d',
  warn: '#ffb020',
  /** Вал под тягой и его свечение (DrivetrainStage CSS). */
  flowCore: '#7fdcff',
  flowGlow: '#38bdff',
  pulseTail: '#2fb4ff',
  pulseMid: '#8fdcff',
  pulseCore: '#f4fbff',
} as const;

/** '#rrggbb' + прозрачность 0…1 → '#rrggbbaa' (kit кэширует строковые цвета). */
export function withA(hex: string, a: number): string {
  const v = Math.max(0, Math.min(255, Math.round(a * 255)));
  return hex.slice(0, 7) + (v < 16 ? '0' : '') + v.toString(16);
}

/** Цвета статусов качества (StatusTag браузера). */
export const QUALITY_COLOR = { valid: C.text, stale: C.warn, unavailable: C.warn, invalid: C.red } as const;
