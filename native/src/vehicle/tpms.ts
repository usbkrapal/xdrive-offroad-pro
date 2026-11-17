// Давление и температура шин (TPMS) в единицах, которые выбраны в автомобиле.
// Источник — upstream redline/tyres.js и car_vitals (app.json config.scaling tyrePress / tyreTemp):
//   TPMS.statusTyrePressure.actualValuePressureTyre{FLH,FRH,RLH,RRH}: raw × 0.1 в единице давления автомобиля,
//     raw ≥ 65532 — нет значения;
//   TPMS.statusTyreTemperature.actualValueTemperatureTyre{…}: raw − 40 в единице температуры автомобиля,
//     65535 — нет значения;
//   Vehicle.statusNewCurrentUnitsStatusExt: unitOfMeasurementAirPressure 1 BAR / 2 KPA / 3 PSI,
//     unitOfMeasurementTemperature 1 C / 2 F (номером или тем же именем).
// В отличие от upstream единица НЕ угадывается по величине (psi ≠ «значит, °F»): пока единицы не пришли,
// сырые отсчёты только хранятся и раскодируются, когда единицы придут, с ИСХОДНЫМ временем отсчёта.
// Отсчёт связывается с единицами, действовавшими при его приходе (смена единиц не переписывает старые).
// Недопустимые единицы обнуляют все прежние отсчёты (invalid) до новых отсчётов.

import { WHEELS, type SignalId, type Wheel } from '../../../src/domain/types';
import { rawUInt } from './decode';

export type PressUnit = 'BAR' | 'KPA' | 'PSI';
export type TempUnit = 'C' | 'F';

const PRESS_UNITS: Readonly<Record<number, PressUnit>> = { 1: 'BAR', 2: 'KPA', 3: 'PSI' };
const TEMP_UNITS: Readonly<Record<number, TempUnit>> = { 1: 'C', 2: 'F' };
const TO_BAR: Readonly<Record<PressUnit, number>> = { BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 };

/** Верхняя граница давления — та же, что у upstream (Redline P_OK, Car Vitals TYRE_P); 0 бар (спущенная шина) допустим. */
export const TYRE_BAR_RANGE = [0, 6] as const;
/** Диапазон температуры шины, °C (upstream T_OK / TYRE_T). */
export const TYRE_C_RANGE = [-40, 150] as const;

export const TYRE_MEMBERS: Readonly<Record<'pressure' | 'temperature', Readonly<Record<Wheel, string>>>> = {
  pressure: { FL: 'actualValuePressureTyreFLH', FR: 'actualValuePressureTyreFRH', RL: 'actualValuePressureTyreRLH', RR: 'actualValuePressureTyreRRH' },
  temperature: {
    FL: 'actualValueTemperatureTyreFLH',
    FR: 'actualValueTemperatureTyreFRH',
    RL: 'actualValueTemperatureTyreRLH',
    RR: 'actualValueTemperatureTyreRRH',
  },
};
export const UNIT_MEMBERS = { pressure: 'unitOfMeasurementAirPressure', temperature: 'unitOfMeasurementTemperature' } as const;

/** Номер провода или то же имя; всё остальное — недопустимо (null). */
export function pressUnitOf(v: unknown): PressUnit | null {
  if (typeof v === 'number') return PRESS_UNITS[v] ?? null;
  return v === 'BAR' || v === 'KPA' || v === 'PSI' ? v : null;
}
export function tempUnitOf(v: unknown): TempUnit | null {
  if (typeof v === 'number') return TEMP_UNITS[v] ?? null;
  return v === 'C' || v === 'F' ? v : null;
}

/** Давление в барах из raw × 0.1 в единице u; null — нет значения/вне диапазона. */
export function decodeTyrePressure(raw: unknown, u: PressUnit): number | null {
  const r = rawUInt(raw, 0xffff);
  if (r === null || r >= 65532) return null;
  const bar = r * 0.1 * TO_BAR[u];
  return bar >= TYRE_BAR_RANGE[0] && bar <= TYRE_BAR_RANGE[1] ? bar : null;
}

/** Температура в °C из raw − 40 в единице u; null — нет значения/вне диапазона. */
export function decodeTyreTemperature(raw: unknown, u: TempUnit): number | null {
  const r = rawUInt(raw, 0xffff);
  if (r === null || r === 0xffff) return null;
  const v = r - 40;
  const c = u === 'F' ? ((v - 32) * 5) / 9 : v;
  return c >= TYRE_C_RANGE[0] && c <= TYRE_C_RANGE[1] ? c : null;
}

type Kind = 'pressure' | 'temperature';

interface RawCorner {
  readonly raw: unknown;
  readonly at: number;
  readonly seq: number;
  /** Единица, действовавшая при приходе; null — единиц ещё не было (свяжется с первыми пришедшими). */
  unit: string | null;
  /**
   * Пришёл без единиц после потери провайдера единиц (или ждал единиц в момент потери): единицы на момент
   * отправки неизвестны — с новыми единицами НЕ связывается, ждёт нового отсчёта угла.
   */
  orphan: boolean;
}

type UnitState = { readonly kind: 'none' } | { readonly kind: 'lost' } | { readonly kind: 'valid'; readonly unit: string } | { readonly kind: 'invalid'; readonly raw: unknown; readonly at: number; readonly seq: number };

/** Отсчёт угла шины для общего разрешения качества в адаптере. */
export interface TyreSample {
  /** null — недопустимое значение (invalid). */
  readonly value: number | null;
  /** Значения нет (ждём единиц) — unavailable. */
  readonly absent: boolean;
  readonly at: number;
  readonly seq: number;
  readonly reason: string | null;
}

export const tyreSignalId = (k: Kind, w: Wheel): SignalId => (k === 'pressure' ? `tyrePressure.${w}` : `tyreTemperature.${w}`);

export class TyreState {
  private readonly raw: Record<Kind, Partial<Record<Wheel, RawCorner>>> = { pressure: {}, temperature: {} };
  private readonly units: Record<Kind, UnitState> = { pressure: { kind: 'none' }, temperature: { kind: 'none' } };
  /** Последние недопустимые единицы: все отсчёты до них недействительны навсегда (до нового отсчёта угла). */
  private readonly voided: Record<Kind, { raw: unknown; at: number; seq: number } | null> = { pressure: null, temperature: null };

  /** Отсчёт statusTyrePressure / statusTyreTemperature: член структуры отсутствует — не отсчёт этого угла. */
  receive(kind: Kind, v: unknown, at: number, seq: number): void {
    if (!v || typeof v !== 'object') return;
    const u = this.units[kind];
    for (const w of WHEELS) {
      const raw = (v as Record<string, unknown>)[TYRE_MEMBERS[kind][w]];
      if (raw === undefined) continue;
      this.raw[kind][w] = { raw, at, seq, unit: u.kind === 'valid' ? u.unit : null, orphan: u.kind === 'lost' };
    }
  }

  /** Отсчёт Vehicle.statusNewCurrentUnitsStatusExt. Отсутствующий член — единица не сообщена (без изменений). */
  receiveUnits(v: unknown, at: number, seq: number): void {
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    this.applyUnit('pressure', o[UNIT_MEMBERS.pressure], pressUnitOf, at, seq);
    this.applyUnit('temperature', o[UNIT_MEMBERS.temperature], tempUnitOf, at, seq);
  }

  private applyUnit(kind: Kind, raw: unknown, parse: (x: unknown) => string | null, at: number, seq: number): void {
    if (raw === undefined) return;
    const unit = parse(raw);
    if (unit === null) {
      this.units[kind] = { kind: 'invalid', raw, at, seq };
      this.voided[kind] = { raw, at, seq };
      return;
    }
    this.units[kind] = { kind: 'valid', unit };
    // Отсчёты, пришедшие без единиц, раскодируются ими (время отсчёта — исходное).
    const voidSeq = this.voided[kind]?.seq ?? -1;
    for (const w of WHEELS) {
      const c = this.raw[kind][w];
      if (c && c.unit === null && !c.orphan && c.seq > voidSeq) c.unit = unit;
    }
  }

  /**
   * Провайдер единиц (Vehicle) пропал: известные единицы забываются. Новые отсчёты шин до прихода свежих
   * единиц не раскодируются (и не связываются с ними потом); ждавшие единиц — тоже. Отсчёты, уже связанные
   * с прежними единицами, обесценивает адаптер (зависимость от интерфейса единиц), они не становятся valid.
   */
  unitsLost(): void {
    for (const kind of ['pressure', 'temperature'] as const) {
      this.units[kind] = { kind: 'lost' };
      for (const w of WHEELS) {
        const c = this.raw[kind][w];
        if (c && c.unit === null) c.orphan = true;
      }
    }
  }

  /** Отсчёт угла или null, если по этому углу ничего не приходило. */
  sample(kind: Kind, w: Wheel): TyreSample | null {
    const c = this.raw[kind][w];
    if (!c) return null;
    // Недопустимые единицы после отсчёта: прежнее значение больше не верно (и не воскресает с новыми единицами).
    const v = this.voided[kind];
    if (v && c.seq < v.seq) return { value: null, absent: false, at: v.at, seq: v.seq, reason: `недопустимые единицы ${String(v.raw)}` };
    if (c.unit === null) {
      const reason = c.orphan
        ? 'отсчёт без единиц после потери провайдера единиц — ждём новых единиц и нового отсчёта'
        : 'ждём единиц автомобиля (Vehicle.statusNewCurrentUnitsStatusExt)';
      return { value: null, absent: true, at: c.at, seq: c.seq, reason };
    }
    const value = kind === 'pressure' ? decodeTyrePressure(c.raw, c.unit as PressUnit) : decodeTyreTemperature(c.raw, c.unit as TempUnit);
    return { value, absent: false, at: c.at, seq: c.seq, reason: value === null ? `raw ${String(c.raw)}: нет значения` : null };
  }

  unitsSummary(): { pressure: string; temperature: string } {
    const s = (u: UnitState) => (u.kind === 'valid' ? u.unit : u.kind === 'invalid' ? `invalid(${String(u.raw)})` : u.kind);
    return { pressure: s(this.units.pressure), temperature: s(this.units.temperature) };
  }
}
