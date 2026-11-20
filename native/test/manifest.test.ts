import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SCENARIO_IDS } from '../../src/domain/types';
import { APP_ID, APP_TITLE, buildManifest, LOGGING_ID, REQUIRES } from '../src/manifest';
import { nativeRu } from '../src/strings';
import { VehicleAdapter } from '../src/vehicle/adapter';
import { VEHICLE_FIELDS, VEHICLE_INTERFACES } from '../src/vehicle/allowlist';
import { TASU_IFACE } from '../src/vehicle/uds/tasu';
import { ICAM2, XVIEW } from '../src/camera/request';
import { APP_FILES, copyLicense, LICENSE_FILE, LICENSE_SRC, M550_LICENSE_SRC, M550_PREAMBLE, NOTICE_PREAMBLE } from '../scripts/build';
import { MARKER, stage } from '../scripts/stage';
import { FakeTransport, flush, ROOT } from './helpers';

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
  settings: { key: string; default: unknown; hidden?: boolean; options: [string, string][] }[];
};

describe('app.json', () => {
  const m = buildManifest() as unknown as Spec;

  it('идентичность: id, заголовок, тег журнала, только ID7, рантайм-зависимость, без автозапуска', () => {
    assert.equal(m.id, APP_ID);
    assert.equal(m.id, 'xdrive_offroad_pro');
    assert.equal(m.title, APP_TITLE);
    assert.equal(m.title, 'Terrain Monitor', 'отображаемое имя — как заголовок веб-шапки');
    assert.match(String((m as unknown as { description: string }).description), /^xDrive Offroad Pro — /, 'подзаголовок — в описании');
    assert.equal(m.loggingId, LOGGING_ID);
    assert.match(m.loggingId, /^[A-Z0-9]{4}$/);
    assert.deepEqual(m.mguHmi, ['ID7']);
    assert.deepEqual(m.requires, { 'mgu-render': '0.6.21', 'mgu-deploy': '0.8.19', 'xop-camera-bridge': '0.1.6' });
    assert.deepEqual(m.requires, { ...REQUIRES });
    assert.doesNotMatch(JSON.stringify(m), /idrive7-renderd|2\.1\.15/, 'старый рендерер нигде не упомянут');
    assert.equal((m as unknown as { version: string }).version, '0.1.6');
    assert.equal((m as unknown as { screens: { title: string }[] }).screens[0].title, '', 'нативная шапка не дублирует полноэкранную шапку приложения');
    assert.equal(nativeRu.app.title, APP_TITLE);
    assert.equal(m.autostart, undefined);
  });

  it('мост камер: версия зависимости = версии его component.json; мост требует свой приёмник той же версии', () => {
    const b = JSON.parse(readFileSync(join(ROOT, 'native/packaging/xop-camera-bridge/component.json'), 'utf8')) as { id: string; version: string; catalog: { requires: Record<string, string> } };
    assert.equal((m.requires as Record<string, string>)[b.id], b.version);
    assert.equal(b.catalog.requires['xop-camrx'], b.version);
  });

  it('зависимость совпадает с официальным component.json mgu-render 0.6.21', { skip: existsSync(RENDER_COMPONENT) ? false : `нет ${RENDER_COMPONENT}` }, () => {
    const c = JSON.parse(readFileSync(RENDER_COMPONENT, 'utf8')) as { id: string; version: string; mguProvides?: string };
    assert.equal(c.id, 'mgu-render');
    assert.equal(c.version, '0.6.21');
    assert.equal(c.mguProvides, 'renderer');
    assert.equal((m.requires as Record<string, string>)[c.id], c.version);
  });

  it('signals: SOME/IP — только чтение/подписка; единственный транспорт с методом — InternalTasu (sendTasuRequest)', () => {
    for (const [iface, fields] of Object.entries(m.signals)) {
      assert.equal(typeof fields._optional, 'string', `${iface}: _optional`);
      if (iface === TASU_IFACE) {
        assert.deepEqual(Object.keys(fields).sort(), ['_broadcasts', '_instances', '_methods', '_optional']);
        assert.deepEqual(fields._methods, ['sendTasuRequest']);
        assert.deepEqual(fields._broadcasts, ['sendTasuResponse']);
        continue;
      }
      if (iface === ICAM2) {
        // камеры: свой cookie и обычный вид (Drive Recorder-путь); без записи полей
        assert.deepEqual(Object.keys(fields).sort(), ['_methods', '_optional', 'currentState']);
        assert.deepEqual(fields._methods, ['changeState', 'clientAttach', 'clientDetach']);
        assert.equal(fields.currentState, 'rs');
        continue;
      }
      for (const [k, v] of Object.entries(fields)) {
        assert.ok(!['_methods', '_broadcasts', '_instances'].includes(k), `${iface}.${k}`);
        if (k.startsWith('_')) continue;
        assert.match(String(v), /^r?s$/, `${iface}.${k}: ${String(v)}`);
        assert.ok(!String(v).includes('w'), `${iface}.${k} не пишется`);
      }
    }
    assert.deepEqual(Object.keys(m.signals).filter((i) => /tasu|diag|uds/i.test(i)), [TASU_IFACE], 'один диагностический транспорт');
    assert.deepEqual(Object.keys(m.signals).filter((i) => (m.signals[i] as Record<string, unknown>)._methods !== undefined).sort(), [ICAM2, TASU_IFACE].sort());
    assert.deepEqual(m.signals[XVIEW], { _optional: (m.signals[XVIEW] as Record<string, unknown>)._optional, CurrentState: 'rs' });
  });

  it('signals совпадает с allowlist и с тем, на что адаптер реально подписывается', async () => {
    const fromList: Record<string, string[]> = {};
    for (const f of VEHICLE_FIELDS) (fromList[f.iface] ??= []).push(f.field);
    const fromManifest: Record<string, string[]> = {};
    const own = [TASU_IFACE, ICAM2, XVIEW]; // транспорт UDS и камеры — не поля адаптера
    for (const [iface, fields] of Object.entries(m.signals)) if (own.indexOf(iface) < 0) fromManifest[iface] = Object.keys(fields).filter((k) => !k.startsWith('_'));
    assert.deepEqual(sorted(fromManifest), sorted(fromList));
    assert.deepEqual(Object.keys(m.signals).filter((i) => own.indexOf(i) < 0).sort(), VEHICLE_INTERFACES.map((i) => i.iface).sort());

    const tr = new FakeTransport();
    const a = new VehicleAdapter(tr.watch, () => 0);
    a.start();
    await flush();
    const subscribed: Record<string, string[]> = {};
    for (const c of tr.calls) subscribed[c.iface] = c.fields;
    assert.deepEqual(sorted(subscribed), sorted(fromManifest));
    await a.stop();
  });

  it('экран: один canvas-экран MAIN БЕЗ кнопок панели HMI — HMI нечего показать как «Далее»/«Назад» ни на каком пути', () => {
    assert.equal(m.screens.length, 1);
    assert.equal(m.screens[0].kind, 'canvas');
    assert.equal(m.screens[0].name, 'MAIN');
    assert.deepEqual(m.screens[0].buttons, [], 'ни BTN_PAGE/BTN_PREV, ни BTN_SETTINGS');
    assert.ok(!JSON.stringify(m).includes('BTN_PAGE') && !JSON.stringify(m).includes('BTN_PREV'));
    assert.ok(!('chrome' in m.screens[0]), 'kit-рамка (вкладки) остаётся');
  });

  it('настройки: все скрыты (интерфейса настроек нет); источник по умолчанию — автомобиль; без основной камеры', () => {
    assert.ok(m.settings.length > 0);
    for (const st of m.settings) assert.equal(st.hidden, true, `${st.key} скрыта`);
    const src = m.settings.find((s) => s.key === 'dataSource')!;
    assert.equal(src.default, 'vehicle');
    assert.deepEqual(src.options.map((o) => o[0]), ['demo', 'vehicle']);
    const sc = m.settings.find((s) => s.key === 'scenario')!;
    assert.deepEqual(sc.options.map((o) => o[0]), [...SCENARIO_IDS]);
    assert.ok(!m.settings.some((s) => s.key === 'primaryCamera'), 'раскладка камер фиксирована');
    assert.ok(!m.settings.some((s) => s.key === 'demo'), 'нет настройки авто-демо upstream');
  });
});

describe('каталог приложения: файлы и MIT-уведомление', () => {
  it('APP_FILES: свои файлы + NOTICE + icon.png; ни GPL-рендерера, ни шрифтов', () => {
    assert.equal(LICENSE_FILE, 'NOTICE', 'build.py копирует только точные LICENSE/NOTICE');
    assert.deepEqual([...APP_FILES], ['app.json', 'main.js', 'assets.js', 'NOTICE', 'icon.png']);
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
      assert.equal(notice, NOTICE_PREAMBLE + src + M550_PREAMBLE + readFileSync(M550_LICENSE_SRC, 'utf8'), 'оба полных MIT-текста');
      assert.match(notice, /Copyright \(c\) 2026 strulock/);
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
