/// <reference types="node" />
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { MockTelemetryProvider } from '../providers/mock/MockTelemetryProvider';
import { AppStore } from './store';

// Интеграция AppStore + MockTelemetryProvider: реальное время подменено управляемыми часами,
// setInterval — mock-таймерами node:test, поэтому тест детерминирован и не ждёт.
describe('AppStore + MockTelemetryProvider', () => {
  let realNow = 0;
  let provider: MockTelemetryProvider;
  let store: AppStore;

  /** Сдвигает и «реальное» время, и таймеры на ms, по одному тику провайдера (100 мс). */
  function advance(ms: number): void {
    for (let left = ms; left > 0; left -= 100) {
      realNow += 100;
      mock.timers.tick(100);
    }
  }

  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval'] });
    realNow = 10_000;
    provider = new MockTelemetryProvider('mountainTrail', () => realNow);
    store = new AppStore(provider);
    provider.start();
  });

  afterEach(() => {
    store.dispose();
    mock.timers.reset();
  });

  it('время симуляции идёт по тикам, подписчики уведомляются, сессия копит отсчёты', () => {
    let notified = 0;
    store.subscribe(() => notified++);
    advance(1000);
    const s = store.getState();
    assert.equal(s.snapshot.simTimeMs, 1000);
    assert.equal(notified, 10);
    assert.equal(s.session.startedAtMs, 0);
    assert.equal(s.session.lastSampleMs, 1000);
    assert.ok(s.session.sampleCount > 1, `sampleCount=${s.session.sampleCount}`);
  });

  it('пауза замораживает данные и сессию; продолжение не перепрыгивает пропущенное время', () => {
    advance(500);
    store.setPaused(true);
    const frozen = store.getState();
    assert.equal(frozen.paused, true);
    advance(5000);
    assert.equal(store.getState().snapshot, frozen.snapshot);
    assert.equal(store.getState().session, frozen.session);
    store.setPaused(false);
    advance(300);
    assert.equal(store.getState().paused, false);
    assert.equal(store.getState().snapshot.simTimeMs, 800);
  });

  it('смена сценария публикует новый снимок без сброса сессии', () => {
    advance(2000);
    const before = store.getState().session.startedAtMs;
    store.setScenario('partialLoss');
    const s = store.getState();
    assert.equal(s.scenarioId, 'partialLoss');
    assert.equal(s.snapshot.scenarioId, 'partialLoss');
    assert.equal(s.snapshot.simTimeMs, 2000);
    assert.equal(s.session.startedAtMs, before);
  });

  it('«Новая сессия» начинается с текущего отсчёта', () => {
    advance(1500);
    store.newSession();
    const s = store.getState();
    assert.equal(s.session.startedAtMs, 1500);
    assert.equal(s.session.lastSampleMs, 1500);
    advance(200);
    assert.equal(store.getState().session.startedAtMs, 1500);
    assert.equal(store.getState().session.lastSampleMs, 1700);
  });

  it('dispose останавливает поток данных', () => {
    advance(300);
    store.dispose();
    const last = store.getState().snapshot;
    advance(1000);
    assert.equal(store.getState().snapshot, last);
  });
});
