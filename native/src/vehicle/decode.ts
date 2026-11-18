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

/** Целое со знаком −32768…−1 (int16) или 0…65535 (uint16, дополнительный код) → int16; иначе null. */
function int16Of(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < -0x8000 || v > 0xffff) return null;
  return v >= 0x8000 ? v - 0x10000 : v;
}

/**
 * SteeringAngle.ActualSteeringAngleDriver / actualSteeringAngleDriverNoCRC .actualValueSteeringAngleDriver:
 * int16 × 0.04395 °, lim ±900 — масштаб и знак — ЛУЧШАЯ ДОГАДКА upstream (live_data/signals.js помечает их `q`:
 * «scaling is a best guess»), не определение BMW. 65535 пропускает upstream xdrive_live.js; что это «нет значения»,
 * а не допустимый отсчёт, не доказано. Привязка может отдать и uint16, и int16: −1 и есть 0xFFFF.
 */
export function decodeSteering(v: unknown): Decoded {
  if (v === 0xffff || v === -1) return INVALID;
  const raw = int16Of(v);
  if (raw === null) return INVALID;
  const deg = raw * 0.04395;
  return deg < -900 || deg > 900 ? INVALID : deg;
}

/** CDS2.statusYawVelocityVehicle.yawVelocityVehicle: uint16 × 0.005 − 163.84 °/с, 65535 — нет значения. */
export function decodeYawRate(v: unknown): Decoded {
  const raw = rawUInt(v, 0xffff);
  if (raw === null || raw === 0xffff) return INVALID;
  return raw * 0.005 - 163.84;
}

/**
 * AcceleratorPedal.AngleAcceleratorPedal.actualValueAngleAcceleratorPedal: × 0.025 % — лучшая догадка upstream
 * (live_data/signals.js, `q`, lim −2…102 %). Полный ход на G07 не измерен: принимается raw 0…4080 (до 102 %, как
 * upstream; kick-down может давать больше 100 %), всё выше, в т. ч. сентинелы, — нет значения.
 * Это положение педали, НЕ дроссель (engine.throttlePercent).
 */
export function decodePedal(v: unknown): Decoded {
  const raw = rawUInt(v, 0xffff);
  if (raw === null || raw > 4080) return INVALID;
  return raw * 0.025;
}
