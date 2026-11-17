import { usableNumber } from './signal';
import { WHEELS, type TelemetrySnapshot, type Wheel } from './types';

export type CornerHeights = Record<Wheel, number | null>;

export interface HeightDeltas {
  /** FL − FR */
  readonly frontDelta: number | null;
  /** RL − RR */
  readonly rearDelta: number | null;
  /** (FL + RL − FR − RR) / 2 */
  readonly leftRight: number | null;
  /** (FL + FR − RL − RR) / 2 */
  readonly frontRear: number | null;
  /** max − min по четырём углам */
  readonly range: number | null;
}

/** Высоты углов, пригодные для расчёта; stale/invalid/unavailable → null. */
export function cornerHeights(snapshot: TelemetrySnapshot): CornerHeights {
  return {
    FL: usableNumber(snapshot.signals['suspensionHeight.FL']),
    FR: usableNumber(snapshot.signals['suspensionHeight.FR']),
    RL: usableNumber(snapshot.signals['suspensionHeight.RL']),
    RR: usableNumber(snapshot.signals['suspensionHeight.RR']),
  };
}

/** Производные высот подвески; если нужного входа нет — результат недоступен. */
export function heightDeltas(h: CornerHeights): HeightDeltas {
  const { FL, FR, RL, RR } = h;
  const all = FL !== null && FR !== null && RL !== null && RR !== null;
  return {
    frontDelta: FL !== null && FR !== null ? FL - FR : null,
    rearDelta: RL !== null && RR !== null ? RL - RR : null,
    leftRight: all ? (FL + RL - FR - RR) / 2 : null,
    frontRear: all ? (FL + FR - RL - RR) / 2 : null,
    range: all ? Math.max(FL, FR, RL, RR) - Math.min(FL, FR, RL, RR) : null,
  };
}

/** Наибольший synthetic slip среди колёс с валидным значением. */
export function maxSlipNow(snapshot: TelemetrySnapshot): { wheel: Wheel; value: number } | null {
  let best: { wheel: Wheel; value: number } | null = null;
  for (const w of WHEELS) {
    const v = usableNumber(snapshot.signals[`wheelSlip.${w}`]);
    if (v !== null && (best === null || v > best.value)) best = { wheel: w, value: v };
  }
  return best;
}
