// Вспомогательные функции только для тестов.
import { buildSnapshot } from '../providers/mock/buildSnapshot';
import { buildSignal } from './signal';
import type { Signal, SignalId, SignalValueMap, TelemetrySnapshot } from './types';

type Overrides = { [K in SignalId]?: Signal<SignalValueMap[K]> };

/** Снимок «горной тропы» в момент t с подменой отдельных сигналов. */
export function snapAt(tMs: number, overrides: Overrides = {}): TelemetrySnapshot {
  const base = buildSnapshot('mountainTrail', 0, tMs);
  return { ...base, signals: { ...base.signals, ...overrides } };
}

export const valid = <K extends SignalId>(id: K, v: SignalValueMap[K], t: number) => buildSignal(id, v, t, t);
export const stale = <K extends SignalId>(id: K, v: SignalValueMap[K], t: number) => buildSignal(id, v, t - 60_000, t);
export const missing = <K extends SignalId>(id: K, t: number) => buildSignal(id, undefined, t, t);
export const nan = <K extends SignalId>(id: K, t: number) => buildSignal(id, Number.NaN as SignalValueMap[K], t, t);
/** Подделка: quality=valid, но значение NaN — агрегаты обязаны это отбросить. */
export const lyingNaN = <K extends SignalId>(id: K, t: number): Signal<SignalValueMap[K]> => ({
  ...buildSignal(id, 0 as SignalValueMap[K], t, t),
  value: Number.NaN as SignalValueMap[K],
});
