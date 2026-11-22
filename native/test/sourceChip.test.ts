// Подпись источника — не доказательство данных: «Измерено» / «Оценка» только при значении. Без распределения
// момента (не пришло, не заполнено, недопустимо) «Сцепление» показывает «нет данных», а не «Измерено».

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSignal } from '../../src/domain/signal';
import { startApp } from '../src/app';
import { PRODUCTION } from '../src/devAccess';
import { presentSource } from '../src/format';
import { T } from '../src/strings';
import { fakeCtx, fakeKit, FakeTransport, flush, syntheticAssets, type TextCall } from './helpers';

const BDS = 'de.bmw.infrastructure.analytics.BasicDataSet';
const SPLIT = 'valueDistributionLongitudinalTorqueRearAxisFrontAxis';

describe('presentSource', () => {
  it('источник — только у сигнала со значением (valid/stale), иначе null', () => {
    assert.equal(presentSource(buildSignal('xdrive.rearPercent', undefined, 0, 0, 'measured')), null, 'не приходил');
    assert.equal(presentSource(buildSignal('xdrive.rearPercent', Number.NaN, 0, 0, 'measured')), null, 'invalid');
    assert.equal(presentSource(buildSignal('xdrive.rearPercent', 60, 0, 0, 'measured')), 'measured');
    assert.equal(presentSource(buildSignal('xdrive.rearPercent', 60, 0, 1e9, 'measured')), 'measured', 'stale — значение есть (показывается с пометкой)');
    assert.equal(presentSource(buildSignal('xdrive.frontPercent', 0, 0, 0, 'estimated')), 'estimated', '0 — значение');
  });
});

describe('«Сцепление» с данными автомобиля: источник — не надпись на экране', () => {
  const texts = (ctx: ReturnType<typeof fakeCtx>): string[] => (ctx.shown[ctx.shown.length - 1].cv as unknown as { texts: TextCall[] }).texts.map((x) => x.s);

  it('ни «Измерено», ни «Источник распределения»; передняя доля, выведенная из задней, помечена только при значении', async () => {
    const tr = new FakeTransport();
    const ctx = fakeCtx(tr);
    const app = startApp(ctx, fakeKit(), syntheticAssets(), () => Date.now(), PRODUCTION);
    try {
      await flush();
      ctx.tab!(1);
      await app.render();
      let tx = texts(ctx);
      for (const s of [T.source.measured, T.source.estimated, T.traction.splitSource, T.native.frontDerived]) assert.ok(!tx.includes(s), `нет «${s}» без данных`);
      tr.feed(BDS, 'basicDataSet', { [SPLIT]: 0 });
      await app.render();
      assert.ok(!texts(ctx).includes(T.native.frontDerived), 'не заполнено — пометки нет');
      tr.feed(BDS, 'basicDataSet', { [SPLIT]: 6000 });
      await app.render();
      tx = texts(ctx);
      assert.ok(tx.includes(T.native.frontDerived), 'передняя — производная, помечена');
      assert.ok(!tx.includes(T.source.measured) && !tx.includes(T.traction.splitSource));
    } finally {
      app.dispose();
    }
  });
});

describe('«Камеры» с данными автомобиля: живое изображение не подключено', () => {
  it('передняя крупно, две боковые справа; без демо-кадров при отсутствии видео', async () => {
    const tr = new FakeTransport();
    const ctx = fakeCtx(tr, {}, { own: true });
    const kit = fakeKit();
    const app = startApp(ctx, kit, syntheticAssets(), () => Date.now(), PRODUCTION);
    try {
      ctx.tab!(4);
      await app.render();
      const cv = ctx.shown[ctx.shown.length - 1].cv as unknown as { texts: TextCall[]; images: number[] };
      const names = T.native.cameras.names;
      const order = [names.left, names.front, names.right].map((n) => cv.texts.find((x) => x.s === n));
      assert.ok(order.every(Boolean), 'три названия');
      assert.ok(order[1]!.x < order[0]!.x && order[0]!.x === order[2]!.x && order[0]!.y < order[2]!.y, 'главная передняя слева, две боковые справа');
      assert.equal(cv.texts.filter((x) => x.s === 'Недоступно').length, 3, 'по одной подписи «Недоступно» на кадр');
      const page = cv.texts.filter((x) => x.s !== T.app.title && x.s !== T.app.subtitle); // знак — в полосе вкладок (без chrome)
      assert.equal(page.length, 7, 'названия, статусы и подсказка увеличения');
      assert.ok(!/live|живое|Drive Recorder|ДЕМО/i.test(cv.texts.map((x) => x.s).join('\n')), 'не утверждает живую интеграцию и не демо');
      assert.equal(cv.images.length, 0, 'ни одного кадра (демо-снимков нет)');
      assert.deepEqual(kit.buttons, []);
    } finally {
      app.dispose();
    }
  });
});
