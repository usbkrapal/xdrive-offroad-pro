// Сверка углов с xView (только лист поддержки): наклон стоя по вектору тяжести ACSM — кандидат, не измерение экрана.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attitudeLines, standingTiltCandidate } from '../src/render/support';

const g = 9.80665;
const acc = (pitchDeg: number, rollDeg: number, q = 2) => {
  const p = (pitchDeg * Math.PI) / 180, r = (rollDeg * Math.PI) / 180;
  return { accX: g * Math.sin(p), accY: g * Math.cos(p) * Math.sin(r), accZ: g * Math.cos(p) * Math.cos(r), accXQualifier: q, accYQualifier: q, accZQualifier: q };
};

describe('кандидат наклона стоя (ACSM)', () => {
  it('восстанавливает тангаж и крен из вектора тяжести', () => {
    for (const [p, r] of [[0, 0], [12, -7], [-25, 18], [30, 30]]) {
      const c = standingTiltCandidate(acc(p, r), true)!;
      assert.ok(Math.abs(c.pitch - p) < 1e-6 && Math.abs(c.roll - r) < 1e-6, `${p}/${r}: ${c.pitch}/${c.roll}`);
    }
  });
  it('нет при движении или неизвестной скорости, при квалификаторе ≠ 2 и при |g| вне 7…12,5 м/с²', () => {
    assert.equal(standingTiltCandidate(acc(10, 5), false), null);
    assert.equal(standingTiltCandidate(acc(10, 5), null), null);
    assert.equal(standingTiltCandidate(acc(10, 5, 6), true), null);
    assert.equal(standingTiltCandidate({ ...acc(0, 0), accZ: 25 }, true), null);
    assert.equal(standingTiltCandidate({ ...acc(0, 0), accX: null }, true), null);
  });
  it('строки сверки: сырой LaneSlope, ACSM, кандидат, BDC — с пометкой «не на экране»', () => {
    const d = {
      at: 10_000,
      latestSamples: [{ iface: 'de.bmw.chassis.VehicleModel', field: 'LaneSlope', at: 9_000, values: { actualValueLongitudinalGradientRoadway: 337, actualValueTransverseGradientRoadway: 3921 } }],
      uds: { ecus: [
        { key: 'ACSM', identity: '0F2040', records: [{ did: '4101', lastAt: 8_000, values: acc(5, -3), lastError: null }] },
        { key: 'BDC', identity: 'x', records: [{ did: 'D54D', lastAt: 8_000, values: { pitchCandidateDeg: 0.4, source: 2, qualifier: 22 }, lastError: null }] },
      ] },
    } as never;
    const lines = attitudeLines(d, true, new Date(2026, 10, 25, 12, 34, 56));
    const text = lines.map((l) => `${l.label} = ${l.value}`).join('\n');
    assert.match(text, /не на экране/);
    assert.match(text, /12:34:56/);
    assert.match(text, /337 \/ 3921/);
    assert.match(text, /тангаж 5,0° · крен -3,0°/);
    assert.match(text, /кузов к осям/);
    const moving = attitudeLines(d, false, new Date()).map((l) => l.value).join('\n');
    assert.match(moving, /только при известной нулевой скорости/);
  });
});
