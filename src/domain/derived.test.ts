/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cornerHeights, heightDeltas } from './derived';
import { snapAt, stale, valid } from './testUtils';

describe('heightDeltas', () => {
  it('формулы из спецификации', () => {
    const d = heightDeltas({ FL: 45, FR: -95, RL: -100, RR: 40 });
    assert.equal(d.frontDelta, 140); // FL − FR
    assert.equal(d.rearDelta, -140); // RL − RR
    assert.equal(d.leftRight, 0); // (45 − 100 + 95 − 40) / 2
    assert.equal(d.frontRear, 5); // (45 − 95 + 100 − 40) / 2
    assert.equal(d.range, 145); // 45 − (−100)
  });

  it('нулевые высоты дают нулевые разницы, а не «нет данных»', () => {
    assert.deepEqual(heightDeltas({ FL: 0, FR: 0, RL: 0, RR: 0 }), {
      frontDelta: 0,
      rearDelta: 0,
      leftRight: 0,
      frontRear: 0,
      range: 0,
    });
  });

  it('недоступный вход делает зависимые величины недоступными', () => {
    const d = heightDeltas({ FL: 10, FR: 4, RL: null, RR: -6 });
    assert.equal(d.frontDelta, 6);
    assert.equal(d.rearDelta, null);
    assert.equal(d.leftRight, null);
    assert.equal(d.frontRear, null);
    assert.equal(d.range, null);
  });

  it('stale высота угла не участвует в расчёте', () => {
    const h = cornerHeights(
      snapAt(1000, {
        'suspensionHeight.FL': valid('suspensionHeight.FL', 10, 1000),
        'suspensionHeight.FR': stale('suspensionHeight.FR', 0, 1000),
      }),
    );
    assert.equal(h.FR, null);
    assert.equal(heightDeltas(h).frontDelta, null);
  });
});
