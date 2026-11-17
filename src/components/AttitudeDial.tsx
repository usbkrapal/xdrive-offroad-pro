import { useId } from 'react';
import { usableNumber } from '../domain/signal';
import type { Signal } from '../domain/types';
import { Readout } from './Readout';
import { useFormat } from './useFormat';
import sideUrl from '../assets/pitch-side-v2.png';
import rearUrl from '../assets/roll-rear-v2.png';

type Kind = 'pitch' | 'roll';

const LABELED = [-40, -20, 0, 20, 40];
/** Шкала фиксирована: ±45° от нуля; дальше машина и указатель упираются в край. */
const ARC_SPAN = 45;
const TICK_STEP = 5;

/**
 * Круглый прибор в квадратном viewBox (центр вращения — 0,0), meet — круг не становится овалом.
 * BEZEL — внешний край ободка, FACE — тёмный циферблат, R — внешний край рисок (они внутри
 * циферблата), цифры — на ободке, R_NUM. Спрайты в пропорциях PNG: pitch-side-v2 2172×724 (3:1),
 * roll-rear-v2 1448×1086 (4:3). Полудиагональ спрайта (~103) меньше внутреннего края рисок,
 * поэтому повёрнутая машина не наезжает на шкалу.
 */
const VB = 150;
const BEZEL = 148;
const FACE = 121;
const R = 118;
const R_NUM = 135;
const SPRITE = {
  pitch: { href: sideUrl, w: 195, h: 65 },
  roll: { href: rearUrl, w: 164, h: 123 },
} as const;

function polar(kind: Kind, a: number, r: number) {
  // pitch: шкала справа, + вверх (против часовой); roll: шкала сверху, + вправо (по часовой).
  const rad = kind === 'pitch' ? (-a * Math.PI) / 180 : ((a - 90) * Math.PI) / 180;
  return { x: r * Math.cos(rad), y: r * Math.sin(rad) };
}

const fx = (v: number) => v.toFixed(2);

/** Дуга радиуса r от угла a0 до a1 (в градусах шкалы); mirror — зеркальная сторона тангажа. */
function arc(kind: Kind, r: number, a0: number, a1: number, mirror = false) {
  const p0 = polar(kind, a0, r);
  const p1 = polar(kind, a1, r);
  const m = mirror ? -1 : 1;
  // Рост угла шкалы: pitch — против часовой (sweep 0), roll — по часовой (sweep 1); зеркало меняет направление.
  const inc = a1 > a0;
  const sweep = (kind === 'pitch' ? !inc : inc) !== mirror ? 1 : 0;
  return `M${fx(p0.x * m)},${fx(p0.y)} A${r},${r} 0 0 ${sweep} ${fx(p1.x * m)},${fx(p1.y)}`;
}

function tick(kind: Kind, a: number, r1: number, r2: number, mirror = false) {
  const p1 = polar(kind, a, r1);
  const p2 = polar(kind, a, r2);
  const m = mirror ? -1 : 1;
  return { x1: fx(p1.x * m), y1: fx(p1.y), x2: fx(p2.x * m), y2: fx(p2.y) };
}

const TICKS = Array.from({ length: (ARC_SPAN * 2) / TICK_STEP + 1 }, (_, i) => -ARC_SPAN + i * TICK_STEP);

function Scale({ kind, mirror = false, labels, fmt }: { kind: Kind; mirror?: boolean; labels: boolean; fmt: (a: number) => string }) {
  return (
    <g className="att__scale">
      {TICKS.map((a) => {
        const major = a % 20 === 0;
        const zero = a === 0;
        const cls = zero ? 'att__tick att__tick--zero' : major ? 'att__tick att__tick--major' : 'att__tick';
        return <line key={a} {...tick(kind, a, zero ? R - 16 : major ? R - 13 : R - 8, zero ? FACE + 1 : R, mirror)} className={cls} />;
      })}
      {labels
        ? LABELED.map((a) => {
            const p = polar(kind, a, R_NUM);
            return (
              <text key={a} x={fx(p.x)} y={fx(p.y)} className={`att__num${a === 0 ? ' att__num--zero' : ''}`} textAnchor="middle" dominantBaseline="central">
                {fmt(a)}
              </text>
            );
          })
        : null}
    </g>
  );
}

/**
 * Прибор тангажа/крена: круглый многослойный ободок с цифрами, тёмный круглый циферблат
 * с фиксированными рисками ±45°; рендер автомобиля и указатель вращаются вместе по значению.
 * +тангаж — нос вверх, +крен — наклон вправо. Нет данных — без указателя и без «0°».
 */
export function AttitudeDial({ kind, signal, paused = false }: { kind: Kind; signal: Signal<number>; paused?: boolean }) {
  const f = useFormat();
  const { t } = f;
  const uid = `att${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const value = usableNumber(signal);
  const display = f.num(signal, 1, true);
  const shown = value === null ? 0 : Math.max(-ARC_SPAN, Math.min(ARC_SPAN, value));
  // SVG: положительный rotate — по часовой. Нос вверх = против часовой; крен вправо = по часовой.
  const rotation = kind === 'pitch' ? -shown : shown;
  const label = kind === 'pitch' ? t.attitude.pitch : t.attitude.roll;
  const hint = kind === 'pitch' ? t.attitude.pitchHint : t.attitude.rollHint;
  const aria = `${kind === 'pitch' ? t.attitude.pitchAria : t.attitude.rollAria}: ${
    display.ok ? `${display.text}${t.units.deg}` : t.quality[display.quality]
  }`;
  const g = SPRITE[kind];
  const fmt = (a: number) => f.value(a, 0, true);
  const mag = Math.abs(shown);
  const pos = shown >= 0;
  // Указатель — на рисках шкалы, ось — от края машины до основания указателя.
  const tipR = R + 1;
  const baseR = R - 12;

  return (
    <div className={`attitude attitude--${kind}${display.ok ? '' : ' is-missing'}${paused ? ' is-paused' : ''}`}>
      <svg
        className="attitude__dial"
        viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={aria}
        data-kind={kind}
        data-state={display.ok ? 'valid' : 'missing'}
      >
        <defs>
          <linearGradient id={`${uid}-bezel`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3a4654" />
            <stop offset="0.45" stopColor="#18202a" />
            <stop offset="1" stopColor="#090c11" />
          </linearGradient>
          <radialGradient id={`${uid}-face`} cx="0.5" cy="0.42" r="0.6">
            <stop offset="0" stopColor="#16202c" />
            <stop offset="0.7" stopColor="#0a0f15" />
            <stop offset="1" stopColor="#040609" />
          </radialGradient>
          <linearGradient id={`${uid}-glass`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#cfe6ff" stopOpacity="0.09" />
            <stop offset="0.5" stopColor="#cfe6ff" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${uid}-face-clip`}>
            <circle r={FACE} />
          </clipPath>
        </defs>

        {/* Круглый многослойный ободок и тёмный циферблат; неподвижный горизонт внутри. */}
        <g className="att__bezel">
          <circle r={BEZEL} fill={`url(#${uid}-bezel)`} className="att__bezel-outer" />
          <circle r={BEZEL - 4} className="att__bezel-ring" />
          <circle r={FACE + 2} className="att__bezel-inner" />
          <circle r={FACE} fill={`url(#${uid}-face)`} className="att__face" />
          <circle r={R} className="att__track" />
          <line x1={-FACE + 4} y1={0} x2={FACE - 4} y2={0} className="att__horizon" />
        </g>

        <Scale kind={kind} labels fmt={fmt} />
        {kind === 'pitch' ? <Scale kind={kind} mirror labels={false} fmt={fmt} /> : null}

        {/* Значение на шкале: дуга от нуля к текущему углу по краю циферблата (шкала не вращается). */}
        {display.ok && mag > 0.05 ? (
          <path d={arc(kind, R, 0, pos ? ARC_SPAN : -ARC_SPAN)} pathLength={ARC_SPAN} className="att__value" strokeDasharray={`${mag.toFixed(2)} ${ARC_SPAN + 1}`} />
        ) : null}

        <g className="att__vehicle" style={{ transform: `rotate(${rotation}deg)` }}>
          <image
            href={g.href}
            x={-g.w / 2}
            y={-g.h / 2}
            width={g.w}
            height={g.h}
            preserveAspectRatio="xMidYMid meet"
            clipPath={`url(#${uid}-face-clip)`}
            className="att__sprite"
            aria-hidden="true"
          />
          {display.ok ? (
            kind === 'pitch' ? (
              <>
                <line x1={g.w / 2 + 2} y1={0} x2={baseR} y2={0} className="att__axis" />
                <line x1={-g.w / 2 - 2} y1={0} x2={-baseR} y2={0} className="att__axis" />
                <path d={`M${tipR},0 L${baseR},-5.5 L${baseR},5.5 Z`} className="att__pointer" />
              </>
            ) : (
              <>
                <line x1={0} y1={-g.h / 2 - 2} x2={0} y2={-baseR} className="att__axis" />
                <path d={`M0,${-tipR} L-5.5,${-baseR} L5.5,${-baseR} Z`} className="att__pointer" />
              </>
            )
          ) : null}
        </g>

        {/* Блик стекла поверх всего — круглый, без рамки. */}
        <circle r={FACE} fill={`url(#${uid}-glass)`} className="att__glass" pointerEvents="none" />
      </svg>
      <Readout label={label} display={display} unit={t.units.deg} size="xl" hint={hint} signal={signal} className="attitude__readout" />
    </div>
  );
}
