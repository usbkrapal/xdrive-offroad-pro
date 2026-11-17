import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GearboxOilGate, readTorqueSplit } from '../src/vehicle/bds';
import { decodeAccelG, decodeEngineTemp, decodePedal, decodeRpm, decodeSpeed, decodeSteering, decodeTorque, decodeYawRate, INVALID } from '../src/vehicle/decode';
import { decodeTyrePressure, decodeTyreTemperature, pressUnitOf, tempUnitOf } from '../src/vehicle/tpms';
import { fuseGear, readGearbox, readSelection, stageOf, actualGearOf } from '../src/vehicle/gear';

describe('масштабирование сырых полей (upstream car.js)', () => {
  it('обороты: ×0,25, 65535 — нет значения, валидный 0 остаётся 0 (без порога <400)', () => {
    assert.equal(decodeRpm(0), 0);
    assert.equal(decodeRpm(1), 0.25);
    assert.equal(decodeRpm(1200), 300);
    assert.equal(decodeRpm(7680), 1920);
    assert.equal(decodeRpm(65535), INVALID);
    assert.equal(decodeRpm(65536), INVALID);
    assert.equal(decodeRpm(-1), INVALID);
    assert.equal(decodeRpm(12.5), INVALID);
    assert.equal(decodeRpm('7680'), INVALID);
    assert.equal(decodeRpm(null), INVALID);
  });

  it('температуры двигателя: raw − 48, 255 — нет значения, отрицательные сохраняются', () => {
    assert.equal(decodeEngineTemp(48), 0);
    assert.equal(decodeEngineTemp(0), -48);
    assert.equal(decodeEngineTemp(138), 90);
    assert.equal(decodeEngineTemp(254), 206);
    assert.equal(decodeEngineTemp(255), INVALID);
    assert.equal(decodeEngineTemp(256), INVALID);
  });

  it('скорость: ×0,015625 км/ч, 65535 — нет значения, 0 км/ч валиден', () => {
    assert.equal(decodeSpeed(0), 0);
    assert.equal(decodeSpeed(768), 12);
    assert.equal(decodeSpeed(65535), INVALID);
  });

  it('момент: ×0,5 − 1023,5; raw ≥ 4095 — нет значения; отрицательный момент валиден', () => {
    assert.equal(decodeTorque(2047), 0);
    assert.equal(decodeTorque(2393), 173);
    assert.equal(decodeTorque(1947), -50);
    assert.equal(decodeTorque(0), -1023.5);
    assert.equal(decodeTorque(4094), 1023.5);
    assert.equal(decodeTorque(4095), INVALID);
    assert.equal(decodeTorque(65535), INVALID);
  });

  it('ускорения: (raw × 0,002 − 65) / 9,80665 g, 65535 — нет значения, знак сохраняется', () => {
    assert.equal(decodeAccelG(32500), 0);
    const brake = decodeAccelG(32500 - 4903);
    assert.ok(typeof brake === 'number' && Math.abs(brake + 1) < 1e-3, `≈ −1 g, got ${String(brake)}`);
    assert.ok((decodeAccelG(32500 + 1000) as number) > 0);
    assert.equal(decodeAccelG(65535), INVALID);
  });
});

describe('передача: две разные таблицы enum', () => {
  it('statusGearboxDrive: G1…G10 = 3…12, R = 1, N_OR_P = 2; селектор P1/R2/N3/D4', () => {
    assert.deepEqual(actualGearOf(3), { kind: 'forward', n: 1 });
    assert.deepEqual(actualGearOf(12), { kind: 'forward', n: 10 });
    assert.deepEqual(actualGearOf('G8'), { kind: 'forward', n: 8 });
    assert.deepEqual(actualGearOf(1), { kind: 'reverse' });
    assert.deepEqual(actualGearOf('N_OR_P'), { kind: 'nOrP' });
    assert.equal(actualGearOf(0), null);
    assert.equal(actualGearOf(13), null);
    assert.equal(stageOf(1), 'P');
    assert.equal(stageOf(4), 'D');
    assert.equal(stageOf('N'), 'N');
    assert.equal(stageOf(5), null);
  });

  it('селектор D + ступень → D3; P/R/N — без номера', () => {
    assert.deepEqual(readGearbox({ statusActualGearDrive: 'G3', statusActualStageDrive: 'D' }), { kind: 'gear', gear: { selector: 'D', gear: 3 }, forward: 3 });
    assert.deepEqual(readGearbox({ statusActualGearDrive: 5, statusActualStageDrive: 4 }), { kind: 'gear', gear: { selector: 'D', gear: 3 }, forward: 3 });
    assert.deepEqual(readGearbox({ statusActualGearDrive: 'N_OR_P', statusActualStageDrive: 'P' }).kind, 'gear');
    assert.deepEqual((readGearbox({ statusActualGearDrive: 2, statusActualStageDrive: 1 }) as { gear: unknown }).gear, { selector: 'P', gear: null });
  });

  it('N_OR_P без селектора — неоднозначно, P не придумывается', () => {
    assert.equal(readGearbox({ statusActualGearDrive: 'N_OR_P' }).kind, 'ambiguous');
    assert.equal(readSelection({ statusGearSelectionDrive: 'NP' }).kind, 'ambiguous');
    assert.equal(readSelection({ statusGearSelectionDrive: 4 }).kind, 'ambiguous');
  });

  it('номер ступени без селектора — неоднозначно (D или M), но задний ход однозначен', () => {
    assert.equal(readGearbox({ statusActualGearDrive: 'G4' }).kind, 'ambiguous');
    assert.equal(readSelection({ statusGearSelectionDrive: '_4' }).kind, 'ambiguous');
    assert.equal(readSelection({ statusGearSelectionDrive: 8 }).kind, 'ambiguous');
    assert.deepEqual((readGearbox({ statusActualGearDrive: 'R' }) as { gear: unknown }).gear, { selector: 'R', gear: null });
  });

  it('DataPowerTrain2: N1/R2/P3 — своя таблица (не та же, что у statusGearboxDrive)', () => {
    assert.deepEqual((readSelection({ statusGearSelectionDrive: 1 }) as { gear: unknown }).gear, { selector: 'N', gear: null });
    assert.deepEqual((readSelection({ statusGearSelectionDrive: 2 }) as { gear: unknown }).gear, { selector: 'R', gear: null });
    assert.deepEqual((readSelection({ statusGearSelectionDrive: 3 }) as { gear: unknown }).gear, { selector: 'P', gear: null });
    // 1 в statusGearboxDrive — это задний ход, а в DataPowerTrain2 — N.
    assert.equal((readGearbox({ statusActualGearDrive: 1 }) as { gear: { selector: string } }).gear.selector, 'R');
  });

  it('мусор → invalid', () => {
    assert.equal(readGearbox(null).kind, 'invalid');
    assert.equal(readGearbox({}).kind, 'invalid');
    assert.equal(readGearbox({ statusActualGearDrive: 'SIGNAL_UNGUELTIG' }).kind, 'invalid');
    assert.equal(readSelection({ statusGearSelectionDrive: 99 }).kind, 'invalid');
    assert.equal(readSelection(undefined).kind, 'invalid');
  });

  it('слияние: D без номера дополняется номером из DataPowerTrain2; устаревшее — stale', () => {
    const g = { reading: readGearbox({ statusActualStageDrive: 'D', statusActualGearDrive: 'N_OR_P' }), at: 1000 };
    const s = { reading: readSelection({ statusGearSelectionDrive: '_2' }), at: 1100 };
    // Итог не свежее самого старого нужного отсчёта (селектор D пришёл в 1000).
    assert.deepEqual(fuseGear(g, s, 1200, 5000), { kind: 'gear', gear: { selector: 'D', gear: 2 }, at: 1000 });
    assert.deepEqual(fuseGear(g, s, 99_000, 5000), { kind: 'stale', at: 1000, gear: { selector: 'D', gear: 2 } });
    assert.equal(fuseGear(null, s, 1200, 5000).kind, 'ambiguous');
    assert.equal(fuseGear(null, null, 0, 5000).kind, 'none');
  });
});

describe('слияние передачи по времени отсчётов', () => {
  const gb = (v: Record<string, unknown>, at: number) => ({ reading: readGearbox(v), at });
  const sel = (v: unknown, at: number) => ({ reading: readSelection({ statusGearSelectionDrive: v }), at });
  const D3 = { statusActualStageDrive: 'D', statusActualGearDrive: 'G3' };
  const STALE = 60_000;

  it('переход D → R/P: более новый явный селектор DataPowerTrain2 побеждает старый statusGearboxDrive', () => {
    assert.deepEqual(fuseGear(gb(D3, 0), sel('R', 1000), 1000, STALE), { kind: 'gear', gear: { selector: 'R', gear: null }, at: 1000 });
    assert.deepEqual(fuseGear(gb(D3, 0), sel(3, 1000), 1000, STALE), { kind: 'gear', gear: { selector: 'P', gear: null }, at: 1000 });
    assert.deepEqual(fuseGear(gb(D3, 0), sel('N', 1000), 1000, STALE), { kind: 'gear', gear: { selector: 'N', gear: null }, at: 1000 });
    // И обратно: свежий D из коробки после старого R.
    assert.deepEqual(fuseGear(gb(D3, 2000), sel('R', 1000), 2000, STALE), { kind: 'gear', gear: { selector: 'D', gear: 3 }, at: 2000 });
    // Согласны: P и P — итог держится на одном (более новом) отсчёте.
    assert.deepEqual(fuseGear(gb({ statusActualStageDrive: 'P' }, 500), sel('P', 900), 1000, STALE), { kind: 'gear', gear: { selector: 'P', gear: null }, at: 900 });
  });

  it('устаревшее основное поле + свежее второе: только свежее, без «D» из одного номера', () => {
    assert.deepEqual(fuseGear(gb(D3, 0), sel('R', 70_000), 70_000, STALE), { kind: 'gear', gear: { selector: 'R', gear: null }, at: 70_000 });
    assert.deepEqual(fuseGear(gb(D3, 0), sel('_4', 70_000), 70_000, STALE), { kind: 'ambiguous', at: 70_000 });
    assert.deepEqual(fuseGear(gb(D3, 0), sel('NP', 70_000), 70_000, STALE), { kind: 'ambiguous', at: 70_000 });
  });

  it('одновременные противоречащие отсчёты — неоднозначно (нет данных)', () => {
    assert.deepEqual(fuseGear(gb(D3, 1000), sel('R', 1000), 1000, STALE), { kind: 'ambiguous', at: 1000 });
    assert.deepEqual(fuseGear(gb({ statusActualStageDrive: 'P' }, 1000), sel('N', 1000), 1000, STALE), { kind: 'ambiguous', at: 1000 });
    assert.deepEqual(fuseGear(gb({ statusActualStageDrive: 'R' }, 1000), sel('NP', 1000), 1000, STALE), { kind: 'ambiguous', at: 1000 });
    assert.deepEqual(fuseGear(gb({ statusActualStageDrive: 'P' }, 1000), sel('_2', 1000), 1000, STALE), { kind: 'ambiguous', at: 1000 });
    // Согласные одновременные — передача.
    assert.deepEqual(fuseGear(gb({ statusActualStageDrive: 'R' }, 1000), sel('R', 1000), 1000, STALE), { kind: 'gear', gear: { selector: 'R', gear: null }, at: 1000 });
  });

  it('NP: неоднозначно само по себе; не опровергает P/N, но опровергает более старые D/R', () => {
    assert.deepEqual(fuseGear(null, sel('NP', 1000), 1000, STALE), { kind: 'ambiguous', at: 1000 });
    assert.deepEqual(fuseGear(gb({ statusActualGearDrive: 'N_OR_P' }, 900), sel('NP', 1000), 1000, STALE), { kind: 'ambiguous', at: 1000 }, 'P не придумывается');
    assert.deepEqual(fuseGear(gb({ statusActualStageDrive: 'P' }, 900), sel('NP', 1000), 1000, STALE), { kind: 'gear', gear: { selector: 'P', gear: null }, at: 900 });
    assert.deepEqual(fuseGear(gb({ statusActualStageDrive: 'N' }, 900), sel('NP', 1000), 1000, STALE), { kind: 'gear', gear: { selector: 'N', gear: null }, at: 900 });
    assert.deepEqual(fuseGear(gb(D3, 900), sel('NP', 1000), 1000, STALE), { kind: 'ambiguous', at: 1000 });
    assert.deepEqual(fuseGear(gb({ statusActualStageDrive: 'R' }, 900), sel('NP', 1000), 1000, STALE), { kind: 'ambiguous', at: 1000 });
    // Более новый N_OR_P из коробки после явного R из DataPowerTrain2.
    assert.deepEqual(fuseGear(gb({ statusActualGearDrive: 'N_OR_P' }, 1000), sel('R', 900), 1000, STALE), { kind: 'ambiguous', at: 1000 });
  });

  it('номер ступени без селектора никогда не даёт D/M', () => {
    assert.deepEqual(fuseGear(gb({ statusActualGearDrive: 'G4' }, 1000), sel('_4', 1000), 1000, STALE), { kind: 'ambiguous', at: 1000 });
    assert.deepEqual(fuseGear(gb({ statusActualGearDrive: 'G4' }, 1000), null, 1000, STALE), { kind: 'ambiguous', at: 1000 });
    assert.deepEqual(fuseGear(null, sel('_4', 1000), 1000, STALE), { kind: 'ambiguous', at: 1000 });
    assert.deepEqual(fuseGear(gb({ statusActualStageDrive: 'P' }, 900), sel('_1', 1000), 1000, STALE), { kind: 'ambiguous', at: 1000 });
    // D из коробки + более новый номер: D с новым номером, время — старейший вход.
    assert.deepEqual(fuseGear(gb(D3, 900), sel('_4', 1000), 1000, STALE), { kind: 'gear', gear: { selector: 'D', gear: 4 }, at: 900 });
  });

  it('недопустимый отсчёт одного поля не мешает другому; оба недопустимы — invalid', () => {
    assert.deepEqual(fuseGear(gb({}, 1000), sel('R', 900), 1000, STALE), { kind: 'gear', gear: { selector: 'R', gear: null }, at: 900 });
    assert.deepEqual(fuseGear(gb({}, 1000), sel(99, 900), 1000, STALE), { kind: 'invalid', at: 1000 });
  });
});

describe('новые поля (upstream live_data / xdrive_live / car_vitals / redline)', () => {
  it('руль: int16 ×0.04395°, uint16 в доп. коде, 65535/−1 и |угол| > 900 — нет значения', () => {
    assert.equal(decodeSteering(0), 0);
    assert.equal(decodeSteering(32767), INVALID, '1440° > 900°');
    assert.equal(decodeSteering(20477), 20477 * 0.04395);
    assert.equal(decodeSteering(20478), INVALID);
    assert.equal(decodeSteering(65536 - 20477), -20477 * 0.04395);
    assert.equal(decodeSteering(-20477), -20477 * 0.04395);
    assert.equal(decodeSteering(65535), INVALID);
    assert.equal(decodeSteering(-1), INVALID);
    assert.equal(decodeSteering(65536), INVALID);
    assert.equal(decodeSteering(1.5), INVALID);
    assert.equal(decodeSteering('100'), INVALID);
  });

  it('рыскание: ×0.005 − 163.84 °/с, 65535 — нет значения', () => {
    assert.equal(decodeYawRate(32768), 0);
    assert.equal(decodeYawRate(0), -163.84);
    assert.equal(decodeYawRate(65535), INVALID);
    assert.equal(decodeYawRate(-1), INVALID);
  });

  it('педаль: ×0.025 %, raw 0…4000', () => {
    assert.equal(decodePedal(0), 0);
    assert.equal(decodePedal(2000), 50);
    assert.equal(decodePedal(4000), 100);
    assert.equal(decodePedal(4001), INVALID);
    assert.equal(decodePedal(65535), INVALID);
    assert.equal(decodePedal(-1), INVALID);
  });

  it('распределение момента: квалификатор, 0/65535 — не заполнено, > 10000 — invalid, член отсутствует — не отсчёт', () => {
    const r = readTorqueSplit({ valueDistributionLongitudinalTorqueRearAxisFrontAxis: 7500, qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis: 'SIGNALWERT_IST_GUELTIG' });
    assert.deepEqual(r, { kind: 'split', rearPercent: 75, frontPercent: 25, qualifier: 'ok' });
    assert.equal(readTorqueSplit({ valueDistributionLongitudinalTorqueRearAxisFrontAxis: 7500 })?.kind, 'split');
    assert.equal(readTorqueSplit({ valueDistributionLongitudinalTorqueRearAxisFrontAxis: 0, qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis: 2 })?.kind, 'unfilled');
    assert.equal(readTorqueSplit({ valueDistributionLongitudinalTorqueRearAxisFrontAxis: 65535 })?.kind, 'unfilled');
    assert.equal(readTorqueSplit({ valueDistributionLongitudinalTorqueRearAxisFrontAxis: 10001 })?.kind, 'invalid');
    assert.equal(readTorqueSplit({ valueDistributionLongitudinalTorqueRearAxisFrontAxis: 5000, qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis: 3 })?.kind, 'invalid');
    assert.equal(readTorqueSplit({ valueTemperatureTransmissionOil: 100 }), null);
  });

  it('масло КПП: ждём второго разного сырого значения; 255 и вне −40…160 °C — invalid', () => {
    const g = new GearboxOilGate();
    assert.equal(g.read({ valueTemperatureTransmissionOil: 90 })?.kind, 'waiting');
    assert.equal(g.read({ valueTemperatureTransmissionOil: 90 })?.kind, 'waiting');
    assert.equal(g.read({ valueTemperatureTransmissionOil: 255 })?.kind, 'invalid');
    assert.deepEqual(g.read({ valueTemperatureTransmissionOil: 91 }), { kind: 'value', c: 43 });
    assert.deepEqual(g.read({ valueTemperatureTransmissionOil: 90 }), { kind: 'value', c: 42 });
    assert.equal(new GearboxOilGate().read({ valueTemperatureTransmissionOil: 0 })?.kind, 'invalid');
    assert.equal(new GearboxOilGate().read({}), null);
  });

  it('TPMS: единицы номером/именем; давление raw × 0.1 в единице, ≥ 65532 нет; 0 бар допустим; температура raw − 40', () => {
    assert.equal(pressUnitOf(1), 'BAR');
    assert.equal(pressUnitOf('PSI'), 'PSI');
    assert.equal(pressUnitOf('psi'), null);
    assert.equal(pressUnitOf(0), null);
    assert.equal(tempUnitOf(2), 'F');
    assert.equal(tempUnitOf('K'), null);
    assert.equal(decodeTyrePressure(0, 'BAR'), 0);
    assert.ok(Math.abs((decodeTyrePressure(23, 'BAR') as number) - 2.3) < 1e-9);
    assert.ok(Math.abs((decodeTyrePressure(2300, 'KPA') as number) - 2.3) < 1e-9);
    assert.ok(Math.abs((decodeTyrePressure(330, 'PSI') as number) - 33 / 14.5038) < 1e-9);
    assert.equal(decodeTyrePressure(65532, 'BAR'), null);
    assert.equal(decodeTyrePressure(61, 'BAR'), null, '> 6 бар (граница upstream)');
    assert.equal(decodeTyreTemperature(60, 'C'), 20);
    assert.ok(Math.abs((decodeTyreTemperature(140, 'F') as number) - (68 * 5) / 9) < 1e-9);
    assert.equal(decodeTyreTemperature(65535, 'C'), null);
    assert.equal(decodeTyreTemperature(0, 'C'), -40);
    assert.equal(decodeTyreTemperature(200, 'C'), null);
  });
});
