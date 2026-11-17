import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { NativeModel } from '../src/model/model';
import { FakeTransport, flush } from './helpers';

const CDS = 'de.bmw.infotainment.vehicle.CDS';

function setup(mode: 'demo' | 'vehicle' = 'demo') {
  const tr = new FakeTransport();
  let t = 0;
  const model = new NativeModel({ now: () => t, watch: tr.watch }, mode, 'mountainTrail');
  const advance = (ms: number) => {
    for (let i = 0; i < ms; i += 100) {
      t += 100;
      mock.timers.tick(100);
    }
  };
  return { tr, model, advance };
}

describe('NativeModel: режимы, пауза, сессия', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
  afterEach(() => mock.timers.reset());

  it('по умолчанию — явное демо, автомобиль не опрашивается', () => {
    const { tr, model, advance } = setup();
    advance(1000);
    const st = model.getState();
    assert.equal(st.mode, 'demo');
    assert.equal(st.vehicle, null);
    assert.equal(tr.calls.length, 0, 'в демо нет ни одной подписки SOME/IP');
    assert.ok(st.snapshot.simTimeMs >= 900);
    assert.equal(st.snapshot.signals['engine.rpm'].runtimeSource, 'mock');
    model.dispose();
  });

  it('пауза замораживает снимок, время и сессию; продолжение — без скачка', () => {
    const { model, advance } = setup();
    advance(2000);
    assert.equal(model.setPaused(true), true);
    const frozen = model.getState();
    advance(3000);
    const still = model.getState();
    assert.equal(still.paused, true);
    assert.equal(still.snapshot.simTimeMs, frozen.snapshot.simTimeMs);
    assert.equal(still.snapshot, frozen.snapshot, 'тот же объект снимка');
    assert.equal(still.session.sampleCount, frozen.session.sampleCount);
    model.setPaused(false);
    advance(500);
    const after = model.getState().snapshot.simTimeMs;
    assert.ok(after > frozen.snapshot.simTimeMs && after <= frozen.snapshot.simTimeMs + 600, `${after}`);
    model.dispose();
  });

  it('смена сценария не сбрасывает сессию; новая сессия — сбрасывает', () => {
    const { model, advance } = setup();
    advance(2000);
    const before = model.getState().session.sampleCount;
    model.setScenario('climb');
    advance(500);
    const st = model.getState();
    assert.equal(st.scenarioId, 'climb');
    assert.equal(st.snapshot.scenarioId, 'climb');
    assert.ok(st.session.sampleCount > before);
    model.newSession();
    assert.equal(model.getState().session.sampleCount, 1);
    model.dispose();
  });

  it('переход в «Автомобиль»: демо уничтожено, сессия новая, без автоматического возврата в демо', async () => {
    const { tr, model, advance } = setup();
    advance(3000);
    const demoSession = model.getState().session;
    model.setMode('vehicle');
    await flush();
    assert.ok(tr.calls.length > 0, 'подписка только после явного выбора');
    advance(10_000);
    const st = model.getState();
    assert.equal(st.mode, 'vehicle');
    assert.notEqual(st.session, demoSession);
    assert.equal(st.session.maxAbsPitch, null, 'демо-экстремумы не перенесены');
    assert.equal(st.session.maxEngineTorque, null);
    assert.equal(st.vehicle?.hasUsableData, false, 'тишина остаётся «нет данных», а не демо');
    for (const id of Object.keys(st.snapshot.signals) as (keyof typeof st.snapshot.signals)[]) {
      assert.notEqual(st.snapshot.signals[id].runtimeSource, 'mock', id);
    }
    assert.equal(model.setPaused(true), false, 'живые данные не ставятся на паузу');
    model.dispose();
  });

  it('автомобиль → демо: подписки закрыты, поздние колбэки не попадают в демо', async () => {
    const { tr, model, advance } = setup('vehicle');
    await flush();
    tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 4000 });
    advance(200);
    assert.equal(model.getState().snapshot.signals['engine.rpm'].value, 1000);
    const vehicleSession = model.getState().session;
    assert.equal(vehicleSession.sampleCount > 0, true);
    model.setMode('demo');
    await flush();
    for (const s of tr.subs) assert.equal(s.res.shutdownCalls, 1, s.iface);
    tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 8000 });
    advance(300);
    const st = model.getState();
    assert.equal(st.mode, 'demo');
    assert.equal(st.snapshot.signals['engine.rpm'].runtimeSource, 'mock');
    assert.notEqual(st.session, vehicleSession);
    model.dispose();
  });

  it('dispose останавливает таймеры и подписки', async () => {
    const { tr, model, advance } = setup('vehicle');
    await flush();
    model.dispose();
    for (const s of tr.subs) assert.equal(s.res.shutdownCalls, 1);
    const st = model.getState();
    advance(1000);
    assert.equal(model.getState().snapshot, st.snapshot, 'после dispose снимок не меняется');
  });
});
