// Расширенная телеметрия режима чтения: опрос, свежесть, потеря провайдера, руль, рыскание, педаль,
// BasicDataSet, TPMS с единицами автомобиля, диагностика. Транспорт — фальшивый, с opts (пятый аргумент
// watch), res.losses и onAvailability, как у пропатченного vendor signals.js.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SIGNAL_IDS } from '../../src/domain/signalCatalog';
import type { SignalId } from '../../src/domain/types';
import type { FieldHandler, WatchResult } from '../src/platform/kitTypes';
import { VehicleAdapter, type GetterStats, type TelemetryWatchFn, type WatchOpts } from '../src/vehicle/adapter';
import { manifestSignals, VEHICLE_EXPANSION_NOTES, VEHICLE_FIELDS, VEHICLE_INTERFACES, VEHICLE_SIGNAL_IDS } from '../src/vehicle/allowlist';
import { RING_MAX } from '../src/vehicle/diag';
import { flush } from './helpers';

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const CDS2 = 'de.bmw.infotainment.vehicle.CDS2';
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const VI = 'de.bmw.infrastructure.VehicleInformation';
const STEER = 'de.bmw.chassis.SteeringAngle';
const PEDAL = 'de.bmw.powertrain.AcceleratorPedal';
const BDS = 'de.bmw.infrastructure.analytics.BasicDataSet';
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const VEH = 'de.bmw.infotainment.vehicle.Vehicle';
const PT = 'de.bmw.powertrain.Powertrain';
const VM = 'de.bmw.chassis.VehicleModel';
const DSC = 'de.bmw.chassis.VehicleStabilizationManagement';

interface Sub {
  iface: string;
  handlers: Record<string, FieldHandler>;
  opts: WatchOpts | undefined;
  res: WatchResult & { losses: number; shutdownCalls: number; reads: Record<string, MutableStats> };
}

type MutableStats = { -readonly [K in keyof GetterStats]: GetterStats[K] } & Record<string, unknown>;

class Transport {
  subs: Sub[] = [];
  readonly watch: TelemetryWatchFn = (iface, _inst, handlers, _log, opts) => {
    const res = {
      available: false,
      losses: 0,
      reads: {} as Record<string, MutableStats>,
      error: null,
      shutdownCalls: 0,
      shutdown() {
        res.shutdownCalls++;
        return Promise.resolve();
      },
    };
    this.subs.push({ iface, handlers, opts, res });
    return Promise.resolve(res);
  };
  private live(iface: string) {
    return this.subs.filter((s) => s.iface === iface && s.res.shutdownCalls === 0);
  }
  /** Уведомление или успешное чтение геттером (провайдер доступен). */
  feed(iface: string, field: string, v: unknown): void {
    for (const s of this.live(iface)) {
      if (!s.handlers[field]) continue;
      if (!s.res.available) this.avail(iface, true);
      s.handlers[field](v);
    }
  }
  avail(iface: string, on: boolean, viaCallback = true): void {
    for (const s of this.live(iface)) {
      if (s.res.available && !on) s.res.losses++;
      s.res.available = on;
      if (viaCallback) s.opts?.onAvailability?.(on);
    }
  }
  /** Чтение геттером, как в пропатченном signals.js: успех — счётчики + обработчик, неудача — только счётчики. */
  getter(iface: string, field: string, t: number, outcome: { value: unknown } | { error: string }): void {
    for (const s of this.live(iface)) {
      const r = (s.res.reads[field] ??= { ok: 0, failed: 0, consecutiveFailures: 0, dropped: 0, skipped: 0, lastOkAt: null, lastFailAt: null, lastError: null, pendingSince: null });
      if ('error' in outcome) {
        r.failed++;
        r.consecutiveFailures++;
        r.lastFailAt = t;
        r.lastError = outcome.error;
        continue;
      }
      r.ok++;
      r.consecutiveFailures = 0;
      r.lastOkAt = t;
      s.handlers[field](outcome.value);
    }
  }
  /** Провайдер пропал и вернулся между кадрами; колбэка нет (старая обёртка) — виден только res.losses. */
  flapSilently(iface: string): void {
    for (const s of this.live(iface)) s.res.losses++;
  }
}

function setup() {
  const tr = new Transport();
  let now = 0;
  const a = new VehicleAdapter(tr.watch, () => now);
  return { tr, a, at: (t: number) => (now = t) };
}

async function started() {
  const s = setup();
  s.a.start();
  await flush();
  return s;
}

const P = (fl: number, fr = fl, rl = fl, rr = fl) => ({ actualValuePressureTyreFLH: fl, actualValuePressureTyreFRH: fr, actualValuePressureTyreRLH: rl, actualValuePressureTyreRRH: rr });
const T = (fl: number, fr = fl, rl = fl, rr = fl) => ({ actualValueTemperatureTyreFLH: fl, actualValueTemperatureTyreFRH: fr, actualValueTemperatureTyreRLH: rl, actualValueTemperatureTyreRRH: rr });
const U = (p: unknown, t: unknown) => ({ unitOfMeasurementAirPressure: p, unitOfMeasurementTemperature: t });

const near = (x: unknown, y: number, eps = 1e-6) => assert.ok(typeof x === 'number' && Math.abs(x - y) < eps, `${String(x)} ≈ ${y}`);

describe('allowlist: манифест, флаги, периоды опроса', () => {
  it('новые интерфейсы и флаги ровно как в upstream app.json; опрос только у полей с геттером', () => {
    const m = manifestSignals();
    assert.equal(m[STEER].ActualSteeringAngleDriver, 's');
    assert.equal(m[STEER].actualSteeringAngleDriverNoCRC, 's');
    assert.equal(m[PEDAL].AngleAcceleratorPedal, 's');
    assert.equal(m[BDS].basicDataSet, 's');
    assert.equal(m[CDS2].statusYawVelocityVehicle, 'rs');
    assert.equal(m[TPMS].statusTyrePressure, 'rs');
    assert.equal(m[TPMS].statusTyreTemperature, 'rs');
    assert.equal(m[VEH].statusNewCurrentUnitsStatusExt, 'rs');
    assert.equal(m[PT].ActualValueRPMWheel, 's');
    assert.equal(m[VM].LaneSlope, 's');
    assert.equal(m[DSC].StabilizationManagement, 's');
    for (const f of VEHICLE_FIELDS) {
      if (f.flags === 's') assert.equal(f.pollMs, undefined, `${f.field}: без геттера не опрашивается`);
      // быстрые — 5 Гц (не чаще: одно чтение на поле в полёте, таймаут привязки 3 с); температуры/TPMS — реже
      else assert.ok(f.pollMs && f.pollMs >= 200, `${f.field}: период опроса`);
    }
    const slow = ['statusEngineTemperature', 'statusTyrePressure', 'statusTyreTemperature', 'statusNewCurrentUnitsStatusExt'];
    for (const f of VEHICLE_FIELDS.filter((x) => x.flags === 'rs')) {
      assert.equal(f.pollMs, slow.includes(f.field) ? (f.field === 'statusEngineTemperature' ? 5000 : 10000) : 200, f.field);
    }
    assert.equal(VEHICLE_INTERFACES.length, 13);
    assert.equal(VEHICLE_FIELDS.length, 19);
  });

  it('прежние 8 привязок сохранены', () => {
    const keys = new Set(VEHICLE_FIELDS.map((f) => `${f.iface}.${f.field}`));
    for (const k of [
      `${CDS}.statusEngineSpeed2`,
      `${CDS}.statusEngineTemperature`,
      `${V2}.statusCarSpeed2`,
      'de.bmw.infotainment.drivingexcitement.FES.statusActualValueTorque2',
      `${CDS2}.statusLongitudinalAccelerationMassCenter`,
      `${CDS2}.statusLateralAccelerationMassCenter`,
      `${VI}.statusGearboxDrive`,
      `${VI}.DataPowerTrain2`,
    ])
      assert.ok(keys.has(k), k);
  });

  it('VEHICLE_EXPANSION_NOTES не пересекается с читаемыми сигналами; неизвестные остаются без источника', () => {
    for (const id of Object.keys(VEHICLE_EXPANSION_NOTES)) assert.ok(!(VEHICLE_SIGNAL_IDS as readonly string[]).includes(id), id);
    for (const id of ['attitude.pitchDeg', 'attitude.rollDeg', 'altitudeM', 'suspension.level', 'hdc.status', 'dsc.status', 'dtc.status', 'rearDiff.lockState', 'engine.throttlePercent', 'xdrive.frontTorqueNm', 'xdrive.rearTorqueNm', 'wheelSpeed.FL', 'wheelSlip.RR', 'brakeIntervention.FL', 'suspensionHeight.FL'])
      assert.ok(!(VEHICLE_SIGNAL_IDS as readonly string[]).includes(id), id);
    for (const id of ['steeringWheelAngleDeg', 'yawRateDegS', 'acceleratorPedalPercent', 'xdrive.frontPercent', 'xdrive.rearPercent', 'temperature.gearboxC', 'tyrePressure.FL', 'tyrePressure.RR', 'tyreTemperature.RL'])
      assert.ok((VEHICLE_SIGNAL_IDS as readonly string[]).includes(id), id);
  });

  it('watch получает opts: fieldPollMs по полям (200 мс = 5 Гц / 5 с / 10 с), onAvailability у всех', async () => {
    const { tr } = await started();
    const by = (i: string) => tr.subs.find((s) => s.iface === i)!.opts!;
    assert.deepEqual(by(CDS).fieldPollMs, { statusEngineSpeed2: 200, statusEngineTemperature: 5000 });
    assert.equal(by(CDS).pollMs, 200);
    assert.deepEqual(by(V2).fieldPollMs, { statusCarSpeed2: 200 });
    assert.deepEqual(by(FES).fieldPollMs, { statusActualValueTorque2: 200 });
    assert.deepEqual(by(CDS2).fieldPollMs, { statusLongitudinalAccelerationMassCenter: 200, statusLateralAccelerationMassCenter: 200, statusYawVelocityVehicle: 200 });
    assert.deepEqual(by(TPMS).fieldPollMs, { statusTyrePressure: 10000, statusTyreTemperature: 10000 });
    assert.deepEqual(by(VEH).fieldPollMs, { statusNewCurrentUnitsStatusExt: 10000 });
    for (const i of [VI, STEER, PEDAL, BDS, PT, VM, DSC]) assert.equal(by(i).pollMs, undefined, i);
    for (const s of tr.subs) assert.equal(typeof s.opts?.onAvailability, 'function', s.iface);
  });
});

describe('свежесть и потеря провайдера', () => {
  it('стоящий автомобиль: скорость 0 держится свежей через успешные чтения геттером; без них — stale', async () => {
    const { tr, a, at } = await started();
    for (let t = 0; t <= 20_000; t += 1000) {
      at(t);
      tr.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 0 });
    }
    const s = a.signals(20_500).vehicleSpeedKmh;
    assert.equal(s.quality, 'valid');
    assert.equal(s.value, 0);
    assert.equal(s.updatedAt, 20_000);
    // Неуспешные чтения колбэк не вызывают: время отсчёта не обновляется.
    assert.equal(a.signals(25_001).vehicleSpeedKmh.quality, 'stale');
  });

  it('провайдер пропал и вернулся до кадра (колбэк): прежние отсчёты не воскресают до нового отсчёта', async () => {
    const { tr, a, at } = await started();
    at(100);
    tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 4000 });
    tr.feed(CDS, 'statusEngineTemperature', { temperatureEngineDrive: 138, temperatureEngineOilDrive: 150 });
    assert.equal(a.signals(200)['engine.rpm'].quality, 'valid');
    tr.avail(CDS, false);
    tr.avail(CDS, true);
    const s = a.signals(300);
    assert.equal(s['engine.rpm'].quality, 'stale');
    assert.equal(s['temperature.coolantC'].quality, 'stale', 'все поля интерфейса');
    assert.equal(s['temperature.engineOilC'].quality, 'stale');
    at(400);
    tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 4000 });
    const r = a.signals(500);
    assert.equal(r['engine.rpm'].quality, 'valid', 'свежий отсчёт после возврата');
    assert.equal(r['temperature.coolantC'].quality, 'stale', 'не пересчитанное поле — по-прежнему нет');
    assert.equal(a.diagnostics(500).interfaces.find((i) => i.iface === CDS)!.losses, 1);
  });

  it('уведомление, пока провайдер недоступен (колбэк или кадр), не отсчёт и не воскрешает значение', async () => {
    const { tr, a, at } = await started();
    at(100);
    tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 4000 });
    tr.avail(CDS, false);
    at(150);
    tr.subs.find((x) => x.iface === CDS)!.handlers.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 8000 });
    let s = a.signals(200)['engine.rpm'];
    assert.equal(s.quality, 'stale');
    assert.equal(s.value, 1000, 'значение без провайдера не принято');
    // Без колбэка: провайдер недоступен в кадре — следующий колбэк тоже не отсчёт.
    const { tr: tr2, a: a2, at: at2 } = await started();
    at2(100);
    tr2.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 768 });
    a2.signals(100);
    tr2.avail(V2, false, false);
    a2.signals(110);
    at2(120);
    tr2.subs.find((x) => x.iface === V2)!.handlers.statusCarSpeed2({ speedVehicleCentreOfGravity: 1536 });
    s = a2.signals(130).vehicleSpeedKmh;
    assert.equal(s.quality, 'stale');
    assert.equal(s.value, 12);
    const f = a2.diagnostics(130).interfaces.find((i) => i.iface === V2)!.fields[0];
    assert.equal(f.droppedWhileUnavailable, 1);
    // Провайдер вернулся, свежий отсчёт — снова valid.
    tr.avail(CDS, true);
    at(300);
    tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 4000 });
    assert.equal(a.signals(310)['engine.rpm'].quality, 'valid');
  });

  it('геттер: неудачное чтение не обновляет отсчёт и видно в диагностике; успешное — обновляет, серия неудач сброшена', async () => {
    const { tr, a, at } = await started();
    at(0);
    tr.getter(V2, 'statusCarSpeed2', 0, { value: { speedVehicleCentreOfGravity: 0 } });
    for (let t = 1000; t <= 6000; t += 1000) {
      at(t);
      tr.getter(V2, 'statusCarSpeed2', t, { error: 'timeout' });
    }
    const s = a.signals(6000).vehicleSpeedKmh;
    assert.equal(s.quality, 'stale', 'неудачи не освежают скорость');
    assert.equal(s.updatedAt, 0);
    let g = a.diagnostics(6000).interfaces.find((i) => i.iface === V2)!.fields.find((x) => x.field === 'statusCarSpeed2')!.getter!;
    assert.equal(g.ok, 1);
    assert.equal(g.failed, 6);
    assert.equal(g.consecutiveFailures, 6);
    assert.equal(g.lastError, 'timeout');
    assert.equal(g.lastOkAt, 0);
    at(7000);
    tr.getter(V2, 'statusCarSpeed2', 7000, { value: { speedVehicleCentreOfGravity: 0 } });
    assert.equal(a.signals(7000).vehicleSpeedKmh.quality, 'valid');
    g = a.diagnostics(7000).interfaces.find((i) => i.iface === V2)!.fields.find((x) => x.field === 'statusCarSpeed2')!.getter!;
    assert.equal(g.ok, 2);
    assert.equal(g.consecutiveFailures, 0);
    assert.equal(g.lastOkAt, 7000);
  });

  it('статистика геттера в диагностике — только известные ключи; у s-полей и без рантайм-статистики — null', async () => {
    const { tr, a } = await started();
    const r = tr.subs.find((x) => x.iface === V2)!.res;
    r.reads.statusCarSpeed2 = { ok: 1, failed: 0, consecutiveFailures: 0, dropped: 0, skipped: 3, lastOkAt: 5, lastFailAt: null, lastError: 'x\u0000'.repeat(100), pendingSince: 9, payload: { vin: 'WBA0000000' } };
    const d = a.diagnostics(0);
    const g = d.interfaces.find((i) => i.iface === V2)!.fields[0].getter!;
    assert.deepEqual(Object.keys(g).sort(), ['consecutiveFailures', 'dropped', 'failed', 'lastError', 'lastFailAt', 'lastOkAt', 'ok', 'pendingSince', 'skipped']);
    assert.equal(g.pendingSince, 9);
    assert.equal(g.skipped, 3);
    assert.ok((g.lastError ?? '').length <= 80);
    assert.doesNotMatch(JSON.stringify(d), /WBA0000000|\\u0000/);
    assert.equal(d.interfaces.find((i) => i.iface === STEER)!.fields[0].getter, null, 's-поле');
    assert.equal(d.interfaces.find((i) => i.iface === CDS)!.fields[0].getter, null, 'рантайм без статистики');
  });

  it('то же без колбэка: потеря видна по res.losses в кадре', async () => {
    const { tr, a, at } = await started();
    at(100);
    tr.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 768 });
    assert.equal(a.signals(150).vehicleSpeedKmh.quality, 'valid');
    tr.flapSilently(V2);
    assert.equal(a.signals(200).vehicleSpeedKmh.quality, 'stale');
    at(300);
    tr.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 768 });
    assert.equal(a.signals(350).vehicleSpeedKmh.quality, 'valid');
  });

  it('передача (только уведомления) держится, пока провайдер непрерывно доступен; потеря — не P и не «валидно»', async () => {
    const { tr, a, at } = await started();
    at(1000);
    tr.feed(VI, 'statusGearboxDrive', { statusActualGearDrive: 'N_OR_P', statusActualStageDrive: 'P' });
    const held = a.signals(1000 + 30 * 60_000).gear;
    assert.equal(held.quality, 'valid', 'стоянка 30 минут без событий');
    assert.deepEqual(held.value, { selector: 'P', gear: null });
    tr.avail(VI, false);
    const lost = a.signals(1000 + 30 * 60_000 + 1).gear;
    assert.notEqual(lost.quality, 'valid');
    tr.avail(VI, true);
    const back = a.signals(1000 + 30 * 60_000 + 2).gear;
    assert.notEqual(back.quality, 'valid', 'после возврата — ждём нового события');
  });

  it('передача: без событий/с ошибкой — никогда не P', async () => {
    const { tr, a, at } = await started();
    assert.equal(a.signals(10).gear.value, null);
    at(20);
    tr.feed(VI, 'DataPowerTrain2', { statusGearSelectionDrive: 'NP' });
    tr.feed(VI, 'statusGearboxDrive', {});
    const g = a.signals(30).gear;
    assert.notEqual(g.quality, 'valid');
    assert.equal(g.value, null);
  });

  it('недоступный провайдер без потерь (не был доступен) не мешает; ошибка подписки — в диагностике', async () => {
    const tr = new Transport();
    const watch: TelemetryWatchFn = (iface, inst, h, l, o) => (iface === TPMS ? Promise.reject(new Error('no SOME/IP config')) : tr.watch(iface, inst, h, l, o));
    const a = new VehicleAdapter(watch, () => 0);
    a.start();
    await flush();
    const d = a.diagnostics(0);
    const t = d.interfaces.find((i) => i.iface === TPMS)!;
    assert.equal(t.subscribed, false);
    assert.match(t.error ?? '', /no SOME\/IP config/);
    assert.equal(d.interfaces.length, VEHICLE_INTERFACES.length);
  });
});

describe('руль, рыскание, педаль', () => {
  it('руль: int16 и uint16 (доп. код), ×0.04395°, 65535/±900 — нет значения', async () => {
    const { tr, a, at } = await started();
    at(10);
    tr.feed(STEER, 'ActualSteeringAngleDriver', { actualValueSteeringAngleDriver: 65536 - 1000 });
    near(a.signals(20).steeringWheelAngleDeg.value, -43.95);
    at(30);
    tr.feed(STEER, 'ActualSteeringAngleDriver', { actualValueSteeringAngleDriver: -1000 });
    near(a.signals(40).steeringWheelAngleDeg.value, -43.95);
    at(50);
    tr.feed(STEER, 'ActualSteeringAngleDriver', { actualValueSteeringAngleDriver: 1000 });
    near(a.signals(60).steeringWheelAngleDeg.value, 43.95);
    at(70);
    tr.feed(STEER, 'ActualSteeringAngleDriver', { actualValueSteeringAngleDriver: 21000 });
    assert.equal(a.signals(80).steeringWheelAngleDeg.quality, 'invalid', '> 900°');
  });

  it('руль: показанный угол — только из ActualSteeringAngleDriver; NoCRC (кодировка не подтверждена) не подменяет его', async () => {
    // Прежняя логика: свежий допустимый отсчёт NoCRC «побеждал» недопустимый/устаревший главного — показанный угол
    // мог переключаться на поле, равнозначность кодировки которого не подтверждена (осторожное исправление; причина
    // замеченных скачков этим не доказана).
    const { tr, a, at } = await started();
    at(10);
    tr.feed(STEER, 'ActualSteeringAngleDriver', { actualValueSteeringAngleDriver: 65536 - 910 }); // −40,0°
    at(20);
    tr.feed(STEER, 'actualSteeringAngleDriverNoCRC', { actualValueSteeringAngleDriver: 65536 - 5506 }); // тем же декодером −242°
    near(a.signals(30).steeringWheelAngleDeg.value, -910 * 0.04395, 1e-9);
    // главное поле — свежий недопустимый: недопустимо, а не значение NoCRC
    at(40);
    tr.feed(STEER, 'ActualSteeringAngleDriver', { actualValueSteeringAngleDriver: 65535 });
    at(45);
    tr.feed(STEER, 'actualSteeringAngleDriverNoCRC', { actualValueSteeringAngleDriver: 200 });
    assert.equal(a.signals(50).steeringWheelAngleDeg.quality, 'invalid');
    // главное поле замолчало (только уведомления), NoCRC свежий: прежний угол только «устарело», не NoCRC
    at(100);
    tr.feed(STEER, 'ActualSteeringAngleDriver', { actualValueSteeringAngleDriver: 1000 });
    at(6000);
    tr.feed(STEER, 'actualSteeringAngleDriverNoCRC', { actualValueSteeringAngleDriver: 400 });
    const s = a.signals(6000).steeringWheelAngleDeg;
    assert.equal(s.quality, 'stale');
    near(s.value, 1000 * 0.04395, 1e-9);
    // только NoCRC с самого начала — угла нет (честно), но сырое видно в диагностике
    const b = await started();
    b.at(10);
    b.tr.feed(STEER, 'actualSteeringAngleDriverNoCRC', { actualValueSteeringAngleDriver: 300 });
    assert.equal(b.a.signals(20).steeringWheelAngleDeg.quality, 'unavailable');
    assert.equal(b.a.diagnostics(20).latestSamples.find((e) => e.field === 'actualSteeringAngleDriverNoCRC')!.values.actualValueSteeringAngleDriver, 300);
  });

  it('allowlist: угол руля — только из ActualSteeringAngleDriver (неподтверждённая подмена из NoCRC запрещена)', () => {
    // Проверка именно руля: квалифицированный выбор источника для других сигналов этим не запрещён.
    const steer = VEHICLE_FIELDS.filter((f) => f.outputs.some((o) => o.kind === 'number' && o.id === 'steeringWheelAngleDeg')).map((f) => f.field);
    assert.deepEqual(steer, ['ActualSteeringAngleDriver']);
    const nocrc = VEHICLE_FIELDS.find((f) => f.field === 'actualSteeringAngleDriverNoCRC')!;
    assert.deepEqual(nocrc.outputs, [], 'NoCRC — только сырой журнал');
    assert.deepEqual(nocrc.diag, ['actualValueSteeringAngleDriver']);
    assert.equal(manifestSignals()[STEER].actualSteeringAngleDriverNoCRC, 's', 'подписка (только чтение) сохранена');
  });

  it('рыскание: raw × 0.005 − 163.84 °/с; 65535 — нет значения', async () => {
    const { tr, a, at } = await started();
    at(10);
    tr.feed(CDS2, 'statusYawVelocityVehicle', { yawVelocityVehicle: 32768 });
    near(a.signals(20).yawRateDegS.value, 0);
    tr.feed(CDS2, 'statusYawVelocityVehicle', { yawVelocityVehicle: 34768 });
    near(a.signals(20).yawRateDegS.value, 10);
    tr.feed(CDS2, 'statusYawVelocityVehicle', { yawVelocityVehicle: 65535 });
    assert.equal(a.signals(20).yawRateDegS.quality, 'invalid');
  });

  it('педаль: ×0.025 %, 0…4080 (до 102 %); это acceleratorPedalPercent, дроссель остаётся без данных', async () => {
    const { tr, a, at } = await started();
    at(10);
    tr.feed(PEDAL, 'AngleAcceleratorPedal', { actualValueAngleAcceleratorPedal: 4000 });
    let s = a.signals(20);
    near(s.acceleratorPedalPercent.value, 100);
    assert.equal(s['engine.throttlePercent'].quality, 'unavailable');
    tr.feed(PEDAL, 'AngleAcceleratorPedal', { actualValueAngleAcceleratorPedal: 0 });
    assert.equal(a.signals(20).acceleratorPedalPercent.value, 0);
    tr.feed(PEDAL, 'AngleAcceleratorPedal', { actualValueAngleAcceleratorPedal: 4080 });
    near(a.signals(20).acceleratorPedalPercent.value, 102);
    tr.feed(PEDAL, 'AngleAcceleratorPedal', { actualValueAngleAcceleratorPedal: 4081 });
    s = a.signals(20);
    assert.equal(s.acceleratorPedalPercent.quality, 'invalid');
    tr.feed(PEDAL, 'AngleAcceleratorPedal', { actualValueAngleAcceleratorPedal: 65535 });
    assert.equal(a.signals(20).acceleratorPedalPercent.quality, 'invalid');
  });
});

describe('BasicDataSet', () => {
  const split = (raw: unknown, q?: unknown) => ({ valueDistributionLongitudinalTorqueRearAxisFrontAxis: raw, ...(q === undefined ? {} : { qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis: q }) });

  it('распределение: задняя ×0.01 % (measured), передняя = 100 − задняя (estimated); Н·м не выводятся', async () => {
    const { tr, a, at } = await started();
    at(10);
    tr.feed(BDS, 'basicDataSet', split(6000, 2));
    const s = a.signals(20);
    near(s['xdrive.rearPercent'].value, 60);
    near(s['xdrive.frontPercent'].value, 40);
    assert.equal(s['xdrive.rearPercent'].runtimeSource, 'measured');
    assert.equal(s['xdrive.frontPercent'].runtimeSource, 'estimated');
    for (const id of ['xdrive.frontTorqueNm', 'xdrive.rearTorqueNm'] as const) assert.equal(s[id].quality, 'unavailable', id);
  });

  it('квалификатор: точные имена/номера upstream; отсутствие допускается с пометкой; прочее — invalid', async () => {
    const { tr, a, at } = await started();
    for (const q of [2, 10, 'SIGNALWERT_IST_GUELTIG', 'SIGNALWERT_IST_GUELTIG__REKALIBRIERUNGSBEDARF']) {
      tr.feed(BDS, 'basicDataSet', split(5000, q));
      assert.equal(a.signals(0)['xdrive.rearPercent'].quality, 'valid', String(q));
    }
    tr.feed(BDS, 'basicDataSet', split(5000, 1));
    assert.equal(a.signals(0)['xdrive.rearPercent'].quality, 'invalid');
    tr.feed(BDS, 'basicDataSet', split(5000, 'SIGNALWERT_IST_UNGUELTIG'));
    assert.equal(a.signals(0)['xdrive.rearPercent'].quality, 'invalid');
    at(5);
    tr.feed(BDS, 'basicDataSet', split(5000));
    assert.equal(a.signals(5)['xdrive.rearPercent'].quality, 'valid');
    assert.match(a.diagnostics(5).reasons['xdrive.rearPercent'] ?? '', /квалификатор отсутствует/);
  });

  it('raw 0 / 65535 — поле не заполнено: unavailable и стирает прежнее; > 10000 — invalid', async () => {
    const { tr, a } = await started();
    tr.feed(BDS, 'basicDataSet', split(3000, 2));
    assert.equal(a.signals(0)['xdrive.rearPercent'].quality, 'valid');
    tr.feed(BDS, 'basicDataSet', split(0, 2));
    let s = a.signals(0);
    assert.equal(s['xdrive.rearPercent'].quality, 'unavailable');
    assert.equal(s['xdrive.frontPercent'].quality, 'unavailable', 'не 100 % спереди из нуля');
    tr.feed(BDS, 'basicDataSet', split(65535, 2));
    assert.equal(a.signals(0)['xdrive.rearPercent'].quality, 'unavailable');
    tr.feed(BDS, 'basicDataSet', split(10001, 2));
    s = a.signals(0);
    assert.equal(s['xdrive.rearPercent'].quality, 'invalid');
    assert.equal(s['xdrive.frontPercent'].quality, 'invalid');
    tr.feed(BDS, 'basicDataSet', split(10000, 2));
    near(a.signals(0)['xdrive.frontPercent'].value, 0);
  });

  it('масло КПП: постоянное значение (заглушка) не показывается, пока не придёт второе разное сырое', async () => {
    const { tr, a, at } = await started();
    for (let t = 0; t < 10; t++) {
      at(t * 1000);
      tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 48 });
    }
    const s = a.signals(9500)['temperature.gearboxC'];
    assert.equal(s.quality, 'unavailable', 'фиксированные 0 °C — не измерение');
    assert.equal(s.value, null);
    const d = a.diagnostics(9500);
    assert.match(d.reasons['temperature.gearboxC'] ?? '', /ждём изменения/);
    assert.equal(d.gearboxOilPromoted, false);
    at(10_000);
    tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 120 });
    assert.equal(a.signals(10_000)['temperature.gearboxC'].value, 72);
    assert.equal(a.diagnostics(10_000).gearboxOilPromoted, true);
    tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 255 });
    assert.equal(a.signals(10_000)['temperature.gearboxC'].quality, 'invalid');
  });

  it('масло КПП: raw 0 (−48 °C) — вне диапазона, никогда не значение', async () => {
    const { tr, a } = await started();
    tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 0 });
    tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 0 });
    assert.equal(a.signals(0)['temperature.gearboxC'].quality, 'invalid');
    assert.equal(a.diagnostics(0).gearboxOilPromoted, false);
  });
});

describe('TPMS и единицы автомобиля', () => {
  const corners = ['FL', 'FR', 'RL', 'RR'] as const;

  it('давление до единиц — нет данных (единица не угадывается); единицы позже — с исходным временем отсчёта', async () => {
    const { tr, a, at } = await started();
    at(1000);
    tr.feed(TPMS, 'statusTyrePressure', P(23, 24, 25, 26));
    tr.feed(TPMS, 'statusTyreTemperature', T(60));
    let s = a.signals(2000);
    for (const c of corners) assert.equal(s[`tyrePressure.${c}`].quality, 'unavailable', c);
    assert.equal(s['tyreTemperature.FL'].quality, 'unavailable');
    assert.match(a.diagnostics(2000).reasons['tyrePressure.FL'] ?? '', /единиц/);
    at(5000);
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    s = a.signals(5000);
    near(s['tyrePressure.FL'].value, 2.3);
    near(s['tyrePressure.FR'].value, 2.4);
    near(s['tyrePressure.RL'].value, 2.5);
    near(s['tyrePressure.RR'].value, 2.6);
    assert.equal(s['tyrePressure.FL'].updatedAt, 1000, 'время — отсчёта давления, не прихода единиц');
    assert.equal(s['tyreTemperature.FL'].value, 20);
  });

  it('psi-значения без единиц не делают ни psi, ни °F', async () => {
    const { tr, a } = await started();
    tr.feed(TPMS, 'statusTyrePressure', P(350));
    tr.feed(TPMS, 'statusTyreTemperature', T(140));
    const s = a.signals(0);
    assert.equal(s['tyrePressure.FL'].quality, 'unavailable');
    assert.equal(s['tyreTemperature.FL'].quality, 'unavailable');
  });

  it('PSI / KPA / F номером и именем; перевод в бар и °C', async () => {
    const { tr, a } = await started();
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(3, 2));
    tr.feed(TPMS, 'statusTyrePressure', P(350));
    tr.feed(TPMS, 'statusTyreTemperature', T(140));
    let s = a.signals(0);
    near(s['tyrePressure.FL'].value, 35 / 14.5038);
    near(s['tyreTemperature.FL'].value, ((100 - 32) * 5) / 9);
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U('KPA', 'C'));
    tr.feed(TPMS, 'statusTyrePressure', P(2300));
    tr.feed(TPMS, 'statusTyreTemperature', T(65));
    s = a.signals(0);
    near(s['tyrePressure.FL'].value, 2.3);
    assert.equal(s['tyreTemperature.FL'].value, 25);
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U('BAR', 'F'));
    tr.feed(TPMS, 'statusTyrePressure', P(22));
    near(a.signals(0)['tyrePressure.FL'].value, 2.2);
  });

  it('смена единиц не перекодирует отсчёт, пришедший в прежних единицах', async () => {
    const { tr, a } = await started();
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    tr.feed(TPMS, 'statusTyrePressure', P(23));
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(3, 2));
    near(a.signals(0)['tyrePressure.FL'].value, 2.3);
  });

  it('недопустимые единицы обесценивают прежние значения; допустимые затем не воскрешают их', async () => {
    const { tr, a, at } = await started();
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    tr.feed(TPMS, 'statusTyrePressure', P(23));
    tr.feed(TPMS, 'statusTyreTemperature', T(60));
    assert.equal(a.signals(0)['tyrePressure.FL'].quality, 'valid');
    at(100);
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(0, 'KELVIN'));
    let s = a.signals(100);
    for (const c of corners) assert.equal(s[`tyrePressure.${c}`].quality, 'invalid', c);
    assert.equal(s['tyreTemperature.FL'].quality, 'invalid');
    at(200);
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    s = a.signals(200);
    assert.equal(s['tyrePressure.FL'].quality, 'invalid', 'старый отсчёт не воскрес');
    at(300);
    tr.feed(TPMS, 'statusTyrePressure', P(24));
    near(a.signals(300)['tyrePressure.FL'].value, 2.4);
  });

  it('сентинел ≥ 65532 — invalid и стирает прежнее; 0 бар при допустимых единицах — настоящий ноль', async () => {
    const { tr, a } = await started();
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    tr.feed(TPMS, 'statusTyrePressure', P(23));
    tr.feed(TPMS, 'statusTyrePressure', P(65532, 65533, 65535, 0));
    const s = a.signals(0);
    assert.equal(s['tyrePressure.FL'].quality, 'invalid');
    assert.equal(s['tyrePressure.FR'].quality, 'invalid');
    assert.equal(s['tyrePressure.RL'].quality, 'invalid');
    assert.equal(s['tyrePressure.RR'].quality, 'valid', 'спущенная шина');
    assert.equal(s['tyrePressure.RR'].value, 0);
    tr.feed(TPMS, 'statusTyreTemperature', T(65535));
    assert.equal(a.signals(0)['tyreTemperature.FL'].quality, 'invalid');
  });

  it('отсутствующий член угла не трогает его значение; устаревание через 10 минут', async () => {
    const { tr, a, at } = await started();
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    at(0);
    tr.feed(TPMS, 'statusTyrePressure', P(23));
    at(1000);
    tr.feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 24 });
    const s = a.signals(1000);
    near(s['tyrePressure.FL'].value, 2.4);
    near(s['tyrePressure.FR'].value, 2.3);
    assert.equal(a.signals(10 * 60_000)['tyrePressure.FR'].quality, 'valid');
    assert.equal(a.signals(10 * 60_000 + 1)['tyrePressure.FR'].quality, 'stale');
  });

  it('потеря и возврат провайдера TPMS: прежние давления не воскресают до нового чтения', async () => {
    const { tr, a, at } = await started();
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    tr.feed(TPMS, 'statusTyrePressure', P(23));
    assert.equal(a.signals(0)['tyrePressure.FL'].quality, 'valid');
    tr.avail(TPMS, false);
    tr.avail(TPMS, true);
    assert.equal(a.signals(10)['tyrePressure.FL'].quality, 'stale');
    at(20);
    tr.feed(TPMS, 'statusTyrePressure', P(23));
    assert.equal(a.signals(30)['tyrePressure.FL'].quality, 'valid');
  });
});

describe('диагностика и жизненный цикл', () => {
  it('только известные члены; первый отсчёт + кольцо изменений ≤ 50; счётчики по полям', async () => {
    const { tr, a, at } = await started();
    at(0);
    tr.feed(VM, 'LaneSlope', { actualValueLongitudinalGradientRoadway: 32768, actualValueTransverseGradientRoadway: 32768, vin: 'WBA0000000', latitude: 55.1 });
    for (let i = 1; i <= 200; i++) {
      at(i * 1000);
      tr.feed(PT, 'ActualValueRPMWheel', { actualValueRPMWheelFLH: i, actualValueRPMwheelFRH: i, actualValueRPMWheelRLH: i, actualValueRPMWheelRRH: i });
    }
    const d = a.diagnostics(200_000);
    const first = d.firstSamples.find((e) => e.field === 'LaneSlope')!;
    assert.deepEqual(Object.keys(first.values).sort(), ['actualValueLongitudinalGradientRoadway', 'actualValueTransverseGradientRoadway']);
    assert.doesNotMatch(JSON.stringify(d), /WBA0000000|55\.1|"vin"|latitude/);
    assert.ok(d.changes.length <= RING_MAX);
    assert.equal(d.changes.length, RING_MAX);
    const pt = d.interfaces.find((i) => i.iface === PT)!;
    assert.equal(pt.samples, 200);
    assert.equal(pt.lastSampleAt, 200_000);
    assert.equal(pt.diagnosticOnly, true);
    // Диагностические интерфейсы в сигналы не попадают.
    const s = a.signals(200_000);
    for (const id of SIGNAL_IDS.filter((x) => x.startsWith('wheelSpeed.') || x.startsWith('attitude.')) as SignalId[]) assert.equal(s[id].quality, 'unavailable', id);
  });

  it('непрерывные числа не пишутся в кольцо (только первый отсчёт)', async () => {
    const { tr, a, at } = await started();
    for (let i = 0; i < 100; i++) {
      at(i * 1000);
      tr.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: i * 64 });
    }
    const d = a.diagnostics(100_000);
    assert.equal(d.changes.filter((e) => e.field === 'statusCarSpeed2').length, 0);
    assert.equal(d.firstSamples.filter((e) => e.field === 'statusCarSpeed2').length, 1);
  });

  it('stop/restart: колбэки и onAvailability старой подписки молчат, всё забыто; новая работает', async () => {
    const { tr, a, at } = await started();
    const old = tr.subs.slice();
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 100 });
    tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 101 });
    await a.stop();
    for (const s of old) assert.equal(s.res.shutdownCalls, 1, s.iface);
    at(5);
    old.forEach((s) => {
      s.handlers.statusTyrePressure?.(P(23));
      s.handlers.statusEngineSpeed2?.({ actualValueRPMEngineCrankshaft: 4000 });
      s.opts?.onAvailability?.(false);
    });
    a.start();
    await flush();
    const fresh = tr.subs.slice(old.length);
    assert.equal(fresh.length, VEHICLE_INTERFACES.length);
    const s = a.signals(10);
    assert.equal(s['engine.rpm'].quality, 'unavailable');
    assert.equal(s['tyrePressure.FL'].quality, 'unavailable');
    const d = a.diagnostics(10);
    assert.equal(d.gearboxOilPromoted, false, 'состояние масла КПП сброшено');
    assert.equal(d.tyreUnits.pressure, 'none', 'единицы сброшены');
    assert.ok(d.interfaces.every((i) => i.losses === 0 && i.samples === 0));
    fresh.find((x) => x.iface === CDS)!.handlers.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 4000 });
    assert.equal(a.signals(11)['engine.rpm'].value, 1000);
  });
});

describe('потеря провайдера единиц / BasicDataSet', () => {
  it('единицы пропали, TPMS на связи: свежие давления не раскодируются старыми единицами; прежние — только stale', async () => {
    const { tr, a, at } = await started();
    at(0);
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    tr.feed(TPMS, 'statusTyrePressure', P(23));
    tr.feed(TPMS, 'statusTyreTemperature', T(60));
    assert.equal(a.signals(0)['tyrePressure.FL'].quality, 'valid');
    at(1000);
    tr.avail(VEH, false);
    let s = a.signals(1000);
    assert.equal(s['tyrePressure.FL'].quality, 'stale', 'прежнее значение не используется');
    near(s['tyrePressure.FL'].value, 2.3);
    assert.equal(s['tyrePressure.FL'].updatedAt, 0, 'время исходное');
    assert.match(a.diagnostics(1000).reasons['tyrePressure.FL'] ?? '', /единиц/);
    assert.equal(a.diagnostics(1000).tyreUnits.pressure, 'lost');
    // TPMS продолжает слать: без единиц это не значение (не 0 и не BAR по старой памяти).
    at(2000);
    tr.feed(TPMS, 'statusTyrePressure', P(350));
    tr.feed(TPMS, 'statusTyreTemperature', T(140));
    s = a.signals(2000);
    assert.equal(s['tyrePressure.FL'].quality, 'unavailable');
    assert.equal(s['tyrePressure.FL'].value, null);
    assert.equal(s['tyreTemperature.FL'].quality, 'unavailable');
    assert.match(a.diagnostics(2000).reasons['tyrePressure.FL'] ?? '', /потери провайдера единиц/);
    // Единицы вернулись, но уже PSI: отсчёт из промежутка не связывается с ними (единицы при отправке неизвестны).
    at(3000);
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(3, 2));
    s = a.signals(3000);
    assert.equal(s['tyrePressure.FL'].quality, 'unavailable', 'нужен свежий отсчёт после свежих единиц');
    assert.equal(s['tyreTemperature.FL'].quality, 'unavailable');
    at(4000);
    tr.feed(TPMS, 'statusTyrePressure', P(350));
    tr.feed(TPMS, 'statusTyreTemperature', T(140));
    s = a.signals(4000);
    near(s['tyrePressure.FL'].value, 35 / 14.5038);
    assert.equal(s['tyrePressure.FL'].quality, 'valid');
    assert.equal(s['tyrePressure.FL'].updatedAt, 4000);
    near(s['tyreTemperature.FL'].value, ((100 - 32) * 5) / 9);
  });

  it('то же без колбэка (потеря видна в кадре); поздние единицы, пока провайдера нет, не принимаются', async () => {
    const { tr, a, at } = await started();
    at(0);
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    tr.feed(TPMS, 'statusTyrePressure', P(23));
    a.signals(0);
    tr.avail(VEH, false, false);
    a.signals(500);
    at(600);
    // Поздний ответ единиц, пока провайдер недоступен: не отсчёт.
    tr.subs.find((x) => x.iface === VEH)!.handlers.statusNewCurrentUnitsStatusExt(U(1, 1));
    at(700);
    tr.feed(TPMS, 'statusTyrePressure', P(24));
    // feed TPMS не трогает Vehicle: он по-прежнему недоступен.
    const s = a.signals(800)['tyrePressure.FL'];
    assert.notEqual(s.quality, 'valid');
    assert.equal(a.diagnostics(800).tyreUnits.pressure, 'lost');
  });

  it('начальный запуск: давление до первых единиц по-прежнему раскодируется ими с исходным временем', async () => {
    const { tr, a, at } = await started();
    at(100);
    tr.feed(TPMS, 'statusTyrePressure', P(23));
    at(900);
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    const s = a.signals(900)['tyrePressure.FL'];
    assert.equal(s.quality, 'valid');
    assert.equal(s.updatedAt, 100);
  });

  it('потеря провайдера единиц до их первого прихода: ждавшее давление не связывается с единицами после возврата', async () => {
    const { tr, a, at } = await started();
    at(0);
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', {});
    tr.feed(TPMS, 'statusTyrePressure', P(23));
    tr.avail(VEH, false);
    tr.avail(VEH, true);
    at(100);
    tr.feed(VEH, 'statusNewCurrentUnitsStatusExt', U(1, 1));
    assert.equal(a.signals(100)['tyrePressure.FL'].quality, 'unavailable');
    at(200);
    tr.feed(TPMS, 'statusTyrePressure', P(23));
    assert.equal(a.signals(200)['tyrePressure.FL'].quality, 'valid');
  });

  it('масло КПП: изменение до потери провайдера не продвигает заглушку после возврата; новые разные данные — продвигают', async () => {
    const { tr, a, at } = await started();
    at(0);
    tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 100 });
    tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 101 });
    assert.equal(a.diagnostics(0).gearboxOilPromoted, true);
    tr.avail(BDS, false);
    tr.avail(BDS, true);
    for (let t = 1000; t <= 5000; t += 1000) {
      at(t);
      tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 48 });
    }
    let s = a.signals(5000)['temperature.gearboxC'];
    assert.equal(s.quality, 'unavailable', 'постоянная заглушка после возврата не показывается');
    assert.equal(a.diagnostics(5000).gearboxOilPromoted, false);
    assert.match(a.diagnostics(5000).reasons['temperature.gearboxC'] ?? '', /ждём изменения/);
    at(6000);
    tr.feed(BDS, 'basicDataSet', { valueTemperatureTransmissionOil: 130 });
    s = a.signals(6000)['temperature.gearboxC'];
    assert.equal(s.quality, 'valid');
    assert.equal(s.value, 82);
  });

  it('распределение xDrive после возврата BasicDataSet: только свежий отсчёт valid', async () => {
    const { tr, a, at } = await started();
    at(0);
    tr.feed(BDS, 'basicDataSet', { valueDistributionLongitudinalTorqueRearAxisFrontAxis: 6000, qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis: 2 });
    tr.avail(BDS, false);
    tr.avail(BDS, true);
    assert.equal(a.signals(10)['xdrive.rearPercent'].quality, 'stale');
    at(20);
    tr.feed(BDS, 'basicDataSet', { valueDistributionLongitudinalTorqueRearAxisFrontAxis: 7000, qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis: 2 });
    near(a.signals(30)['xdrive.rearPercent'].value, 70);
    assert.equal(a.signals(30)['xdrive.rearPercent'].quality, 'valid');
  });
});
