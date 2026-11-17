/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { usableValue } from '../../domain/signal';
import { SIGNAL_IDS } from '../../domain/signalCatalog';
import { SCENARIO_IDS, SUSPENSION_LEVELS, WHEELS, type Quality, type SignalId } from '../../domain/types';
import { buildSnapshot } from './buildSnapshot';

const TIMES = Array.from({ length: 241 }, (_, i) => i * 250); // 0..60 с

function num(id: SignalId, s: ReturnType<typeof buildSnapshot>): number | null {
  return usableValue<unknown>(s.signals[id]) as number | null;
}

for (const id of SCENARIO_IDS) {
  describe(`сценарий ${id}`, () => {
    it('детерминирован по времени симуляции', () => {
      assert.deepEqual(buildSnapshot(id, 1000, 7300), buildSnapshot(id, 1000, 7300));
      // Значения зависят только от локального времени сценария, не от момента выбора.
      const values = (s: ReturnType<typeof buildSnapshot>) => SIGNAL_IDS.map((sid) => s.signals[sid].value);
      assert.deepEqual(values(buildSnapshot(id, 0, 6300)), values(buildSnapshot(id, 1000, 7300)));
    });

    it('содержит все сигналы, все mock, валидные значения правдоподобны', () => {
      for (const t of TIMES) {
        const s = buildSnapshot(id, 0, t);
        const at = `t=${t}`;
        assert.equal(s.scenarioId, id);
        for (const sid of SIGNAL_IDS) {
          const sig = s.signals[sid];
          const where = `${sid} @ ${at}`;
          assert.ok(sig, where);
          assert.equal(sig.runtimeSource, 'mock', where);
          if (sig.quality === 'valid') {
            assert.notEqual(sig.value, null, where);
            if (typeof sig.value === 'number') assert.ok(Number.isFinite(sig.value), where);
          } else if (sig.quality !== 'stale') {
            assert.equal(sig.value, null, where);
          }
        }
        for (const w of WHEELS) {
          const slip = num(`wheelSlip.${w}`, s);
          if (slip !== null) assert.ok(slip >= 0 && slip <= 100, `wheelSlip.${w}=${slip} @ ${at}`);
        }
        const pitch = num('attitude.pitchDeg', s);
        const roll = num('attitude.rollDeg', s);
        if (pitch !== null) assert.ok(Math.abs(pitch) < 45, `pitch=${pitch} @ ${at}`);
        if (roll !== null) assert.ok(Math.abs(roll) < 45, `roll=${roll} @ ${at}`);
        const front = num('xdrive.frontPercent', s);
        const rear = num('xdrive.rearPercent', s);
        if (front !== null && rear !== null) {
          assert.ok(Math.abs(front + rear - 100) < 1e-6, `front+rear=${front + rear} @ ${at}`);
        }
        const level = usableValue(s.signals['suspension.level']);
        if (level !== null) assert.ok([...SUSPENSION_LEVELS, 'unknown'].includes(level), `level=${level} @ ${at}`);
      }
    });
  });
}

describe('сценарии без потерь', () => {
  for (const id of ['mountainTrail', 'climb', 'diagonal', 'hdcDescent'] as const) {
    it(`${id}: нет stale/invalid`, () => {
      for (const t of TIMES) {
        const s = buildSnapshot(id, 0, t);
        for (const sid of SIGNAL_IDS) {
          const q = s.signals[sid].quality;
          assert.ok(q === 'valid' || q === 'unavailable', `${sid} @ t=${t}: ${q}`);
        }
      }
    });
  }

  it('спуск с HDC: педаль 0 % и DTC=false — валидные значения; момент отрицательный', () => {
    const s = buildSnapshot('hdcDescent', 0, 5000);
    assert.equal(s.signals.acceleratorPedalPercent.value, 0);
    assert.equal(s.signals.acceleratorPedalPercent.quality, 'valid');
    assert.equal(s.signals['dtc.status'].value, false);
    assert.equal(s.signals['dtc.status'].quality, 'valid');
    assert.equal(s.signals['hdc.status'].value, 'active');
    assert.equal(s.signals['rearDiff.lockPercent'].value, 0);
    assert.equal(s.signals['rearDiff.lockPercent'].quality, 'valid');
    const torque = num('engine.torqueNm', s);
    const pitch = num('attitude.pitchDeg', s);
    assert.ok(torque !== null && torque < 0, `torque=${torque}`);
    assert.ok(pitch !== null && pitch < 0, `pitch=${pitch}`);
  });

  it('горная тропа: блокировка дифференциала — нет данных, а не 0 %', () => {
    const s = buildSnapshot('mountainTrail', 0, 0);
    assert.equal(s.signals['rearDiff.lockPercent'].quality, 'unavailable');
  });

  it('сценарии вместе показывают все шесть уровней подвески', () => {
    const seen = new Set<string>();
    for (const id of SCENARIO_IDS) {
      for (let t = 0; t <= 60_000; t += 500) {
        const v = usableValue(buildSnapshot(id, 0, t).signals['suspension.level']);
        if (v) seen.add(v);
      }
    }
    for (const level of SUSPENSION_LEVELS) assert.ok(seen.has(level), level);
  });
});

describe('нет части данных', () => {
  const groupOf = (id: string) => id.split('.')[0];

  it('имитирует unavailable, stale и invalid для нескольких разных типов сигналов', () => {
    const byQuality: Record<Quality, Set<string>> = {
      valid: new Set(),
      stale: new Set(),
      unavailable: new Set(),
      invalid: new Set(),
    };
    for (const t of TIMES) {
      const s = buildSnapshot('partialLoss', 0, t);
      for (const sid of SIGNAL_IDS) byQuality[s.signals[sid].quality].add(groupOf(sid));
    }
    assert.ok(byQuality.unavailable.size >= 3, `unavailable: ${[...byQuality.unavailable]}`);
    assert.ok(byQuality.stale.size >= 3, `stale: ${[...byQuality.stale]}`);
    assert.ok(byQuality.invalid.size >= 2, `invalid: ${[...byQuality.invalid]}`);
  });

  it('stale хранит старое значение и старый updatedAt', () => {
    const s = buildSnapshot('partialLoss', 0, 30_000);
    const gb = s.signals['temperature.gearboxC'];
    assert.equal(gb.quality, 'stale');
    assert.equal(gb.updatedAt, 1000);
    assert.equal(gb.value, buildSnapshot('partialLoss', 0, 1000).signals['temperature.gearboxC'].value);
  });
});
