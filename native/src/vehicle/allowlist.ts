// Явный список того, что приложение читает из автомобиля. Единственный источник правды и для
// подписок адаптера, и для "signals" в app.json (native/src/manifest.ts): лишних полей в манифесте нет.
// Только чтение/подписка (флаги r, s). Никаких w, _methods, _broadcasts, UDS/TASU, CAN.
// Пути, флаги и масштабы — только из закреплённых примеров upstream (082d42d): kit/runtime/car.js,
// apps/car_vitals, apps/live_data/signals.js, apps/live_adjustments/xdrive_live.js, apps/redline/tyres.js.
// На G07 не проверены. Флаг 'r' ставится только там, где геттер есть в upstream app.json.

import type { SignalId } from '../../../src/domain/types';
import { WHEELS } from '../../../src/domain/types';
import { BDS_MEMBERS } from './bds';
import {
  decodeAccelG,
  decodeEngineTemp,
  decodePedal,
  decodeRpm,
  decodeSpeed,
  decodeSteering,
  decodeTorque,
  decodeYawRate,
  type Decoded,
} from './decode';
import { TYRE_MEMBERS, UNIT_MEMBERS, tyreSignalId } from './tpms';

/** Числовой выход поля: член структуры → сигнал домена. */
export interface NumericOutput {
  readonly kind: 'number';
  readonly member: string;
  readonly id: SignalId;
  readonly decode: (raw: unknown) => Decoded;
  /** Без новых отсчётов дольше — «устарело». Кандидат: частота уведомлений на G07 не измерена. */
  readonly staleMs: number;
  /**
   * Несколько полей на один сигнал: меньше — главнее. Свежий допустимый отсчёт любого источника
   * побеждает недопустимый/отсутствующий другого; при двух допустимых — меньший priority.
   * Второе поле допустимо как явно квалифицированный источник (своя проверенная кодировка/вариант). Неквалифицированная
   * подмена запрещена только там, где равнозначность не установлена — у руля (см. ниже, проверяет тест).
   */
  readonly priority?: number;
}

/** Поле передачи: разбирается целиком (vehicle/gear.ts), выход — сигнал 'gear'. */
export interface GearOutput {
  readonly kind: 'gearbox' | 'selection';
  readonly id: 'gear';
  /** Только уведомления при изменении: пока провайдер непрерывно доступен, отсчёт держится (см. адаптер). */
  readonly staleMs: number;
}

/** BasicDataSet: распределение момента — задняя (измерено) и передняя = 100 − задняя (вычислено). */
export interface TorqueSplitOutput {
  readonly kind: 'torqueSplit';
  readonly rear: 'xdrive.rearPercent';
  readonly front: 'xdrive.frontPercent';
  readonly staleMs: number;
}

/** BasicDataSet: масло КПП, показывается после первого изменения сырого значения (vehicle/bds.ts). */
export interface GearboxOilOutput {
  readonly kind: 'gearboxOil';
  readonly id: 'temperature.gearboxC';
  readonly staleMs: number;
}

/** TPMS по четырём углам; значения зависят от единиц автомобиля (vehicle/tpms.ts). */
export interface TyreOutput {
  readonly kind: 'tyrePressure' | 'tyreTemperature';
  readonly staleMs: number;
}

/** Единицы автомобиля для TPMS (сами сигналом не являются). */
export interface UnitsOutput {
  readonly kind: 'units';
}

export type FieldOutput = NumericOutput | GearOutput | TorqueSplitOutput | GearboxOilOutput | TyreOutput | UnitsOutput;

export interface FieldSpec {
  readonly iface: string;
  readonly field: string;
  /** Как в upstream app.json: 'rs' — есть геттер, 's' — только уведомления. */
  readonly flags: 'rs' | 's';
  /** Период чтения геттером (только для 'rs'): поле может не уведомлять, пока значение не меняется. */
  readonly pollMs?: number;
  readonly outputs: readonly FieldOutput[];
  /** Известные члены структуры для диагностического журнала (vehicle/diag.ts). */
  readonly diag: readonly string[];
  /** Писать изменения этих членов в кольцо (поля для проверки на автомобиле, не непрерывные числа). */
  readonly diagChanges?: boolean;
}

export interface InterfaceSpec {
  readonly iface: string;
  /** app.json "_optional": блок без этого интерфейса всё равно ставит приложение (без этих данных). */
  readonly optional: string;
  /** Только диагностика: сырые значения в журнал, в сигналы не попадают. */
  readonly diagnosticOnly?: boolean;
}

const FAST_MS = 5000;
const SLOW_MS = 60000;
/** car_vitals SPLIT_STALE. */
const SPLIT_MS = 10000;
/** Redline tyres.js STALE_MS: на стоянке автомобиль шлёт шины редко. */
const TPMS_MS = 10 * 60 * 1000;

/**
 * Периоды опроса геттером. Быстрые поля с геттером (обороты, скорость, момент, ускорения, рыскание) — 5 Гц:
 * vendor signals.js ставит таймер интерфейса на самый короткий период его полей (setInterval, без округления до
 * секунды; проверяет vehicleSignalsRuntime.test). Это частота ОТСЧЁТОВ, не частота кадров рендерера.
 * Поля только с уведомлениями (руль, педаль) геттера не имеют: их отсчёты — по мере прихода уведомлений.
 */
export const POLL_FAST_MS = 200;
export const POLL_TEMP_MS = 5000;
/** upstream car_vitals / live_data: TPMS { pollMs: 10000 }. */
export const POLL_TPMS_MS = 10000;

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const CDS2 = 'de.bmw.infotainment.vehicle.CDS2';
const V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const VI = 'de.bmw.infrastructure.VehicleInformation';
const STEER = 'de.bmw.chassis.SteeringAngle';
const PEDAL = 'de.bmw.powertrain.AcceleratorPedal';
const BDS = 'de.bmw.infrastructure.analytics.BasicDataSet';
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const VEH = 'de.bmw.infotainment.vehicle.Vehicle';
const PT = 'de.bmw.powertrain.Powertrain';
const VM = 'de.bmw.chassis.VehicleModel';
const DSC = 'de.bmw.chassis.VehicleStabilizationManagement';

export const VEHICLE_INTERFACES: readonly InterfaceSpec[] = [
  { iface: CDS, optional: 'обороты и температуры двигателя в режиме чтения' },
  { iface: V2, optional: 'скорость в режиме чтения' },
  { iface: FES, optional: 'момент двигателя в режиме чтения' },
  { iface: CDS2, optional: 'ускорения и скорость рыскания в режиме чтения' },
  { iface: VI, optional: 'передача в режиме чтения' },
  { iface: STEER, optional: 'угол руля в режиме чтения' },
  { iface: PEDAL, optional: 'положение педали газа в режиме чтения' },
  { iface: BDS, optional: 'распределение момента xDrive и масло КПП в режиме чтения' },
  { iface: TPMS, optional: 'давление и температура шин в режиме чтения' },
  { iface: VEH, optional: 'единицы автомобиля для давления и температуры шин' },
  { iface: PT, optional: 'диагностика: сырые обороты колёс (масштаб не известен, не показываются)', diagnosticOnly: true },
  { iface: VM, optional: 'диагностика: сырой уклон дороги (не угол кузова, не показывается)', diagnosticOnly: true },
  { iface: DSC, optional: 'диагностика: сырые статусы ABS/ASC/DSC (enum не подтверждены, не показываются)', diagnosticOnly: true },
];

const STEER_MEMBER = 'actualValueSteeringAngleDriver';
const tyreMembers = (k: 'pressure' | 'temperature') => WHEELS.map((w) => TYRE_MEMBERS[k][w]);

export const VEHICLE_FIELDS: readonly FieldSpec[] = [
  {
    iface: CDS,
    field: 'statusEngineSpeed2',
    flags: 'rs',
    pollMs: POLL_FAST_MS,
    outputs: [{ kind: 'number', member: 'actualValueRPMEngineCrankshaft', id: 'engine.rpm', decode: decodeRpm, staleMs: FAST_MS }],
    diag: ['actualValueRPMEngineCrankshaft'],
  },
  {
    iface: CDS,
    field: 'statusEngineTemperature',
    flags: 'rs',
    pollMs: POLL_TEMP_MS,
    outputs: [
      { kind: 'number', member: 'temperatureEngineDrive', id: 'temperature.coolantC', decode: decodeEngineTemp, staleMs: SLOW_MS },
      { kind: 'number', member: 'temperatureEngineOilDrive', id: 'temperature.engineOilC', decode: decodeEngineTemp, staleMs: SLOW_MS },
    ],
    diag: ['temperatureEngineDrive', 'temperatureEngineOilDrive'],
  },
  {
    iface: V2,
    field: 'statusCarSpeed2',
    flags: 'rs',
    pollMs: POLL_FAST_MS,
    outputs: [{ kind: 'number', member: 'speedVehicleCentreOfGravity', id: 'vehicleSpeedKmh', decode: decodeSpeed, staleMs: FAST_MS }],
    diag: ['speedVehicleCentreOfGravity'],
  },
  {
    iface: FES,
    field: 'statusActualValueTorque2',
    flags: 'rs',
    pollMs: POLL_FAST_MS,
    outputs: [{ kind: 'number', member: 'actualValueTorqueCrankshaft', id: 'engine.torqueNm', decode: decodeTorque, staleMs: FAST_MS }],
    diag: ['actualValueTorqueCrankshaft'],
  },
  {
    iface: CDS2,
    field: 'statusLongitudinalAccelerationMassCenter',
    flags: 'rs',
    pollMs: POLL_FAST_MS,
    outputs: [{ kind: 'number', member: 'longitudinalAccelerationCentreOfGravity', id: 'acceleration.longG', decode: decodeAccelG, staleMs: FAST_MS }],
    diag: ['longitudinalAccelerationCentreOfGravity'],
  },
  {
    iface: CDS2,
    field: 'statusLateralAccelerationMassCenter',
    flags: 'rs',
    pollMs: POLL_FAST_MS,
    outputs: [{ kind: 'number', member: 'lateralAccelerationCentreOfGravity', id: 'acceleration.latG', decode: decodeAccelG, staleMs: FAST_MS }],
    diag: ['lateralAccelerationCentreOfGravity'],
  },
  {
    iface: VI,
    field: 'statusGearboxDrive',
    flags: 's',
    outputs: [{ kind: 'gearbox', id: 'gear', staleMs: SLOW_MS }],
    diag: ['statusActualGearDrive', 'statusActualStageDrive'],
    diagChanges: true,
  },
  {
    iface: VI,
    field: 'DataPowerTrain2',
    flags: 's',
    outputs: [{ kind: 'selection', id: 'gear', staleMs: SLOW_MS }],
    diag: ['statusGearSelectionDrive'],
    diagChanges: true,
  },
  // Новое (upstream live_data / live_adjustments / car_vitals / redline).
  {
    iface: CDS2,
    field: 'statusYawVelocityVehicle',
    flags: 'rs',
    pollMs: POLL_FAST_MS,
    outputs: [{ kind: 'number', member: 'yawVelocityVehicle', id: 'yawRateDegS', decode: decodeYawRate, staleMs: FAST_MS }],
    diag: ['yawVelocityVehicle'],
  },
  {
    iface: STEER,
    field: 'ActualSteeringAngleDriver',
    flags: 's',
    outputs: [{ kind: 'number', member: STEER_MEMBER, id: 'steeringWheelAngleDeg', decode: decodeSteering, staleMs: FAST_MS }],
    diag: [STEER_MEMBER],
  },
  // Запасное поле руля — только сырой журнал. upstream (live_data, xdrive_live) читает оба поля одной формулой; что на
  // G07 кодировка NoCRC та же, не подтверждено. Фото 0.1.1 показывают ПЕРВЫЕ отсчёты двух полей, полученные в разное
  // время (главное raw 47321, NoCRC raw 32696), — не пару при одном положении руля: они не доказывают ни разную
  // кодировку, ни то, что замеченные скачки вызваны сменой источника. Доказано другое: прежний код мог переключаться
  // между полями, а равнозначность второго не установлена. Отказ от этой подмены — осторожное исправление, а не
  // подтверждённая аппаратная причина скачков.
  {
    iface: STEER,
    field: 'actualSteeringAngleDriverNoCRC',
    flags: 's',
    outputs: [],
    diag: [STEER_MEMBER],
  },
  {
    iface: PEDAL,
    field: 'AngleAcceleratorPedal',
    flags: 's',
    outputs: [{ kind: 'number', member: 'actualValueAngleAcceleratorPedal', id: 'acceleratorPedalPercent', decode: decodePedal, staleMs: FAST_MS }],
    diag: ['actualValueAngleAcceleratorPedal'],
  },
  {
    iface: BDS,
    field: 'basicDataSet',
    flags: 's',
    outputs: [
      { kind: 'torqueSplit', rear: 'xdrive.rearPercent', front: 'xdrive.frontPercent', staleMs: SPLIT_MS },
      { kind: 'gearboxOil', id: 'temperature.gearboxC', staleMs: SLOW_MS },
    ],
    diag: [BDS_MEMBERS.split, BDS_MEMBERS.qualifier, BDS_MEMBERS.gearboxOil],
    diagChanges: true,
  },
  {
    iface: TPMS,
    field: 'statusTyrePressure',
    flags: 'rs',
    pollMs: POLL_TPMS_MS,
    outputs: [{ kind: 'tyrePressure', staleMs: TPMS_MS }],
    diag: tyreMembers('pressure'),
    diagChanges: true,
  },
  {
    iface: TPMS,
    field: 'statusTyreTemperature',
    flags: 'rs',
    pollMs: POLL_TPMS_MS,
    outputs: [{ kind: 'tyreTemperature', staleMs: TPMS_MS }],
    diag: tyreMembers('temperature'),
    diagChanges: true,
  },
  {
    iface: VEH,
    field: 'statusNewCurrentUnitsStatusExt',
    flags: 'rs',
    pollMs: POLL_TPMS_MS,
    outputs: [{ kind: 'units' }],
    diag: [UNIT_MEMBERS.pressure, UNIT_MEMBERS.temperature],
    diagChanges: true,
  },
  // Только диагностика: известные upstream члены, без масштаба/единиц и без вывода в сигналы.
  {
    iface: PT,
    field: 'ActualValueRPMWheel',
    flags: 's',
    outputs: [],
    // Так в upstream: у переднего правого — «RPMwheel» со строчной w.
    diag: ['actualValueRPMWheelFLH', 'actualValueRPMwheelFRH', 'actualValueRPMWheelRLH', 'actualValueRPMWheelRRH'],
    diagChanges: true,
  },
  {
    iface: VM,
    field: 'LaneSlope',
    flags: 's',
    outputs: [],
    diag: ['actualValueLongitudinalGradientRoadway', 'actualValueTransverseGradientRoadway'],
    diagChanges: true,
  },
  {
    iface: DSC,
    field: 'StabilizationManagement',
    flags: 's',
    outputs: [],
    diag: ['qualifierFunctionABS', 'qualifierFunctionASC', 'qualifierFunctionFDR', 'statusBrakingDriver'],
    diagChanges: true,
  },
];

/** Сигналы, которые даёт выход поля. */
export function outputIds(o: FieldOutput): readonly SignalId[] {
  switch (o.kind) {
    case 'number':
    case 'gearbox':
    case 'selection':
    case 'gearboxOil':
      return [o.id];
    case 'torqueSplit':
      return [o.rear, o.front];
    case 'tyrePressure':
      return WHEELS.map((w) => tyreSignalId('pressure', w));
    case 'tyreTemperature':
      return WHEELS.map((w) => tyreSignalId('temperature', w));
    default:
      return [];
  }
}

/** Сигналы домена, у которых в режиме чтения есть источник. Все остальные — «нет данных». */
export const VEHICLE_SIGNAL_IDS: readonly SignalId[] = Array.from(
  new Set(VEHICLE_FIELDS.reduce<SignalId[]>((acc, f) => acc.concat(...f.outputs.map((o) => outputIds(o))), [])),
);

/** Интерфейс-источник каждого сигнала (для потери провайдера). */
export const SIGNAL_IFACE: ReadonlyMap<SignalId, string> = new Map(
  VEHICLE_FIELDS.reduce<[SignalId, string][]>((acc, f) => acc.concat(...f.outputs.map((o) => outputIds(o).map((id): [SignalId, string] => [id, f.iface]))), []),
);

/**
 * Что НЕ читается и почему (сигналы остаются «нет данных»). Ни один ключ не пересекается с
 * VEHICLE_SIGNAL_IDS (проверяется тестом). Добавлять источник только по подтверждённой upstream-реализации.
 */
export const VEHICLE_EXPANSION_NOTES: Readonly<Partial<Record<SignalId, string>>> = {
  'attitude.pitchDeg': 'угол к горизонту: публичного источника нет; LaneSlope — уклон ДОРОГИ (TLT_RW), масштаб неизвестен; BDC D54D — кузов к осям (отдельно); скорости CDS в угол не интегрируются',
  'attitude.rollDeg': 'угол к горизонту: публичного источника нет (крена к осям нет и в BDC); LaneSlope — уклон дороги, масштаб неизвестен; скорость крена в угол не интегрируется',
  altitudeM: 'источник не найден',
  'engine.throttlePercent': 'дроссель не найден; педаль газа — отдельный сигнал acceleratorPedalPercent',
  'xdrive.frontTorqueNm': 'момента оси нет; только доля BasicDataSet (Н·м из неё не выводятся)',
  'xdrive.rearTorqueNm': 'момента оси нет; «двигатель − передний» не вычисляется',
  'rearDiff.lockState': 'источник не найден',
  'rearDiff.lockPercent': 'источник не найден',
  'suspension.level': 'источник не найден',
  'hdc.status': 'источник/enum не найдены',
  'hdc.setSpeedKmh': 'источник не найден',
  'dsc.status': 'VehicleStabilizationManagement.StabilizationManagement — только сырой журнал: enum не подтверждены',
  'dtc.status': 'источник/enum не найдены',
  'wheelSpeed.FL': 'Powertrain.ActualValueRPMWheel — только сырой журнал: масштаб не известен (то же для FR/RL/RR)',
  'wheelSlip.FL': 'физического проскальзывания нет (то же для FR/RL/RR)',
  'brakeIntervention.FL': 'источник не найден (то же для FR/RL/RR)',
  'suspensionHeight.FL': 'источник не найден (то же для FR/RL/RR)',
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
