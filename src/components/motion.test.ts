/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { snapAt, missing, nan, stale, valid } from '../domain/testUtils';
import { WHEELS } from '../domain/types';
import { BLINK_HZ, DASH_PERIOD, SLIP_VISIBLE_PCT, advancePhase, blinkLevel, braking, computeMotion, flowing, tyreBlink, tyreSurface } from './motion';

const T = 10_000;
const wheelsAt = (kmh: number) =>
  Object.fromEntries(WHEELS.map((w) => [`wheelSpeed.${w}`, valid(`wheelSpeed.${w}`, kmh, T)]));

describe('computeMotion', () => {
  it('валидные 0 об/мин останавливают двигатель и входной вал, null — «нет данных»', () => {
    const off = computeMotion(snapAt(T, { 'engine.rpm': valid('engine.rpm', 0, T) }).signals);
    assert.equal(off.engine, 'off');
    assert.equal(off.rates.input, 0);
    assert.equal(off.rpmFrac, 0);

    const lost = computeMotion(snapAt(T, { 'engine.rpm': missing('engine.rpm', T) }).signals);
    assert.equal(lost.engine, 'missing');
    assert.equal(lost.rates.input, 0);
    assert.equal(lost.rpmFrac, null);
  });

  it('доля оси 0 % — поток стоит, а колёса при скорости > 0 вращаются', () => {
    const m = computeMotion(
      snapAt(T, {
        'xdrive.frontTorqueNm': missing('xdrive.frontTorqueNm', T),
        'xdrive.frontPercent': valid('xdrive.frontPercent', 0, T),
        'engine.torqueNm': valid('engine.torqueNm', 400, T),
        ...wheelsAt(40),
      }).signals,
    );
    assert.equal(m.front.source, 'share');
    assert.equal(flowing(m.front), false);
    assert.equal(m.rates.front, 0);
    for (const w of WHEELS) assert.ok(m.rates[`t${w}`] > 0);
  });

  it('измеренный 0 Нм на оси важнее ненулевой доли (накат)', () => {
    const m = computeMotion(
      snapAt(T, {
        'xdrive.frontTorqueNm': valid('xdrive.frontTorqueNm', 0, T),
        'xdrive.frontPercent': valid('xdrive.frontPercent', 50, T),
        'engine.torqueNm': valid('engine.torqueNm', 400, T),
        ...wheelsAt(30),
      }).signals,
    );
    assert.equal(m.front.source, 'axleTorque');
    assert.equal(m.rates.front, 0);
    assert.ok(m.rates.tFL > 0);
  });

  it('устаревший момент не превращается в активную нагрузку', () => {
    const m = computeMotion(
      snapAt(T, {
        'xdrive.frontTorqueNm': stale('xdrive.frontTorqueNm', 900, T),
        'xdrive.frontPercent': valid('xdrive.frontPercent', 40, T),
        'xdrive.rearTorqueNm': stale('xdrive.rearTorqueNm', 900, T),
        'xdrive.rearPercent': valid('xdrive.rearPercent', 60, T),
        'engine.torqueNm': stale('engine.torqueNm', 500, T),
      }).signals,
    );
    assert.deepEqual(m.front, { level: null, source: null, direction: null });
    assert.deepEqual(m.rear, { level: null, source: null, direction: null });
    assert.equal(m.rates.front, 0);
    assert.equal(m.rates.rear, 0);
    assert.equal(m.engineLoad, null);
  });

  it('задняя ось не вычисляется как «двигатель − перед»', () => {
    const m = computeMotion(
      snapAt(T, {
        'xdrive.rearTorqueNm': missing('xdrive.rearTorqueNm', T),
        'xdrive.rearPercent': missing('xdrive.rearPercent', T),
        'xdrive.frontTorqueNm': valid('xdrive.frontTorqueNm', 300, T),
        'engine.torqueNm': valid('engine.torqueNm', 500, T),
      }).signals,
    );
    assert.equal(m.rear.level, null);
    assert.equal(m.rates.rear, 0);
    assert.ok(m.rates.front > 0);
  });

  it('отрицательный момент — торможение двигателем, а не тяга; модуль — только интенсивность', () => {
    const m = computeMotion(
      snapAt(T, {
        'engine.rpm': valid('engine.rpm', 1800, T),
        'engine.torqueNm': valid('engine.torqueNm', -140, T),
        'xdrive.frontTorqueNm': valid('xdrive.frontTorqueNm', -320, T),
        'xdrive.rearTorqueNm': missing('xdrive.rearTorqueNm', T),
        'xdrive.rearPercent': valid('xdrive.rearPercent', 60, T),
        ...wheelsAt(25),
      }).signals,
    );
    assert.equal(m.engineDirection, 'braking');
    assert.equal(m.engineLoad, 0.2);
    assert.deepEqual(m.front, { level: 0.2, source: 'axleTorque', direction: 'braking' });
    // Доля × отрицательный момент двигателя: тоже торможение, а не тяга.
    assert.equal(m.rear.source, 'share');
    assert.equal(m.rear.direction, 'braking');
    assert.ok((m.rear.level as number) > 0);
    assert.equal(flowing(m.front), false);
    assert.equal(flowing(m.rear), false);
    assert.equal(braking(m.front), true);
    assert.equal(m.rates.front, 0);
    assert.equal(m.rates.rear, 0);
    // Вход вращается по оборотам независимо от знака момента; все скорости фаз ≥ 0.
    assert.ok(m.rates.input > 0);
    assert.ok(Object.values(m.rates).every((r) => r >= 0));
    assert.equal(m.anyMotion, true);
  });

  it('валидный 0 Нм на задней оси важнее доли и момента двигателя', () => {
    const m = computeMotion(
      snapAt(T, {
        'xdrive.rearTorqueNm': valid('xdrive.rearTorqueNm', 0, T),
        'xdrive.rearPercent': valid('xdrive.rearPercent', 60, T),
        'engine.torqueNm': valid('engine.torqueNm', 500, T),
      }).signals,
    );
    assert.deepEqual(m.rear, { level: 0, source: 'axleTorque', direction: 'none' });
    assert.equal(flowing(m.rear), false);
    assert.equal(braking(m.rear), false);
    assert.equal(m.rates.rear, 0);
  });

  it('задняя ось берёт собственный момент, а не долю', () => {
    const m = computeMotion(
      snapAt(T, {
        'xdrive.rearTorqueNm': valid('xdrive.rearTorqueNm', 800, T),
        'xdrive.rearPercent': valid('xdrive.rearPercent', 0, T),
        'engine.torqueNm': valid('engine.torqueNm', 500, T),
      }).signals,
    );
    assert.deepEqual(m.rear, { level: 0.5, source: 'axleTorque', direction: 'drive' });
    assert.ok(m.rates.rear > 0);
  });

  it('устаревший момент задней оси без момента двигателя — нагрузка неизвестна', () => {
    for (const engine of [missing('engine.torqueNm', T), stale('engine.torqueNm', 400, T), nan('engine.torqueNm', T)]) {
      const m = computeMotion(
        snapAt(T, {
          'xdrive.rearTorqueNm': stale('xdrive.rearTorqueNm', 900, T),
          'xdrive.rearPercent': valid('xdrive.rearPercent', 60, T),
          'xdrive.frontTorqueNm': valid('xdrive.frontTorqueNm', 300, T),
          'engine.torqueNm': engine,
        }).signals,
      );
      assert.deepEqual(m.rear, { level: null, source: null, direction: null });
      assert.equal(m.rates.rear, 0);
      assert.equal(m.engineDirection, null);
    }
  });

  it('устаревший момент задней оси — оценка по собственной доле и моменту двигателя', () => {
    const m = computeMotion(
      snapAt(T, {
        'xdrive.rearTorqueNm': stale('xdrive.rearTorqueNm', 900, T),
        'xdrive.rearPercent': valid('xdrive.rearPercent', 60, T),
        'xdrive.frontTorqueNm': valid('xdrive.frontTorqueNm', 1500, T),
        'engine.torqueNm': valid('engine.torqueNm', 350, T),
      }).signals,
    );
    assert.equal(m.rear.source, 'share');
    assert.equal(m.rear.direction, 'drive');
    // 0.6 × 350/700, а не «двигатель − перед».
    assert.ok(Math.abs((m.rear.level as number) - 0.3) < 1e-9);
    assert.ok(m.rates.rear > 0);
  });
});

describe('computeMotion: вращение колёс и агрегатов', () => {
  it('валидные 0 км/ч — колёса и оси стоят, но скорость известна; нет данных — неизвестна', () => {
    const still = computeMotion(snapAt(T, wheelsAt(0)).signals);
    for (const w of WHEELS) assert.equal(still.rates[`t${w}`], 0);
    assert.equal(still.rates.sf, 0);
    assert.equal(still.rates.sr, 0);
    assert.deepEqual(still.spinKnown, { front: true, rear: true });

    const lost = computeMotion(
      snapAt(T, Object.fromEntries(WHEELS.map((w) => [`wheelSpeed.${w}`, w.startsWith('F') ? missing(`wheelSpeed.${w}`, T) : stale(`wheelSpeed.${w}`, 30, T)]))).signals,
    );
    for (const w of WHEELS) assert.equal(lost.rates[`t${w}`], 0);
    assert.deepEqual(lost.spinKnown, { front: false, rear: false });
    assert.equal(lost.rates.sf, 0);
  });

  it('ползущее колесо (1–2 км/ч) катится заметно, ось вращается и без тяги', () => {
    const m = computeMotion(
      snapAt(T, {
        ...wheelsAt(1.6),
        'xdrive.frontTorqueNm': valid('xdrive.frontTorqueNm', -200, T),
        'xdrive.rearTorqueNm': valid('xdrive.rearTorqueNm', 0, T),
      }).signals,
    );
    for (const w of WHEELS) assert.ok(m.rates[`t${w}`] >= 0.2, w);
    assert.ok(m.rates.sf > 0 && m.rates.sr > 0);
    // Вращение не делает торможение двигателем или 0 Нм тягой.
    assert.equal(flowing(m.front), false);
    assert.equal(flowing(m.rear), false);
    assert.equal(m.rates.front, 0);
  });

  it('двигатель и АКПП вращаются по оборотам независимо от знака момента', () => {
    const m = computeMotion(snapAt(T, { 'engine.rpm': valid('engine.rpm', 900, T), 'engine.torqueNm': valid('engine.torqueNm', -80, T) }).signals);
    assert.ok(m.rates.eng > 0);
    assert.equal(m.engineDirection, 'braking');
    const off = computeMotion(snapAt(T, { 'engine.rpm': valid('engine.rpm', 0, T) }).signals);
    assert.equal(off.rates.eng, 0);
  });
});

describe('advancePhase', () => {
  it('фаза остаётся в [0, 1) и переход через 1 бесшовен для всех периодов штрихов', () => {
    let p = 0;
    for (let i = 0; i < 1000; i++) {
      p = advancePhase(p, 1.37, 0.016);
      assert.ok(p >= 0 && p < 1);
    }
    const before = advancePhase(0.99, 1, 0.005);
    const after = advancePhase(0.99, 1, 0.015);
    assert.ok(after < before, 'произошёл перенос');
    for (const period of Object.values(DASH_PERIOD)) {
      assert.ok(Math.abs(1 / period - Math.round(1 / period)) < 1e-9, `период ${period} делит 1`);
      // Положение рисунка штрихов по модулю периода непрерывно через перенос.
      const gap = ((after - before) % period + period) % period;
      assert.ok(Math.abs(gap - 0.01) < 1e-9);
    }
  });

  it('нулевая скорость не двигает фазу', () => {
    assert.equal(advancePhase(0.42, 0, 0.1), 0.42);
  });
});

describe('tyreSurface: буксование + торможение', () => {
  it('мигающий красный — только валидный тормоз и видимая пробуксовка вместе', () => {
    assert.equal(tyreSurface(true, SLIP_VISIBLE_PCT), 'brake-slip');
    assert.equal(tyreSurface(true, 45), 'brake-slip');
    // Тормоз без пригодной или видимой пробуксовки — ровный красный.
    assert.equal(tyreSurface(true, null), 'brake');
    assert.equal(tyreSurface(true, SLIP_VISIBLE_PCT - 0.1), 'brake');
    assert.equal(tyreSurface(true, 0), 'brake');
    // Пробуксовка без валидного тормоза (false / нет / устарел → null) — янтарь, не красный.
    assert.equal(tyreSurface(false, 45), 'slip');
    assert.equal(tyreSurface(null, 45), 'slip');
    assert.equal(tyreSurface(null, null), 'normal');
    assert.equal(tyreSurface(false, 2), 'normal');
  });

  it('режим мигания: пауза замораживает, reduced-motion — ровный красный', () => {
    assert.equal(tyreBlink('brake-slip', true, false), 'pulse');
    assert.equal(tyreBlink('brake-slip', false, false), 'frozen');
    assert.equal(tyreBlink('brake-slip', false, true), 'steady');
    assert.equal(tyreBlink('brake-slip', true, true), 'steady');
    for (const s of ['normal', 'slip', 'brake'] as const) assert.equal(tyreBlink(s, true, false), 'none', s);
  });

  it('пульсация плавная 1–1.5 Гц: от тёмного к яркому и обратно за период', () => {
    assert.ok(BLINK_HZ >= 1 && BLINK_HZ <= 1.5);
    assert.ok(Math.abs(blinkLevel(0)) < 1e-9, 'начало периода — тёмно-красный');
    assert.ok(Math.abs(blinkLevel(0.5) - 1) < 1e-9, 'середина — ярко-красный');
    // Ровно один период за 1/BLINK_HZ с: яркость возвращается к исходной.
    let p = 0.3;
    for (let i = 0; i < 50; i++) p = advancePhase(p, BLINK_HZ, 1 / BLINK_HZ / 50);
    assert.ok(Math.abs(blinkLevel(p) - blinkLevel(0.3)) < 1e-6);
    // Плавность: за кадр 60 Гц яркость меняется меньше чем на 15 % — не строб.
    for (let q = 0; q < 1; q += 0.01) assert.ok(Math.abs(blinkLevel(advancePhase(q, BLINK_HZ, 1 / 60)) - blinkLevel(q)) < 0.15);
  });

  it('пауза: нулевой шаг времени не двигает фазу мигания, продолжение идёт с того же места', () => {
    const frozen = advancePhase(0.37, BLINK_HZ, 0);
    assert.equal(frozen, 0.37);
    assert.ok(advancePhase(frozen, BLINK_HZ, 0.1) > 0.37);
  });
});
