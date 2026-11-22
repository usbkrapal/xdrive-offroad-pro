import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startApp, CAMERA_PAGE } from '../src/app';
import { PRODUCTION } from '../src/devAccess';
import { fakeCtx, fakeKit, FakeTransport, stageVendorKit, syntheticAssets } from './helpers';
import type { Surface } from '../src/platform/kitTypes';

describe('крупные камеры и выбор окна', () => {
  it('все окна крупнее прежних, выбор и повторное нажатие разворачивают и возвращают камеры', async () => {
    const stage = stageVendorKit();
    const { Recorder } = stage.req('./record.js');
    const ctx = fakeCtx(new FakeTransport(), {}, { own: true });
    ctx.canvas = () => Object.assign(new Recorder(1600, 520), { own: true });
    const app = startApp(ctx, fakeKit(), syntheticAssets(), () => 1000, PRODUCTION);
    const targets = () => (ctx.shown[ctx.shown.length - 1].cv as Surface & { targets: { key: string; x: number; y: number; w: number; h: number; run(): unknown }[] }).targets;
    try {
      app.setPage(CAMERA_PAGE); app.render();
      let ts = targets();
      assert.deepEqual(ts.map((x) => x.key), ['camera:front', 'camera:left', 'camera:right']);
      assert.ok((ts[0].w - 16) * (ts[0].h - 44) > 722 * 406);
      assert.ok((ts[1].w - 16) * (ts[1].h - 44) > 371 * 209);
      ts[1].run();
      ts = targets();
      assert.equal(ts[0].key, 'camera:left');
      const normalWidth = ts[0].w;
      ts[0].run();
      ts = targets();
      assert.equal(ts.length, 1);
      assert.equal(ts[0].key, 'camera:left');
      assert.ok(ts[0].w > normalWidth);
      ts[0].run();
      assert.equal(targets().length, 3);
      app.setPage(0); app.render();
      app.setPage(CAMERA_PAGE); app.render();
      assert.equal(targets().length, 3);
    } finally { await app.dispose(); stage.cleanup(); }
  });

  it('шестьдесят тиков рендерера дают пять обновлений данных в секунду; касание вкладки рисует сразу', async () => {
    let now = 0;
    const ctx = fakeCtx(new FakeTransport());
    const app = startApp(ctx, fakeKit(), syntheticAssets(), () => now, PRODUCTION);
    try {
      for (let i = 0; i < 60; i++) { now = i * 1000 / 60; await ctx.loopFn!(); }
      assert.equal(ctx.shown.length, 5);
      const n = ctx.shown.length;
      ctx.tab!(3);
      assert.equal(ctx.shown.length, n + 1);
    } finally { await app.dispose(); }
  });
});
