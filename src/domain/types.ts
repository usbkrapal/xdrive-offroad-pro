// Доменный контракт телеметрии. Не зависит от React и от транспорта.

export const WHEELS = ['FL', 'FR', 'RL', 'RR'] as const;
export type Wheel = (typeof WHEELS)[number];

/** Откуда значение получено во время работы. В этом релизе всегда mock. */
export type RuntimeSource = 'mock' | 'measured' | 'estimated';
/** Свежесть/пригодность конкретного отсчёта. Независимо от источника. */
export type Quality = 'valid' | 'stale' | 'unavailable' | 'invalid';
/** Исследовательский статус пути сигнала (SIGNALS.md), НЕ признак живого подключения. */
export type EvidenceStatus = 'confirmed' | 'likely' | 'unknown';

export type Unit =
  | 'deg'
  | 'deg_s'
  | 'm'
  | 'km_h'
  | 'nm'
  | 'percent'
  | 'mm'
  | 'celsius'
  | 'bar'
  | 'rpm'
  | 'g'
  | 'none';

export interface Signal<T> {
  readonly value: T | null;
  readonly unit: Unit;
  /** Время последнего обновления по часам симуляции, мс; null — значение не приходило. */
  readonly updatedAt: number | null;
  readonly runtimeSource: RuntimeSource;
  readonly quality: Quality;
  readonly evidenceStatus: EvidenceStatus;
}

/** Предложенная продуктовая шкала уровней; соответствие кодам G07 не подтверждено. */
export const SUSPENSION_LEVELS = ['offroad', 'high', 'normal', 'dynamic', 'sport', 'loading'] as const;
export type SupportedSuspensionLevel = (typeof SUSPENSION_LEVELS)[number];
export type SuspensionLevel = SupportedSuspensionLevel | 'unknown';

export type GearSelector = 'P' | 'R' | 'N' | 'D' | 'M';
export interface Gear {
  readonly selector: GearSelector;
  /** Номер ступени для D/M; null для P/R/N. */
  readonly gear: number | null;
}

export type HdcStatus = 'off' | 'standby' | 'active';
export type DiffLockState = 'open' | 'partial' | 'locked';

type PerWheel<P extends string, T> = { [W in Wheel as `${P}.${W}`]: T };

/** Полный набор сигналов прототипа и тип значения каждого. */
export type SignalValueMap = {
  'attitude.pitchDeg': number;
  'attitude.rollDeg': number;
  altitudeM: number;
  steeringWheelAngleDeg: number;
  vehicleSpeedKmh: number;
  gear: Gear;
  'engine.torqueNm': number;
  'engine.rpm': number;
  'engine.throttlePercent': number;
  acceleratorPedalPercent: number;
  'xdrive.frontPercent': number;
  'xdrive.rearPercent': number;
  'xdrive.frontTorqueNm': number;
  'xdrive.rearTorqueNm': number;
  'rearDiff.lockState': DiffLockState;
  'rearDiff.lockPercent': number;
  'suspension.level': SuspensionLevel;
  'temperature.gearboxC': number;
  'temperature.coolantC': number;
  'temperature.engineOilC': number;
  'hdc.status': HdcStatus;
  'hdc.setSpeedKmh': number;
  /** DSC включён (true) / выключен (false). */
  'dsc.status': boolean;
  /** Режим DTC активен (true) / нет (false). */
  'dtc.status': boolean;
  'acceleration.longG': number;
  'acceleration.latG': number;
  yawRateDegS: number;
} & PerWheel<'wheelSpeed', number> &
  PerWheel<'wheelSlip', number> &
  PerWheel<'brakeIntervention', boolean> &
  PerWheel<'suspensionHeight', number> &
  PerWheel<'tyrePressure', number> &
  PerWheel<'tyreTemperature', number>;

export type SignalId = keyof SignalValueMap;
export type SignalMap = { readonly [K in SignalId]: Signal<SignalValueMap[K]> };
/** Сырые значения генератора: отсутствие ключа = нет данных, NaN = недопустимое значение. */
export type RawFrame = { [K in SignalId]?: SignalValueMap[K] };

export const SCENARIO_IDS = ['mountainTrail', 'climb', 'diagonal', 'hdcDescent', 'partialLoss'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface TelemetrySnapshot {
  /** Монотонное время симуляции, мс. Не идёт во время паузы. */
  readonly simTimeMs: number;
  readonly scenarioId: ScenarioId;
  readonly signals: SignalMap;
}

export function wheelSignalId<P extends 'wheelSpeed' | 'wheelSlip' | 'brakeIntervention' | 'suspensionHeight' | 'tyrePressure' | 'tyreTemperature'>(
  prefix: P,
  wheel: Wheel,
): `${P}.${Wheel}` {
  return `${prefix}.${wheel}`;
}
