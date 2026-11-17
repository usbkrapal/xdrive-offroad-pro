import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SCENARIO_IDS } from '../../src/domain/types';
import { CAMERA_IDS } from '../../src/screens/cameraPresentation';
import { APP_ID, APP_TITLE, buildManifest, LOGGING_ID, REQUIRES } from '../src/manifest';
import { nativeRu } from '../src/strings';
import { VehicleAdapter } from '../src/vehicle/adapter';
import { VEHICLE_FIELDS, VEHICLE_INTERFACES } from '../src/vehicle/allowlist';
import { APP_FILES, copyLicense, LICENSE_FILE, LICENSE_SRC, NOTICE_PREAMBLE } from '../scripts/build';
import { MARKER, stage } from '../scripts/stage';
import { FakeTransport, flush, hasUpstream, loadUpstream, loadUpstreamDisplay, ROOT } from './helpers';

/** Официальный component.json mgu-render 0.6.21, скачанный root (work/research). */
const RENDER_COMPONENT = join(ROOT, '..', '..', 'work', 'research', 'mgu-render-0.6.21', 'component.json');

type Spec = {
  id: string;
  title: string;
  loggingId: string;
  mguHmi: string[];
  requires: Record<string, string>;
  autostart?: unknown;
  signals: Record<string, Record<string, unknown>>;
  screens: { name: string; kind: string; buttons: [string, string][] }[];
  settings: { key: string; default: unknown; options: [string, string][] }[];
};

describe('app.json', () => {
  const m = buildManifest() as unknown as Spec;

  it('идентичность: id, заголовок, тег журнала, только ID7, рантайм-зависимость, без автозапуска', () => {
    assert.equal(m.id, APP_ID);
    assert.equal(m.id, 'xdrive_offroad_pro');
    assert.equal(m.title, APP_TITLE);
    assert.equal(m.title, 'xDrive Offroad Pro');
    assert.equal(m.loggingId, LOGGING_ID);
    assert.match(m.loggingId, /^[A-Z0-9]{4}$/);
    assert.deepEqual(m.mguHmi, ['ID7']);
    assert.deepEqual(m.requires, { 'mgu-render': '0.6.21' });
    assert.deepEqual(m.requires, { ...REQUIRES });
    assert.doesNotMatch(JSON.stringify(m), /idrive7-renderd|2\.1\.15/, 'старый рендерер нигде не упомянут');
    assert.equal(m.autostart, undefined);
  });

  it('зависимость совпадает с официальным component.json mgu-render 0.6.21', { skip: existsSync(RENDER_COMPONENT) ? false : `нет ${RENDER_COMPONENT}` }, () => {
    const c = JSON.parse(readFileSync(RENDER_COMPONENT, 'utf8')) as { id: string; version: string; mguProvides?: string };
    assert.equal(c.id, 'mgu-render');
    assert.equal(c.version, '0.6.21');
    assert.equal(c.mguProvides, 'renderer');
    assert.deepEqual(m.requires, { [c.id]: c.version });
  });

  it('signals: только чтение/подписка, без w, _methods, _broadcasts, _instances', () => {
    for (const [iface, fields] of Object.entries(m.signals)) {
      assert.equal(typeof fields._optional, 'string', `${iface}: _optional`);
      for (const [k, v] of Object.entries(fields)) {
        assert.ok(!['_methods', '_broadcasts', '_instances'].includes(k), `${iface}.${k}`);
        if (k.startsWith('_')) continue;
        assert.match(String(v), /^r?s$/, `${iface}.${k}: ${String(v)}`);
        assert.ok(!String(v).includes('w'), `${iface}.${k} не пишется`);
      }
    }
    assert.ok(!Object.keys(m.signals).some((i) => /tasu|diag|uds/i.test(i)), 'нет диагностических транспортов');
  });

  it('signals совпадает с allowlist и с тем, на что адаптер реально подписывается', async () => {
    const fromList: Record<string, string[]> = {};
    for (const f of VEHICLE_FIELDS) (fromList[f.iface] ??= []).push(f.field);
    const fromManifest: Record<string, string[]> = {};
    for (const [iface, fields] of Object.entries(m.signals)) fromManifest[iface] = Object.keys(fields).filter((k) => !k.startsWith('_'));
    assert.deepEqual(sorted(fromManifest), sorted(fromList));
    assert.deepEqual(Object.keys(m.signals).sort(), VEHICLE_INTERFACES.map((i) => i.iface).sort());

    const tr = new FakeTransport();
    const a = new VehicleAdapter(tr.watch, () => 0);
    a.start();
    await flush();
    const subscribed: Record<string, string[]> = {};
    for (const c of tr.calls) subscribed[c.iface] = c.fields;
    assert.deepEqual(sorted(subscribed), sorted(fromManifest));
    await a.stop();
  });

  it('экран и кнопки: один canvas-экран MAIN, пять кнопок HMI (с отдельной «Сброс» — новая сессия)', () => {
    assert.equal(m.screens.length, 1);
    assert.equal(m.screens[0].kind, 'canvas');
    assert.equal(m.screens[0].name, 'MAIN');
    assert.equal(m.screens[0].buttons.length, 5);
    assert.deepEqual(m.screens[0].buttons.map((b) => b[0]), ['BTN_PAGE', 'BTN_PREV', 'BTN_ACTION', 'BTN_SESSION', 'BTN_SETTINGS']);
    assert.ok(!('chrome' in m.screens[0]), 'kit-рамка (вкладки, панель) остаётся');
  });

  // Панель HMI iDrive 7 (display.js HMI7.btn): кнопки от x 132, каждая — ширина подписи (шрифт 'label' 40 px × 1.465)
  // + 180 px; шире 1920 — HMI прокручивает панель. Все подписи, включая сменные (Пауза/Пуск), — без прокрутки.
  const barSets = (): string[][] => {
    const b = nativeRu.bar;
    return [b.pause, b.resume].map((action) => [b.next, b.prev, action, b.session, b.settings]);
  };

  it('подписи панели помещаются без прокрутки (консервативная оценка 30 px HMI на символ)', () => {
    // Замеры kit: «Next page» 412, «Previous page» 507, «Settings» 370 px → ≤ 26 px на символ; 30 — с запасом на кириллицу.
    for (const labels of barSets()) {
      const total = 132 + labels.reduce((s, l) => s + l.length * 30 + 180, 0);
      assert.ok(total <= 1920, `${labels.join(' | ')}: ${total} px > 1920`);
    }
    assert.deepEqual(m.screens[0].buttons.map((b) => b[1]), [nativeRu.bar.next, nativeRu.bar.prev, nativeRu.bar.pause, nativeRu.bar.session, nativeRu.bar.settings]);
  });

  it('подписи панели помещаются по модели kit (display.js HMI7, Recorder.textWidth), если есть кириллический атлас', { skip: hasUpstream ? false : 'нет checkout idrive7-apps' }, (t) => {
    const { display, fonts } = loadUpstreamDisplay();
    if (!fonts.has('cyrillic')) {
      t.skip('в checkout нет kit/runtime/fonts/cyrillic.json — ширина кириллицы не измерима (см. консервативную оценку)');
      return;
    }
    const meter = new (loadUpstream().record.Recorder)(1, 1);
    const B = display.HMI7.btn;
    for (const labels of barSets()) {
      const total = labels.reduce((x, l) => x + Math.round(meter.textWidth(l, B.size, { font: 'label' }) * B.k) + B.pad, B.x);
      assert.ok(total <= display.HMI7.screen.w, `${labels.join(' | ')}: ${total} px > ${display.HMI7.screen.w}`);
    }
  });

  it('настройка primaryCamera: передняя/левая/правая, по умолчанию передняя', () => {
    const cam = m.settings.find((s) => s.key === 'primaryCamera')!;
    assert.ok(cam, 'есть настройка основной камеры');
    assert.equal(cam.default, 'front');
    assert.deepEqual(cam.options.map((o) => o[0]), [...CAMERA_IDS]);
    assert.deepEqual(CAMERA_IDS, ['front', 'left', 'right']);
    for (const o of cam.options) assert.ok(o[1].length > 0);
  });

  it('настройки: источник данных по умолчанию — демо; пять сценариев', () => {
    const src = m.settings.find((s) => s.key === 'dataSource')!;
    assert.equal(src.default, 'demo');
    assert.deepEqual(src.options.map((o) => o[0]), ['demo', 'vehicle']);
    const sc = m.settings.find((s) => s.key === 'scenario')!;
    assert.deepEqual(sc.options.map((o) => o[0]), [...SCENARIO_IDS]);
    assert.ok(!m.settings.some((s) => s.key === 'demo'), 'нет настройки авто-демо upstream');
  });
});

describe('каталог приложения: файлы и MIT-уведомление', () => {
  it('APP_FILES: свои файлы + NOTICE; ни GPL-рендерера, ни шрифтов', () => {
    assert.equal(LICENSE_FILE, 'NOTICE', 'build.py копирует только точные LICENSE/NOTICE');
    assert.deepEqual([...APP_FILES], ['app.json', 'main.js', 'assets.js', 'NOTICE']);
    for (const f of APP_FILES) assert.doesNotMatch(f, /renderd|mgu-render|gpl|\.(ttf|otf|woff2?)$|font/i, f);
  });

  it('copyLicense: NOTICE = преамбула + licenses/IDRIVE7_APPS_MIT.txt дословно, без исходника — ошибка', () => {
    const src = readFileSync(LICENSE_SRC, 'utf8');
    assert.match(src, /MIT License|Permission is hereby granted/);
    const dir = mkdtempSync(join(tmpdir(), 'xop-lic-'));
    try {
      writeFileSync(join(dir, 'keep.txt'), 'x');
      const dst = copyLicense(dir);
      assert.equal(dst, join(dir, LICENSE_FILE));
      const notice = readFileSync(dst, 'utf8');
      assert.equal(notice, NOTICE_PREAMBLE + src, 'полный MIT-текст после преамбулы');
      assert.match(NOTICE_PREAMBLE, /portions/);
      assert.match(NOTICE_PREAMBLE, /No license has been selected/);
      assert.deepEqual(readdirSync(dir).sort(), [LICENSE_FILE, 'keep.txt'], 'другие файлы не тронуты, временных нет');
      assert.throws(() => copyLicense(dir, join(dir, 'missing.txt')), /MIT notice/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stage: в apps/<id> попадают ровно APP_FILES (с лицензией) и метка; соседние приложения не тронуты', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xop-stage-'));
    try {
      const up = join(tmp, 'up');
      for (const d of ['kit/tools', 'kit/runtime', 'apps/other']) mkdirSync(join(up, d), { recursive: true });
      for (const f of ['kit/tools/build.py', 'kit/runtime/mgu.js', 'kit/runtime/record.js', 'kit/runtime/gauges.js']) writeFileSync(join(up, f), '');
      const other = JSON.stringify({ id: 'other', loggingId: 'OTH1' });
      writeFileSync(join(up, 'apps/other/app.json'), other);
      const src = join(tmp, 'src');
      mkdirSync(src);
      for (const f of APP_FILES) writeFileSync(join(src, f), f === LICENSE_FILE ? NOTICE_PREAMBLE + readFileSync(LICENSE_SRC, 'utf8') : `// ${f}`);
      writeFileSync(join(src, 'stray.txt'), 'не копируется');

      const res = stage(up, src);
      assert.deepEqual(readdirSync(res.target).sort(), [...APP_FILES, MARKER].sort());
      assert.equal(readFileSync(join(res.target, LICENSE_FILE), 'utf8'), NOTICE_PREAMBLE + readFileSync(LICENSE_SRC, 'utf8'));
      assert.equal(readFileSync(join(up, 'apps/other/app.json'), 'utf8'), other);
      // Повторная подготовка поверх своей (с лицензией) разрешена.
      assert.deepEqual(readdirSync(stage(up, src).target).sort(), [...APP_FILES, MARKER].sort());
      // Без лицензии в исходнике — отказ.
      rmSync(join(src, LICENSE_FILE));
      assert.throws(() => stage(up, src), /NOTICE is missing/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function sorted(o: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k].slice().sort();
  return out;
}
