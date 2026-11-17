import type { ReactNode } from 'react';
import type { Signal } from '../domain/types';
import type { Display } from '../i18n/format';
import { StatusTag } from './StatusTag';
import { useFormat } from './useFormat';

export type ReadoutSize = 'xl' | 'lg' | 'md' | 'sm';

interface ReadoutProps {
  label: string;
  display: Display;
  unit?: string;
  size?: ReadoutSize;
  hint?: ReactNode;
  /** Для подсказки об источнике/исследовательском статусе. */
  signal?: Signal<unknown>;
  className?: string;
  children?: ReactNode;
}

/** Подпись + крупное табличное значение. Недоступное значение — «—» и текстовый статус. */
export function Readout({ label, display, unit, size = 'md', hint, signal, className, children }: ReadoutProps) {
  const f = useFormat();
  // Градус пишется вплотную к числу, остальные единицы — отдельно.
  const tight = display.ok && unit === f.t.units.deg;
  return (
    <div
      className={`readout readout--${size}${display.ok ? '' : ' is-missing'}${className ? ` ${className}` : ''}`}
      title={signal ? f.provenance(signal) : undefined}
    >
      <div className="readout__label">{label}</div>
      <div className="readout__value">
        <span className="readout__num">
          {display.text}
          {tight ? unit : null}
        </span>
        {display.ok && unit && !tight ? <span className="readout__unit">{unit}</span> : null}
        {!display.ok ? <StatusTag quality={display.quality} /> : null}
      </div>
      {hint ? <div className="readout__hint">{hint}</div> : null}
      {children}
    </div>
  );
}
