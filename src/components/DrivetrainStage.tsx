import { useEffect, useId, useRef, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { usableNumber, usableValue } from '../domain/signal';
import { WHEELS, type SignalMap, type Wheel } from '../domain/types';
import { displaySignal } from '../i18n/format';
import { gearText } from './displayHelpers';
import {
  advancePhase,
  BLINK_HZ,
  braking,
  clamp,
  computeMotion,
  flowing,
  halfShaftAxle,
  packetPeriod,
  shaftRate,
  SLIP_HIGH_PCT,
  SLIP_VISIBLE_PCT,
  tyreBlink,
  tyreSurface,
  type AxleLoad,
} from './motion';
import { useFormat, type Format } from './useFormat';
import xrayUrl from '../assets/xray-drivetrain.png';

/** Размер исходного PNG; изображение и оверлей живут в одной системе координат. */
const IMG_W = 1122;
const IMG_H = 1402;
/** Поля под выноски в полном режиме (в единицах исходного изображения). */
const SIDE = 640;

type Pt = readonly [number, number];

/** Опорные точки, сверенные с xray-drivetrain.png: перед — сверху, левый борт — слева. */
const A = {
  engine: [560, 175] as Pt,
  gearbox: [560, 390] as Pt,
  transfer: [560, 545] as Pt,
  frontDiff: [470, 350] as Pt,
  rearDiff: [560, 1010] as Pt,
};

/**
 * Видимая беговая дорожка каждой шины (маска протектора). Рамки чуть утоплены внутрь
 * силуэта резины на PNG, ось симметрии рендера — x≈561. Передние шины частично закрыты
 * кузовом — маска только по видимой части.
 */
const TYRE: Record<Wheel, { x: number; y: number; w: number; h: number }> = {
  FL: { x: 272, y: 216, w: 78, h: 234 },
  FR: { x: 772, y: 216, w: 78, h: 234 },
  RL: { x: 146, y: 850, w: 112, h: 244 },
  RR: { x: 864, y: 850, w: 112, h: 244 },
};
const CALIPER: Record<Wheel, Pt> = { FL: [338, 322], FR: [784, 322], RL: [276, 1000], RR: [846, 1000] };
/** Центры пружин стоек на рендере. */
const STRUT: Record<Wheel, Pt> = { FL: [380, 205], FR: [741, 205], RL: [298, 892], RR: [825, 892] };
const LEFT = (w: Wheel) => w === 'FL' || w === 'RL';

/** Профиль шины сверху: прямые торцы со скруглёнными плечами и слегка выпуклыми боковинами. */
function tyreOutline({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const rx = w * 0.3;
  const ry = Math.min(h * 0.1, 26);
  const b = w * 0.035;
  const r = x + w;
  const btm = y + h;
  return [
    `M${x + rx},${y} L${r - rx},${y} Q${r},${y} ${r},${y + ry}`,
    `Q${r + b},${y + h / 2} ${r},${btm - ry} Q${r},${btm} ${r - rx},${btm}`,
    `L${x + rx},${btm} Q${x},${btm} ${x},${btm - ry} Q${x - b},${y + h / 2} ${x},${y + ry} Q${x},${y} ${x + rx},${y} Z`,
  ].join(' ');
}

/** Шаг рисунка протектора и число шагов за один цикл фазы (целое — переход бесшовный). */
const LUG_PITCH = 24;
const LUG_STEPS = 8;

/** Ёлочка протектора: V-ламели с центральной канавкой, с запасом снизу на прокрутку. */
function treadPattern({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const cx = x + w / 2;
  const g = w * 0.07;
  const d = LUG_PITCH * 0.6;
  const parts: string[] = [];
  for (let yy = y - LUG_PITCH; yy <= y + h + LUG_PITCH * (LUG_STEPS + 1); yy += LUG_PITCH) {
    parts.push(`M${(x + w * 0.06).toFixed(1)},${(yy + d).toFixed(1)} L${(cx - g).toFixed(1)},${yy.toFixed(1)}`);
    parts.push(`M${(cx + g).toFixed(1)},${yy.toFixed(1)} L${(x + w * 0.94).toFixed(1)},${(yy + d).toFixed(1)}`);
  }
  return parts.join(' ');
}

/** Шестерня: n трапециевидных зубьев между rIn и rOut. */
function gearPath(cx: number, cy: number, rOut: number, rIn: number, n: number) {
  const pts: string[] = [];
  const step = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const a = i * step;
    for (const [da, r] of [
      [0, rIn],
      [step * 0.18, rOut],
      [step * 0.5, rOut],
      [step * 0.68, rIn],
    ] as const) {
      pts.push(`${(cx + r * Math.cos(a + da)).toFixed(2)},${(cy + r * Math.sin(a + da)).toFixed(2)}`);
    }
  }
  return `M${pts.join(' L')} Z`;
}

/** Цилиндры V8 под крышкой двигателя: два ряда по четыре; сдвиг фаз — порядок работы. */
const PISTONS: { x: number; y: number; off: number }[] = [
  [506, 0], [506, 270], [506, 90], [506, 180],
  [614, 180], [614, 90], [614, 270], [614, 0],
].map(([px, off], i) => ({ x: px, y: 122 + (i % 4) * 30, off }));
/** Ходов поршня за цикл фазы двигателя (целое — бесшовно). */
const PISTON_STROKES = 4;
/** Оборотов шестерни за цикл фазы. */
const GEAR_TURNS = 2;

/** Пружина стойки: зигзаг витков вдоль оси y от top, длиной len. */
function coilPath(cx: number, top: number, len: number, wid: number, turns = 5) {
  const n = turns * 2;
  const pts = [`M${cx},${top}`];
  for (let i = 1; i < n; i++) pts.push(`L${(cx + (i % 2 ? -1 : 1) * (wid / 2)).toFixed(1)},${(top + (len * i) / n).toFixed(1)}`);
  pts.push(`L${cx},${top + len}`);
  return pts.join(' ');
}
const COIL = { front: { len: 56, wid: 24 }, rear: { len: 60, wid: 26 } } as const;
/** Наибольшее растяжение/сжатие пружины на схеме (доля длины) при ±TRAVEL_MM. */
const COIL_STRETCH = 0.38;

/** Полос «вращения» на валу: период в ед. изображения и сдвиг периодов за цикл фазы. */
const SPIN_PERIOD = 28;
const SPIN_STEPS = 6;

type Packets = 1 | 2 | 3 | 4;
interface ShaftGeo {
  d: string;
  /** Приблизительная длина пути, ед. изображения — для единой видимой скорости пакетов. */
  len: number;
  /** Пакетов на валу: на длинных — больше, шаг ~100–130 ед. */
  n: Packets;
}

const PATH: { input: ShaftGeo; front: ShaftGeo; rear: ShaftGeo; half: Record<Wheel, ShaftGeo> } = {
  input: { d: 'M560,250 L560,515', len: 265, n: 2 },
  front: { d: 'M548,530 C520,500 488,440 478,372', len: 185, n: 2 },
  rear: { d: 'M562,580 L565,930 L560,975', len: 396, n: 4 },
  half: {
    FL: { d: 'M440,350 L320,342', len: 120, n: 1 },
    FR: { d: 'M500,350 L810,342', len: 310, n: 3 },
    RL: { d: 'M500,1014 L262,1010', len: 238, n: 2 },
    RR: { d: 'M620,1014 L860,1010', len: 240, n: 2 },
  },
};

const TRAVEL_MM = 120;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
function subscribeReducedMotion(cb: () => void) {
  const mq = typeof window === 'undefined' ? undefined : window.matchMedia?.(REDUCED_MOTION);
  if (!mq) return () => {};
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
const readReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION).matches === true;

/** Живое значение prefers-reduced-motion: переключение в системе действует сразу. */
function useReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);
}

/**
 * Плавные фазы анимации по реальному времени между тиками телеметрии (10 Гц).
 * Скорости читаются из ref, фазы (0…1, см. advancePhase) пишутся CSS-переменными
 * на корневой svg, поэтому React-рендер и новые отсчёты их не сбрасывают.
 * В паузе и при reduced-motion цикл rAF не работает, фазы стоят.
 */
function usePhases(ref: RefObject<SVGSVGElement | null>, rates: Record<string, number>, running: boolean) {
  const ratesRef = useRef(rates);
  ratesRef.current = rates;
  const phases = useRef<Record<string, number>>({});

  useEffect(() => {
    const el = ref.current;
    if (!running || !el) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, now - last) / 1000);
      last = now;
      for (const [k, r] of Object.entries(ratesRef.current)) {
        if (r === 0) continue;
        const p = advancePhase(phases.current[k] ?? 0, r, dt);
        phases.current[k] = p;
        el.style.setProperty(`--ph-${k}`, p.toFixed(4));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ref, running]);
}

/**
 * Сколько единиц viewBox приходится на один экранный пиксель (CSS-переменная --u на svg).
 * viewBox крупный (до 2402 ед.), поэтому толщины линий в CSS задаются в экранных пикселях:
 * calc(var(--u) * Npx). Без ResizeObserver (SSR/тесты) действует запасное значение из CSS.
 */
function useStageScale(ref: RefObject<SVGSVGElement | null>, vbW: number, vbH: number) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const scale = Math.min(width / vbW, height / vbH);
      // Верхний предел — чтобы на очень маленькой сцене свечение не закрывало рендер.
      el.style.setProperty('--u', clamp(1 / scale, 0.5, 6).toFixed(3));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, vbW, vbH]);
}

interface Callout {
  key: string;
  side: 'left' | 'right';
  y: number;
  anchor: Pt;
  label: string;
  /** Строки значения; при отсутствии данных — текстовый статус. */
  lines: string[];
  ok: boolean;
  title: string;
}

function CalloutView({ c }: { c: Callout }) {
  const left = c.side === 'left';
  const textX = left ? -SIDE + 40 : IMG_W + SIDE - 40;
  const edge = left ? -40 : IMG_W + 40;
  const elbow = left ? 70 : IMG_W - 70;
  return (
    <g className={`dts__callout${c.ok ? '' : ' is-missing'}`}>
      <title>{c.title}</title>
      <polyline points={`${edge},${c.y} ${elbow},${c.y} ${c.anchor[0]},${c.anchor[1]}`} className="dts__leader" />
      <circle cx={c.anchor[0]} cy={c.anchor[1]} r={9} className="dts__leader-dot" />
      <text x={textX} y={c.y - 22} textAnchor={left ? 'start' : 'end'} className="dts__callout-label">
        {c.label}
      </text>
      <text x={textX} y={c.y + 46} textAnchor={left ? 'start' : 'end'} className="dts__callout-value">
        {c.lines.map((l, i) => (
          <tspan key={i} x={textX} dy={i === 0 ? 0 : 64}>
            {l}
          </tspan>
        ))}
      </text>
    </g>
  );
}

type Part = { text: string; ok: boolean; unit?: string; quality: keyof Format['t']['quality'] };

/** Части значения → строки; если нет ни одной валидной — статус первой. */
function valueLines(f: Format, parts: Part[], join = false): { lines: string[]; ok: boolean } {
  if (!parts.some((p) => p.ok)) return { lines: [f.t.quality[parts[0].quality]], ok: false };
  const lines = parts.map((p) => (p.ok ? `${p.text}${p.unit ? ` ${p.unit}` : ''}` : `— ${f.t.quality[p.quality]}`));
  return { lines: join ? [lines.join(' · ')] : lines, ok: true };
}

/**
 * Прозрачная схема полного привода: статичный AI-рендер + SVG-слои показаний.
 * Это 2.5D визуализация данных, а не физическая модель: изображение не
 * деформируется, оверлеи только подсвечивают узлы по текущим сигналам.
 */
export function DrivetrainStage({ signals, paused, compact = false }: { signals: SignalMap; paused: boolean; compact?: boolean }) {
  const f = useFormat();
  const { t } = f;
  const svgRef = useRef<SVGSVGElement>(null);
  const s = signals;

  const rpm = usableNumber(s['engine.rpm']);
  const torque = usableNumber(s['engine.torqueNm']);
  const speed = usableNumber(s.vehicleSpeedKmh);
  const front = usableNumber(s['xdrive.frontPercent']);
  const rear = usableNumber(s['xdrive.rearPercent']);
  const gearboxC = usableNumber(s['temperature.gearboxC']);
  const lockState = usableValue(s['rearDiff.lockState']);
  const lockPct = usableNumber(s['rearDiff.lockPercent']);
  const wheel = Object.fromEntries(
    WHEELS.map((w) => [
      w,
      {
        speed: usableNumber(s[`wheelSpeed.${w}`]),
        slip: usableNumber(s[`wheelSlip.${w}`]),
        brake: usableValue(s[`brakeIntervention.${w}`]),
        height: usableNumber(s[`suspensionHeight.${w}`]),
      },
    ]),
  ) as Record<Wheel, { speed: number | null; slip: number | null; brake: boolean | null; height: number | null }>;

  const motion = computeMotion(s);
  // Валидные нули (0 об/мин, 0 км/ч) — это живые данные «стоим», а не потеря связи.
  const anyLive =
    motion.anyMotion ||
    [rpm, speed, torque, front, rear, gearboxC, lockPct, usableNumber(s['xdrive.frontTorqueNm'])].some((v) => v !== null) ||
    lockState !== null ||
    WHEELS.some((w) => Object.values(wheel[w]).some((v) => v !== null));

  // Фаза у каждого вала своя: скорость оси приводится к длине вала (см. shaftRate).
  const rates: Record<string, number> = {};
  for (const w of WHEELS) {
    rates[`t${w}`] = motion.rates[`t${w}`];
    rates[`h${w}`] = shaftRate(motion.rates[halfShaftAxle(w)], PATH.half[w].len);
  }
  rates.input = shaftRate(motion.rates.input, PATH.input.len);
  rates.front = shaftRate(motion.rates.front, PATH.front.len);
  rates.rear = shaftRate(motion.rates.rear, PATH.rear.len);
  // Вращение агрегатов — те же rAF-фазы, отдельных таймеров нет.
  rates.eng = motion.rates.eng;
  rates.sf = motion.rates.sf;
  rates.sr = motion.rates.sr;
  // Мигание шин «буксует + тормоз» — одна общая фаза на все колёса, тот же цикл rAF.
  const blinking = WHEELS.some((w) => tyreSurface(wheel[w].brake, wheel[w].slip) === 'brake-slip');
  rates.blink = blinking ? BLINK_HZ : 0;

  const vbX = compact ? -40 : -SIDE;
  const vbW = compact ? IMG_W + 80 : IMG_W + SIDE * 2;
  const reducedMotion = useReducedMotion();
  const animating = !paused && !reducedMotion;
  const phasesRunning = animating && (motion.anyMotion || blinking);
  usePhases(svgRef, rates, phasesRunning);
  useStageScale(svgRef, vbW, IMG_H);
  // Уникальные id clipPath/градиентов на экземпляр (useId содержит «:»/««»» — в url() их нет).
  const uid = `dts${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const running = motion.engine === 'running';
  const engineDrive = running && motion.engineDirection === 'drive';
  const driveLoad = engineDrive ? (motion.engineLoad ?? 0) : 0;
  const inputLoad: AxleLoad = { level: motion.engineLoad, source: null, direction: motion.engineDirection };
  /** Поворот шестерни по фазе; null — скорость неизвестна, шестерня стоит. */
  const turn = (phase: string, known: boolean, dir = 1, offDeg = 0): CSSProperties | undefined =>
    known ? { transform: `rotate(calc(var(--ph-${phase}, 0) * ${dir * GEAR_TURNS}turn + ${offDeg}deg))` } : offDeg ? { transform: `rotate(${offDeg}deg)` } : undefined;
  const estimate = motion.front.source === 'share' || motion.rear.source === 'share';
  const frontDrive = flowing(motion.front);
  const rearDrive = flowing(motion.rear);
  const axleLevel = (a: AxleLoad) => (flowing(a) ? (a.level ?? 0) : 0);
  /** Активность узла: 'is-load' — тяга, 'is-spin' — вращение без тяги (нейтрально). */
  const activity = (load: boolean, spin: boolean) => (load ? ' is-load' : spin ? ' is-spin' : '');
  const loadVar = (v: number) => ({ '--w': v.toFixed(3) }) as CSSProperties;

  // Блокировка заднего дифференциала: unknown ≠ open.
  const lockFrac = lockState === null ? null : lockPct !== null ? clamp(lockPct, 0, 100) / 100 : lockState === 'locked' ? 1 : lockState === 'open' ? 0 : null;
  const DIFF_R = 66;
  const diffCirc = 2 * Math.PI * DIFF_R;

  const pctText = (v: number | null) => (v === null ? '—' : `${f.value(v, 0)} ${t.units.percent}`);
  const pctPart = (sig: SignalMap['xdrive.frontPercent']): Part => ({ ...f.num(sig, 0), unit: t.units.percent });
  const engineVal = valueLines(f, [
    { ...f.num(s['engine.rpm'], 0), unit: t.units.rpm },
    { ...f.num(s['engine.torqueNm'], 0), unit: t.units.nm },
  ]);
  const gear = usableValue(s.gear);
  const gearboxVal = valueLines(
    f,
    [
      { text: gear ? gearText(gear) : '—', ok: gear !== null, quality: s.gear.quality === 'valid' && gear === null ? 'invalid' : s.gear.quality },
      { ...f.num(s['temperature.gearboxC'], 0), unit: t.units.celsius },
    ],
    true,
  );
  const frontVal = valueLines(f, [pctPart(s['xdrive.frontPercent'])]);
  const rearVal = valueLines(f, [pctPart(s['xdrive.rearPercent'])]);
  const splitText = (v: number | null) => (v === null ? '—' : f.value(v, 0));
  const splitVal = front !== null || rear !== null ? { lines: [`${splitText(front)} / ${splitText(rear)} ${t.units.percent}`], ok: true } : frontVal;
  const diffVal = valueLines(f, [
    displaySignal(s['rearDiff.lockState'], (v) => t.diffLock[v]),
    pctPart(s['rearDiff.lockPercent']),
  ]);
  // Неизвестное состояние блокировки — это статус, а не «открыт».
  if (lockState === null) diffVal.ok = false;
  const tip = (label: string, lines: string[], sig: SignalMap[keyof SignalMap]) => `${label}: ${lines.join(' · ')} — ${f.provenance(sig)}`;

  const callouts: Callout[] = [
    { key: 'engine', side: 'left', y: 100, anchor: [462, 125], label: t.drivetrain.engine, ...engineVal, title: tip(t.drivetrain.engine, engineVal.lines, s['engine.rpm']) },
    { key: 'front', side: 'left', y: 610, anchor: [A.frontDiff[0] - 24, A.frontDiff[1] + 20], label: t.drivetrain.frontAxle, ...frontVal, title: tip(t.drivetrain.frontAxle, frontVal.lines, s['xdrive.frontPercent']) },
    { key: 'rear', side: 'left', y: 1190, anchor: [500, 1032], label: t.drivetrain.rearAxle, ...rearVal, title: tip(t.drivetrain.rearAxle, rearVal.lines, s['xdrive.rearPercent']) },
    { key: 'gearbox', side: 'right', y: 440, anchor: [612, 420], label: t.drivetrain.gearbox, ...gearboxVal, title: tip(t.drivetrain.gearbox, gearboxVal.lines, s['temperature.gearboxC']) },
    { key: 'transfer', side: 'right', y: 640, anchor: [618, 560], label: t.drivetrain.transfer, ...splitVal, title: tip(t.drivetrain.transfer, splitVal.lines, s['xdrive.frontPercent']) },
    { key: 'diff', side: 'right', y: 1170, anchor: [A.rearDiff[0] + DIFF_R, A.rearDiff[1] + 14], label: t.drivetrain.rearDiff, ...diffVal, title: tip(t.drivetrain.rearDiff, diffVal.lines, s['rearDiff.lockState']) },
  ];

  const classes = ['dts', compact ? 'dts--compact' : 'dts--full', paused ? 'is-paused' : '', anyLive ? '' : 'is-lost'].filter(Boolean).join(' ');

  return (
    <figure className={classes} aria-label={t.drivetrain.aria} data-animating={phasesRunning ? 'true' : 'false'}>
      <svg ref={svgRef} className="dts__svg" viewBox={`${vbX} 0 ${vbW} ${IMG_H}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={t.drivetrain.aria}>
        <image href={xrayUrl} x={0} y={0} width={IMG_W} height={IMG_H} preserveAspectRatio="xMidYMid meet" className="dts__img" aria-hidden="true" />

        <defs>
          {/* Резина: тёмные плечи, светлее к середине беговой дорожки. */}
          <linearGradient id={`${uid}-rubber`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#030405" stopOpacity="0.92" />
            <stop offset="0.22" stopColor="#1a1f26" stopOpacity="0.78" />
            <stop offset="0.5" stopColor="#262c34" stopOpacity="0.72" />
            <stop offset="0.78" stopColor="#1a1f26" stopOpacity="0.78" />
            <stop offset="1" stopColor="#030405" stopOpacity="0.92" />
          </linearGradient>
          {/* Кривизна шины: беговая дорожка уходит вниз у торцов — затемнение по краям. */}
          <linearGradient id={`${uid}-curve`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#000" stopOpacity="0.85" />
            <stop offset="0.2" stopColor="#000" stopOpacity="0" />
            <stop offset="0.8" stopColor="#000" stopOpacity="0" />
            <stop offset="1" stopColor="#000" stopOpacity="0.85" />
          </linearGradient>
          <linearGradient id={`${uid}-sheen`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0.18" stopColor="#dfeaf6" stopOpacity="0" />
            <stop offset="0.36" stopColor="#dfeaf6" stopOpacity="0.14" />
            <stop offset="0.54" stopColor="#dfeaf6" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${uid}-slip`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffb020" stopOpacity="0.15" />
            <stop offset="0.5" stopColor="#ffb020" stopOpacity="0.75" />
            <stop offset="1" stopColor="#ffb020" stopOpacity="0.15" />
          </linearGradient>
          {/* Торможение: красная резина — тёмно-красные плечи, ярче к середине беговой дорожки. */}
          <linearGradient id={`${uid}-brake`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#5c0709" stopOpacity="0.95" />
            <stop offset="0.25" stopColor="#c81e22" stopOpacity="0.85" />
            <stop offset="0.5" stopColor="#ff3b3d" stopOpacity="0.85" />
            <stop offset="0.75" stopColor="#c81e22" stopOpacity="0.85" />
            <stop offset="1" stopColor="#5c0709" stopOpacity="0.95" />
          </linearGradient>
          {/* Яркая фаза мигания «буксует + тормоз»: красный ярче к середине дорожки, плечи темнее. */}
          <linearGradient id={`${uid}-brake-hot`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#b3141a" stopOpacity="0.85" />
            <stop offset="0.3" stopColor="#ff3034" stopOpacity="0.9" />
            <stop offset="0.5" stopColor="#ff5a5c" stopOpacity="0.95" />
            <stop offset="0.7" stopColor="#ff3034" stopOpacity="0.9" />
            <stop offset="1" stopColor="#b3141a" stopOpacity="0.85" />
          </linearGradient>
          {WHEELS.map((w) => (
            <clipPath key={w} id={`${uid}-tyre-${w}`}>
              <path d={tyreOutline(TYRE[w])} />
            </clipPath>
          ))}
        </defs>

        {/* Двигатель: поршни V8 под крышкой — ход по фазе оборотов; под тягой — циан. */}
        <g
          className={`dts__node dts__engine is-${motion.engine}${activity(engineDrive, running)}`}
          style={loadVar(driveLoad)}
          data-part="engine"
          data-state={motion.engine}
        >
          <title>{callouts[0].title}</title>
          {motion.engine === 'missing'
            ? null
            : PISTONS.map((p, i) => (
                <g
                  key={i}
                  className="dts__piston"
                  style={
                    running
                      ? {
                          transform: `scale(calc(0.8 + 0.2 * sin(calc(var(--ph-eng, 0) * ${PISTON_STROKES * 360}deg + ${p.off}deg))))`,
                          opacity: `calc(0.6 + 0.4 * sin(calc(var(--ph-eng, 0) * ${PISTON_STROKES * 360}deg + ${p.off}deg)))`,
                        }
                      : undefined
                  }
                >
                  <circle cx={p.x} cy={p.y} r={12} className="dts__piston-crown" />
                  <circle cx={p.x} cy={p.y} r={5} className="dts__piston-pin" />
                </g>
              ))}
        </g>
        <Shaft geo={PATH.input} load={inputLoad} rotating={running} phase="input" spin={motion.engine === 'missing' ? null : 'eng'} t={t} title={`${t.drivetrain.engine} → ${t.drivetrain.gearbox}`} />
        {/* АКПП: пара шестерён внутри картера вращается с двигателем; под тягой — циан. */}
        <g
          className={`dts__node dts__gearset${motion.engine === 'missing' ? ' is-missing' : gearboxC !== null && gearboxC >= 110 ? ' is-hot' : ''}${activity(engineDrive, running)}`}
          style={loadVar(driveLoad)}
          data-part="gearbox"
        >
          <title>{callouts[3].title}</title>
          <Gear cx={A.gearbox[0]} cy={A.gearbox[1] - 24} r={25} n={10} style={turn('eng', motion.engine !== 'missing')} />
          <Gear cx={A.gearbox[0]} cy={A.gearbox[1] + 21} r={25} n={10} style={turn('eng', motion.engine !== 'missing', -1, 18)} />
        </g>

        {/* Раздатка: шестерня внутри корпуса; вес — нагрузка осей, вращение — от оборотов. */}
        <g
          className={`dts__node dts__gearset${motion.engine === 'missing' ? ' is-missing' : ''}${activity(frontDrive || rearDrive, running)}`}
          style={loadVar(Math.max(axleLevel(motion.front), axleLevel(motion.rear)))}
          data-part="transfer"
        >
          <title>{callouts[4].title}</title>
          <Gear cx={A.transfer[0]} cy={A.transfer[1]} r={22} n={9} style={turn('eng', motion.engine !== 'missing')} />
        </g>
        <Shaft geo={PATH.front} load={motion.front} axle phase="front" spin={motion.spinKnown.front ? 'sf' : null} t={t} title={`${t.drivetrain.frontAxle}: ${pctText(front)}`} />
        <Shaft geo={PATH.rear} load={motion.rear} axle phase="rear" spin={motion.spinKnown.rear ? 'sr' : null} t={t} title={`${t.drivetrain.propShaft}: ${pctText(rear)}`} />
        {WHEELS.map((w) => {
          const axle = halfShaftAxle(w);
          return (
            <Shaft
              key={w}
              geo={PATH.half[w]}
              load={motion[axle]}
              axle
              phase={`h${w}`}
              spin={wheel[w].speed === null ? null : `t${w}`}
              thin
              t={t}
              title={`${t.drivetrain.halfShaft} ${t.wheels[w].short} ${w}`}
            />
          );
        })}

        {/* Дифференциалы вращаются со своей осью (скорость колёс); тяга — циан, без тяги — нейтрально. */}
        <g
          className={`dts__node dts__gearset${motion.spinKnown.front ? '' : ' is-missing'}${activity(frontDrive, motion.rates.sf > 0)}`}
          style={loadVar(axleLevel(motion.front))}
          data-part="front-diff"
        >
          <title>{t.drivetrain.frontDiff}</title>
          <Gear cx={A.frontDiff[0]} cy={A.frontDiff[1]} r={21} n={8} style={turn('sf', motion.spinKnown.front)} />
        </g>

        {/* Задний дифференциал: коронная шестерня внутри; стабильная дуга — степень блокировки, неизвестно — пунктир. */}
        <g
          className={`dts__node dts__gearset${lockState === null ? ' is-lock-missing' : ''}${motion.spinKnown.rear ? '' : ' is-missing'}${activity(rearDrive, motion.rates.sr > 0)}`}
          style={loadVar(axleLevel(motion.rear))}
          data-part="rear-diff"
        >
          <title>{callouts[5].title}</title>
          <Gear cx={A.rearDiff[0]} cy={A.rearDiff[1]} r={32} n={14} style={turn('sr', motion.spinKnown.rear)} />
          <circle cx={A.rearDiff[0]} cy={A.rearDiff[1]} r={DIFF_R} className="dts__diff-track" />
          {lockFrac !== null && lockFrac > 0 ? (
            <g className={`dts__diff-lock-g${lockState === 'locked' ? ' is-locked' : ''}`} transform={`rotate(-90 ${A.rearDiff[0]} ${A.rearDiff[1]})`}>
              {['dts__diff-lock-glow', 'dts__diff-lock'].map((cls) => (
                <circle
                  key={cls}
                  cx={A.rearDiff[0]}
                  cy={A.rearDiff[1]}
                  r={DIFF_R}
                  className={cls}
                  strokeDasharray={`${(lockFrac * diffCirc).toFixed(1)} ${diffCirc.toFixed(1)}`}
                />
              ))}
            </g>
          ) : null}
        </g>

        {WHEELS.map((w) => (
          <WheelLayer key={w} w={w} uid={uid} data={wheel[w]} rolling={motion.rates[`t${w}`] > 0} animating={animating} reducedMotion={reducedMotion} f={f} signals={s} />
        ))}

        {compact ? null : (
          <>
            {WHEELS.map((w) => {
              const tyre = TYRE[w];
              const x = LEFT(w) ? Math.min(tyre.x, 140) - 34 : Math.max(tyre.x + tyre.w, 982) + 34;
              return (
                <text key={w} x={x} y={tyre.y + tyre.h / 2 + 18} textAnchor={LEFT(w) ? 'end' : 'start'} className="dts__wheel">
                  <tspan className="dts__wheel-ru">{t.wheels[w].short}</tspan>
                  <tspan dx={14} className="dts__wheel-code">
                    {t.wheels[w].code}
                  </tspan>
                </text>
              );
            })}
            {callouts.map((c) => (
              <CalloutView key={c.key} c={c} />
            ))}
            <g className="dts__legend" transform={`translate(${IMG_W + SIDE - 40} 70)`}>
              <LegendRow y={0} cls="dts__legend-flow" label={estimate ? t.drivetrain.legendFlowEstimate : t.drivetrain.legendFlow} />
              <LegendRow y={52} cls="dts__legend-slip" label={t.drivetrain.legendSlip} />
              <LegendRow y={104} cls="dts__legend-brake" label={t.drivetrain.legendBrake} />
            </g>
            <text x={-SIDE + 40} y={1380} className="dts__legend-text">
              {t.drivetrain.legendTravel}
            </text>
          </>
        )}

        {anyLive ? null : (
          <text x={IMG_W / 2} y={IMG_H / 2} textAnchor="middle" className="dts__lost">
            {t.drivetrain.allLost}
          </text>
        )}
      </svg>
    </figure>
  );
}

function LegendRow({ y, cls, label }: { y: number; cls: string; label: string }) {
  return (
    <g transform={`translate(0 ${y})`}>
      <line x1={-70} y1={-14} x2={0} y2={-14} className={cls} />
      <text x={-90} y={0} textAnchor="end" className="dts__legend-text">
        {label}
      </text>
    </g>
  );
}

/**
 * Шестерня внутри картера. Невидимый круг r выравнивает рамку группы по центру —
 * вращение (transform-box: fill-box) идёт точно вокруг оси шестерни.
 */
function Gear({ cx, cy, r, n, style }: { cx: number; cy: number; r: number; n: number; style?: CSSProperties }) {
  return (
    <g className="dts__gear" style={style}>
      <circle cx={cx} cy={cy} r={r} className="dts__gear-box" />
      <path d={gearPath(cx, cy, r, r * 0.8, n)} className="dts__gear-teeth" />
      <circle cx={cx} cy={cy} r={r * 0.32} className="dts__gear-hub" />
      <line x1={cx} y1={cy - r * 0.32} x2={cx} y2={cy - r * 0.72} className="dts__gear-mark" />
    </g>
  );
}

/** Слои пакета (доли периода): длинный мягкий хвост → средний → яркое ядро; головы совпадают. */
const PULSE_LAYERS = [
  { cls: 'dts__pulse-tail', frac: 0.62 },
  { cls: 'dts__pulse-mid', frac: 0.3 },
  { cls: 'dts__pulse-core', frac: 0.1 },
] as const;

/**
 * Вал: всегда нейтральная дорожка. При тяге (момент > 0) — циановое ядро вала со свечением
 * и бегущие пакеты (на длинных валах несколько) по нормированному пути (pathLength=1);
 * толщина и яркость — по модулю нагрузки. Толщины задаются в CSS в экранных пикселях (--u).
 * Отрицательный момент (торможение двигателем) — статичная нейтральная полоса без импульсов.
 * Оси: load.level=null — нагрузка неизвестна, дорожка пунктиром. Входной вал (axle=false)
 * при оборотах > 0 вращается всегда; без тяги пакеты нейтральные, без ядра вала.
 * source='share' — визуальная оценка по доле оси, а не измеренные Нм.
 * spin — фаза вращения самого вала (двигатель / колёса оси): нейтральные поперечные
 * блики бегут по валу и без тяги; null — скорость неизвестна, бликов нет.
 */
function Shaft({
  geo,
  load,
  axle = false,
  rotating = false,
  phase,
  spin,
  thin = false,
  t,
  title,
}: {
  geo: ShaftGeo;
  load: AxleLoad;
  axle?: boolean;
  rotating?: boolean;
  phase: string;
  spin: string | null;
  thin?: boolean;
  t: Format['t'];
  title: string;
}) {
  const { d } = geo;
  const drive = flowing(load);
  const brakingLoad = braking(load);
  const on = axle ? drive : rotating;
  const period = packetPeriod(geo.n);
  // Модуль — только интенсивность; вес — только у тяги.
  const weight = drive ? (load.level ?? 0) : 0;
  const notes = [brakingLoad ? t.drivetrain.engineBraking : '', load.source === 'share' ? t.drivetrain.loadEstimate : ''].filter(Boolean);
  const classes = [
    'dts__shaft',
    drive ? ' is-drive' : ' is-unknown',
    thin ? ' is-thin' : '',
    axle && load.level === null ? ' is-missing' : '',
    load.source === 'share' ? ' is-estimate' : '',
  ].join('');
  const style = { '--w': weight.toFixed(3), '--wb': brakingLoad ? (load.level ?? 0).toFixed(3) : '0' } as CSSProperties;
  return (
    <g className={classes} style={style}>
      <title>{notes.length ? `${title} · ${notes.join(' · ')}` : title}</title>
      <path d={d} className="dts__track" />
      {spin ? (
        <path
          d={d}
          className="dts__spin"
          strokeDasharray={`${SPIN_PERIOD * 0.3} ${SPIN_PERIOD * 0.7}`}
          style={{ strokeDashoffset: `calc(var(--ph-${spin}, 0) * ${-SPIN_PERIOD * SPIN_STEPS})` }}
        />
      ) : null}
      {brakingLoad ? <path d={d} className="dts__load-static" /> : null}
      {drive && (axle || rotating) ? (
        <>
          <path d={d} className="dts__core-glow" />
          <path d={d} className="dts__core" />
        </>
      ) : null}
      {on ? (
        <g className="dts__pulse" style={{ opacity: drive ? 0.8 + weight * 0.2 : 0.7 }}>
          {PULSE_LAYERS.map((l) => {
            const len = period * l.frac;
            return (
              <path
                key={l.cls}
                d={d}
                pathLength={1}
                className={l.cls}
                strokeDasharray={`${len.toFixed(4)} ${(period - len).toFixed(4)}`}
                style={{ strokeDashoffset: `calc(${len.toFixed(4)} - var(--ph-${phase}, 0))` }}
              />
            );
          })}
        </g>
      ) : null}
    </g>
  );
}

function WheelLayer({
  w,
  uid,
  data,
  rolling,
  animating,
  reducedMotion,
  f,
  signals,
}: {
  w: Wheel;
  uid: string;
  data: { speed: number | null; slip: number | null; brake: boolean | null; height: number | null };
  /** Скорость фазы протектора > 0 (валидная ненулевая скорость колеса). */
  rolling: boolean;
  /** Цикл rAF работает: не пауза и не reduced-motion. */
  animating: boolean;
  /** prefers-reduced-motion: мигание заменяется ровным красным. */
  reducedMotion: boolean;
  f: Format;
  signals: SignalMap;
}) {
  const { t } = f;
  const tyre = TYRE[w];
  const [cx, cy] = CALIPER[w];
  const [sx, sy] = STRUT[w];
  const name = `${t.wheels[w].short} ${w}`;
  const slip = data.slip;
  const travel = f.num(signals[`suspensionHeight.${w}`], 0, true);
  const slipD = f.num(signals[`wheelSlip.${w}`], 0);
  const speedD = f.num(signals[`wheelSpeed.${w}`], 1);
  const brakeQ = signals[`brakeIntervention.${w}`].quality;
  // Дуга суппорта — со стороны колеса.
  const r = 40;
  const dir = LEFT(w) ? -1 : 1;
  const arc = `M${cx - dir * 6},${cy - r} A${r},${r} 0 0 ${dir > 0 ? 1 : 0} ${cx - dir * 6},${cy + r}`;
  // Пробуксовка: янтарная подсветка самой беговой дорожки, яркость — по величине.
  const slipFrac = slip === null ? 0 : clamp(slip, 0, 100) / 100;
  const slipLevel = slip === null || slip < SLIP_VISIBLE_PCT ? 'none' : slip >= SLIP_HIGH_PCT ? 'high' : 'slip';
  // Состояние протектора: missing — скорость неизвестна (рисунок стоит, приглушён),
  // stopped — валидный ~0 км/ч, frozen — колесо крутится, но пауза/reduced-motion.
  const tread = data.speed === null ? 'missing' : !rolling ? 'stopped' : animating ? 'rolling' : 'frozen';
  // Торможение — только по валидному brakeIntervention = true (не по моменту и не по буксованию).
  // Красная резина важнее янтарной пробуксовки; буксует + тормоз — красный мигает.
  const brakeOn = data.brake === true;
  const brakeState = data.brake === null ? 'missing' : brakeOn ? 'on' : 'off';
  const surface = tyreSurface(data.brake, slip);
  // Мигание идёт по общей фазе --ph-blink: в паузе фаза стоит (frozen), при reduced-motion — ровный красный.
  const blink = tyreBlink(surface, animating, reducedMotion);
  const pulsing = blink === 'pulse' || blink === 'frozen';
  const wash = 'calc(0.5 - 0.5 * cos(calc(var(--ph-blink, 0) * 360deg)))';
  const outline = tyreOutline(tyre);
  // Пружина: длиннее — выше нормы, короче — ниже; без данных — только пунктирный силуэт.
  const coil = w === 'FL' || w === 'FR' ? COIL.front : COIL.rear;
  const top = sy - coil.len / 2;
  const hn = data.height === null ? null : clamp(data.height, -TRAVEL_MM, TRAVEL_MM) / TRAVEL_MM;
  const stretch = hn === null ? 1 : 1 + hn * COIL_STRETCH;
  const coilD = coilPath(sx, top, coil.len, coil.wid);
  const capX = coil.wid * 0.75;

  return (
    <g className="dts__wheel-layer">
      <g
        className={`dts__tyre is-${tread}${brakeOn ? ' is-brake' : surface === 'slip' ? ` is-slip${slipLevel === 'high' ? ' is-slip-high' : ''}` : ''}${pulsing ? ' is-blink' : ''}`}
        data-wheel={w}
        data-tread={tread}
        data-slip={slipLevel}
        data-brake={brakeState}
        data-surface={surface}
        data-blink={blink}
      >
        <title>{`${t.drivetrain.wheel} ${name}: ${speedD.ok ? `${speedD.text} ${t.units.km_h}` : t.quality[speedD.quality]} · ${t.traction.slip} ${slipD.ok ? `${slipD.text} ${t.units.percent}` : t.quality[slipD.quality]}${brakeOn ? ` · ${t.drivetrain.brake}: ${t.brake.active}` : ''}`}</title>
        {/* Вся беговая дорожка внутри силуэта шины: резина, бегущая «ёлочка», объём и блик. */}
        <g clipPath={`url(#${uid}-tyre-${w})`}>
          <rect x={tyre.x - 4} y={tyre.y} width={tyre.w + 8} height={tyre.h} fill={`url(#${uid}-rubber)`} />
          {/* Торможение красит саму резину под протектором: ламели и объём остаются видны поверх. */}
          {brakeOn ? <rect x={tyre.x - 4} y={tyre.y} width={tyre.w + 8} height={tyre.h} fill={`url(#${uid}-brake)`} className="dts__tyre-brake" /> : null}
          {/* Буксует + тормоз: яркий красный слой пульсирует поверх тёмно-красного, протектор — над ним. */}
          {pulsing ? (
            <rect x={tyre.x - 4} y={tyre.y} width={tyre.w + 8} height={tyre.h} fill={`url(#${uid}-brake-hot)`} className="dts__tyre-blink" style={{ opacity: wash }} />
          ) : null}
          <g
            className="dts__tread-roll"
            style={tread === 'missing' ? undefined : { transform: `translateY(calc(var(--ph-t${w}, 0) * ${-LUG_PITCH * LUG_STEPS}px))` }}
          >
            <path d={treadPattern(tyre)} className="dts__tread-lug" />
          </g>
          {surface === 'slip' ? (
            <rect x={tyre.x - 4} y={tyre.y} width={tyre.w + 8} height={tyre.h} fill={`url(#${uid}-slip)`} className="dts__tyre-slip" style={{ opacity: 0.35 + slipFrac * 0.6 }} />
          ) : null}
          <rect x={tyre.x - 4} y={tyre.y} width={tyre.w + 8} height={tyre.h} fill={`url(#${uid}-sheen)`} />
          <rect x={tyre.x - 4} y={tyre.y} width={tyre.w + 8} height={tyre.h} fill={`url(#${uid}-curve)`} />
        </g>
        {brakeOn ? <path d={outline} className="dts__tyre-brake-glow" style={pulsing ? { opacity: `calc(0.35 + 0.65 * ${wash})` } : undefined} /> : null}
        <path d={outline} className="dts__tyre-edge" />
      </g>
      <g>
        <title>{`${t.drivetrain.brake} ${name}: ${data.brake === null ? t.quality[brakeQ === 'valid' ? 'invalid' : brakeQ] : data.brake ? t.brake.active : t.brake.inactive}`}</title>
        {data.brake === true ? (
          <>
            <path d={arc} className="dts__brake-glow" />
            <path d={arc} className="dts__brake" />
          </>
        ) : data.brake === null ? (
          <path d={arc} className="dts__brake-missing" />
        ) : null}
      </g>
      <g className={`dts__strut${hn === null ? ' is-missing' : hn >= 0 ? ' is-up' : ' is-down'}`} data-strut={w} data-height={hn === null ? 'missing' : 'valid'}>
        <title>{`${t.drivetrain.strut} ${name}: ${travel.ok ? `${travel.text} ${t.units.mm}` : t.quality[travel.quality]}`}</title>
        {/* Номинальная длина — тонкий силуэт; поверх — пружина, растянутая/сжатая от верхней опоры. */}
        <path d={coilD} className="dts__coil-ghost" />
        <line x1={sx - capX} y1={top} x2={sx + capX} y2={top} className="dts__coil-cap" />
        {hn !== null ? (
          <>
            <path d={coilD} className="dts__coil-glow dts__coil-stretch" style={{ transform: `scaleY(${stretch.toFixed(3)})` }} />
            <path d={coilD} className="dts__coil dts__coil-stretch" style={{ transform: `scaleY(${stretch.toFixed(3)})` }} />
            <line
              x1={sx - capX}
              y1={top + coil.len}
              x2={sx + capX}
              y2={top + coil.len}
              className="dts__coil-cap is-moving"
              style={{ transform: `translateY(${((stretch - 1) * coil.len).toFixed(1)}px)` }}
            />
          </>
        ) : null}
      </g>
    </g>
  );
}
