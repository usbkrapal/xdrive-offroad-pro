import { heightDeltas, type CornerHeights } from '../../../src/domain/derived';
import { WHEELS, type Wheel } from '../../../src/domain/types';
import type { NativeSnapshot } from '../model/model';
import type { ExtraSignal } from './adapter';

export const usableExtra = (e: ExtraSignal): number | null =>
  e.quality === 'valid' && e.value !== null && Number.isFinite(e.value) ? e.value : null;

/** DC05 returns all four calibrated sensor travels in one reply. Compare channels from that reply only. */
export function sensorHeightDeltas({ extra }: NativeSnapshot) {
  const heights: CornerHeights = { FL: null, FR: null, RL: null, RR: null };
  let newest = -Infinity;
  for (const wheel of WHEELS) {
    const at = extra[`rideHeightSensor.${wheel}`].updatedAt;
    if (at !== null) newest = Math.max(newest, at);
  }
  for (const wheel of WHEELS) {
    const sample = extra[`rideHeightSensor.${wheel}`];
    if (sample.updatedAt === newest) heights[wheel] = usableExtra(sample);
  }
  return heightDeltas(heights);
}

/** Absolute difference from the DSC reference speed, as a percentage. */
export function wheelDeltaMagnitude({ extra }: NativeSnapshot, wheel: Wheel): number | null {
  const delta = usableExtra(extra[`wheelDelta.${wheel}`]);
  return delta === null ? null : Math.abs(delta);
}
