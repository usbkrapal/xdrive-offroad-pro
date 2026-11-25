// Вёрстка 0.1.8 на настоящем Recorder kit с кириллическим атласом: все пять вкладок (данные автомобиля и демо),
// каждое состояние качества («Нет данных», «Устарело», «Ошибка данных») и крайние значения; масштаб текста 1 (HMI 1600 × 520,
// программный путь и стандартная раскладка) и 1,164 (полноэкранная 1920 × 720); без места под страницей и с ним (49 px kit).
// Никакой текст не шире своей ячейки, не выходит за панель и видимую область, не накладывается на другой текст.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PRODUCTION } from '../src/devAccess';
import { diagnosticsSheet } from '../src/render/diagnostics';
import { FIT_MIN_PX, panel, setLayoutProbe, text, type LayoutProbe } from '../src/render/ui';
import { glyphBox, layoutViolations, probeRig, type ProbeRig, type Variant } from './layoutProbe';
import { THEME } from './helpers';

const PAGES = ['Рельеф', 'Сцепление', 'Подвеска', 'Системы', 'Камеры'];
const VARIANTS: Variant[] = ['valid', 'unavailable', 'stale', 'invalid'];
const SURFACES = [
  { name: 'HMI 1600×520 (программный путь / стандартная)', textScale: 1, extra: 0, own: false },
  { name: '1920×720 полноэкранная', textScale: 1.164, extra: 49, own: true },
  { name: '1920×720 без места под страницей', textScale: 1.164, extra: 0, own: true },
];

describe('вёрстка: данные автомобиля, все вкладки × состояния × поверхности', () => {
  let rig: ProbeRig;
  before(() => (rig = probeRig(PRODUCTION)));
  after(() => rig.close());
  for (const sf of SURFACES) {
    it(sf.name, async () => {
      const all: string[] = [];
      for (let p = 0; p < 5; p++) {
        for (const v of VARIANTS) {
          const fp = await rig.frame(p, v, sf.textScale, sf.extra, sf.own);
          assert.ok(fp.texts.length > 3, `${PAGES[p]}/${v}: текст нарисован`);
          for (const e of layoutViolations(fp, FIT_MIN_PX)) all.push(`${PAGES[p]}/${v}: ${e}`);
        }
      }
      assert.deepEqual(all, []);
    });
  }
});

describe('вёрстка: демо разработчика (все сценарии)', () => {
  let rig: ProbeRig;
  before(() => (rig = probeRig({ ...PRODUCTION, demo: true, scenario: 'partialLoss' })));
  after(() => rig.close());
  it('пять вкладок, 1600×520 и 1920×720', async () => {
    const all: string[] = [];
    for (const sf of SURFACES) for (let p = 0; p < 5; p++) {
      const fp = await rig.frame(p, null, sf.textScale, sf.extra, sf.own);
      for (const e of layoutViolations(fp, FIT_MIN_PX)) all.push(`${PAGES[p]}/${sf.name}: ${e}`);
    }
    assert.deepEqual(all, []);
  });
});

describe('вёрстка: лист диагностики', () => {
  it('длинные русские строки переносятся внутри листа, кнопки и заголовок не накладываются', async () => {
    const rig = probeRig(PRODUCTION);
    try {
      const long = 'Очень длинное русское название показателя диагностики с несколькими словами и уточнением в скобках (кандидат)';
      const sheet = diagnosticsSheet(() => rig.app.model.diagnostics(), () => [
        { label: 'Поддержка · Terrain Monitor 0.1.8', value: 'вкладка «Системы»', tone: 'head' },
        { label: long, value: `${long} · -12 345,6 · Ошибка данных · Устарело · Нет данных`, tone: 'warn' },
        { label: 'Рендерер: последнее X_STATE', value: 'на экране 0 · в фронте 1 · 12,3 с назад', tone: 'dim' },
      ]);
      for (const sf of SURFACES) {
        const r = new rig.Recorder(1600, 520, { textScale: sf.textScale });
        r.extra = sf.extra;
        const probe: LayoutProbe = { panels: [], texts: [] };
        setLayoutProbe(probe);
        try { sheet.draw(r, THEME); } finally { setLayoutProbe(null); }
        const words = new Uint32Array(r.words());
        const texts = probe.texts.filter((t) => t.cv === r).map((t) => ({ ...t, box: glyphBox(words, t.n0, t.n1) }));
        const v = layoutViolations({ page: -1, words, panels: [], texts, extra: sf.extra, recorder: r }, FIT_MIN_PX);
        assert.deepEqual(v, [], sf.name);
      }
    } finally { await rig.close(); }
  });
});

describe('проверка вёрстки сама ловит нарушения', () => {
  it('текст шире панели, наложение и выход за видимую область — нарушения', async () => {
    const rig = probeRig(PRODUCTION);
    try {
      const r = new rig.Recorder(1600, 520, { textScale: 1 });
      const probe: LayoutProbe = { panels: [], texts: [] };
      setLayoutProbe(probe);
      try {
        panel(r, 100, 100, 200, 100);
        text(r, 'Пик момента двигателя очень длинный', 116, 150, 20, '#ffffff');
        text(r, 'Наложение', 116, 152, 14, '#ffffff');
        text(r, 'Справа за краем', 1560, 300, 14, '#ffffff');
      } finally { setLayoutProbe(null); }
      const words = new Uint32Array(r.words());
      const texts = probe.texts.filter((t) => t.cv === r).map((t) => ({ ...t, box: glyphBox(words, t.n0, t.n1) }));
      const v = layoutViolations({ page: -1, words, panels: probe.panels, texts, extra: 0, recorder: r }, FIT_MIN_PX);
      assert.ok(v.some((e) => /выходит за панель/.test(e)), v.join('\n'));
      assert.ok(v.some((e) => /накладываются/.test(e)), v.join('\n'));
      assert.ok(v.some((e) => /вне видимой области/.test(e)), v.join('\n'));
      // с ячейкой тот же текст помещается: уменьшается, затем сокращается многоточием, но не выходит
      const r2 = new rig.Recorder(1600, 520, { textScale: 1 });
      const p2: LayoutProbe = { panels: [], texts: [] };
      setLayoutProbe(p2);
      try { panel(r2, 100, 100, 200, 100); text(r2, 'Пик момента двигателя очень длинный', 116, 150, 20, '#ffffff', { maxW: 168 }); } finally { setLayoutProbe(null); }
      const w2 = new Uint32Array(r2.words());
      const t2 = p2.texts.filter((t) => t.cv === r2).map((t) => ({ ...t, box: glyphBox(w2, t.n0, t.n1) }));
      assert.deepEqual(layoutViolations({ page: -1, words: w2, panels: p2.panels, texts: t2, extra: 0, recorder: r2 }, FIT_MIN_PX), []);
      assert.match(t2[0].s, /…$/);
    } finally { await rig.close(); }
  });
});
