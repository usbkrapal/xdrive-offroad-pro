import type { ReactNode } from 'react';
import { WHEELS, type Wheel } from '../domain/types';
import { useT } from '../i18n';
import schematicUrl from '../assets/topdown-schematic-v2.png';

/** Размер topdown-schematic-v2.png; схема и оверлеи живут в его координатах (перед — вверху). */
export const TOP_W = 887;
export const TOP_H = 1774;
/** Поле над капотом под метку «ПЕРЕД». */
const TOP_PAD = 84;
/** Боковые поля под подписи колёс (подписи стоят в прозрачной зоне рядом с шиной). */
const SIDE_PAD = 24;

/** Центры шин на рендере. */
export const WHEEL_POS: Readonly<Record<Wheel, { x: number; y: number }>> = {
  FL: { x: 150, y: 440 },
  FR: { x: 738, y: 440 },
  RL: { x: 150, y: 1426 },
  RR: { x: 738, y: 1426 },
};
/** Видимая шина на рендере (ширина × длина). */
export const TYRE_W = 84;
export const TYRE_H = 276;
/** Пружины стоек на рендере — сюда крепятся оверлеи высоты. */
export const SPRING_POS: Readonly<Record<Wheel, { x: number; y: number }>> = {
  FL: { x: 283, y: 412 },
  FR: { x: 604, y: 412 },
  RL: { x: 283, y: 1420 },
  RR: { x: 604, y: 1420 },
};

interface TopDownCarProps {
  ariaLabel: string;
  /** Дополнительный класс для каждой шины (состояние). */
  tyreClass?: Partial<Record<Wheel, string>>;
  /** Слой под кузовом (например, трансмиссия). */
  under?: ReactNode;
  /** Слой поверх кузова. */
  over?: ReactNode;
  showLabels?: boolean;
  className?: string;
}

/** Схема крупного SUV сверху (общий рендер) с четырьмя подписанными колёсами. */
export function TopDownCar({ ariaLabel, tyreClass, under, over, showLabels = true, className }: TopDownCarProps) {
  const t = useT();
  const pad = showLabels ? SIDE_PAD : 0;
  const cx = TOP_W / 2;
  return (
    <svg
      className={`topcar${className ? ` ${className}` : ''}`}
      viewBox={`${-pad} ${-TOP_PAD} ${TOP_W + pad * 2} ${TOP_H + TOP_PAD}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel}
    >
      <path d={`M${cx},${-TOP_PAD + 6} L${cx + 22},${-TOP_PAD + 40} L${cx - 22},${-TOP_PAD + 40} Z`} className="topcar__front" />
      <text x={cx} y={-6} textAnchor="middle" className="topcar__front-label">
        {t.terrain.front}
      </text>
      {under}
      <image href={schematicUrl} x={0} y={0} width={TOP_W} height={TOP_H} preserveAspectRatio="xMidYMid meet" className="topcar__img" aria-hidden="true" />
      {WHEELS.map((w) => {
        const p = WHEEL_POS[w];
        return (
          <rect
            key={w}
            x={p.x - TYRE_W / 2 - 6}
            y={p.y - TYRE_H / 2 - 6}
            width={TYRE_W + 12}
            height={TYRE_H + 12}
            rx={22}
            vectorEffect="non-scaling-stroke"
            className={`topcar__tyre ${tyreClass?.[w] ?? ''}`}
            data-wheel={w}
          />
        );
      })}
      {over}
      {showLabels
        ? WHEELS.map((w) => {
            const p = WHEEL_POS[w];
            const left = w === 'FL' || w === 'RL';
            const x = left ? p.x - TYRE_W / 2 - 16 : p.x + TYRE_W / 2 + 16;
            return (
              <text key={w} x={x} y={p.y - 6} textAnchor={left ? 'end' : 'start'} className="topcar__label">
                <tspan className="topcar__label-ru">{t.wheels[w].short}</tspan>
                <tspan x={x} dy="46" className="topcar__label-code">
                  {t.wheels[w].code}
                </tspan>
              </text>
            );
          })
        : null}
    </svg>
  );
}
