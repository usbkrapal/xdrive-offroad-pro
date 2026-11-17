/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayNumber, displaySignal, formatNumber } from '../i18n/format';
import { buildSignal, usableValue } from './signal';
import { SIGNAL_CATALOG } from './signalCatalog';
import { lyingNaN } from './testUtils';

describe('buildSignal', () => {
  it('0 и false — валидные значения, а не «нет данных»', () => {
    const zero = buildSignal('acceleratorPedalPercent', 0, 1000, 1000);
    const off = buildSignal('dtc.status', false, 1000, 1000);
    assert.equal(zero.value, 0);
    assert.equal(zero.quality, 'valid');
    assert.equal(zero.runtimeSource, 'mock');
    assert.equal(off.value, false);
    assert.equal(off.quality, 'valid');
    assert.equal(usableValue(zero), 0);
    assert.equal(usableValue(off), false);
  });

  it('отсутствующее значение → unavailable без updatedAt', () => {
    const s = buildSignal('altitudeM', undefined, 1000, 1000);
    assert.equal(s.value, null);
    assert.equal(s.updatedAt, null);
    assert.equal(s.quality, 'unavailable');
  });

  it('NaN и Infinity → invalid с value=null', () => {
    const nanSignal = buildSignal('engine.torqueNm', Number.NaN, 5, 5);
    assert.equal(nanSignal.value, null);
    assert.equal(nanSignal.quality, 'invalid');
    assert.equal(buildSignal('engine.torqueNm', Infinity, 5, 5).quality, 'invalid');
  });

  it('старый отсчёт → stale, значение хранится, но непригодно', () => {
    const limit = SIGNAL_CATALOG['attitude.rollDeg'].staleAfterMs;
    const fresh = buildSignal('attitude.rollDeg', -4, 0, limit);
    const old = buildSignal('attitude.rollDeg', -4, 0, limit + 1);
    assert.equal(fresh.quality, 'valid');
    assert.equal(old.value, -4);
    assert.equal(old.quality, 'stale');
    assert.equal(old.updatedAt, 0);
    assert.equal(usableValue(old), null);
  });

  it('evidenceStatus из каталога и не влияет на quality', () => {
    const steer = buildSignal('steeringWheelAngleDeg', 10, 0, 0);
    const pitch = buildSignal('attitude.pitchDeg', 10, 0, 0);
    assert.equal(steer.evidenceStatus, 'confirmed');
    assert.equal(pitch.evidenceStatus, 'unknown');
    assert.equal(steer.quality, pitch.quality);
  });
});

describe('отображение', () => {
  const RU = 'ru-RU';

  it('stale/unavailable/invalid показываются как «—» со статусом', () => {
    const cases = [
      [buildSignal('altitudeM', undefined, 0, 0), 'unavailable'],
      [buildSignal('altitudeM', 1840, 0, 60_000), 'stale'],
      [lyingNaN('altitudeM', 0), 'invalid'],
    ] as const;
    for (const [signal, quality] of cases) {
      const shown = displayNumber(signal, 0, RU);
      assert.equal(shown.text, '—', quality);
      assert.equal(shown.quality, quality);
    }
  });

  it('ноль и false отображаются значением', () => {
    assert.equal(displayNumber(buildSignal('engine.throttlePercent', 0, 0, 0), 0, RU).text, '0');
    assert.equal(displaySignal(buildSignal('dtc.status', false, 0, 0), (v) => (v ? 'Вкл' : 'Выкл')).text, 'Выкл');
  });

  it('знак сохраняется; типографский минус; ноль без знака', () => {
    assert.equal(formatNumber(-12.44, 1, RU, true), '−12,4');
    assert.equal(formatNumber(12.44, 1, RU, true), '+12,4');
    assert.equal(formatNumber(-0.04, 1, RU, true), '0,0');
    assert.equal(formatNumber(-430, 0, RU), '−430');
  });
});
