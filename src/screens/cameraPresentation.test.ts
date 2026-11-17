/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCENARIO_IDS } from '../domain/types';
import { CAMERA_IDS, cameraAvailability, cameraLayout } from './cameraPresentation';

describe('демо-виды камер', () => {
  it('вне partialLoss все три изображения доступны', () => {
    for (const s of SCENARIO_IDS.filter((x) => x !== 'partialLoss')) {
      for (const id of CAMERA_IDS) assert.equal(cameraAvailability(s, id), 'available', `${s} · ${id}`);
    }
  });

  it('partialLoss: левый вид недоступен, передний и правый — доступны', () => {
    assert.equal(cameraAvailability('partialLoss', 'left'), 'simulatedLoss');
    assert.equal(cameraAvailability('partialLoss', 'front'), 'available');
    assert.equal(cameraAvailability('partialLoss', 'right'), 'available');
  });

  it('основной вид не сбрасывается при смене сценария, в том числе на недоступный', () => {
    for (const primary of CAMERA_IDS) {
      for (const s of SCENARIO_IDS) {
        const layout = cameraLayout(primary, s);
        assert.equal(layout.primary.id, primary, `${primary} · ${s}`);
        assert.deepEqual(
          layout.secondary.map((v) => v.id),
          CAMERA_IDS.filter((id) => id !== primary),
        );
      }
    }
    assert.equal(cameraLayout('left', 'partialLoss').primary.availability, 'simulatedLoss');
    assert.equal(cameraLayout('left', 'mountainTrail').primary.availability, 'available');
  });
});
