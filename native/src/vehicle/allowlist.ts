// Явный список того, что приложение читает из автомобиля. Единственный источник правды и для
// подписок адаптера, и для "signals" в app.json (native/src/manifest.ts): лишних полей в манифесте нет.
// Только чтение/подписка (флаги r, s). Никаких w, _methods, _broadcasts, UDS/TASU, CAN.
// Масштабы — upstream car.js / README §7 / SIGNALS.md на коммите 082d42d; на G07 НЕ проверены.

import type { SignalId } from '../../../src/domain/types';
import { decodeAccelG, decodeEngineTemp, decodeRpm, decodeSpeed, decodeTorque, type Decoded } from './decode';

/** Числовой выход поля: член структуры → сигнал домена. */
export interface NumericOutput {
  readonly kind: 'number';
  readonly member: string;
  readonly id: SignalId;
  readonly decode: (raw: unknown) => Decoded;
  /** Без новых уведомлений дольше — «устарело». Кандидат: частота уведомлений на G07 не измерена. */
  readonly staleMs: number;
}

/** Поле передачи: разбирается целиком (vehicle/gear.ts), выход — сигнал 'gear'. */
export interface GearOutput {
  readonly kind: 'gearbox' | 'selection';
  readonly id: 'gear';
  readonly staleMs: number;
}

export interface FieldSpec {
  readonly iface: string;
  readonly field: string;
  /** Как у закреплённых примеров upstream (car_vitals): 'rs' — есть геттер, 's' — только уведомления. */
  readonly flags: 'rs' | 's';
  readonly outputs: readonly (NumericOutput | GearOutput)[];
}

export interface InterfaceSpec {
  readonly iface: string;
  /** app.json "_optional": блок без этого интерфейса всё равно ставит приложение (без этих данных). */
  readonly optional: string;
}

const FAST_MS = 5000;
const SLOW_MS = 60000;

export const VEHICLE_INTERFACES: readonly InterfaceSpec[] = [
  { iface: 'de.bmw.infotainment.vehicle.CDS', optional: 'обороты и температуры двигателя в режиме чтения' },
  { iface: 'de.bmw.infotainment.vehicle.Vehicle2', optional: 'скорость в режиме чтения' },
  { iface: 'de.bmw.infotainment.drivingexcitement.FES', optional: 'момент двигателя в режиме чтения' },
  { iface: 'de.bmw.infotainment.vehicle.CDS2', optional: 'продольное и поперечное ускорение в режиме чтения' },
  { iface: 'de.bmw.infrastructure.VehicleInformation', optional: 'передача в режиме чтения' },
];

export const VEHICLE_FIELDS: readonly FieldSpec[] = [
  {
    iface: 'de.bmw.infotainment.vehicle.CDS',
    field: 'statusEngineSpeed2',
    flags: 'rs',
    outputs: [{ kind: 'number', member: 'actualValueRPMEngineCrankshaft', id: 'engine.rpm', decode: decodeRpm, staleMs: FAST_MS }],
  },
  {
    iface: 'de.bmw.infotainment.vehicle.CDS',
    field: 'statusEngineTemperature',
    flags: 'rs',
    outputs: [
      { kind: 'number', member: 'temperatureEngineDrive', id: 'temperature.coolantC', decode: decodeEngineTemp, staleMs: SLOW_MS },
      { kind: 'number', member: 'temperatureEngineOilDrive', id: 'temperature.engineOilC', decode: decodeEngineTemp, staleMs: SLOW_MS },
    ],
  },
  {
    iface: 'de.bmw.infotainment.vehicle.Vehicle2',
    field: 'statusCarSpeed2',
    flags: 'rs',
    outputs: [{ kind: 'number', member: 'speedVehicleCentreOfGravity', id: 'vehicleSpeedKmh', decode: decodeSpeed, staleMs: FAST_MS }],
  },
  {
    iface: 'de.bmw.infotainment.drivingexcitement.FES',
    field: 'statusActualValueTorque2',
    flags: 'rs',
    outputs: [{ kind: 'number', member: 'actualValueTorqueCrankshaft', id: 'engine.torqueNm', decode: decodeTorque, staleMs: FAST_MS }],
  },
  {
    iface: 'de.bmw.infotainment.vehicle.CDS2',
    field: 'statusLongitudinalAccelerationMassCenter',
    flags: 'rs',
    outputs: [{ kind: 'number', member: 'longitudinalAccelerationCentreOfGravity', id: 'acceleration.longG', decode: decodeAccelG, staleMs: FAST_MS }],
  },
  {
    iface: 'de.bmw.infotainment.vehicle.CDS2',
    field: 'statusLateralAccelerationMassCenter',
    flags: 'rs',
    outputs: [{ kind: 'number', member: 'lateralAccelerationCentreOfGravity', id: 'acceleration.latG', decode: decodeAccelG, staleMs: FAST_MS }],
  },
  {
    iface: 'de.bmw.infrastructure.VehicleInformation',
    field: 'statusGearboxDrive',
    flags: 's',
    outputs: [{ kind: 'gearbox', id: 'gear', staleMs: SLOW_MS }],
  },
  {
    iface: 'de.bmw.infrastructure.VehicleInformation',
    field: 'DataPowerTrain2',
    flags: 's',
    outputs: [{ kind: 'selection', id: 'gear', staleMs: SLOW_MS }],
  },
];

/** Сигналы домена, у которых в режиме чтения есть источник. Все остальные — «нет данных». */
export const VEHICLE_SIGNAL_IDS: readonly SignalId[] = Array.from(
  new Set(VEHICLE_FIELDS.reduce<SignalId[]>((acc, f) => acc.concat(f.outputs.map((o) => o.id)), [])),
);

/**
 * Карта для будущего расширения (НЕ подписывается): кандидаты из SIGNALS.md, у которых нет
 * подтверждённого пути/масштаба для этой версии. Добавлять в VEHICLE_FIELDS только после проверки на G07.
 */
export const VEHICLE_EXPANSION_NOTES: Readonly<Partial<Record<SignalId, string>>> = {
  steeringWheelAngleDeg: 'путь в каталоге есть, масштаб/знак не подтверждены',
  yawRateDegS: 'путь в каталоге есть, масштаб не подтверждён',
  'temperature.gearboxC': 'BDS raw−48 бывает постоянно 0; EGS DID требует UDS — не используется',
  'xdrive.frontPercent': 'upstream оценивает через UDS LMV — диагностический транспорт не используется',
  'tyrePressure.FL': 'TPMS: единицы зависят от настроек автомобиля, не подтверждено',
  'attitude.pitchDeg': 'источник не найден',
  'attitude.rollDeg': 'источник не найден',
  altitudeM: 'источник не найден',
};

/** "signals" для app.json, строго из списка выше. */
export function manifestSignals(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const i of VEHICLE_INTERFACES) out[i.iface] = { _optional: i.optional };
  for (const f of VEHICLE_FIELDS) {
    const entry = out[f.iface];
    if (!entry) throw new Error(`interface ${f.iface} is not declared in VEHICLE_INTERFACES`);
    entry[f.field] = f.flags;
  }
  return out;
}
