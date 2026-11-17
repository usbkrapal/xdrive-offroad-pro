import { SIGNAL_CATALOG } from './signalCatalog';
import type { Quality, RuntimeSource, Signal, SignalId, SignalValueMap } from './types';

/**
 * Нормализует сырой отсчёт в типизированный сигнал.
 * - undefined → unavailable (значения нет вообще);
 * - нечисловое число (NaN/±Infinity) → invalid, value=null;
 * - возраст больше staleAfterMs → stale, последнее значение сохраняется, но не используется;
 * - 0 и false — обычные валидные значения.
 */
export function buildSignal<K extends SignalId>(
  id: K,
  raw: SignalValueMap[K] | undefined,
  updatedAt: number,
  nowMs: number,
  runtimeSource: RuntimeSource = 'mock',
): Signal<SignalValueMap[K]> {
  const spec = SIGNAL_CATALOG[id];
  const base = { unit: spec.unit, runtimeSource, evidenceStatus: spec.evidence };
  if (raw === undefined || raw === null) {
    return { ...base, value: null, updatedAt: null, quality: 'unavailable' };
  }
  if (typeof raw === 'number' && !Number.isFinite(raw)) {
    return { ...base, value: null, updatedAt, quality: 'invalid' };
  }
  const quality: Quality = nowMs - updatedAt > spec.staleAfterMs ? 'stale' : 'valid';
  return { ...base, value: raw, updatedAt, quality };
}

/** Значение пригодно для показа как актуальное и для агрегатов. */
export function usableValue<T>(signal: Signal<T>): T | null {
  if (signal.quality !== 'valid' || signal.value === null) return null;
  if (typeof signal.value === 'number' && !Number.isFinite(signal.value)) return null;
  return signal.value;
}

export function usableNumber(signal: Signal<number>): number | null {
  return usableValue(signal);
}
