// Какие блоки читаются, как опознаются и куда идут значения. Значение попадает в сигналы приложения ТОЛЬКО если
// идентификация блока (22 F150, SGBD-индекс) есть в его списке `identities` — со ссылкой на доказательство.
// Неизвестный вариант: сигналы «нет данных» с точной причиной (индекс), записи читаются редко и только в
// диагностику (сырые байты + разбор по каталогу как «кандидат»), остальное приложение работает как обычно.
// Набор записей зависит от варианта (`variants`): у IB_G05 нет DBE5, у GSZFB1 нет 6000 — их не читают.
// Отсутствие ответа блока — «нет ответа», не «не установлен».
// SGBD-индексы G05-семейства: idrive7-apps apps/live_data/builtin/sgbd_index.json @4be3e52 (MIT; построен из
// публичного EdiabasX SGBD reference); схемы записей — records.ts.

import type { SignalId } from '../../../../src/domain/types';
import {
  ACSM_IMU_RAW,
  BDC_FES,
  BDC_LWR_PITCH,
  DSC_PRESSURE,
  EGS_OIL_DA12,
  GHAS_DELTA_N,
  GHAS_FLAGS,
  GHAS_LOCK_TORQUE,
  GHAS_OIL,
  GHAS_POSITION,
  GHAS_STATE,
  GHAS_TARGET,
  IB_ABS,
  IB_ASC,
  IB_FDR,
  IB_HDC,
  IB_PRESSURE,
  DSC_WHEEL_SPEED,
  EGS_OIL,
  EPS_PINION,
  FUNCTION_STATUS_QUALIFIERS_KNOWN,
  GHAS_STATES,
  LMV_MOMENT,
  LMV_QUALIFIER_VALID,
  VDP_HEIGHTS,
  VDP_LEVEL,
  VDP_OFFSET_STATE,
  VDP_SENSOR_STATE,
  WHEEL_KEYS,
  type DecodedRecord,
  type RecordSchema,
} from './records';

export type EcuKey = 'EGS' | 'LMV' | 'DSC' | 'EPS' | 'VDP' | 'GHAS' | 'BDC' | 'ACSM';

/**
 * Величины, которых нет в общем домене (смысл отличается от доменных сигналов): давление контуров тормоза (не
 * вмешательство по колёсам), выход датчика высоты в мм (не отклонение от нормы), угол шестерни EPS (не угол руля),
 * уровень EHC (3 состояния, не шкала из 6 уровней приложения).
 */
export type ExtraId =
  | 'brakePressure.circuit1'
  | 'brakePressure.circuit2'
  | 'rideHeightSensor.FL'
  | 'rideHeightSensor.FR'
  | 'rideHeightSensor.RL'
  | 'rideHeightSensor.RR'
  | 'epsPinionDeg'
  | 'ehcLevel'
  | 'brakePressure.tmc'
  | 'brakePressure.system'
  | 'dsc.fdr'
  | 'dsc.asc'
  | 'dsc.abs'
  | 'hdc.available'
  | 'rearLock.state'
  | 'rearLock.torqueNm'
  | 'rearLock.targetNm'
  | 'rearLock.positionInc'
  | 'rearLock.deltaRpm'
  | 'rearLock.oilC'
  | 'driveMode'
  | 'pitchVsAxlesDeg'
  | 'wheelDelta.FL'
  | 'wheelDelta.FR'
  | 'wheelDelta.RL'
  | 'wheelDelta.RR';
export const EXTRA_IDS: readonly ExtraId[] = [
  'brakePressure.circuit1',
  'brakePressure.circuit2',
  'rideHeightSensor.FL',
  'rideHeightSensor.FR',
  'rideHeightSensor.RL',
  'rideHeightSensor.RR',
  'epsPinionDeg',
  'ehcLevel',
  'brakePressure.tmc',
  'brakePressure.system',
  'dsc.fdr',
  'dsc.asc',
  'dsc.abs',
  'hdc.available',
  'rearLock.state',
  'rearLock.torqueNm',
  'rearLock.targetNm',
  'rearLock.positionInc',
  'rearLock.deltaRpm',
  'rearLock.oilC',
  'driveMode',
  'pitchVsAxlesDeg',
  'wheelDelta.FL',
  'wheelDelta.FR',
  'wheelDelta.RL',
  'wheelDelta.RR',
];

export type Target = { readonly kind: 'signal'; readonly id: SignalId } | { readonly kind: 'extra'; readonly id: ExtraId };

/** Выход записи: величина записи → цель. */
export interface RecordOutput {
  readonly value: string;
  readonly target: Target;
}

export interface RecordSpec {
  readonly schema: RecordSchema;
  /** Период чтения при опознанном блоке. */
  readonly periodMs: number;
  /** Без новых ответов дольше — «устарело». */
  readonly staleMs: number;
  readonly outputs: readonly RecordOutput[];
  /** Пригодность выхода зависит от других записей того же блока (VDP: исправность датчика и нуль). */
  readonly gate?: (value: string, others: (did: number) => DecodedRecord | null) => string | null;
  /**
   * Только диагностика: выходы записи на экран не попадают (смысл не установлен) — читается редко
   * (DIAGNOSTIC_PERIOD_MS), не отнимая шину у показываемых величин.
   */
  readonly diagnosticOnly?: boolean;
}

/** Период записей «только диагностика» (кандидаты, флаги, сырьё). */
export const DIAGNOSTIC_PERIOD_MS = 20000;

export interface EcuSpec {
  readonly key: EcuKey;
  readonly addr: number;
  readonly name: string;
  /** SGBD-индекс (22 F150) → вариант и доказательство. Пусто — доказательств нет, только диагностика. */
  readonly identities: Readonly<Record<string, string>>;
  /** Записи по умолчанию (и для неопознанного варианта — только в диагностику). */
  readonly records: readonly RecordSpec[];
  /** Свои записи опознанного варианта (SGBD-индекс → записи), если они отличаются от `records`. */
  readonly variants?: Readonly<Record<string, readonly RecordSpec[]>>;
}

/** Записи, которые читаются у блока с этой идентификацией. */
export const recordsFor = (spec: EcuSpec, identity: string | null): readonly RecordSpec[] =>
  (identity !== null && spec.variants && spec.identities[identity] && spec.variants[identity]) || spec.records;

const sig = (id: SignalId): Target => ({ kind: 'signal', id });
const extra = (id: ExtraId): Target => ({ kind: 'extra', id });

/** Значение GHAS — только когда блок в состоянии «работа» (4013 = 2); иначе — состояние вместо значения. */
function ghas(schema: RecordSchema, periodMs: number, value: string, id: ExtraId, shown = true): RecordSpec {
  return {
    schema,
    periodMs,
    staleMs: Math.max(3000, periodMs * 3),
    outputs: [{ value, target: extra(id) }],
    diagnosticOnly: !shown,
    gate: (_v, others) => {
      const st = others(GHAS_STATE.did);
      if (!st) return 'нет свежего состояния блока (4013)';
      return st.values.state === 2 ? null : `блок не в работе (${st.values.state === null ? 'неизвестное состояние' : GHAS_STATES[st.values.state as number]})`;
    },
  };
}

/** Записи IB_G05: скорости колёс (та же схема DBE4), давления ГТЦ/системы, состояния функций. */
// состояния функций: квалификаторы не описаны — только кандидаты (records.ts FUNCTION_STATUS_QUALIFIERS_KNOWN)
const fn = (schema: RecordSchema, id: ExtraId): RecordSpec => ({ schema, periodMs: 1000, staleMs: 5000, outputs: [{ value: 'status', target: extra(id) }], diagnosticOnly: !FUNCTION_STATUS_QUALIFIERS_KNOWN });
// Периоды — по бюджету последовательной шины (≈ 3 запроса/с при ответе 80 мс; uds.test «расписание»): показываемые
// величины 1 раз в 1…5 с, срок свежести — 3 периода.
const wheelSpeeds = (): RecordSpec => ({
  schema: DSC_WHEEL_SPEED,
  periodMs: 1000,
  staleMs: 3000,
  outputs: [
    ...WHEEL_KEYS.map((w) => ({ value: `speed.${w}`, target: sig(`wheelSpeed.${w}` as SignalId) })),
    ...WHEEL_KEYS.map((w) => ({ value: `deltaPct.${w}`, target: extra(`wheelDelta.${w}` as ExtraId) })),
  ],
});
const IB_RECORDS: readonly RecordSpec[] = [
  wheelSpeeds(),
  {
    schema: IB_PRESSURE,
    periodMs: 1000,
    staleMs: 3000,
    outputs: [
      { value: 'tmcBar', target: extra('brakePressure.tmc') },
      { value: 'systemBar', target: extra('brakePressure.system') },
    ],
  },
  fn(IB_FDR, 'dsc.fdr'),
  fn(IB_ASC, 'dsc.asc'),
  fn(IB_ABS, 'dsc.abs'),
  fn(IB_HDC, 'hdc.available'),
];

/** Медленное чтение записей неопознанного блока — только для диагностики. */
export const UNVERIFIED_PERIOD_MS = 30000;

export const ECUS: readonly EcuSpec[] = [
  {
    key: 'EGS',
    addr: 0x18,
    name: 'АКПП (EGS)',
    identities: {
      '0F25D0': 'GSZFBCE — idrive7-apps zf8hp, проверено на G22',
      '0F21E0': '8HP hybrid — idrive7-apps zf8hp, все записи прочитаны на G20 330e',
      '0F21D0': 'GSZFB1 — sgbd_index @4be3e52; DA12 по EdiabasX rev 9.003 и бинарной выгрузке m550 (2 байта, high, −48)',
    },
    records: [{ schema: EGS_OIL, periodMs: 5000, staleMs: 15000, outputs: [{ value: 'oilC', target: sig('temperature.gearboxC') }] }],
    // у GSZFB1 у 6000 нет описания результата: его не читают
    variants: { '0F21D0': [{ schema: EGS_OIL_DA12, periodMs: 5000, staleMs: 15000, outputs: [{ value: 'oilC', target: sig('temperature.gearboxC') }] }] },
  },
  {
    key: 'LMV',
    addr: 0x19,
    name: 'Раздатка xDrive (LMV)',
    // LMV_G11 (0F2180, sgbd_index; схема DB32 по EdiabasX rev 3.002 = m550). Квалификатор ISTMOMENT без таблицы:
    // момент к передней оси остаётся кандидатом (диагностика), на экран не идёт (LMV_QUALIFIER_VALID пуст).
    identities: { '0F2180': 'LMV_G11 — sgbd_index @4be3e52, DB32 по EdiabasX rev 3.002' },
    records: [{ schema: LMV_MOMENT, periodMs: 500, staleMs: 3000, outputs: [{ value: 'frontTorqueNm', target: sig('xdrive.frontTorqueNm') }], diagnosticOnly: LMV_QUALIFIER_VALID.length === 0 }],
  },
  {
    key: 'DSC',
    addr: 0x29,
    name: 'DSC',
    identities: {
      '0F2850': 'DSC_G30N (EBC460 SP2018) — карта G30 m550-analyzer, записи по каталогу DSC_G30N',
      '0F2500': 'IB_G05 (интегрированный тормоз G05/G06/G07) — sgbd_index @4be3e52, записи по EdiabasX rev 8.000',
    },
    variants: { '0F2500': IB_RECORDS },
    records: [
      wheelSpeeds(),
      {
        schema: DSC_PRESSURE,
        periodMs: 1000,
        staleMs: 3000,
        outputs: [
          { value: 'circuit1Bar', target: extra('brakePressure.circuit1') },
          { value: 'circuit2Bar', target: extra('brakePressure.circuit2') },
        ],
      },
    ],
  },
  {
    key: 'EPS',
    addr: 0x30,
    name: 'Электроусилитель руля (EPS)',
    identities: { '0F2580': 'EPS_G05 — sgbd_index @4be3e52, DB57 по EdiabasX rev 3.003 (= EPS_G11)' },
    // угол шестерни на экран не выводится — только диагностика
    records: [{ schema: EPS_PINION, periodMs: 500, staleMs: 3000, outputs: [{ value: 'pinionDeg', target: extra('epsPinionDeg') }], diagnosticOnly: true }],
  },
  {
    key: 'VDP',
    addr: 0x76,
    name: 'Подвеска (VDP)',
    // VDP_G11 — единственный VDP G-серии в индексе; есть ли он на конкретном G07 (пневмоподвеска), решает F150.
    identities: { '0F1F50': 'VDP_G11 — sgbd_index @4be3e52, записи по EdiabasX rev 9.000' },
    records: [
      { schema: VDP_SENSOR_STATE, periodMs: 10000, staleMs: 30000, outputs: [] },
      { schema: VDP_OFFSET_STATE, periodMs: 30000, staleMs: 120000, outputs: [] },
      {
        schema: VDP_HEIGHTS,
        periodMs: 1000,
        staleMs: 3000,
        outputs: WHEEL_KEYS.map((w) => ({ value: `heightMm.${w}`, target: extra(`rideHeightSensor.${w}` as ExtraId) })),
        gate: (value, others) => {
          const w = value.slice(value.indexOf('.') + 1);
          const st = others(VDP_SENSOR_STATE.did);
          const off = others(VDP_OFFSET_STATE.did);
          if (!st || !off) return 'нет свежего состояния датчика/нуля (DC06/DC31)';
          const sv = st.values[`sensor.${w}`];
          if (sv !== 0) return sv === 1 || sv === 255 ? `датчик ${w} неисправен (${String(sv)})` : `датчик ${w}: неизвестный код ${String(sv)}`;
          const ov = off.values[`offset.${w}`];
          if (ov === 2) return `датчик ${w} не установлен по кодированию (DC31 = 2)`;
          if (ov !== 1) return ov === 0 ? `нуль ${w} не откалиброван` : ov === 255 ? `нуль ${w}: состояние неизвестно` : `нуль ${w}: неизвестный код ${String(ov)}`;
          return null;
        },
      },
      // Три документированных уровня EHC: низкий / стандарт / высокий.
      { schema: VDP_LEVEL, periodMs: 5000, staleMs: 15000, outputs: [{ value: 'level', target: extra('ehcLevel') }] },
    ],
  },
  {
    key: 'GHAS',
    addr: 0x0f,
    name: 'Блокировка заднего дифференциала (GHAS)',
    identities: { '0F1720': 'GHAS10 — sgbd_index @4be3e52, записи по EdiabasX ghas10 rev 1.203' },
    records: [
      { schema: GHAS_STATE, periodMs: 3000, staleMs: 10000, outputs: [{ value: 'state', target: extra('rearLock.state') }] },
      ghas(GHAS_LOCK_TORQUE, 1000, 'torqueNm', 'rearLock.torqueNm'),
      ghas(GHAS_TARGET, 1000, 'targetNm', 'rearLock.targetNm'),
      ghas(GHAS_POSITION, 2000, 'positionInc', 'rearLock.positionInc', false),
      ghas(GHAS_DELTA_N, 2000, 'deltaRpm', 'rearLock.deltaRpm', false),
      ghas(GHAS_OIL, 5000, 'oilC', 'rearLock.oilC', false),
      ...GHAS_FLAGS.map((schema) => ({ schema, periodMs: 30000, staleMs: 120000, outputs: [], diagnosticOnly: true })),
    ],
  },
  {
    key: 'BDC',
    addr: 0x40,
    name: 'Режим движения (BDC)',
    identities: { '0F2680': 'BDC_G05 — sgbd_index @4be3e52, E468/D54D по EdiabasX BDC_G05' },
    records: [
      { schema: BDC_FES, periodMs: 3000, staleMs: 10000, outputs: [{ value: 'mode', target: extra('driveMode') }] },
      { schema: BDC_LWR_PITCH, periodMs: 2000, staleMs: 6000, outputs: [{ value: 'pitchDeg', target: extra('pitchVsAxlesDeg') }] },
    ],
  },
  {
    key: 'ACSM',
    addr: 0x01,
    name: 'Датчик ускорений (ACSM)',
    // раскладка 4101 не установлена: проверенных вариантов нет — только сырьё в диагностику (раз в 30 с)
    identities: {},
    records: [{ schema: ACSM_IMU_RAW, periodMs: 30000, staleMs: 120000, outputs: [], diagnosticOnly: true }],
  },
];

export const ecuByAddr = (addr: number): EcuSpec | undefined => ECUS.find((e) => e.addr === addr);
