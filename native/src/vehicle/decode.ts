// Масштабирование сырых полей SOME/IP. Источник формул — upstream kit/runtime/car.js
// (SCALE) и README §7 на закреплённом коммите; на G07 не проверено.
// Сентинел «нет значения» и выход за разрядность поля → INVALID. Валидный 0 остаётся 0,
// отрицательные значения (момент < 0) сохраняются; никаких порогов «ниже 400 об/мин = 0».

export const INVALID = Symbol('invalid');
export type Decoded = number | typeof INVALID;

const G0 = 9.80665;

/** Целое неотрицательное число в пределах разрядности, иначе null. */
export function rawUInt(v: unknown, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > max) return null;
  return v;
}

/** CDS.statusEngineSpeed2.actualValueRPMEngineCrankshaft: uint16 × 0.25 об/мин, 65535 — нет значения. */
export function decodeRpm(v: unknown): Decoded {
  const raw = rawUInt(v, 0xffff);
  if (raw === null || raw === 0xffff) return INVALID;
  return raw * 0.25;
}

/** CDS.statusEngineTemperature.*: uint8 − 48 °C, 255 — нет значения. */
export function decodeEngineTemp(v: unknown): Decoded {
  const raw = rawUInt(v, 0xff);
  if (raw === null || raw === 0xff) return INVALID;
  return raw - 48;
}

/** Vehicle2.statusCarSpeed2.speedVehicleCentreOfGravity: uint16 × 0.015625 км/ч, 65535 — нет значения. */
export function decodeSpeed(v: unknown): Decoded {
  const raw = rawUInt(v, 0xffff);
  if (raw === null || raw === 0xffff) return INVALID;
  return raw * 0.015625;
}

/**
 * FES.statusActualValueTorque2.actualValueTorqueCrankshaft: 12 бит, 0,5 Н·м/бит, 0 Н·м при raw 2047;
 * raw ≥ 4095 (в т. ч. 65535) — нет значения. Отрицательный момент (торможение двигателем) валиден.
 */
export function decodeTorque(v: unknown): Decoded {
  const raw = rawUInt(v, 0xffff);
  if (raw === null || raw >= 4095) return INVALID;
  return raw * 0.5 - 1023.5;
}

/** CDS2.status*AccelerationMassCenter: (uint16 × 0.002 − 65) м/с² → g; 65535 — нет значения. */
export function decodeAccelG(v: unknown): Decoded {
  const raw = rawUInt(v, 0xffff);
  if (raw === null || raw === 0xffff) return INVALID;
  return (raw * 0.002 - 65) / G0;
}
