import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { SCENARIO_IDS, type ScenarioId } from '../../src/domain/types';
import { migrateSettings, SETTING_VALUES, startApp, type AppHandle } from '../src/app';
import { IMAGE_ID } from '../src/assets/spec';
import { devAccess, PRODUCTION, type DevAccess } from '../src/devAccess';
import type { Kit } from '../src/platform/kit';
import type { Surface } from '../src/platform/kitTypes';
import { DIAG } from '../src/render/diagnostics';
import { H, Y1 } from '../src/render/layout';
import { PAGE_COUNT } from '../src/render/pages';
import { T, TAB_LABELS } from '../src/strings';
import { fakeCtx, fakeKit, FakeTransport, flush, hasUpstream, loadUpstream, strictSurface, syntheticAssets, type FakeCtx } from './helpers';

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const NUM_CHARS = /^[0-9 ,.+\-/:%]*$/;
const CAMERA_IDS = [IMAGE_ID.cameraFront, IMAGE_ID.cameraLeft, IMAGE_ID.cameraRight, IMAGE_ID.thumbFront, IMAGE_ID.thumbLeft, IMAGE_ID.thumbRight];
const demo = (scenario: ScenarioId | null = null, diagnostics = false): DevAccess => ({ demo: true, scenario, diagnostics });

const ASSETS_MOD = syntheticAssets();

const apps: AppHandle[] = [];
after(() => apps.forEach((a) => a.dispose()));

function launch(init: Record<string, unknown> = {}, opts: { own?: boolean; kit?: Kit; canvas?: () => Surface; dev?: DevAccess } = {}) {
  const tr = new FakeTransport();
  const ctx = fakeCtx(tr, init, opts);
  if (opts.canvas) ctx.canvas = opts.canvas;
  const kit = opts.kit ?? fakeKit();
  let t = 0;
  const app = startApp(ctx, kit, ASSETS_MOD, () => (t += 50), opts.dev ?? PRODUCTION);
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
    assert.ok(tc.size >= 16, `${where}: слишком мелкий текст ${tc.size}px «${tc.s}»`);
  }
}

describe('режим по умолчанию и доступ разработчика', () => {
  it('обычный запуск — данные автомобиля; сохранённое «Демо» прежней версии переносится и демо не включает', async () => {
    const { ctx, app, tr } = launch({ dataSource: 'demo', layout: 'standard', renderer: 'software' });
    assert.equal(app.model.dataMode, 'vehicle');
    assert.deepEqual({ dataSource: ctx.values.dataSource, layout: ctx.values.layout, renderer: ctx.values.renderer }, SETTING_VALUES, 'перенос сохранён');
    await flush();
    assert.ok(tr.subs.length > 0, 'подписки автомобиля установлены');
    // настройка из прежнего интерфейса больше не переключает источник
    ctx.settings.set('dataSource', 'demo');
    assert.equal(app.model.dataMode, 'vehicle');
    app.dispose();
  });

  it('migrateSettings пишет только отличающееся', () => {
    const tr = new FakeTransport();
    const ctx = fakeCtx(tr, { ...SETTING_VALUES });
    const writes: string[] = [];
    ctx.settings.onChange((k) => writes.push(k));
    assert.deepEqual(migrateSettings(ctx.settings), []);
    assert.deepEqual(writes, []);
  });

  it('XOP_DEV: только явные токены; пусто/прочее — обычный запуск', () => {
    assert.deepEqual(devAccess({}), PRODUCTION);
    assert.deepEqual(devAccess({ XOP_DEV: '' }), PRODUCTION);
    assert.deepEqual(devAccess({ XOP_DEV: 'yes' }), PRODUCTION);
    assert.deepEqual(devAccess({ XOP_DEV: 'diag' }), { demo: false, scenario: null, diagnostics: true });
    assert.deepEqual(devAccess({ XOP_DEV: '1' }), { demo: false, scenario: null, diagnostics: true });
    assert.deepEqual(devAccess({ XOP_DEV: 'demo=hdcdescent, diag' }), { demo: true, scenario: 'hdcDescent', diagnostics: true });
    assert.deepEqual(devAccess({ XOP_DEV: 'demo=nope' }), { demo: true, scenario: null, diagnostics: false });
  });

  it('демо разработчика: подписок на автомобиль нет, бейдж ДЕМО; сохранённая настройка остаётся «автомобиль»', async () => {
    const { ctx, kit, app, tr } = launch({}, { dev: demo('climb') });
    await flush();
    assert.equal(app.model.dataMode, 'demo');
    assert.equal(app.model.getState().scenarioId, 'climb');
    assert.equal(tr.subs.length, 0, 'демо и автомобиль не смешиваются');
    assert.equal(ctx.values.dataSource, 'vehicle', 'демо не сохраняется');
    await ctx.loopFn!();
    const fr = (kit as ReturnType<typeof fakeKit>).frames.slice(-1)[0] as { badges: { text: string }[] };
    assert.deepEqual(fr.badges.map((b) => b.text), [T.native.badge.demo]);
    app.dispose();
  });
});

describe('отрисовка: строгая поверхность (только методы Recorder)', () => {
  it('касание вкладки сразу рисует открытую страницу без ожидания следующего тика', () => {
    const { ctx, app } = launch();
    const before = ctx.shown.length;
    ctx.tab!(3);
    assert.equal(app.page(), 3);
    assert.ok(ctx.shown.length > before);
    const cv = ctx.shown[ctx.shown.length - 1].cv as ReturnType<typeof strictSurface>;
    assert.ok(cv.texts.some((x) => x.s === T.systems.powertrain.toUpperCase()));
    app.dispose();
  });

  it('демо разработчика: 5 экранов × 5 сценариев рисуются, вкладки и бейдж ДЕМО', async () => {
    for (const sc of SCENARIO_IDS) {
      const { ctx, kit, app } = launch({}, { dev: demo(sc) });
      const k = kit as ReturnType<typeof fakeKit>;
      const cvs = await drawAll(ctx, app);
      cvs.forEach((cv, p) => {
        assert.ok(cv.counts.fillRect > 5, `${sc}/${p}: страница пуста`);
        checkTexts(cv, `${sc}/${p}`);
      });
      const fr = k.frames[k.frames.length - 1] as { tabs: string[]; badges: { text: string }[] };
      assert.deepEqual(fr.tabs, [...TAB_LABELS]);
      assert.equal(fr.badges[0].text, 'ДЕМО');
      // Камеры: левая — передняя (крупно) — правая; в partialLoss левая — смоделированная потеря (кадр не рисуется).
      const cam = cvs[4];
      assert.ok(cam.images.includes(IMAGE_ID.cameraFront), `${sc}: передняя крупно`);
      assert.ok(cam.images.includes(IMAGE_ID.thumbRight));
      if (sc === 'partialLoss') assert.ok(!cam.images.includes(IMAGE_ID.thumbLeft) && !cam.images.includes(IMAGE_ID.cameraLeft));
      else assert.ok(cam.images.includes(IMAGE_ID.thumbLeft));
      assert.equal(cam.texts.filter((x) => x.s === T.native.cameras.demo).length, 3, 'каждый демо-кадр помечен');
      // Рельеф: рендер привода и оба прибора.
      for (const id of [IMAGE_ID.xray, IMAGE_ID.dialPitch, IMAGE_ID.dialRoll]) assert.ok(cvs[0].images.includes(id), `${sc}: image ${id}`);
      app.dispose();
    }
  });

  it('данные автомобиля: бейджа режима нет ни до, ни после данных; демо-снимков камер нет', async () => {
    const { ctx, kit, app, tr } = launch();
    const k = kit as ReturnType<typeof fakeKit>;
    await flush();
    const cvs = await drawAll(ctx, app);
    cvs.forEach((cv, p) => {
      checkTexts(cv, `vehicle/${p}`);
      for (const id of CAMERA_IDS) assert.ok(!cv.images.includes(id), `vehicle/${p}: демо-кадр камеры ${id}`);
    });
    assert.ok(!k.setImageCalls.some((c) => CAMERA_IDS.includes(c.id as never)), 'кадры камер даже не распакованы');
    assert.deepEqual((k.frames[k.frames.length - 1] as { badges: unknown[] }).badges, []);
    tr.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 3000 });
    await new Promise((r) => setTimeout(r, 150));
    await ctx.loopFn!();
    assert.deepEqual((k.frames[k.frames.length - 1] as { badges: unknown[] }).badges, []);
    app.dispose();
  });

  it('нижней строки статуса нет: ни текста режима, ни второго таймера сессии; содержимое доходит до низа холста', async () => {
    for (const dev of [PRODUCTION, demo()]) {
      const { ctx, app } = launch({}, { dev, own: true });
      await flush();
      const cvs = await drawAll(ctx, app);
      const old = ['АВТОМОБИЛЬ · ТОЛЬКО ЧТЕНИЕ', 'СЦЕНАРИЙ ДЕМО', 'Время сессии', 'Время симуляции'];
      cvs.forEach((cv, p) => {
        for (const s of old) assert.ok(!cv.texts.some((x) => x.s.toUpperCase().includes(s.toUpperCase())), `${p}: «${s}»`);
      });
      assert.ok(Y1 >= H - 8, `Y1 ${Y1}`);
      app.dispose();
    }
  });

  it('кнопок панели HMI нет: приложение не подписывается ни на одну (листание — вкладками kit)', async () => {
    const { ctx, app } = launch();
    assert.deepEqual(Object.keys(ctx.clicks), []);
    ctx.tab!(PAGE_COUNT - 1);
    assert.equal(app.page(), PAGE_COUNT - 1);
    app.dispose();
  });

  it('own = false: целей нажатия на страницах нет, G.button не вызывается', async () => {
    const { ctx, kit } = launch({}, { own: false, dev: demo(null, true) });
    for (let p = 0; p < PAGE_COUNT; p++) {
      ctx.tab!(p);
      await ctx.loopFn!();
      const cv = ctx.shown[ctx.shown.length - 1].cv as ReturnType<typeof strictSurface>;
      assert.equal(cv.counts.target ?? 0, 0, `страница ${p}: целей нажатия нет`);
    }
    assert.equal((kit as ReturnType<typeof fakeKit>).buttons.length, 0);
  });

  it('own = true, обычный запуск: на страницах нет кнопок (нижней полосы «Рельефа» с «Сбросом» больше нет); диагностики нет', async () => {
    const { ctx, app, kit } = launch({}, { own: true });
    const k = kit as ReturnType<typeof fakeKit>;
    await drawAll(ctx, app);
    assert.deepEqual(Object.keys(k.presses).sort(), []);
    assert.equal(app.openDiagnostics(), false);
    assert.equal(ctx.sheets.length, 0);
  });

  it('XOP_DEV=diag: кнопка «Диагностика» на «Системах» открывает лист снимка (и рендерера/управления)', async () => {
    const { ctx, app, kit } = launch({}, { own: true, dev: { ...PRODUCTION, diagnostics: true } });
    const k = kit as ReturnType<typeof fakeKit>;
    await flush();
    ctx.tab!(3);
    await ctx.loopFn!();
    assert.ok(k.buttons.includes(DIAG.open));
    k.presses['dev-diagnostics']();
    assert.equal(ctx.sheets.length, 1);
    const sh = ctx.sheets[0] as { title: string; lines: { label: string }[] };
    assert.equal(sh.title, DIAG.title);
    assert.ok(sh.lines.some((l) => l.label === 'Контроллер iDrive'));
    assert.ok(sh.lines.some((l) => l.label === DIAG.services));
    app.dispose();
  });

  it('shutdown от MainApp: цикл остановлен, подписки закрыты', async () => {
    const { ctx, tr } = launch();
    await flush();
    assert.ok(tr.subs.length > 0);
    ctx.shutdown!();
    await flush();
    assert.equal(ctx.loopStopped, true);
    for (const s of tr.subs) assert.equal(s.res.shutdownCalls, 1);
  });

  it('id картинок постоянные: многократная отрисовка не плодит новые id', async () => {
    const { ctx, kit, app } = launch({}, { dev: demo() });
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
      const { ctx, app } = launch({}, { kit, canvas: () => new up.record.Recorder(1600, 520), dev: mode === 'demo' ? demo() : PRODUCTION });
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

  it('own = true: на страницах нет целей, кроме «Сброс» сессии (демо и автомобиль)', async () => {
    const up = loadUpstream();
    const kit: Kit = { mgu: { run: () => undefined }, G: up.G, record: { setImage: up.record.setImage } };
    for (const sc of SCENARIO_IDS) {
      const { ctx, app } = launch({}, {
        kit,
        canvas: () => Object.assign(new up.record.Recorder(1600, 520), { own: true }) as Surface,
        dev: demo(sc),
      });
      for (const page of [0, 1, 2, 3, 4]) {
        for (const paused of [false, true]) {
          app.setPage(page);
          app.model.setPaused(paused);
          await ctx.loopFn!();
          const rec = ctx.shown[ctx.shown.length - 1].cv as unknown as { targets: { y: number; key: string }[] };
          assert.deepEqual(rec.targets.map((t) => t.key), [], `${sc}/${page}`);
        }
      }
      app.dispose();
    }
  });
});

describe('страницы без руля, без нижней полосы «Рельефа» и без служебных подписей', () => {
  it('ни на одной странице нет угла руля, «Сессии» внизу «Рельефа», «Шкалы уровней», пояснения высоты угла', async () => {
    const { ctx, app } = launch({}, {});
    const texts: string[] = [];
    for (let page = 0; page < PAGE_COUNT; page++) {
      ctx.tab!(page);
      await ctx.loopFn!();
      const cv = ctx.shown[ctx.shown.length - 1].cv as ReturnType<typeof strictSurface>;
      for (const x of cv.texts) texts.push(x.s);
    }
    app.dispose();
    assert.ok(texts.length > 50, `тексты страниц собраны (${texts.length})`);
    assert.ok(texts.indexOf(T.terrain.altitude) >= 0 && texts.indexOf(T.terrain.speed) >= 0, 'проверка не пустая');
    for (const gone of [T.terrain.steering, T.terrain.steeringHint, T.terrain.sessionTitle, T.suspension.levelScale, T.suspension.unitNote, T.systems.dynamics, T.systems.longG, T.systems.latG, T.systems.yaw])
      assert.ok(texts.indexOf(gone) < 0, `«${gone}» не рисуется`);
  });
});
