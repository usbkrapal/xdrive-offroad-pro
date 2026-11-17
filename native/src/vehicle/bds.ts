// BasicDataSet.basicDataSet (только уведомления, геттера нет — upstream app.json "s").
// Источник — upstream car_vitals main.js / app.json config.scaling и live_adjustments/xdrive_live.js:
//   valueDistributionLongitudinalTorqueRearAxisFrontAxis: × 0.01 % — доля ЗАДНЕЙ оси; 0 и 65535 — поле
//     не заполнено; принимается, только если qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis
//     допустим (2 / 10 / SIGNALWERT_IST_GUELTIG / …__REKALIBRIERUNGSBEDARF) или отсутствует (upstream
//     допускает отсутствие; для G07 не подтверждено). Передняя доля = 100 − задняя (вычислена, estimated).
//     Моменты осей в Н·м отсюда НЕ выводятся (никакого «задний = двигатель − передний»).
//   valueTemperatureTransmissionOil: raw − 48 °C, 255 — нет значения. Некоторые автомобили поле не заполняют
//     и шлют постоянное число (raw 0 = −48 °C или 48 = 0 °C): как в car_vitals (MOVE gearbox 1 °C), значение
//     показывается только после того, как пришло больше одного разного сырого значения.

import { rawUInt } from './decode';

export const BDS_MEMBERS = {
  split: 'valueDistributionLongitudinalTorqueRearAxisFrontAxis',
  qualifier: 'qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis',
  gearboxOil: 'valueTemperatureTransmissionOil',
} as const;

/** Допустимые значения квалификатора — ровно как SPLIT_OK upstream (car_vitals, xdrive_live). */
const SPLIT_QUALIFIER_OK: readonly unknown[] = [2, 10, 'SIGNALWERT_IST_GUELTIG', 'SIGNALWERT_IST_GUELTIG__REKALIBRIERUNGSBEDARF'];

export type SplitReading =
  | { readonly kind: 'split'; readonly rearPercent: number; readonly frontPercent: number; readonly qualifier: 'ok' | 'absent' }
  /** Поле не заполнено (0 / 65535) — нет данных. */
  | { readonly kind: 'unfilled'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/** null — члена в структуре нет (это не отсчёт распределения). */
export function readTorqueSplit(v: unknown): SplitReading | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const raw = o[BDS_MEMBERS.split];
  if (raw === undefined) return null;
  const q = o[BDS_MEMBERS.qualifier];
  const qAbsent = q === undefined || q === null;
  if (!qAbsent && SPLIT_QUALIFIER_OK.indexOf(q) < 0) return { kind: 'invalid', reason: `квалификатор ${String(q)}` };
  if (raw === 0 || raw === 0xffff) return { kind: 'unfilled', reason: `raw ${raw}: поле не заполнено` };
  const r = rawUInt(raw, 10000);
  if (r === null) return { kind: 'invalid', reason: `raw ${String(raw)} вне 1…10000` };
  const rear = r * 0.01;
  return { kind: 'split', rearPercent: rear, frontPercent: 100 - rear, qualifier: qAbsent ? 'absent' : 'ok' };
}

/** Диапазон масла КПП, °C (car_vitals RANGE.gearbox). */
const GEARBOX_C_RANGE = [-40, 160] as const;

export type GearboxOilReading =
  | { readonly kind: 'value'; readonly c: number }
  | { readonly kind: 'waiting'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Масло КПП из BasicDataSet: не показывается, пока сырое значение ни разу не поменялось. */
export class GearboxOilGate {
  private first: number | null = null;
  private promoted = false;

  get isPromoted(): boolean {
    return this.promoted;
  }

  /** Потеря провайдера: изменение до неё не считается — после возврата снова ждём двух разных значений. */
  reset(): void {
    this.first = null;
    this.promoted = false;
  }

  /** null — члена нет (не отсчёт). */
  read(v: unknown): GearboxOilReading | null {
    if (!v || typeof v !== 'object') return null;
    const raw = (v as Record<string, unknown>)[BDS_MEMBERS.gearboxOil];
    if (raw === undefined) return null;
    const r = rawUInt(raw, 0xff);
    if (r === null || r === 0xff) return { kind: 'invalid', reason: `raw ${String(raw)}: нет значения` };
    const c = r - 48;
    if (c < GEARBOX_C_RANGE[0] || c > GEARBOX_C_RANGE[1]) return { kind: 'invalid', reason: `raw ${r} (${c} °C) вне диапазона` };
    if (!this.promoted) {
      if (this.first === null) this.first = r;
      else if (r !== this.first) this.promoted = true;
    }
    if (!this.promoted) return { kind: 'waiting', reason: `стоит на raw ${r} (${c} °C) — ждём изменения` };
    return { kind: 'value', c };
  }
}
