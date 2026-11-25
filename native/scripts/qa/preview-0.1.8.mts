// Снимки native-отрисовки 0.1.8 (вендорный record.js → canvas.js, кириллический атлас сборки ru) для просмотра:
// пять вкладок × состояния данных × поверхности, демо, развёрнутая камера, лист диагностики. Не сервер: пишет PNG и выходит.
//   node --import tsx --import ./scripts/test-assets.mjs native/scripts/qa/preview-0.1.8.mts <каталог> [assets.js]
// Графика — производственный assets.js итоговой сборки (native/dist/xdrive_offroad_pro/assets.js), не синтетика тестов.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeRig, layoutViolations, type Variant } from '../../test/layoutProbe';
import { PRODUCTION } from '../../src/devAccess';
import { diagnosticsSheet } from '../../src/render/diagnostics';
import { FIT_MIN_PX } from '../../src/render/ui';
import { THEME } from '../../test/helpers';
import type { AssetsModule } from '../../src/assets/spec';

const out = process.argv[2] ?? 'qa-0.1.8/screens';
const assetsFile = process.argv[3] ?? 'native/dist/xdrive_offroad_pro/assets.js';
mkdirSync(out, { recursive: true });
const assetsSrc = readFileSync(assetsFile, 'utf8');
const mod = { exports: {} as AssetsModule };
new Function('module', 'exports', assetsSrc)(mod, mod.exports);
const assets = mod.exports;
const assetsSha = createHash('sha256').update(assetsSrc).digest('hex');
const PAGES = ['terrain', 'traction', 'suspension', 'systems', 'cameras'];
const SURF = [{ id: '1600x520', ts: 1, extra: 0, own: false }, { id: '1920x720', ts: 1.164, extra: 49, own: true }];
const report: string[] = [];
const rig = probeRig(PRODUCTION, assets);
for (const sf of SURF) for (const v of ['valid', 'unavailable', 'stale', 'invalid'] as Variant[]) for (let p = 0; p < 5; p++) {
  const fp = await rig.frame(p, v, sf.ts, sf.extra, sf.own);
  const name = `vehicle-${sf.id}-${PAGES[p]}-${v}.png`;
  writeFileSync(join(out, name), rig.png(fp));
  const bad = layoutViolations(fp, FIT_MIN_PX);
  const minPx = Math.min(...fp.texts.map((t) => t.px));
  report.push(`${name}: текстов ${fp.texts.length}, мин. ${minPx.toFixed(1)} px, нарушений ${bad.length}${bad.length ? ': ' + bad.join('; ') : ''}`);
}
const sheet = diagnosticsSheet(() => rig.app.model.diagnostics(), () => [
  { label: 'Поддержка · Terrain Monitor 0.1.8', value: 'вкладка «Системы»', tone: 'head' },
  { label: 'Рендерер: последнее X_STATE', value: 'на экране 0 · в фронте 1 · 12,3 с назад', tone: 'warn' },
]);
for (const sf of SURF) {
  const r = new rig.Recorder(1600, 520, { textScale: sf.ts });
  r.extra = sf.extra;
  sheet.draw(r, THEME);
  const cv = new rig.Canvas(1600, 520 + sf.extra);
  rig.record.play(new Uint32Array(r.words()), cv);
  writeFileSync(join(out, `diagnostics-${sf.id}.png`), cv.png());
}
await rig.close();
const demo = probeRig({ ...PRODUCTION, demo: true, scenario: 'climb' }, assets);
for (const sf of SURF) for (let p = 0; p < 5; p++) {
  const fp = await demo.frame(p, null, sf.ts, sf.extra, sf.own);
  writeFileSync(join(out, `demo-${sf.id}-${PAGES[p]}.png`), demo.png(fp));
}
await demo.close();
writeFileSync(join(out, 'layout-report.txt'), `assets.js ${assetsFile} sha256 ${assetsSha}\n` + report.join('\n') + '\n');
console.log(report.filter((l) => !/нарушений 0$/.test(l)).join('\n') || `ok: ${report.length} кадров без нарушений`);
