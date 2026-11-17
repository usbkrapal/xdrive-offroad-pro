// Чистая логика анимации схемы привода: какие эффекты движутся, с какой
// скоростью и с какой «нагрузкой». Без React и DOM — проверяется тестами.
import { usableNumber } from '../domain/signal';
import { WHEELS, type SignalMap, type Wheel } from '../domain/types';

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Нормировка нагрузки: момент двигателя и момент на оси (после трансмиссии). */
const ENGINE_NM_FULL = 700;
const AXLE_NM_FULL = 1600;
/** Ниже этой доли поток считается нулевым: валидный ~0 Нм не анимируется. */
export const MIN_LOAD = 0.02;

/** Откуда взята нагрузка оси: измеренный момент оси или доля × момент двигателя. */
export type LoadSource = 'axleTorque' | 'share';

/**
 * Знак момента: 'drive' — тяга (импульсы к колёсам), 'braking' — отрицательный
 * момент, торможение двигателем (статичная нейтральная нагрузка, без импульсов),
 * 'none' — валидный ~0. null — неизвестно.
 */
export type LoadDirection = 'drive' | 'braking' | 'none';

export interface AxleLoad {
  /** 0…1, модуль — только интенсивность; null — нагрузка неизвестна (нет/устарел сигнал). */
  readonly level: number | null;
  readonly source: LoadSource | null;
  readonly direction: LoadDirection | null;
}

export type EngineState = 'missing' | 'off' | 'running';

export interface MotionModel {
  readonly engine: EngineState;
  /** 0…1 доля оборотов для стабильной дуги; null — нет данных. */
  readonly rpmFrac: number | null;
  /** Нагрузка двигателя 0…1 (модуль); null — момент неизвестен. */
  readonly engineLoad: number | null;
  /** Знак момента двигателя; вращение входного вала от него не зависит. */
  readonly engineDirection: LoadDirection | null;
  readonly front: AxleLoad;
  readonly rear: AxleLoad;
  /** Известна ли скорость вращения оси (хотя бы одно колесо оси валидно, в т. ч. 0 км/ч). */
  readonly spinKnown: { readonly front: boolean; readonly rear: boolean };
  /**
   * Скорости фаз, циклов/с, всегда ≥ 0; 0 — стоит. input/front/rear — пакеты потока,
   * t{колесо} — протектор, eng — двигатель и АКПП, sf/sr — вращение передней/задней оси.
   */
  readonly rates: Record<string, number>;
  readonly anyMotion: boolean;
}

/** Импульсы по валу: циклов/с для эталонного вала (см. SHAFT_REF_LEN), с насыщением. */
const pulseRate = (level: number) => clamp(0.4 + 0.8 * level, 0.4, 1.2);
const inputRate = (rpm: number) => clamp(0.35 + rpm / 5000, 0.35, 1.2);
/** Ниже этой скорости колесо считается стоящим (валидный ~0 км/ч не крутится). */
export const MIN_ROLL_KMH = 0.05;
/** Протектор: км/ч → циклов/с, с насыщением. Нижний порог — чтобы ползущее
 *  на 1–2 км/ч колесо заметно катилось; валидный ~0 км/ч остаётся неподвижным. */
const treadRate = (kmh: number) => (Math.abs(kmh) < MIN_ROLL_KMH ? 0 : clamp(0.22 + Math.abs(kmh) / 32, 0.22, 1.6));
/** Среднее по известным скоростям колёс оси; null — ни одного валидного значения. */
const meanRate = (rates: (number | null)[]) => {
  const known = rates.filter((r): r is number => r !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
};

/** Длина эталонного вала (ед. изображения): скорости валов приводятся к ней, чтобы пакеты
 *  на коротких и длинных валах шли с одинаковой видимой скоростью. */
export const SHAFT_REF_LEN = 300;
/** Скорость фазы конкретного вала длиной len при скорости оси/входа rate. */
export const shaftRate = (rate: number, len: number) => (len > 0 ? (rate * SHAFT_REF_LEN) / len : 0);

const direction = (signedNm: number, level: number): LoadDirection =>
  level < MIN_LOAD ? 'none' : signedNm > 0 ? 'drive' : 'braking';

function axleLoad(axleNm: number | null, pct: number | null, engineNm: number | null): AxleLoad {
  if (axleNm !== null) {
    const level = clamp(Math.abs(axleNm) / AXLE_NM_FULL, 0, 1);
    return { level, source: 'axleTorque', direction: direction(axleNm, level) };
  }
  // Доля без живого момента двигателя не превращается в «активную» нагрузку.
  if (pct !== null && engineNm !== null) {
    const level = clamp(pct / 100, 0, 1) * clamp(Math.abs(engineNm) / ENGINE_NM_FULL, 0, 1);
    return { level, source: 'share', direction: direction(engineNm, level) };
  }
  return { level: null, source: null, direction: null };
}

/** Активен ли поток тяги на оси (импульсы движутся). Отрицательный момент — не поток. */
export const flowing = (a: AxleLoad) => a.direction === 'drive';
/** Отрицательный момент (торможение двигателем): статичная нагрузка без импульсов. */
export const braking = (a: AxleLoad) => a.direction === 'braking';

export function computeMotion(s: SignalMap): MotionModel {
  const rpm = usableNumber(s['engine.rpm']);
  const engineNm = usableNumber(s['engine.torqueNm']);
  const front = axleLoad(usableNumber(s['xdrive.frontTorqueNm']), usableNumber(s['xdrive.frontPercent']), engineNm);
  // Задняя ось — собственный момент, иначе собственная доля; «двигатель − перед» не вычисляется.
  const rear = axleLoad(usableNumber(s['xdrive.rearTorqueNm']), usableNumber(s['xdrive.rearPercent']), engineNm);
  const engineLoad = engineNm === null ? null : clamp(Math.abs(engineNm) / ENGINE_NM_FULL, 0, 1);

  const engine: EngineState = rpm === null ? 'missing' : rpm > 0 ? 'running' : 'off';
  const rates: Record<string, number> = {
    // Вращение входного вала — от оборотов, не от знака момента.
    input: engine === 'running' ? inputRate(rpm as number) : 0,
    front: flowing(front) ? pulseRate(front.level as number) : 0,
    rear: flowing(rear) ? pulseRate(rear.level as number) : 0,
  };
  const wheelRate: Record<Wheel, number | null> = { FL: null, FR: null, RL: null, RR: null };
  for (const w of WHEELS) {
    const ws = usableNumber(s[`wheelSpeed.${w}`]);
    wheelRate[w] = ws === null ? null : treadRate(ws);
    rates[`t${w}`] = wheelRate[w] ?? 0;
  }
  // Вращение агрегатов (без знака момента): двигатель/АКПП — от оборотов,
  // карданы и дифференциалы — от средней скорости колёс своей оси.
  const spinFront = meanRate([wheelRate.FL, wheelRate.FR]);
  const spinRear = meanRate([wheelRate.RL, wheelRate.RR]);
  rates.eng = rates.input;
  rates.sf = spinFront ?? 0;
  rates.sr = spinRear ?? 0;
  return {
    engine,
    rpmFrac: rpm === null ? null : clamp(rpm / 7000, 0, 1),
    engineLoad,
    engineDirection: engineNm === null || engineLoad === null ? null : direction(engineNm, engineLoad),
    front,
    rear,
    spinKnown: { front: spinFront !== null, rear: spinRear !== null },
    rates,
    anyMotion: Object.values(rates).some((r) => r > 0),
  };
}

export const halfShaftAxle = (w: Wheel): 'front' | 'rear' => (w === 'FL' || w === 'FR' ? 'front' : 'rear');

/**
 * Фаза в [0, 1). Все эффекты используют нормированный путь (pathLength=1),
 * а периоды штрихов делят 1 нацело — переход 1→0 бесшовный.
 */
export function advancePhase(phase: number, rate: number, dtSec: number): number {
  const p = (phase + rate * dtSec) % 1;
  return p < 0 ? p + 1 : p;
}

/** Периоды штрихов (доли пути); каждый обязан делить 1 нацело. */
export const DASH_PERIOD = { pulse1: 1, pulse2: 0.5, pulse3: 1 / 3, pulse4: 0.25, tread: 0.2 } as const;

/** Период штриха для n пакетов на валу (1…4). */
export const packetPeriod = (n: 1 | 2 | 3 | 4) => [DASH_PERIOD.pulse1, DASH_PERIOD.pulse2, DASH_PERIOD.pulse3, DASH_PERIOD.pulse4][n - 1];

/** Порог видимой пробуксовки шины, % (mock-визуализация): ниже — шина не подсвечивается. */
export const SLIP_VISIBLE_PCT = 10;
/** Порог сильной пробуксовки, %: толще янтарная кромка. */
export const SLIP_HIGH_PCT = 30;

/**
 * Поверхность шины: 'slip' — янтарь без тормоза, 'brake' — ровный красный,
 * 'brake-slip' — колесо буксует и DSC его подтормаживает: мигающий красный, без янтаря.
 * Торможение — только валидный brakeIntervention = true (null — нет/устарел/невалиден),
 * никогда не выводится из пробуксовки или момента двигателя.
 */
export type TyreSurface = 'normal' | 'slip' | 'brake' | 'brake-slip';

export function tyreSurface(brake: boolean | null, slipPct: number | null): TyreSurface {
  const slipping = slipPct !== null && slipPct >= SLIP_VISIBLE_PCT;
  if (brake === true) return slipping ? 'brake-slip' : 'brake';
  return slipping ? 'slip' : 'normal';
}

/**
 * Режим мигания шины: 'pulse' — фаза идёт, 'frozen' — пауза (фаза стоит на месте, после
 * продолжения идёт дальше), 'steady' — reduced-motion, ровный красный; 'none' — не мигает.
 */
export type TyreBlink = 'none' | 'pulse' | 'frozen' | 'steady';

export function tyreBlink(surface: TyreSurface, animating: boolean, reducedMotion: boolean): TyreBlink {
  if (surface !== 'brake-slip') return 'none';
  return reducedMotion ? 'steady' : animating ? 'pulse' : 'frozen';
}

/** Частота мигания красной шины (буксование + торможение), Гц: плавная пульсация, не строб. */
export const BLINK_HZ = 1.25;

/**
 * Яркость пульсации 0…1 по фазе мигания: 0 — тёмно-красный, 1 — ярко-красный.
 * CSS повторяет ту же формулу: 0.5 − 0.5·cos(--ph-blink · 360°).
 */
export const blinkLevel = (phase: number) => 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);
