import { usableValue } from '../domain/signal';
import type { Quality, Signal } from '../domain/types';

export const DASH = '—';
const MINUS = '−';

const formatters = new Map<string, Intl.NumberFormat>();
function nf(locale: string, decimals: number): Intl.NumberFormat {
  const key = `${locale}|${decimals}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    formatters.set(key, f);
  }
  return f;
}

/**
 * Число с фиксированными знаками, типографским минусом и (опционально) явным «+».
 * Округлённый ноль всегда без знака. NaN/Infinity → «—».
 */
export function formatNumber(value: number, decimals: number, locale: string, signed = false): string {
  if (!Number.isFinite(value)) return DASH;
  const factor = 10 ** decimals;
  const rounded = Math.round(Math.abs(value) * factor) / factor;
  const body = nf(locale, decimals).format(rounded);
  if (rounded === 0) return body;
  if (value < 0) return MINUS + body;
  return signed ? `+${body}` : body;
}

export function formatDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface Display {
  /** Текст значения или «—», если значение нельзя показывать как актуальное. */
  readonly text: string;
  readonly quality: Quality;
  readonly ok: boolean;
}

/** Stale/invalid/unavailable никогда не показываются как число. 0 и false — показываются. */
export function displaySignal<T>(signal: Signal<T>, render: (v: T) => string): Display {
  const v = usableValue(signal);
  if (v === null) {
    // Если quality формально valid, но значение непригодно (NaN), считаем это ошибкой данных.
    const quality: Quality = signal.quality === 'valid' ? 'invalid' : signal.quality;
    return { text: DASH, quality, ok: false };
  }
  return { text: render(v), quality: 'valid', ok: true };
}

export function displayNumber(signal: Signal<number>, decimals: number, locale: string, signed = false): Display {
  return displaySignal(signal, (v) => formatNumber(v, decimals, locale, signed));
}
