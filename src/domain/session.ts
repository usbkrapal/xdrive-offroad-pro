import { cornerHeights, heightDeltas } from './derived';
import { usableNumber } from './signal';
import { WHEELS, type Signal, type TelemetrySnapshot, type Wheel } from './types';

export interface Extremum {
  readonly value: number;
  /** simTime отсчёта, на котором достигнут экстремум. */
  readonly atMs: number;
}

export interface WheelExtremum extends Extremum {
  readonly wheel: Wheel;
}

/**
 * Сессионные агрегаты. null — ещё не было ни одного валидного отсчёта.
 * Ничего не инициализируется нулём: первый валидный отсчёт становится базой.
 */
export interface SessionStats {
  readonly startedAtMs: number;
  readonly lastSampleMs: number;
  readonly sampleCount: number;
  readonly maxAbsPitch: Extremum | null;
  readonly maxAbsRoll: Extremum | null;
  readonly minAltitude: Extremum | null;
  readonly maxAltitude: Extremum | null;
  /** Первая валидная высота сессии — для «изменения от старта». */
  readonly startAltitude: Extremum | null;
  readonly maxSlip: Readonly<Record<Wheel, Extremum | null>>;
  readonly maxSlipOverall: WheelExtremum | null;
  readonly maxEngineTorque: Extremum | null;
  readonly maxGearboxTemp: Extremum | null;
  readonly maxOilTemp: Extremum | null;
  readonly maxCoolantTemp: Extremum | null;
  readonly maxHeightRange: Extremum | null;
}

function emptySession(startedAtMs: number): SessionStats {
  return {
    startedAtMs,
    lastSampleMs: startedAtMs,
    sampleCount: 0,
    maxAbsPitch: null,
    maxAbsRoll: null,
    minAltitude: null,
    maxAltitude: null,
    startAltitude: null,
    maxSlip: { FL: null, FR: null, RL: null, RR: null },
    maxSlipOverall: null,
    maxEngineTorque: null,
    maxGearboxTemp: null,
    maxOilTemp: null,
    maxCoolantTemp: null,
    maxHeightRange: null,
  };
}

function keepMax(prev: Extremum | null, value: number | null, atMs: number): Extremum | null {
  if (value === null) return prev;
  return prev === null || value > prev.value ? { value, atMs } : prev;
}

function keepMin(prev: Extremum | null, value: number | null, atMs: number): Extremum | null {
  if (value === null) return prev;
  return prev === null || value < prev.value ? { value, atMs } : prev;
}

function abs(signal: Signal<number>): number | null {
  const v = usableNumber(signal);
  return v === null ? null : Math.abs(v);
}

export interface SessionMeasurements {
  readonly wheelPercent: Readonly<Record<Wheel, number | null>>;
  readonly heightRange: number | null;
}

/** Добавляет отсчёт в сессию. Повтор того же simTime (пауза) ничего не меняет. */
export function ingestSample(session: SessionStats, snapshot: TelemetrySnapshot, measurements?: SessionMeasurements): SessionStats {
  const t = snapshot.simTimeMs;
  if (session.sampleCount > 0 && t <= session.lastSampleMs) return session;
  const s = snapshot.signals;

  const altitude = usableNumber(s.altitudeM);
  const maxSlip = { ...session.maxSlip };
  let maxSlipOverall = session.maxSlipOverall;
  for (const w of WHEELS) {
    const v = measurements ? measurements.wheelPercent[w] : usableNumber(s[`wheelSlip.${w}`]);
    maxSlip[w] = keepMax(maxSlip[w], v, t);
    if (v !== null && (maxSlipOverall === null || v > maxSlipOverall.value)) {
      maxSlipOverall = { value: v, atMs: t, wheel: w };
    }
  }

  return {
    ...session,
    lastSampleMs: t,
    sampleCount: session.sampleCount + 1,
    maxAbsPitch: keepMax(session.maxAbsPitch, abs(s['attitude.pitchDeg']), t),
    maxAbsRoll: keepMax(session.maxAbsRoll, abs(s['attitude.rollDeg']), t),
    minAltitude: keepMin(session.minAltitude, altitude, t),
    maxAltitude: keepMax(session.maxAltitude, altitude, t),
    startAltitude: session.startAltitude ?? (altitude === null ? null : { value: altitude, atMs: t }),
    maxSlip,
    maxSlipOverall,
    maxEngineTorque: keepMax(session.maxEngineTorque, usableNumber(s['engine.torqueNm']), t),
    maxGearboxTemp: keepMax(session.maxGearboxTemp, usableNumber(s['temperature.gearboxC']), t),
    maxOilTemp: keepMax(session.maxOilTemp, usableNumber(s['temperature.engineOilC']), t),
    maxCoolantTemp: keepMax(session.maxCoolantTemp, usableNumber(s['temperature.coolantC']), t),
    maxHeightRange: keepMax(session.maxHeightRange, measurements ? measurements.heightRange : heightDeltas(cornerHeights(snapshot)).range, t),
  };
}

/** Новая сессия: текущий отсчёт служит первым измерением (его невалидные поля пропускаются). */
export function createSession(snapshot: TelemetrySnapshot, measurements?: SessionMeasurements): SessionStats {
  return ingestSample(emptySession(snapshot.simTimeMs), snapshot, measurements);
}

export function sessionElapsedMs(session: SessionStats, nowSimMs: number): number {
  return Math.max(0, nowSimMs - session.startedAtMs);
}

/** Изменение высоты относительно первого валидного отсчёта сессии; не сумма набора. */
export function altitudeChangeFromStart(session: SessionStats, snapshot: TelemetrySnapshot): number | null {
  const now = usableNumber(snapshot.signals.altitudeM);
  if (now === null || session.startAltitude === null) return null;
  return now - session.startAltitude.value;
}
