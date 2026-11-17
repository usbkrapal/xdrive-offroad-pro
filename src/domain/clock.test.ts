/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_STEP_MS, createClock, pauseClock, resumeClock, tickClock } from './clock';

describe('sim clock', () => {
  it('идёт по реальному времени во время работы', () => {
    let c = createClock();
    c = tickClock(c, 1000);
    c = tickClock(c, 1100);
    c = tickClock(c, 1200);
    assert.equal(c.simTimeMs, 200);
  });

  it('пауза замораживает время; продолжение не перепрыгивает пропущенное', () => {
    let c = tickClock(tickClock(createClock(), 0), 100);
    c = pauseClock(c);
    c = tickClock(c, 60_000);
    assert.equal(c.simTimeMs, 100);
    c = resumeClock(c, 120_000);
    c = tickClock(c, 120_100);
    assert.equal(c.simTimeMs, 200);
  });

  it('один шаг ограничен MAX_STEP_MS (свёрнутая вкладка)', () => {
    let c = tickClock(createClock(), 0);
    c = tickClock(c, 10_000);
    assert.equal(c.simTimeMs, MAX_STEP_MS);
  });

  it('время не идёт назад', () => {
    let c = tickClock(tickClock(createClock(), 500), 600);
    c = tickClock(c, 550);
    assert.equal(c.simTimeMs, 100);
  });
});
