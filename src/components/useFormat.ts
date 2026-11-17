import { useMemo } from 'react';
import type { Signal, Unit } from '../domain/types';
import { useT } from '../i18n';
import { displayNumber, displaySignal, formatNumber, type Display } from '../i18n/format';

/** Форматтеры, привязанные к текущему словарю и локали. */
export function useFormat() {
  const t = useT();
  return useMemo(
    () => ({
      t,
      num: (s: Signal<number>, decimals = 0, signed = false): Display => displayNumber(s, decimals, t.locale, signed),
      bool: (s: Signal<boolean>): Display => displaySignal(s, (v) => (v ? t.onOff.on : t.onOff.off)),
      value: (v: number, decimals = 0, signed = false) => formatNumber(v, decimals, t.locale, signed),
      unit: (u: Unit) => t.units[u],
      /** Подсказка для title: источник и исследовательский статус сигнала. */
      provenance: (s: Signal<unknown>) =>
        `${t.source[s.runtimeSource]} · ${t.quality[s.quality]} · ${t.evidence.label}: ${t.evidence[s.evidenceStatus]}`,
    }),
    [t],
  );
}

export type Format = ReturnType<typeof useFormat>;
