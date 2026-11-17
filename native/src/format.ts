// Форматирование чисел для головного устройства. Node 8 на MGU собран без полного ICU,
// поэтому Intl.NumberFormat('ru-RU') там не надёжен: правила ru-RU (запятая, группы по 3
// через пробел) повторены вручную. Минус — ASCII '-': в крупных цифровых атласах kit нет U+2212.
// Семантика как у src/i18n/format.ts: stale/invalid/unavailable никогда не показываются числом.

import { usableValue } from '../../src/domain/signal';
import type { Quality, RuntimeSource, Signal } from '../../src/domain/types';
import { DASH, formatDuration } from '../../src/i18n/format';

export { DASH, formatDuration };

export interface Shown {
  readonly text: string;
  readonly quality: Quality;
  readonly ok: boolean;
}

function group(intPart: string): string {
  let out = '';
  for (let i = 0; i < intPart.length; i++) {
    if (i > 0 && (intPart.length - i) % 3 === 0) out += ' ';
    out += intPart[i];
  }
  return out;
}

/** Фиксированные знаки, запятая, группы разрядов; округлённый ноль без знака; NaN → «—». */
export function formatNumber(value: number, decimals: number, signed = false): string {
  if (!Number.isFinite(value)) return DASH;
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(Math.abs(value) * factor) / factor;
  const fixed = rounded.toFixed(decimals);
  const dot = fixed.indexOf('.');
  const body = dot < 0 ? group(fixed) : `${group(fixed.slice(0, dot))},${fixed.slice(dot + 1)}`;
  if (rounded === 0) return body;
  if (value < 0) return `-${body}`;
  return signed ? `+${body}` : body;
}

export function shownSignal<T>(signal: Signal<T>, render: (v: T) => string): Shown {
  const v = usableValue(signal);
  if (v === null) return { text: DASH, quality: signal.quality === 'valid' ? 'invalid' : signal.quality, ok: false };
  return { text: render(v), quality: 'valid', ok: true };
}

export const shownNumber = (s: Signal<number>, decimals = 0, signed = false): Shown => shownSignal(s, (v) => formatNumber(v, decimals, signed));

export const NONE: Shown = { text: DASH, quality: 'unavailable', ok: false };

/**
 * Источник значения — только если значение есть (свежее или устаревшее, конечное). runtimeSource — классификация
 * пути сигнала, а не доказательство данных: сигнал unavailable / invalid / ни разу не приходивший источника не имеет.
 */
export function presentSource(s: Signal<unknown>): RuntimeSource | null {
  if (s.value === null || s.value === undefined) return null;
  if (s.quality !== 'valid' && s.quality !== 'stale') return null;
  if (typeof s.value === 'number' && !Number.isFinite(s.value)) return null;
  return s.runtimeSource;
}
