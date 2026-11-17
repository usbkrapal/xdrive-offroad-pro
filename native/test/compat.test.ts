import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import vm from 'node:vm';
import * as zlib from 'node:zlib';
import { fromEntries, installObjectFromEntries } from '../src/compat';
import { monotonicNow } from '../src/clock';
import { RENDER_SOCKET } from '../src/renderTarget';
import { bundleMain } from '../scripts/bundle';
import { scanBundle } from '../scripts/compat-scan';

type Env = Record<string, string | undefined>;

/**
 * Выполнить собранный main.js как CommonJS-модуль в отдельном vm-контексте, где Object.fromEntries нет
 * (как в Node 8). require('./kit/…') — заглушки, запоминающие окружение процесса в момент загрузки.
 */
function runBundle(code: string, env: Env) {
  const proc = { env: { ...env }, hrtime: process.hrtime, once: () => undefined, removeListener: () => undefined };
  const kitLoads: { id: string; env: Env }[] = [];
  let started = false;
  let spec: { start?: unknown } | null = null;
  const req = (id: string): unknown => {
    if (id.startsWith('./kit/')) {
      kitLoads.push({ id, env: { ...proc.env } });
      return id === './kit/mgu' ? { run: (sp: { start?: unknown }) => ((started = true), (spec = sp)) } : {};
    }
    if (id === 'zlib') return zlib;
    throw new Error(`unexpected require ${id}`);
  };
  const sandbox = vm.createContext({ Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate });
  vm.runInContext('delete Object.fromEntries;', sandbox);
  assert.equal(vm.runInContext('typeof Object.fromEntries', sandbox), 'undefined');
  const wrapper = vm.runInContext(`(function (require, module, exports, process) {\n${code}\n})`, sandbox) as (...a: unknown[]) => void;
  const mod = { exports: {} };
  wrapper(req, mod, mod.exports, proc);
  return { kitLoads, started, spec: spec as { start?: unknown } | null, performance: vm.runInContext('typeof performance', sandbox) as string, env: proc.env, fromEntries: vm.runInContext('typeof Object.fromEntries', sandbox) as string };
}

describe('совместимость с Node 8.7', () => {
  it('полифил Object.fromEntries ставится только при отсутствии и ведёт себя как оригинал', () => {
    const fake: { fromEntries?: unknown } = {};
    assert.equal(installObjectFromEntries(fake), true);
    assert.equal(installObjectFromEntries(fake), false);
    const f = fake.fromEntries as typeof fromEntries;
    assert.deepEqual(f([['a', 1], ['b', 2]]), { a: 1, b: 2 });
    assert.deepEqual(f(new Map([['x', 'y']])), Object.fromEntries(new Map([['x', 'y']])));
    assert.equal(installObjectFromEntries(Object as never), false, 'современный Node не трогается');
  });

  it('монотонные часы из process.hrtime в мс', () => {
    let calls = 0;
    const fake = ((prev?: [number, number]) => {
      calls++;
      return prev ? ([2, 500_000] as [number, number]) : ([100, 0] as [number, number]);
    }) as (prev?: [number, number]) => [number, number];
    const now = monotonicNow(fake);
    assert.equal(now(), 2000.5);
    assert.equal(calls, 2);
  });

  it('бандл main.js: CommonJS, без браузерных/новых API, require только встроенные Node и ./kit/*, ./assets', async () => {
    const code = await bundleMain();
    const issues = scanBundle(code);
    assert.deepEqual(issues, [], issues.map((i) => `${i.line}: ${i.rule}: ${i.excerpt}`).join('\n'));
    assert.match(code, /require\("\.\/kit\/mgu"\)/);
    assert.match(code, /require\("\.\/kit\/gauges"\)/);
    assert.match(code, /require\("\.\/kit\/record"\)/);
    assert.match(code, /require\("\.\/assets"\)/);
    assert.doesNotMatch(code, /from ["']react|createElement|useState/);
    assert.doesNotMatch(code, /^\s*(import|export)\s/m, 'ESM-синтаксис в Node 8 недопустим');
    assert.doesNotMatch(code, /\?\?|\?\.[a-zA-Z_(]/, 'оператор ?? и ?. должны быть понижены');
    // Полифил стоит до каталога сигналов (который вызывает Object.fromEntries при загрузке).
    const compat = code.indexOf('native/src/compat.ts');
    const catalog = code.indexOf('src/domain/signalCatalog.ts');
    assert.ok(compat >= 0 && catalog > compat, 'compat.ts раньше signalCatalog.ts');
    // Рантайм upstream и SDK не встроены.
    assert.doesNotMatch(code, /class Recorder|function softLayer|OnlineApp/);
  });

  it('сканер ловит типичные нарушения', () => {
    const bad = ['const a = [1].flatMap((x) => [x]);', 'globalThis.x = 1;', 'p.finally(() => 0);', 'const r = /(?<=a)b/;', 'require("lodash");', 'window.foo();'].join('\n');
    const rules = scanBundle(bad).map((i) => i.rule);
    assert.equal(rules.length, 6, rules.join('; '));
  });

  it('сканер: Object.fromEntries допустим только после вызова полифила, а не после его определения', () => {
    const def = 'function installObjectFromEntries(target = Object) {\n  return 1;\n}\n';
    assert.equal(scanBundle(`${def}const a = Object.fromEntries([]);\ninstallObjectFromEntries();`).length, 1, 'вызов до установки');
    assert.equal(scanBundle(`${def}installObjectFromEntries();\nconst a = Object.fromEntries([]);`).length, 0);
    assert.equal(scanBundle('const a = Object.fromEntries([]);').length, 1, 'без полифила');
  });

  it('сканер: выбор рендерера обязан стоять раньше require ./kit/*', () => {
    const order = (a: string, b: string) => scanBundle(`${a}\n${b}`).map((i) => i.rule);
    assert.deepEqual(order('selectRenderTarget(process.env);', 'const m = require("./kit/mgu");'), []);
    assert.equal(order('const m = require("./kit/mgu");', 'selectRenderTarget(process.env);').length, 1);
    assert.equal(scanBundle('const m = require("./kit/mgu");').length, 1);
  });
});

describe('main.js при загрузке (vm, без Object.fromEntries)', () => {
  let code = '';
  before(async () => {
    code = await bundleMain();
  });

  it('upstream-диалект и сокет mgu-render выставлены ДО первого require ./kit/*; каталог сигналов загружается', () => {
    const outer = { proto: process.env.MGU_RENDERD_PROTO, socket: process.env.MGU_RENDERD_SOCKET };
    const r = runBundle(code, {});
    assert.equal(r.fromEntries, 'function', 'полифил установлен в среде без Object.fromEntries');
    assert.equal(r.performance, 'undefined', 'в среде нет глобального performance (как в Node 8)');
    assert.equal(r.started, true, 'mgu.run зарегистрирован после загрузки kit');
    assert.equal(typeof r.spec?.start, 'function');
    assert.ok(r.kitLoads.length >= 3, r.kitLoads.map((k) => k.id).join(','));
    assert.equal(r.kitLoads[0].id, './kit/mgu');
    for (const k of r.kitLoads) {
      assert.equal(k.env.MGU_RENDERD_PROTO, 'upstream', `${k.id}: диалект`);
      assert.equal(k.env.MGU_RENDERD_SOCKET, RENDER_SOCKET, `${k.id}: сокет`);
    }
    assert.equal(RENDER_SOCKET, '/run/mgu-render/render.sock');
    // Окружение самого тестового процесса (как и системное) не тронуто.
    assert.deepEqual({ proto: process.env.MGU_RENDERD_PROTO, socket: process.env.MGU_RENDERD_SOCKET }, outer);
  });

  it('сокет эмулятора, заданный снаружи, сохраняется; диалект всегда upstream; запись в файл не трогается', () => {
    const emu = runBundle(code, { MGU_RENDERD_SOCKET: '/tmp/xop-emu/render.sock', MGU_RENDERD_PROTO: 'mgu-render/1' });
    assert.equal(emu.kitLoads[0].env.MGU_RENDERD_SOCKET, '/tmp/xop-emu/render.sock');
    assert.equal(emu.kitLoads[0].env.MGU_RENDERD_PROTO, 'upstream');
    const file = runBundle(code, { MGU_RENDERD_FILE: '/tmp/xop.rd' });
    assert.equal(file.kitLoads[0].env.MGU_RENDERD_FILE, '/tmp/xop.rd');
    assert.equal(file.kitLoads[0].env.MGU_RENDERD_PROTO, 'upstream');
    const sw = runBundle(code, { MGU_RENDERER: 'software' });
    assert.equal(sw.kitLoads[0].env.MGU_RENDERER, 'software', 'программный путь по-прежнему выбирается');
  });
});
