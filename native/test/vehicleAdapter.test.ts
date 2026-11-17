import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SIGNAL_IDS } from '../../src/domain/signalCatalog';
import { VehicleAdapter } from '../src/vehicle/adapter';
import { VEHICLE_FIELDS, VEHICLE_INTERFACES, VEHICLE_SIGNAL_IDS } from '../src/vehicle/allowlist';
import { FakeTransport, flush } from './helpers';

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const VI = 'de.bmw.infrastructure.VehicleInformation';

function setup() {
  const tr = new FakeTransport();
  let now = 0;
  const a = new VehicleAdapter(tr.watch, () => now);
  return { tr, a, at: (t: number) => (now = t) };
}

describe('VehicleAdapter (только чтение, фальшивый транспорт)', () => {
  it('подписывается ровно на allowlist, по одному watch на интерфейс, экземпляр "1"', async () => {
    const { tr, a } = setup();
    a.start();
    await flush();
    const want = new Map<string, Set<string>>();
    for (const f of VEHICLE_FIELDS) (want.get(f.iface) ?? want.set(f.iface, new Set()).get(f.iface)!).add(f.field);
    assert.equal(tr.calls.length, want.size);
    for (const c of tr.calls) {
      assert.equal(c.instance, '1');
      assert.deepEqual(new Set(c.fields), want.get(c.iface));
    }
    a.start();
    assert.equal(tr.calls.length, want.size, 'повторный start не подписывается заново');
  });

  it('до первого колбэка всё «нет данных»; значения — только из колбэков, provenance measured', async () => {
    const { tr, a, at } = setup();
    a.start();
    await flush();
    const s0 = a.signals(0);
    for (const id of SIGNAL_IDS) assert.equal(s0[id].quality, 'unavailable', id);
    assert.equal(a.status().hasUsableData, false);

    at(100);
    tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 0 });
    tr.feed(FES, 'statusActualValueTorque2', { actualValueTorqueCrankshaft: 1947 });
    tr.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 0 });
    const s = a.signals(150);
    assert.equal(s['engine.rpm'].value, 0, 'валидный ноль оборотов');
    assert.equal(s['engine.rpm'].quality, 'valid');
    assert.equal(s['engine.torqueNm'].value, -50, 'отрицательный момент сохраняется');
    assert.equal(s.vehicleSpeedKmh.value, 0);
    assert.equal(s['engine.rpm'].runtimeSource, 'measured');
    assert.equal(a.status().hasUsableData, true);
  });

  it('неподдержанные сигналы остаются unavailable, никаких демо-значений', async () => {
    const { tr, a } = setup();
    a.start();
    await flush();
    tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 4000 });
    const s = a.signals(10);
    for (const id of SIGNAL_IDS) {
      if ((VEHICLE_SIGNAL_IDS as readonly string[]).includes(id)) continue;
      assert.equal(s[id].quality, 'unavailable', id);
      assert.equal(s[id].value, null, id);
      assert.notEqual(s[id].runtimeSource, 'mock', id);
    }
  });

  it('сентинел → invalid (не 0); отсутствующий член структуры не трогает значение', async () => {
    const { tr, a, at } = setup();
    a.start();
    await flush();
    at(10);
    tr.feed(CDS, 'statusEngineTemperature', { temperatureEngineDrive: 138, temperatureEngineOilDrive: 255 });
    let s = a.signals(20);
    assert.equal(s['temperature.coolantC'].value, 90);
    assert.equal(s['temperature.engineOilC'].quality, 'invalid');
    assert.equal(s['temperature.engineOilC'].value, null);
    at(30);
    tr.feed(CDS, 'statusEngineTemperature', { temperatureEngineOilDrive: 150 });
    s = a.signals(40);
    assert.equal(s['temperature.coolantC'].value, 90, 'не пришедший член не сбрасывается');
    assert.equal(s['temperature.engineOilC'].value, 102);
    at(50);
    tr.feed(FES, 'statusActualValueTorque2', { actualValueTorqueCrankshaft: 4095 });
    assert.equal(a.signals(60)['engine.torqueNm'].quality, 'invalid');
  });

  it('свежесть: без уведомлений дольше порога — stale; потеря провайдера — stale сразу', async () => {
    const { tr, a, at } = setup();
    a.start();
    await flush();
    at(1000);
    tr.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 768 });
    assert.equal(a.signals(1000 + 4999).vehicleSpeedKmh.quality, 'valid');
    const st = a.signals(1000 + 5001).vehicleSpeedKmh;
    assert.equal(st.quality, 'stale');
    assert.equal(st.value, 12, 'устаревшее значение хранится, но не пригодно');
    at(7000);
    tr.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 768 });
    assert.equal(a.signals(7001).vehicleSpeedKmh.quality, 'valid');
    tr.setAvailable(V2, false);
    assert.equal(a.signals(7002).vehicleSpeedKmh.quality, 'stale');
  });

  it('передача: P не придумывается из N_OR_P; D + номер из двух полей', async () => {
    const { tr, a, at } = setup();
    a.start();
    await flush();
    at(10);
    tr.feed(VI, 'statusGearboxDrive', { statusActualGearDrive: 'N_OR_P' });
    assert.equal(a.signals(20).gear.quality, 'unavailable');
    assert.equal(a.signals(20).gear.value, null);
    at(30);
    tr.feed(VI, 'statusGearboxDrive', { statusActualGearDrive: 'N_OR_P', statusActualStageDrive: 'D' });
    tr.feed(VI, 'DataPowerTrain2', { statusGearSelectionDrive: '_1' });
    assert.deepEqual(a.signals(40).gear.value, { selector: 'D', gear: 1 });
    at(50);
    tr.feed(VI, 'statusGearboxDrive', { statusActualGearDrive: 'SIGNAL_UNGUELTIG', statusActualStageDrive: 'D' });
    tr.feed(VI, 'DataPowerTrain2', { statusGearSelectionDrive: 'NP' });
    assert.notEqual(a.signals(60).gear.quality, 'valid');
  });

  it('stop(): все подписки закрыты, значения забыты, поздние колбэки старой подписки игнорируются', async () => {
    const { tr, a, at } = setup();
    a.start();
    await flush();
    const old = tr.subs.slice();
    await a.stop();
    for (const s of old) assert.equal(s.res.shutdownCalls, 1, s.iface);
    at(5);
    tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 4000 });
    assert.equal(a.signals(10)['engine.rpm'].quality, 'unavailable');
    assert.equal(a.isActive, false);
  });

  it('поздний ответ watch после stop(): подписка сразу закрывается и не принимается', async () => {
    const { tr, a } = setup();
    tr.deferred = true;
    a.start();
    await a.stop();
    tr.resolvePending();
    await flush();
    await flush();
    assert.ok(tr.subs.length > 0);
    for (const s of tr.subs) assert.equal(s.res.shutdownCalls, 1, `late ${s.iface} closed`);
    assert.equal(a.status().subscribed, 0);
  });

  it('повторный старт после stop: старые обработчики мертвы, новые работают', async () => {
    const { tr, a, at } = setup();
    a.start();
    await flush();
    const oldHandlers = tr.subs.map((s) => s.handlers);
    await a.stop();
    a.start();
    await flush();
    at(1);
    oldHandlers.forEach((h) => h.statusEngineSpeed2 && h.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 8000 }));
    assert.equal(a.signals(2)['engine.rpm'].quality, 'unavailable', 'старый генератор подписки не пишет');
    tr.subs.slice(-VEHICLE_INTERFACES.length).forEach((s) => s.handlers.statusEngineSpeed2 && s.handlers.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 4000 }));
    assert.equal(a.signals(3)['engine.rpm'].value, 1000);
  });

  it('ошибка подписки интерфейса видна в статусе, остальные работают', async () => {
    const { tr, a } = setup();
    tr.errorFor.add(FES);
    a.start();
    await flush();
    const st = a.status();
    assert.equal(st.errors.length, 1);
    assert.match(st.errors[0], /FES/);
    assert.equal(st.subscribed, st.interfaces - 1);
  });
});
