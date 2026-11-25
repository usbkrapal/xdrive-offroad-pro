// Скрытый лист поддержки: 5 касаний уже открытой вкладки «Системы» или «Камеры» за 3 с. Только чтение, без демо,
// без новых кнопок; страница не меняется (камеры не запускаются и не останавливаются листом).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CAMERA_PAGE, startApp, SYSTEMS_PAGE } from '../src/app';
import { PRODUCTION } from '../src/devAccess';
import type { DiagLine } from '../src/render/diagnostics';
import { laneSlopeLines, SupportTaps, SUPPORT_WINDOW_MS } from '../src/render/support';
import { memberShape } from '../src/vehicle/adapter';
import { fakeCtx, fakeKit, FakeTransport, syntheticAssets } from './helpers';

type Launched = { ctx: ReturnType<typeof fakeCtx>; app: ReturnType<typeof startApp>; at: (ms: number) => number };
/** Запуск приложения на время теста: dispose() — всегда, даже когда проверка упала (иначе его таймеры держат Node). */
async function withApp(fn: (l: Launched) => void | Promise<void>): Promise<void> {
  let t = 0;
  const ctx = fakeCtx(new FakeTransport(), {}, { own: true });
  const app = startApp(ctx, fakeKit(), syntheticAssets(), () => t, PRODUCTION);
  try {
    await fn({ ctx, app, at: (ms: number) => (t = ms) });
  } finally {
    await app.dispose();
  }
}
const lines = (sh: object) => {
  const s = sh as { refresh(): void; lines: DiagLine[] };
  s.refresh();
  return s.lines;
};

describe('лист поддержки (скрытый, для фото с экрана)', () => {
  it('длинные имена квалификаторов LaneSlope видны полностью отдельными строками, личные поля скрыты', () => withApp(({ app }) => {
    const qualifier = 'qualifierActualValueLongitudinalGradientRoadway';
    const shape = memberShape({
      crcTiltRoadway: 1,
      aliveTiltRoadway: 1,
      actualValueLongitudinalGradientRoadway: 2129,
      actualValueTransverseGradientRoadway: 2642,
      [qualifier]: 2,
      latitude: 55.1,
      vin: 'WBA0000000',
    });
    assert.ok(shape.indexOf(qualifier) > 120, 'нужный член раньше скрывался за обрезкой строки');
    const d = app.model.diagnostics()!;
    const rows = laneSlopeLines({ ...d, memberShapes: { 'VehicleModel.LaneSlope': shape } });
    assert.ok(rows.some((row) => row.value === `${qualifier}:int`), 'полное имя и тип видны на листе');
    assert.doesNotMatch(JSON.stringify(rows), /latitude|55\.1|WBA0000000|vin/);
  }));

  it('счётчик: только та же открытая разрешённая вкладка, 5 касаний за 3 с; другая вкладка и пауза сбрасывают', () => {
    const k = new SupportTaps();
    for (let i = 0; i < 4; i++) assert.equal(k.tap(3, 3, true, i * 100), false);
    assert.equal(k.tap(3, 3, true, 400), true, 'пятое за 3 с');
    for (let i = 0; i < 4; i++) k.tap(3, 3, true, 1000 + i * 100);
    assert.equal(k.tap(3, 3, true, 1000 + SUPPORT_WINDOW_MS + 500), false, 'первые касания вышли из окна');
    for (let i = 0; i < 4; i++) k.tap(3, 3, true, 10000 + i);
    k.tap(2, 3, true, 10005); // другая вкладка
    assert.equal(k.tap(3, 3, true, 10006), false, 'счёт начался заново');
    for (let i = 0; i < 6; i++) assert.equal(k.tap(0, 0, false, 20000 + i), false, 'не на «Системах»/«Камерах» — никогда');
  });

  it('«Системы»: 5 касаний открытой вкладки → лист; сначала сверка углов с xView и LaneSlope, затем UDS; страница и режим не меняются', () => withApp(({ ctx, app, at }) => {
    ctx.tab!(SYSTEMS_PAGE);
    for (let i = 0; i < 4; i++) {
      at(1000 + i * 200);
      ctx.tab!(SYSTEMS_PAGE);
    }
    assert.equal(ctx.sheets.length, 0, 'четыре касания — ничего (первое касание открыло вкладку)');
    at(1900);
    ctx.tab!(SYSTEMS_PAGE);
    assert.equal(ctx.sheets.length, 1);
    assert.equal(app.page(), SYSTEMS_PAGE);
    assert.equal(app.model.dataMode, 'vehicle', 'демо не включается');
    const l = lines(ctx.sheets[0]);
    assert.match(l[0].label, /^Поддержка · Terrain Monitor /);
    assert.equal(l[0].value, 'вкладка «Системы»');
    // 0.1.8: на «Системах» первым — материал для сверки углов (фото листа и xView в одну секунду), затем UDS
    const head = (re: RegExp) => l.findIndex((x) => x.tone === 'head' && re.test(x.label));
    const angles = head(/^Углы: сверка с xView/), lane = head(/^LaneSlope/), uds = head(/^Диагностика \(чтение UDS \/ OBD\)$/);
    assert.equal(angles, 1, 'сверка углов — сразу после заголовка');
    assert.ok(lane > angles && uds > lane, `порядок: углы ${angles}, LaneSlope ${lane}, UDS ${uds}`);
    assert.ok(l.some((x) => /^кандидат наклона стоя/.test(x.label)), 'кандидат наклона виден (с пометкой)');
    assert.ok(l.some((x) => /^Рендерер: события/.test(x.label)), 'события рендерера — для разбора исчезновения');
  }));

  it('обычное листание вкладок лист не открывает; «Рельеф» — никогда', () => withApp(({ ctx, at }) => {
    for (let i = 0; i < 20; i++) {
      at(i * 100);
      ctx.tab!(i % 5);
    }
    ctx.tab!(0);
    for (let i = 0; i < 8; i++) {
      at(5000 + i * 100);
      ctx.tab!(0);
    }
    assert.equal(ctx.sheets.length, 0);
  }));

  it('«Камеры»: лист открывается поверх страницы, страница «Камеры» остаётся (запрос/кадры не трогаются); первая строка — камеры', () => withApp(({ ctx, app, at }) => {
    ctx.tab!(CAMERA_PAGE);
    for (let i = 0; i < 5; i++) {
      at(2000 + i * 100);
      ctx.tab!(CAMERA_PAGE);
    }
    assert.equal(ctx.sheets.length, 1);
    assert.equal(app.page(), CAMERA_PAGE, 'страница не сменилась');
    const l = lines(ctx.sheets[0]);
    assert.equal(l[0].value, 'вкладка «Камеры»');
    assert.equal(l[1].label, 'Камеры');
    assert.ok(!l[2].value.includes('не нужен'), `мост — как его держит страница «Камеры»: ${l[2].value}`);
  }));
});
