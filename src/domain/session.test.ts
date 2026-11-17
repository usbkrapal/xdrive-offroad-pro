/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { altitudeChangeFromStart, createSession, ingestSample, sessionElapsedMs } from './session';
import { lyingNaN, missing, nan, snapAt, stale, valid } from './testUtils';

describe('session aggregates', () => {
  it('max |pitch| и |roll| хранят величину отрицательных углов', () => {
    let s = createSession(
      snapAt(0, { 'attitude.pitchDeg': valid('attitude.pitchDeg', -22.5, 0), 'attitude.rollDeg': valid('attitude.rollDeg', 3, 0) }),
    );
    s = ingestSample(
      s,
      snapAt(100, { 'attitude.pitchDeg': valid('attitude.pitchDeg', 10, 100), 'attitude.rollDeg': valid('attitude.rollDeg', -17, 100) }),
    );
    assert.deepEqual(s.maxAbsPitch, { value: 22.5, atMs: 0 });
    assert.deepEqual(s.maxAbsRoll, { value: 17, atMs: 100 });
  });

  it('min/max высоты корректны для отрицательных высот и не начинаются с 0', () => {
    let s = createSession(snapAt(0, { altitudeM: valid('altitudeM', -410, 0) }));
    assert.equal(s.minAltitude?.value, -410);
    assert.equal(s.maxAltitude?.value, -410);
    s = ingestSample(s, snapAt(100, { altitudeM: valid('altitudeM', -428, 100) }));
    s = ingestSample(s, snapAt(200, { altitudeM: valid('altitudeM', -395, 200) }));
    assert.equal(s.minAltitude?.value, -428);
    assert.equal(s.maxAltitude?.value, -395);
    assert.equal(altitudeChangeFromStart(s, snapAt(200, { altitudeM: valid('altitudeM', -395, 200) })), 15);
  });

  it('высота до первого валидного отсчёта — null, а не 0', () => {
    let s = createSession(snapAt(0, { altitudeM: missing('altitudeM', 0) }));
    assert.equal(s.minAltitude, null);
    assert.equal(s.startAltitude, null);
    s = ingestSample(s, snapAt(100, { altitudeM: valid('altitudeM', 1840, 100) }));
    assert.equal(s.minAltitude?.value, 1840);
    assert.equal(s.startAltitude?.value, 1840);
  });

  it('stale, invalid, unavailable и NaN не участвуют в агрегатах', () => {
    let s = createSession(
      snapAt(0, {
        'attitude.pitchDeg': valid('attitude.pitchDeg', 5, 0),
        'engine.torqueNm': valid('engine.torqueNm', 300, 0),
        'temperature.gearboxC': valid('temperature.gearboxC', 80, 0),
        'wheelSlip.FL': valid('wheelSlip.FL', 10, 0),
      }),
    );
    s = ingestSample(
      s,
      snapAt(100, {
        'attitude.pitchDeg': stale('attitude.pitchDeg', 40, 100),
        'engine.torqueNm': nan('engine.torqueNm', 100),
        'temperature.gearboxC': lyingNaN('temperature.gearboxC', 100),
        'wheelSlip.FL': missing('wheelSlip.FL', 100),
      }),
    );
    assert.equal(s.maxAbsPitch?.value, 5);
    assert.equal(s.maxEngineTorque?.value, 300);
    assert.equal(s.maxGearboxTemp?.value, 80);
    assert.equal(s.maxSlip.FL?.value, 10);
  });

  it('нулевые значения участвуют в агрегатах', () => {
    const s = createSession(
      snapAt(0, { 'attitude.pitchDeg': valid('attitude.pitchDeg', 0, 0), altitudeM: valid('altitudeM', 0, 0) }),
    );
    assert.equal(s.maxAbsPitch?.value, 0);
    assert.equal(s.minAltitude?.value, 0);
  });

  it('отрицательный момент двигателя — валиден, пик выбирается по максимуму', () => {
    let s = createSession(snapAt(0, { 'engine.torqueNm': valid('engine.torqueNm', -60, 0) }));
    assert.equal(s.maxEngineTorque?.value, -60);
    s = ingestSample(s, snapAt(100, { 'engine.torqueNm': valid('engine.torqueNm', -20, 100) }));
    assert.equal(s.maxEngineTorque?.value, -20);
  });

  it('max slip по колёсам и общий с указанием колеса', () => {
    let s = createSession(
      snapAt(0, {
        'wheelSlip.FL': valid('wheelSlip.FL', 5, 0),
        'wheelSlip.FR': valid('wheelSlip.FR', 0, 0),
        'wheelSlip.RL': valid('wheelSlip.RL', 12, 0),
        'wheelSlip.RR': valid('wheelSlip.RR', 3, 0),
      }),
    );
    s = ingestSample(s, snapAt(100, { 'wheelSlip.FR': valid('wheelSlip.FR', 44, 100) }));
    assert.equal(s.maxSlip.FR?.value, 44);
    assert.equal(s.maxSlipOverall?.wheel, 'FR');
    assert.equal(s.maxSlipOverall?.value, 44);
  });

  it('повтор того же simTime (пауза) не добавляет отсчёт', () => {
    const snap = snapAt(500);
    const s1 = createSession(snap);
    const s2 = ingestSample(s1, snap);
    assert.equal(s2, s1);
    assert.equal(sessionElapsedMs(s2, 500), 0);
  });

  it('новая сессия берёт базу из текущего валидного отсчёта, а не из старых экстремумов', () => {
    let s = createSession(snapAt(0, { 'attitude.rollDeg': valid('attitude.rollDeg', -30, 0) }));
    s = ingestSample(s, snapAt(100, { altitudeM: valid('altitudeM', 2000, 100) }));
    const current = snapAt(5000, {
      'attitude.rollDeg': valid('attitude.rollDeg', 2, 5000),
      altitudeM: valid('altitudeM', 1500, 5000),
    });
    const fresh = createSession(current);
    assert.equal(fresh.startedAtMs, 5000);
    assert.equal(fresh.maxAbsRoll?.value, 2);
    assert.equal(fresh.maxAltitude?.value, 1500);
    assert.equal(fresh.minAltitude?.value, 1500);
    assert.equal(sessionElapsedMs(fresh, 6000), 1000);
  });

  it('размах высот подвески учитывается только при всех четырёх валидных углах', () => {
    let s = createSession(
      snapAt(0, {
        'suspensionHeight.FL': valid('suspensionHeight.FL', 40, 0),
        'suspensionHeight.FR': valid('suspensionHeight.FR', -60, 0),
        'suspensionHeight.RL': valid('suspensionHeight.RL', -50, 0),
        'suspensionHeight.RR': valid('suspensionHeight.RR', 30, 0),
      }),
    );
    assert.equal(s.maxHeightRange?.value, 100);
    s = ingestSample(
      s,
      snapAt(100, {
        'suspensionHeight.FL': valid('suspensionHeight.FL', 200, 100),
        'suspensionHeight.FR': valid('suspensionHeight.FR', -200, 100),
        'suspensionHeight.RL': valid('suspensionHeight.RL', 0, 100),
        'suspensionHeight.RR': stale('suspensionHeight.RR', 0, 100),
      }),
    );
    assert.equal(s.maxHeightRange?.value, 100);
  });
});
