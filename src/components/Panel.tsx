import type { ReactNode } from 'react';

interface PanelProps {
  title?: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Плоская панель: короткая полоса и тонкая линия сверху, заголовок капсом. */
export function Panel({ title, aside, className, children }: PanelProps) {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`} aria-label={title}>
      {title ? (
        <header className="panel__head">
          <h2 className="panel__title">{title}</h2>
          {aside ? <div className="panel__aside">{aside}</div> : null}
        </header>
      ) : null}
      <div className="panel__body">{children}</div>
    </section>
  );
}

/** Горизонтальная шкала 0..max (или симметричная для signed). Не рисует ничего для недоступного значения. */
export function BarGauge({
  value,
  min = 0,
  max,
  tone = 'ice',
  label,
}: {
  value: number | null;
  min?: number;
  max: number;
  tone?: 'ice' | 'warn' | 'dim';
  label?: string;
}) {
  const signed = min < 0;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  let left = 0;
  let width = 0;
  if (value !== null) {
    const pos = ((clamp(value) - min) / (max - min)) * 100;
    const zero = signed ? ((0 - min) / (max - min)) * 100 : 0;
    left = Math.min(pos, zero);
    width = Math.abs(pos - zero);
  }
  return (
    <div className={`bar${signed ? ' bar--signed' : ''}${value === null ? ' is-empty' : ''}`} aria-hidden={label ? undefined : true} aria-label={label}>
      {value !== null ? <div className={`bar__fill bar__fill--${tone}`} style={{ left: `${left}%`, width: `${width}%` }} /> : null}
    </div>
  );
}
