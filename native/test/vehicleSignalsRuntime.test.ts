// Настоящий vendor/idrive7-apps/kit/runtime/signals.js в vm с заглушкой привязки someip:
// жизненный цикл watch() — опрос геттерами, отсутствие наложений, остановка, потери провайдера.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { ROOT } from './helpers';

// XOP_SIGNALS_SRC — проверить другой signals.js (например, исходный upstream: эти тесты на нём должны падать).
const SRC = process.env.XOP_SIGNALS_SRC || join(ROOT, 'vendor', 'idrive7-apps', 'kit', 'runtime', 'signals.js');

type Handler = (v: unknown) => void;

interface Pending {
  field: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

class StubProxy {
  avail = false;
  availCb: ((a: boolean) => void) | null = null;
  subs = new Map<string, Handler>();
  pending: Pending[] = [];
  gets: string[] = [];
  shutdowns = 0;
  throwOn = new Set<string>();
  init() {
    return Promise.resolve();
  }
  subscribeToAvailability(cb: (a: boolean) => void) {
    this.availCb = cb;
  }
  subscribe(o: { name: string; onReceive: Handler }) {
    this.subs.set(o.name, o.onReceive);
  }
  isAvailable() {
    return this.avail;
  }
  getValue(field: string): Promise<unknown> {
    this.gets.push(field);
    if (this.throwOn.has(field)) throw new Error(`getter ${field} broke`);
    return new Promise((resolve, reject) => this.pending.push({ field, resolve, reject }));
  }
  shutdown() {
    this.shutdowns++;
  }
  setAvailable(a: boolean) {
    this.avail = a;
    this.availCb?.(a);
  }
  /** Ответить на все висящие чтения поля. */
  answer(field: string, v: unknown) {
    const mine = this.pending.filter((p) => p.field === field);
    this.pending = this.pending.filter((p) => p.field !== field);
    mine.forEach((p) => p.resolve(v));
  }
  fail(field: string) {
    const mine = this.pending.filter((p) => p.field === field);
    this.pending = this.pending.filter((p) => p.field !== field);
    mine.forEach((p) => p.reject(new Error('timeout')));
  }
  count(field: string) {
    return this.gets.filter((g) => g === field).length;
  }
}

interface ReadStats {
  ok: number;
  failed: number;
  consecutiveFailures: number;
  dropped: number;
  skipped: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastError: string | null;
  pendingSince: number | null;
}

interface Runtime {
  watch: (iface: string, inst: string, handlers: Record<string, Handler>, log?: unknown, opts?: unknown) => Promise<{
    available: boolean;
    losses: number;
    reads: Record<string, ReadStats>;
    error: string | null;
    shutdown(): Promise<unknown>;
  }>;
  proxy: StubProxy;
  clock: { t: number };
  timers: Map<number, { fn: () => void; ms: number }>;
  cleared: number[];
  warnings: string[];
  /** Тик всех таймеров, время сдвигается на период самого быстрого. */
  tick(ms?: number): Promise<void>;
}

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Конфиги интерфейсов как от генератора: getter у полей из списка. */
function load(getters: Record<string, string[]>): Runtime {
  const proxy = new StubProxy();
  const clock = { t: 100_000 };
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const cleared: number[] = [];
  let nextId = 1;
  const someip = { buildProxy: () => Promise.resolve(proxy) };
  const fsStub = {
    readFileSync: (p: string) => {
      const name = basename(p, '.json');
      const iface = Object.keys(getters).find((i) => i.replace(/\./g, '_') === name);
      if (!iface) throw new Error('ENOENT');
      const fields: Record<string, { getter?: boolean }> = {};
      for (const f of getters[iface]) fields[f] = { getter: true };
      return JSON.stringify({ fields });
    },
  };
  const req = (m: string) => (m === 'someip' ? someip : m === 'fs' ? fsStub : m === 'path' ? nodePath : (() => { throw new Error(`unexpected require ${m}`); })());
  const module = { exports: {} as Record<string, unknown> };
  const ctx = vm.createContext({
    setImmediate,
    setInterval: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id: number) => {
      cleared.push(id);
      timers.delete(id);
    },
    Date: { now: () => clock.t },
    Promise,
    JSON,
    Math,
    Object,
    String,
    Error,
  });
  const code = readFileSync(SRC, 'utf8');
  vm.runInContext(`(function (require, module, exports, __dirname) {${code}\n})`, ctx, { filename: SRC })(req, module, module.exports, join(ROOT, 'vendor', 'idrive7-apps', 'kit', 'runtime'));
  const warnings: string[] = [];
  const rt: Runtime = {
    watch: module.exports.watch as Runtime['watch'],
    proxy,
    clock,
    timers,
    cleared,
    warnings,
    async tick(ms) {
      const step = ms ?? Math.min(...Array.from(timers.values()).map((t) => t.ms));
      clock.t += step;
      Array.from(timers.values()).forEach((t) => t.fn());
      await settle();
    },
  };
  return rt;
}

const log = (rt: Runtime) => ({ info() {}, warn: (m: string) => rt.warnings.push(String(m)), error() {} });
const V2 = 'de.bmw.infotainment.vehicle.Vehicle2';

describe('vendor signals.js watch(): опрос и жизненный цикл (vm + заглушка someip)', () => {
  it('fieldPollMs: у каждого поля свой период; только пока провайдер доступен; поле без геттера не читается', async () => {
    const rt = load({ [V2]: ['fast', 'slow'] });
    const got: string[] = [];
    const res = await rt.watch(V2, '1', { fast: (v) => got.push(`fast:${String(v)}`), slow: () => got.push('slow'), notify: () => got.push('notify') }, log(rt), {
      pollMs: 1000,
      fieldPollMs: { fast: 1000, slow: 5000 },
    });
    assert.equal(res.error, null);
    assert.equal(rt.timers.size, 1, 'один таймер на интерфейс');
    assert.equal([...rt.timers.values()][0].ms, 1000);
    await rt.tick();
    assert.equal(rt.proxy.gets.length, 0, 'провайдер недоступен — не читаем');
    rt.proxy.setAvailable(true);
    await settle();
    assert.deepEqual(rt.proxy.gets.sort(), ['fast', 'slow'], 'первое чтение при появлении провайдера');
    rt.proxy.answer('fast', 1);
    rt.proxy.answer('slow', 2);
    await settle();
    for (let i = 0; i < 10; i++) {
      await rt.tick(1000);
      rt.proxy.answer('fast', i);
      rt.proxy.answer('slow', i);
      await settle();
    }
    assert.equal(rt.proxy.count('fast'), 11);
    assert.ok(rt.proxy.count('slow') >= 2 && rt.proxy.count('slow') <= 3, `slow: ${rt.proxy.count('slow')}`);
    assert.equal(rt.proxy.count('notify'), 0);
    assert.ok(got.includes('fast:9'));
    await res.shutdown();
  });

  it('5 Гц: fieldPollMs 200 мс — таймер 200 мс, ровно 5 чтений в секунду (без округления до 1 с); медленное поле — своим периодом', async () => {
    const rt = load({ [V2]: ['fast', 'temp'] });
    const got: number[] = [];
    const res = await rt.watch(V2, '1', { fast: (v) => got.push(Number(v)), temp: () => undefined }, log(rt), {
      pollMs: 200,
      fieldPollMs: { fast: 200, temp: 5000 },
    });
    assert.deepEqual([...rt.timers.values()].map((t) => t.ms), [200], 'интервал интерфейса — самый короткий период');
    rt.proxy.setAvailable(true);
    await settle();
    rt.proxy.answer('fast', 0);
    rt.proxy.answer('temp', 0);
    await settle();
    const start = rt.proxy.count('fast');
    // 10 с реального времени таймера, ответ на каждое чтение сразу
    for (let i = 1; i <= 50; i++) {
      await rt.tick(200);
      rt.proxy.answer('fast', i);
      rt.proxy.answer('temp', i);
      await settle();
    }
    assert.equal(rt.proxy.count('fast') - start, 50, '5 чтений в секунду × 10 с');
    assert.equal(got.length, 51, 'каждый ответ — отсчёт');
    const temps = rt.proxy.count('temp');
    assert.ok(temps >= 2 && temps <= 3, `температура раз в 5 с: ${temps}`);
    // медленный ответ (дольше периода) не накапливает запросов: тики пропускаются
    await rt.tick(200);
    await rt.tick(200);
    await rt.tick(200);
    assert.equal(rt.proxy.pending.filter((p) => p.field === 'fast').length, 1);
    assert.equal(res.reads.fast.skipped, 2);
    await res.shutdown();
  });

  it('висящее чтение не накладывается: тики пропускаются, очередь не растёт; неудача — не отсчёт, затем снова читаем', async () => {
    const rt = load({ [V2]: ['a', 'b'] });
    const got: string[] = [];
    rt.proxy.avail = true;
    const res = await rt.watch(V2, '1', { a: () => got.push('a'), b: () => got.push('b') }, log(rt), { pollMs: 1000 });
    await settle();
    assert.equal(rt.proxy.count('a'), 1);
    rt.proxy.answer('b', 1);
    await settle();
    // a висит (таймаут привязки ещё не пришёл): пять тиков — ни одного нового чтения a; b — каждый тик.
    for (let i = 0; i < 5; i++) {
      await rt.tick(1000);
      rt.proxy.answer('b', 1);
      await settle();
    }
    assert.equal(rt.proxy.count('a'), 1, 'нет наложения чтений a');
    assert.equal(rt.proxy.pending.filter((p) => p.field === 'a').length, 1, 'очередь не растёт');
    assert.equal(rt.proxy.count('b'), 6, 'чтения b не зависят от a');
    rt.proxy.fail('a');
    await settle();
    assert.ok(!got.includes('a'), 'неудачное чтение не вызывает обработчик');
    await rt.tick(1000);
    assert.equal(rt.proxy.count('a'), 2, 'после неудачи — снова читаем');
    await res.shutdown();
  });

  it('висящий навсегда запрос: за много тиков — один getValue, пропуски и pendingSince видны; другие поля читаются; shutdown снимает таймер', async () => {
    const rt = load({ [V2]: ['a', 'b'] });
    const got: unknown[] = [];
    rt.proxy.avail = true;
    const res = await rt.watch(V2, '1', { a: (v) => got.push(v), b: () => undefined }, log(rt), { pollMs: 1000 });
    await settle();
    const started = rt.clock.t;
    rt.proxy.answer('b', -1);
    await settle();
    for (let i = 0; i < 60; i++) {
      await rt.tick(1000);
      rt.proxy.answer('b', i);
      await settle();
    }
    assert.equal(rt.proxy.count('a'), 1, 'одно реальное обращение к привязке за 60 с');
    assert.equal(rt.proxy.pending.filter((p) => p.field === 'a').length, 1);
    assert.equal(rt.proxy.count('b'), 61, 'соседнее поле читается каждый тик');
    assert.equal(res.reads.a.pendingSince, started);
    assert.equal(res.reads.a.skipped, 60);
    assert.equal(res.reads.b.ok, 61);
    await res.shutdown();
    assert.equal(rt.timers.size, 0);
    rt.proxy.answer('a', 'very late');
    await settle();
    assert.deepEqual(got, [], 'ответ после остановки не доставлен');
  });

  it('эпоха провайдера: чтение, начатое до потери, отвечает после быстрого переподключения — ответ отброшен; новое чтение доставлено', async () => {
    const rt = load({ [V2]: ['a'] });
    const got: unknown[] = [];
    rt.proxy.avail = true;
    const res = await rt.watch(V2, '1', { a: (v) => got.push(v) }, log(rt), { pollMs: 1000 });
    await settle();
    assert.equal(rt.proxy.count('a'), 1);
    const old = rt.proxy.pending[0];
    rt.proxy.setAvailable(false);
    rt.proxy.setAvailable(true);
    await settle();
    assert.equal(rt.proxy.count('a'), 1, 'пока старое чтение не завершилось, второго нет');
    old.resolve('before loss');
    await settle();
    assert.deepEqual(got, [], 'ответ старой эпохи не доставлен');
    assert.equal(res.reads.a.dropped, 1);
    assert.equal(res.reads.a.ok, 0);
    await rt.tick(1000);
    assert.equal(rt.proxy.count('a'), 2);
    rt.proxy.answer('a', 'after reconnect');
    await settle();
    assert.deepEqual(got, ['after reconnect']);
    assert.equal(res.reads.a.ok, 1);
    await res.shutdown();
  });

  it('ответ, пришедший пока провайдера нет, отброшен; уведомление поля без провайдера не доставляется', async () => {
    const rt = load({ [V2]: ['a'] });
    const got: unknown[] = [];
    rt.proxy.avail = true;
    const res = await rt.watch(V2, '1', { a: (v) => got.push(v), n: (v) => got.push(v) }, log(rt), { pollMs: 1000 });
    await settle();
    rt.proxy.setAvailable(false);
    rt.proxy.answer('a', 'while away');
    rt.proxy.subs.get('n')!('notify while away');
    await settle();
    assert.deepEqual(got, []);
    rt.proxy.setAvailable(true);
    rt.proxy.subs.get('n')!('notify back');
    await settle();
    assert.deepEqual(got, ['notify back']);
    await res.shutdown();
  });

  it('статистика геттера: неудача — счётчик, текст ошибки, без вызова обработчика; успех — ok, lastOkAt, сброс серии неудач', async () => {
    const rt = load({ [V2]: ['a'] });
    const got: unknown[] = [];
    rt.proxy.avail = true;
    const res = await rt.watch(V2, '1', { a: (v) => got.push(v), n: () => undefined }, log(rt), { pollMs: 1000 });
    await settle();
    assert.deepEqual(Object.keys(res.reads), ['a'], 'только поля с геттером');
    rt.proxy.fail('a');
    await settle();
    await rt.tick(1000);
    rt.proxy.fail('a');
    await settle();
    let st = res.reads.a;
    assert.equal(st.failed, 2);
    assert.equal(st.consecutiveFailures, 2);
    assert.equal(st.lastError, 'timeout');
    assert.equal(st.lastFailAt, rt.clock.t);
    assert.equal(st.lastOkAt, null);
    assert.equal(st.pendingSince, null);
    assert.deepEqual(got, [], 'неудачное чтение — не отсчёт');
    await rt.tick(1000);
    rt.proxy.answer('a', { secret: 'payload' });
    await settle();
    st = res.reads.a;
    assert.equal(st.ok, 1);
    assert.equal(st.consecutiveFailures, 0);
    assert.equal(st.lastOkAt, rt.clock.t);
    assert.equal(st.lastError, 'timeout', 'последняя ошибка остаётся для истории');
    assert.doesNotMatch(JSON.stringify(res.reads), /secret|payload/);
    await res.shutdown();
  });

  it('синхронная ошибка геттера и исключение обработчика изолированы по полям', async () => {
    const rt = load({ [V2]: ['a', 'b'] });
    const got: unknown[] = [];
    rt.proxy.avail = true;
    rt.proxy.throwOn.add('a');
    const res = await rt.watch(V2, '1', { a: () => got.push('a'), b: (v) => { if (v === 'boom') throw new Error('handler'); got.push(v); } }, log(rt), { pollMs: 1000 });
    await settle();
    rt.proxy.answer('b', 'boom');
    await settle();
    assert.ok(rt.warnings.some((w) => /b: Error: handler/.test(w)), rt.warnings.join('|'));
    await rt.tick(1000);
    rt.proxy.answer('b', 'ok');
    await settle();
    assert.deepEqual(got, ['ok']);
    rt.proxy.subs.get('b')!('notified');
    assert.deepEqual(got, ['ok', 'notified']);
    await res.shutdown();
  });

  it('shutdown: таймер снят, прокси закрыт, поздние ответы/уведомления/доступность больше не доходят', async () => {
    const rt = load({ [V2]: ['a'] });
    const got: unknown[] = [];
    const avail: boolean[] = [];
    rt.proxy.avail = true;
    const res = await rt.watch(V2, '1', { a: (v) => got.push(v) }, log(rt), { pollMs: 1000, onAvailability: (a: boolean) => avail.push(a) });
    await settle();
    assert.equal(rt.timers.size, 1);
    const availBefore = avail.length;
    await res.shutdown();
    assert.equal(rt.timers.size, 0, 'интервал снят');
    assert.equal(rt.cleared.length, 1);
    assert.equal(rt.proxy.shutdowns, 1);
    rt.proxy.answer('a', 'late');
    rt.proxy.subs.get('a')!('late notify');
    rt.proxy.setAvailable(false);
    rt.proxy.setAvailable(true);
    await settle();
    assert.deepEqual(got, []);
    assert.equal(avail.length, availBefore, 'колбэк доступности после остановки молчит');
    assert.equal(rt.proxy.count('a'), 1, 'после остановки не читаем');
  });

  it('потеря провайдера: res.losses растёт, onAvailability(false/true), без опроса пока нет провайдера', async () => {
    const rt = load({ [V2]: ['a'] });
    const avail: boolean[] = [];
    rt.proxy.avail = true;
    const res = await rt.watch(V2, '1', { a: () => undefined }, log(rt), { pollMs: 1000, onAvailability: (a: boolean) => avail.push(a) });
    await settle();
    rt.proxy.answer('a', 1);
    await settle();
    rt.proxy.setAvailable(false);
    rt.proxy.setAvailable(true);
    rt.proxy.setAvailable(false);
    assert.equal(res.losses, 2);
    assert.equal(res.available, false);
    assert.deepEqual(avail, [true, false, true, false]);
    const before = rt.proxy.count('a');
    await rt.tick(1000);
    assert.equal(rt.proxy.count('a'), before);
    await res.shutdown();
  });

  it('без opts — поведение upstream: без таймера, первое чтение при доступности', async () => {
    const rt = load({ [V2]: ['a'] });
    rt.proxy.avail = true;
    const res = await rt.watch(V2, '1', { a: () => undefined });
    await settle();
    assert.equal(rt.timers.size, 0);
    assert.equal(rt.proxy.count('a'), 1);
    await res.shutdown();
  });
});
