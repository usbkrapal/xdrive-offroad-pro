/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState } from '../app/store';
import { createSession, ingestSample } from '../domain/session';
import { SCENARIO_IDS } from '../domain/types';
import { ru } from '../i18n/ru';
import { buildSnapshot } from '../providers/mock/buildSnapshot';
import { CamerasScreen } from './CamerasScreen';
import { SuspensionScreen } from './SuspensionScreen';
import { SystemsScreen } from './SystemsScreen';
import { TerrainScreen } from './TerrainScreen';
import { TractionScreen } from './TractionScreen';

const SCREENS = { TerrainScreen, TractionScreen, SuspensionScreen, SystemsScreen, CamerasScreen };

function stateAt(id: (typeof SCENARIO_IDS)[number], tMs: number): AppState {
  let session = createSession(buildSnapshot(id, 0, 0));
  for (let t = 500; t <= tMs; t += 500) session = ingestSample(session, buildSnapshot(id, 0, t));
  return { snapshot: buildSnapshot(id, 0, tMs), session, paused: false, scenarioId: id };
}

describe('экраны рендерятся во всех сценариях', () => {
  for (const id of SCENARIO_IDS) {
    for (const [name, Screen] of Object.entries(SCREENS)) {
      it(`${name} · ${id}`, () => {
        const html = renderToStaticMarkup(<Screen state={stateAt(id, 15_000)} />);
        assert.ok(html.length > 500, `html.length=${html.length}`);
        assert.doesNotMatch(html, /NaN/);
        assert.doesNotMatch(html, /undefined/);
      });
    }
  }

  it('при потере данных показываются текстовые статусы, а не нули', () => {
    const html = renderToStaticMarkup(<SystemsScreen state={stateAt('partialLoss', 15_000)} />);
    assert.ok(html.includes(ru.quality.unavailable), ru.quality.unavailable);
    assert.ok(html.includes(ru.quality.stale), ru.quality.stale);
  });

  it('камеры: три подписанных демо-вида, передний — основной', () => {
    const html = renderToStaticMarkup(<CamerasScreen state={stateAt('mountainTrail', 5_000)} />);
    for (const name of Object.values(ru.cameras.names)) assert.ok(html.includes(name), name);
    assert.equal(html.split(ru.cameras.demoLabel).length - 1, 3);
    for (const v of ['front', 'left', 'right']) assert.match(html, new RegExp(`<img[^>]+camera-${v}-demo\\.png`), v);
    assert.ok(!html.includes(ru.cameras.unavailable));
    assert.match(html, /aria-pressed="true" aria-label="[^"]*Передняя камера"/);
  });

  it('камеры: в partialLoss левый вид — заглушка, передний и правый доступны', () => {
    const html = renderToStaticMarkup(<CamerasScreen state={stateAt('partialLoss', 15_000)} />);
    assert.ok(!html.includes('camera-left-demo.png'), 'левое изображение не рендерится');
    assert.ok(html.includes('camera-front-demo.png'));
    assert.ok(html.includes('camera-right-demo.png'));
    assert.ok(html.includes(ru.cameras.unavailable));
    assert.ok(html.includes(ru.cameras.simulatedLoss));
    assert.ok(html.includes(ru.cameras.names.left));
    assert.equal(html.split(ru.cameras.demoLabel).length - 1, 3);
  });

  it('все четыре колеса подписаны на экранах с топологией', () => {
    for (const Screen of [TractionScreen, SuspensionScreen, SystemsScreen]) {
      const html = renderToStaticMarkup(<Screen state={stateAt('diagonal', 5_000)} />);
      for (const w of ['ПЛ', 'ПП', 'ЗЛ', 'ЗП']) assert.ok(html.includes(w), `${Screen.name}: ${w}`);
    }
  });
});
