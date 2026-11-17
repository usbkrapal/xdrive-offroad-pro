// Подпись источника — не доказательство данных: «Измерено» / «Оценка» только при значении. Без распределения
// момента (не пришло, не заполнено, недопустимо) «Сцепление» показывает «нет данных», а не «Измерено».

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSignal } from '../../src/domain/signal';
import { startApp } from '../src/app';
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

describe('«Сцепление» в режиме «Автомобиль»: чип источника распределения', () => {
  const texts = (ctx: ReturnType<typeof fakeCtx>): string[] => (ctx.shown[ctx.shown.length - 1].cv as unknown as { texts: TextCall[] }).texts.map((x) => x.s);

  it('нет данных → «нет данных», не «Измерено»; пришла задняя доля → «Измерено» и «передняя — оценка»', async () => {
    const tr = new FakeTransport();
    const ctx = fakeCtx(tr, { dataSource: 'vehicle' });
    const app = startApp(ctx, fakeKit(), syntheticAssets(), () => Date.now());
    try {
      await flush();
      ctx.tab!(1);
      await ctx.loopFn!();
      let tx = texts(ctx);
      assert.ok(!tx.includes(T.source.measured), `до данных нет «${T.source.measured}»: ${tx.filter((s) => /Измер|Оцен/.test(s)).join(',')}`);
      assert.ok(!tx.includes(T.source.estimated));
      assert.ok(tx.includes(T.native.noSource));

      // raw 0 — «не заполнено» (INTEGRATION.md): провайдер есть, значения нет — всё ещё не «Измерено»
      tr.feed(BDS, 'basicDataSet', { [SPLIT]: 0 });
      await new Promise((r) => setTimeout(r, 120));
      await ctx.loopFn!();
      tx = texts(ctx);
      assert.ok(!tx.includes(T.source.measured), 'не заполнено — без источника');
      assert.ok(tx.includes(T.native.noSource));

      tr.feed(BDS, 'basicDataSet', { [SPLIT]: 6000 });
      await new Promise((r) => setTimeout(r, 120));
      await ctx.loopFn!();
      tx = texts(ctx);
      assert.ok(tx.includes(T.source.measured), 'задняя доля пришла — «Измерено»');
      assert.ok(tx.includes(T.native.frontDerived), 'передняя — производная, помечена');
      assert.ok(!tx.includes(T.native.noSource));
    } finally {
      app.dispose();
    }
  });

  it('демо со значением: источник «Демо», не «Измерено»', async () => {
    const tr = new FakeTransport();
    const ctx = fakeCtx(tr, { dataSource: 'demo', scenario: 'mountainTrail' });
    const app = startApp(ctx, fakeKit(), syntheticAssets(), () => Date.now());
    try {
      ctx.tab!(1);
      await ctx.loopFn!();
      const tx = texts(ctx);
      assert.ok(tx.includes(T.source.mock), 'демо со значением — «Демо»');
      assert.ok(!tx.includes(T.source.measured));
    } finally {
      app.dispose();
    }
  });
});

describe('«Камеры» в режиме «Автомобиль»: Drive Recorder, живое изображение не подключено', () => {
  it('формулировка: камеры не «отсутствуют»; все три без изображения; кнопок выбора и демо-кадров нет', async () => {
    const tr = new FakeTransport();
    const ctx = fakeCtx(tr, { dataSource: 'vehicle' }, { own: true });
    const kit = fakeKit();
    const app = startApp(ctx, kit, syntheticAssets(), () => Date.now());
    try {
      ctx.tab!(4);
      await ctx.loopFn!();
      const cv = ctx.shown[ctx.shown.length - 1].cv as unknown as { texts: TextCall[]; images: number[] };
      const tx = cv.texts.map((x) => x.s).join('\n');
      assert.equal(T.native.cameras.vehicleNote, 'Камеры автомобиля доступны в Drive Recorder. Передача живого изображения в Terrain Monitor ещё не подключена.');
      assert.equal(cv.texts.filter((x) => x.s.includes('Drive Recorder')).length, 1, 'Drive Recorder — одна общая пометка, не у каждой камеры');
      assert.ok(tx.includes('Камеры автомобиля доступны в Drive Recorder.'));
      assert.ok(tx.includes('Передача живого изображения в Terrain Monitor ещё не подключена.'));
      assert.equal(cv.texts.filter((x) => x.s === T.native.cameras.vehicleNoFeed).length, 3, 'все три камеры — без изображения');
      assert.equal(cv.texts.filter((x) => x.s === T.native.cameras.vehicleStatus).length, 3);
      assert.ok(!/не подключены\.|недоступн|отсутству|нет камер/i.test(tx), 'аппаратура камер не объявлена отсутствующей');
      assert.equal(cv.images.length, 0, 'ни одного кадра (демо-снимков в режиме автомобиля нет)');
      assert.deepEqual(kit.buttons, [], '«Показать крупно» — только в демо');
    } finally {
      app.dispose();
    }
  });
});
