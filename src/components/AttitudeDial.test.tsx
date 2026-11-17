/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { missing, stale, valid } from '../domain/testUtils';
import { ru } from '../i18n/ru';
import { AttitudeDial } from './AttitudeDial';

const T = 10_000;
const rotationOf = (html: string) => html.match(/class="att__vehicle" style="transform:rotate\(([-\d.]+)deg\)"/)?.[1];

describe('AttitudeDial: тангаж и крен', () => {
  it('+тангаж — нос вверх (против часовой), +крен — вправо (по часовой)', () => {
    const pitch = renderToStaticMarkup(<AttitudeDial kind="pitch" signal={valid('attitude.pitchDeg', 12, T)} />);
    assert.equal(rotationOf(pitch), '-12');
    assert.ok(pitch.includes('pitch-side-v2.png'));
    assert.ok(pitch.includes('att__pointer'));

    const roll = renderToStaticMarkup(<AttitudeDial kind="roll" signal={valid('attitude.rollDeg', 12, T)} />);
    assert.equal(rotationOf(roll), '12');
    assert.ok(roll.includes('roll-rear-v2.png'));
  });

  it('круглый прибор: квадратный viewBox с meet, без прямоугольной подложки', () => {
    for (const kind of ['pitch', 'roll'] as const) {
      const html = renderToStaticMarkup(<AttitudeDial kind={kind} signal={valid(kind === 'pitch' ? 'attitude.pitchDeg' : 'attitude.rollDeg', 5, T)} />);
      const vb = html.match(/viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/);
      assert.ok(vb, kind);
      assert.equal(vb[3], vb[4], kind);
      // Центр вращения машины — центр квадрата.
      assert.equal(Number(vb[1]) + Number(vb[3]) / 2, 0, kind);
      assert.equal(Number(vb[2]) + Number(vb[4]) / 2, 0, kind);
      assert.match(html, /preserveAspectRatio="xMidYMid meet"[^>]*role="img"/);
      assert.ok(!html.includes('<rect'), kind);
      assert.ok(html.includes('att__face'), kind);
    }
  });

  it('за пределом шкалы машина упирается в край, число остаётся истинным', () => {
    const html = renderToStaticMarkup(<AttitudeDial kind="roll" signal={valid('attitude.rollDeg', -58, T)} />);
    assert.equal(rotationOf(html), '-45');
    assert.ok(html.includes('−58,0'));
  });

  it('нет данных или устарело — без указателя и дуги значения, со статусом вместо 0°', () => {
    for (const sig of [missing('attitude.pitchDeg', T), stale('attitude.pitchDeg', 7, T)]) {
      const html = renderToStaticMarkup(<AttitudeDial kind="pitch" signal={sig} />);
      assert.match(html, /data-state="missing"/);
      assert.ok(!html.includes('att__pointer'));
      assert.ok(!html.includes('att__value'));
      assert.ok(html.includes(ru.quality[sig.quality === 'stale' ? 'stale' : 'unavailable']));
    }
  });

  it('шкала с подписями −40…+40 и нулём; id подложки уникальны', () => {
    const html = renderToStaticMarkup(
      <>
        <AttitudeDial kind="pitch" signal={valid('attitude.pitchDeg', 0, T)} />
        <AttitudeDial kind="roll" signal={valid('attitude.rollDeg', 0, T)} />
      </>,
    );
    for (const l of ['−40', '−20', '+20', '+40']) assert.ok(html.includes(`>${l}</text>`), l);
    assert.ok(html.includes('att__num att__num--zero'));
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length);
  });
});
