import { WHEELS, type EvidenceStatus, type SignalId, type Unit, type Wheel } from './types';

export interface SignalSpec {
  readonly unit: Unit;
  /** Исследовательский статус из SIGNALS.md (аудит upstream, не проверка на G07). */
  readonly evidence: EvidenceStatus;
  /** Возраст отсчёта, после которого он считается устаревшим. */
  readonly staleAfterMs: number;
}

const FAST = 600;
const MEDIUM = 1500;
const SLOW = 4000;
const TPMS = 8000;

function perWheel<P extends string>(prefix: P, spec: SignalSpec): { [W in Wheel as `${P}.${W}`]: SignalSpec } {
  return Object.fromEntries(WHEELS.map((w) => [`${prefix}.${w}`, spec])) as {
    [W in Wheel as `${P}.${W}`]: SignalSpec;
  };
}

/** Каталог сигналов. evidence соответствует таблице SIGNALS.md. */
export const SIGNAL_CATALOG: { readonly [K in SignalId]: SignalSpec } = {
  'attitude.pitchDeg': { unit: 'deg', evidence: 'unknown', staleAfterMs: FAST },
  'attitude.rollDeg': { unit: 'deg', evidence: 'unknown', staleAfterMs: FAST },
  altitudeM: { unit: 'm', evidence: 'unknown', staleAfterMs: SLOW },
  steeringWheelAngleDeg: { unit: 'deg', evidence: 'confirmed', staleAfterMs: FAST },
  vehicleSpeedKmh: { unit: 'km_h', evidence: 'confirmed', staleAfterMs: FAST },
  gear: { unit: 'none', evidence: 'confirmed', staleAfterMs: MEDIUM },
  'engine.torqueNm': { unit: 'nm', evidence: 'confirmed', staleAfterMs: FAST },
  'engine.rpm': { unit: 'rpm', evidence: 'confirmed', staleAfterMs: FAST },
  'engine.throttlePercent': { unit: 'percent', evidence: 'confirmed', staleAfterMs: MEDIUM },
  acceleratorPedalPercent: { unit: 'percent', evidence: 'confirmed', staleAfterMs: FAST },
  'xdrive.frontPercent': { unit: 'percent', evidence: 'confirmed', staleAfterMs: MEDIUM },
  'xdrive.rearPercent': { unit: 'percent', evidence: 'confirmed', staleAfterMs: MEDIUM },
  'xdrive.frontTorqueNm': { unit: 'nm', evidence: 'confirmed', staleAfterMs: MEDIUM },
  'xdrive.rearTorqueNm': { unit: 'nm', evidence: 'unknown', staleAfterMs: MEDIUM },
  'rearDiff.lockState': { unit: 'none', evidence: 'unknown', staleAfterMs: MEDIUM },
  'rearDiff.lockPercent': { unit: 'percent', evidence: 'unknown', staleAfterMs: MEDIUM },
  'suspension.level': { unit: 'none', evidence: 'unknown', staleAfterMs: SLOW },
  'temperature.gearboxC': { unit: 'celsius', evidence: 'confirmed', staleAfterMs: SLOW },
  'temperature.coolantC': { unit: 'celsius', evidence: 'confirmed', staleAfterMs: SLOW },
  'temperature.engineOilC': { unit: 'celsius', evidence: 'confirmed', staleAfterMs: SLOW },
  'hdc.status': { unit: 'none', evidence: 'unknown', staleAfterMs: MEDIUM },
  'hdc.setSpeedKmh': { unit: 'km_h', evidence: 'unknown', staleAfterMs: MEDIUM },
  'dsc.status': { unit: 'none', evidence: 'likely', staleAfterMs: MEDIUM },
  'dtc.status': { unit: 'none', evidence: 'unknown', staleAfterMs: MEDIUM },
  'acceleration.longG': { unit: 'g', evidence: 'confirmed', staleAfterMs: FAST },
  'acceleration.latG': { unit: 'g', evidence: 'confirmed', staleAfterMs: FAST },
  yawRateDegS: { unit: 'deg_s', evidence: 'confirmed', staleAfterMs: FAST },
  ...perWheel('wheelSpeed', { unit: 'km_h', evidence: 'likely', staleAfterMs: FAST }),
  // Synthetic slip: физический slip-сигнал не найден (unknown).
  ...perWheel('wheelSlip', { unit: 'percent', evidence: 'unknown', staleAfterMs: FAST }),
  ...perWheel('brakeIntervention', { unit: 'none', evidence: 'unknown', staleAfterMs: FAST }),
  ...perWheel('suspensionHeight', { unit: 'mm', evidence: 'unknown', staleAfterMs: MEDIUM }),
  ...perWheel('tyrePressure', { unit: 'bar', evidence: 'confirmed', staleAfterMs: TPMS }),
  ...perWheel('tyreTemperature', { unit: 'celsius', evidence: 'confirmed', staleAfterMs: TPMS }),
};

export const SIGNAL_IDS = Object.keys(SIGNAL_CATALOG) as SignalId[];
