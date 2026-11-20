import assert from 'node:assert/strict';
import {it} from 'node:test';
import {suspensionReading} from '../src/render/pages';
import {startApp} from '../src/app';
import {fakeCtx,fakeKit,FakeTransport,syntheticAssets} from './helpers';
import type {ExtraSignal} from '../src/vehicle/adapter';
import { sensorHeightDeltas, wheelDeltaMagnitude } from '../src/vehicle/derived';
import { createSession, ingestSample } from '../../src/domain/session';
import { asDomain } from '../src/model/model';
it('уровень подвески: реальные EHC коды, устаревание и неизвестный код; не шесть уровней демо', async()=>{
  const app=startApp(fakeCtx(new FakeTransport(),{}),fakeKit(),syntheticAssets(),()=>0);
  const state=app.model.getState();
  const shown=(e:ExtraSignal)=>suspensionReading({...state,snapshot:{...state.snapshot,extra:{...state.snapshot.extra,ehcLevel:e}}});
  for(const [value,label] of [[2,'низкий'],[8,'стандарт'],[16,'высокий']] as const){
    assert.equal(shown({value,quality:'valid',updatedAt:100}).text,label);
    assert.equal(shown({value,quality:'stale',updatedAt:100}).ok,false);
  }
  assert.equal(shown({value:4,quality:'valid',updatedAt:100}).ok,false);
  assert.equal(shown({value:null,quality:'unavailable',updatedAt:null}).ok,false);
  await app.dispose();
});

it('данные G07: разницы только из одного пригодного ответа, сессия считает пики датчиков и отклонений DSC', () => {
  const app = startApp(fakeCtx(new FakeTransport(), {}), fakeKit(), syntheticAssets(), () => 0);
  try {
    const initial = app.model.getState().snapshot;
    const sample = (value: number, updatedAt = 100): ExtraSignal => ({ value, quality: 'valid', updatedAt });
    const extra = {
      ...initial.extra,
      'rideHeightSensor.FL': sample(-11), 'rideHeightSensor.FR': sample(7),
      'rideHeightSensor.RL': sample(-3), 'rideHeightSensor.RR': sample(-3),
      'wheelDelta.FR': sample(-4),
    };
    const snapshot = { ...initial, simTimeMs: 100, extra };
    const d = sensorHeightDeltas(snapshot);
    assert.deepEqual(d, { frontDelta: -18, rearDelta: 0, leftRight: -9, frontRear: 1, range: 18 });
    const measurements = { heightRange: d.range, wheelPercent: { FL: null, FR: wheelDeltaMagnitude(snapshot, 'FR'), RL: null, RR: null } };
    const stats = createSession(asDomain(snapshot), measurements);
    assert.deepEqual(stats.maxSlipOverall, { value: 4, atMs: 100, wheel: 'FR' });
    assert.equal(stats.maxHeightRange?.value, 18);
    const late = { ...snapshot, simTimeMs: 200, extra: { ...extra, 'rideHeightSensor.FL': sample(-12, 200), 'wheelDelta.FR': { ...sample(50), quality: 'stale' as const } } };
    assert.equal(sensorHeightDeltas(late).range, null, 'разные ответы не смешиваются');
    assert.equal(wheelDeltaMagnitude(late, 'FR'), null);
    const next = ingestSample(stats, asDomain(late), { heightRange: null, wheelPercent: { FL: null, FR: null, RL: null, RR: null } });
    assert.equal(next.maxHeightRange?.value, 18);
    assert.equal(next.maxSlip.FR?.value, 4);
    assert.equal(snapshot.signals['suspensionHeight.FL'].value, null, 'отклонение от нормы остаётся отдельным полем');
  } finally {
    app.dispose();
  }
});
