import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { SCENARIO_IDS } from '../../src/domain/types';
import { startApp, type AppHandle } from '../src/app';
import { IMAGE_ID } from '../src/assets/spec';
import type { Kit } from '../src/platform/kit';
import type { Surface } from '../src/platform/kitTypes';
import { BAR_Y } from '../src/render/layout';
import { PAGE_COUNT } from '../src/render/pages';
import { TAB_LABELS } from '../src/strings';
import { fakeCtx, fakeKit, FakeTransport, flush, hasUpstream, loadUpstream, strictSurface, syntheticAssets, type FakeCtx } from './helpers';

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const NUM_CHARS = /^[0-9 ,.+\-/:%]*$/;
const CAMERA_IDS = [IMAGE_ID.cameraFront, IMAGE_ID.cameraLeft, IMAGE_ID.cameraRight, IMAGE_ID.thumbFront, IMAGE_ID.thumbLeft, IMAGE_ID.thumbRight];

const ASSETS_MOD = syntheticAssets();

const apps: AppHandle[] = [];
after(() => apps.forEach((a) => a.dispose()));

function launch(init: Record<string, unknown> = {}, opts: { own?: boolean; kit?: Kit; canvas?: () => Surface } = {}) {
  const tr = new FakeTransport();
  const ctx = fakeCtx(tr, init, opts);
  if (opts.canvas) ctx.canvas = opts.canvas;
  const kit = opts.kit ?? fakeKit();
  let t = 0;
  const app = startApp(ctx, kit, ASSETS_MOD, () => (t += 50));
  apps.push(app);
  return { tr, ctx, kit, app };
}

async function drawAll(ctx: FakeCtx, app: AppHandle): Promise<ReturnType<typeof strictSurface>[]> {
  const out: ReturnType<typeof strictSurface>[] = [];
  for (let p = 0; p < PAGE_COUNT; p++) {
    ctx.tab!(p);
    assert.equal(app.page(), p);
    await ctx.loopFn!();
    out.push(ctx.shown[ctx.shown.length - 1].cv as ReturnType<typeof strictSurface>);
  }
  return out;
}

function checkTexts(cv: ReturnType<typeof strictSurface>, where: string): void {
  for (const tc of cv.texts) {
    assert.equal(tc.literal, true, `${where}: текст без literal: «${tc.s}»`);
    if (tc.font === 'num') assert.match(tc.s, NUM_CHARS, `${where}: символ вне цифрового атласа: «${tc.s}»`);
    assert.ok(tc.size >= 11, `${where}: слишком мелкий текст ${tc.size}px «${tc.s}»`);
  }
}

describe('отрисовка: строгая поверхность (только методы Recorder)', () => {
  it('демо: 5 экранов × 5 сценариев рисуются, вкладки и бейдж ДЕМО', async () => {
    for (const sc of SCENARIO_IDS) {
      const { ctx, kit, app } = launch({ scenario: sc });
      const k = kit as ReturnType<typeof fakeKit>;
      const cvs = await drawAll(ctx, app);
      cvs.forEach((cv, p) => {
        assert.ok(cv.counts.fillRect > 5, `${sc}/${p}: страница пуста`);
        checkTexts(cv, `${sc}/${p}`);
      });
      const fr = k.frames[k.frames.length - 1] as { tabs: string[]; badges: { text: string }[] };
      assert.deepEqual(fr.tabs, [...TAB_LABELS]);
      assert.equal(fr.badges[0].text, 'ДЕМО');
      // Камеры: в partialLoss левая — смоделированная потеря (кадр не рисуется).
      const cam = cvs[4];
      assert.ok(cam.images.includes(IMAGE_ID.cameraFront), `${sc}: основной кадр`);
      if (sc === 'partialLoss') assert.ok(!cam.images.includes(IMAGE_ID.thumbLeft) && !cam.images.includes(IMAGE_ID.cameraLeft));
      else assert.ok(cam.images.includes(IMAGE_ID.thumbLeft));
      // Рельеф: рендер привода и оба прибора.
      for (const id of [IMAGE_ID.xray, IMAGE_ID.dialPitch, IMAGE_ID.dialRoll]) assert.ok(cvs[0].images.includes(id), `${sc}: image ${id}`);
      app.dispose();
    }
  });

  it('режим чтения: бейдж «нет данных», без демо-снимков камер, затем «частично» после колбэка', async () => {
    const { ctx, kit, app, tr } = launch({ dataSource: 'vehicle' });
    const k = kit as ReturnType<typeof fakeKit>;
    await flush();
    const cvs = await drawAll(ctx, app);
    cvs.forEach((cv, p) => {
      checkTexts(cv, `vehicle/${p}`);
      for (const id of CAMERA_IDS) assert.ok(!cv.images.includes(id), `vehicle/${p}: демо-кадр камеры ${id}`);
    });
    assert.ok(!k.setImageCalls.some((c) => CAMERA_IDS.includes(c.id as never)), 'кадры камер даже не распакованы');
    let fr = k.frames[k.frames.length - 1] as { badges: { text: string }[] };
    assert.equal(fr.badges[0].text, 'НЕТ ДАННЫХ');
    tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 3000 });
    await new Promise((r) => setTimeout(r, 150));
    await ctx.loopFn!();
    fr = k.frames[k.frames.length - 1] as { badges: { text: string }[] };
    assert.equal(fr.badges[0].text, 'ЧТЕНИЕ');
    app.dispose();
  });

  it('кнопки HMI: экраны по кругу; «Пауза» — только демо; «Сброс» — новая сессия в обоих режимах', async () => {
    const { ctx, app } = launch();
    ctx.clicks.BTN_PREV({});
    assert.equal(app.page(), PAGE_COUNT - 1);
    ctx.clicks.BTN_PAGE({});
    assert.equal(app.page(), 0);
    assert.equal(ctx.labels.BTN_ACTION, 'Пауза');
    assert.equal(ctx.enabledState.BTN_ACTION, true);
    ctx.clicks.BTN_ACTION({});
    assert.equal(app.model.getState().paused, true);
    assert.equal(ctx.labels.BTN_ACTION, 'Пуск');
    ctx.clicks.BTN_ACTION({});
    assert.equal(app.model.getState().paused, false);
    let before = app.model.getState().epoch;
    ctx.clicks.BTN_SESSION({});
    assert.equal(app.model.getState().epoch, before + 1, 'демо: новая сессия');

    ctx.settings.set('dataSource', 'vehicle');
    assert.equal(app.model.dataMode, 'vehicle');
    assert.equal(ctx.labels.BTN_ACTION, 'Пауза');
    assert.equal(ctx.enabledState.BTN_ACTION, false, 'пауза недоступна в режиме чтения');
    before = app.model.getState().epoch;
    ctx.clicks.BTN_ACTION({});
    assert.equal(app.model.getState().epoch, before, 'действие в режиме чтения ничего не делает');
    assert.equal(app.model.getState().paused, false);
    ctx.clicks.BTN_SESSION({});
    assert.equal(app.model.getState().epoch, before + 1, 'режим чтения: новая сессия');
    ctx.settings.set('dataSource', 'demo');
    assert.equal(ctx.enabledState.BTN_ACTION, true);
    app.dispose();
  });

  it('own = false (upstream-диалект, программный путь): без кнопок на странице сессия и камера доступны с панели и из настроек', async () => {
    const { ctx, app, kit } = launch({}, { own: false });
    const k = kit as ReturnType<typeof fakeKit>;
    for (let p = 0; p < PAGE_COUNT; p++) {
      ctx.tab!(p);
      await ctx.loopFn!();
      const cv = ctx.shown[ctx.shown.length - 1].cv as ReturnType<typeof strictSurface>;
      assert.equal(cv.counts.target ?? 0, 0, `страница ${p}: целей нажатия нет`);
    }
    assert.equal(k.buttons.length, 0, 'G.button не вызывается');
    assert.equal(typeof ctx.clicks.BTN_SESSION, 'function');
    const before = app.model.getState().epoch;
    ctx.clicks.BTN_SESSION({});
    assert.equal(app.model.getState().epoch, before + 1);

    const mainImage = async () => {
      ctx.tab!(4);
      await ctx.loopFn!();
      return (ctx.shown[ctx.shown.length - 1].cv as ReturnType<typeof strictSurface>).images;
    };
    let imgs = await mainImage();
    assert.ok(imgs.includes(IMAGE_ID.cameraFront) && !imgs.includes(IMAGE_ID.cameraRight), 'по умолчанию — передняя');
    ctx.settings.set('primaryCamera', 'right');
    imgs = await mainImage();
    assert.ok(imgs.includes(IMAGE_ID.cameraRight) && imgs.includes(IMAGE_ID.thumbFront) && !imgs.includes(IMAGE_ID.cameraFront));
    ctx.settings.set('primaryCamera', 'rear');
    imgs = await mainImage();
    assert.ok(imgs.includes(IMAGE_ID.cameraRight), 'недопустимое значение игнорируется');
    app.dispose();

    const saved = launch({ primaryCamera: 'left' }, { own: false });
    saved.ctx.tab!(4);
    await saved.ctx.loopFn!();
    assert.ok((saved.ctx.shown[saved.ctx.shown.length - 1].cv as ReturnType<typeof strictSurface>).images.includes(IMAGE_ID.cameraLeft), 'сохранённый выбор');
    saved.app.dispose();
    const bad = launch({ primaryCamera: 42 }, { own: false });
    bad.ctx.tab!(4);
    await bad.ctx.loopFn!();
    assert.ok((bad.ctx.shown[bad.ctx.shown.length - 1].cv as ReturnType<typeof strictSurface>).images.includes(IMAGE_ID.cameraFront));
    bad.app.dispose();
  });

  it('own = true: «Показать крупно» меняет ту же настройку primaryCamera; «Основной вид» — не кнопка', async () => {
    const { ctx, app, kit } = launch({}, { own: true });
    const k = kit as ReturnType<typeof fakeKit>;
    ctx.tab!(4);
    await ctx.loopFn!();
    assert.deepEqual(Object.keys(k.presses).filter((key) => key.startsWith('cam-')).sort(), ['cam-left', 'cam-right'], 'кнопки только у миниатюр');
    k.presses['cam-left']();
    assert.equal(ctx.values.primaryCamera, 'left');
    await ctx.loopFn!();
    assert.ok((ctx.shown[ctx.shown.length - 1].cv as ReturnType<typeof strictSurface>).images.includes(IMAGE_ID.cameraLeft));
    app.dispose();
  });

  it('кнопки на странице только когда kit сам ведёт экран', async () => {
    const own = launch({}, { own: true });
    await own.ctx.loopFn!();
    assert.equal((own.kit as ReturnType<typeof fakeKit>).buttons.length, 0, '«Рельеф»: в строке статуса кнопок нет');
    own.ctx.tab!(4);
    await own.ctx.loopFn!();
    assert.equal((own.kit as ReturnType<typeof fakeKit>).buttons.length, 2, '«Камеры»: «Показать крупно» у двух миниатюр');
    const hmi = launch({}, { own: false });
    hmi.ctx.tab!(4);
    await hmi.ctx.loopFn!();
    assert.equal((hmi.kit as ReturnType<typeof fakeKit>).buttons.length, 0);
    own.app.dispose();
    hmi.app.dispose();
  });

  it('shutdown от MainApp: цикл остановлен, подписки закрыты', async () => {
    const { ctx, tr } = launch({ dataSource: 'vehicle' });
    await flush();
    assert.ok(tr.subs.length > 0);
    ctx.shutdown!();
    await flush();
    assert.equal(ctx.loopStopped, true);
    for (const s of tr.subs) assert.equal(s.res.shutdownCalls, 1);
  });

  it('id картинок постоянные: многократная отрисовка не плодит новые id', async () => {
    const { ctx, kit, app } = launch();
    for (let i = 0; i < 30; i++) {
      ctx.tab!(i % PAGE_COUNT);
      await ctx.loopFn!();
    }
    const ids = new Set((kit as ReturnType<typeof fakeKit>).setImageCalls.map((c) => c.id));
    assert.ok(ids.size <= Object.keys(IMAGE_ID).length, `ids: ${[...ids].join(',')}`);
    app.dispose();
  });
});

describe('отрисовка: настоящий Recorder и программный путь upstream (MIT kit/runtime)', { skip: hasUpstream ? false : 'нет checkout idrive7-apps (MGU_UPSTREAM)' }, () => {
  it('все экраны записываются Recorder и проигрываются в canvas.js без ошибок', async () => {
    const up = loadUpstream();
    const kit: Kit = { mgu: { run: () => undefined }, G: up.G, record: { setImage: up.record.setImage } };
    for (const mode of ['demo', 'vehicle']) {
      const { ctx, app } = launch({ dataSource: mode }, { kit, canvas: () => new up.record.Recorder(1600, 520) });
      await flush();
      for (let p = 0; p < PAGE_COUNT; p++) {
        ctx.tab!(p);
        await ctx.loopFn!();
        const rec = ctx.shown[ctx.shown.length - 1].cv as unknown as { words(): Uint32Array; n: number };
        assert.ok(rec.n > 100, `${mode}/${p}: запись пуста`);
        const canvas = new up.canvas.Canvas(1600, 520) as { d: Uint8Array };
        up.record.play(rec.words(), canvas);
        let lit = 0;
        for (let i = 0; i < canvas.d.length; i += 4 * 97) if (canvas.d[i] + canvas.d[i + 1] + canvas.d[i + 2] > 60) lit++;
        assert.ok(lit > 50, `${mode}/${p}: кадр почти пуст (${lit})`);
      }
      app.dispose();
    }
  });

  it('own = true: нижняя строка — только статус, без кнопок (пауза/сессия/сценарий — в «Настройках»)', async () => {
    const up = loadUpstream();
    const kit: Kit = { mgu: { run: () => undefined }, G: up.G, record: { setImage: up.record.setImage } };
    for (const sc of SCENARIO_IDS) {
      const { ctx, app } = launch({ scenario: sc }, {
        kit,
        canvas: () => Object.assign(new up.record.Recorder(1600, 520), { own: true }) as Surface,
      });
      for (const page of [0, 1, 2, 3, 4]) {
        for (const paused of [false, true]) {
          app.setPage(page);
          app.model.setPaused(paused);
          await ctx.loopFn!();
          const rec = ctx.shown[ctx.shown.length - 1].cv as unknown as { targets: { y: number; key: string }[] };
          assert.deepEqual(rec.targets.filter((t) => t.key.startsWith('tb-') || t.y >= BAR_Y - 4).map((t) => t.key), [], `${sc}/${page}: в строке статуса нет кнопок`);
          // на странице остаются только «Показать крупно» у миниатюр камер
          assert.ok(rec.targets.every((t) => t.key.startsWith('cam-')), rec.targets.map((t) => t.key).join(','));
        }
      }
      app.dispose();
    }
  });
});
