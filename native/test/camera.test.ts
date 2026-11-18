// Жизненный цикл камер: запрос вида (ICAM2Proxy, свой cookie), соединение с мостом (поколения), мост (источник кадров).
// Внешнее — подделки: SOME/IP-вызовы с отложенными ответами, ручные таймеры, сокеты и процессы.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bridge, HANDOVER_MS, PRODUCTION_PRODUCERS, socketAccess, type ChildLike, type Deps, type Peer, type SpawnHooks } from '../bridge/src/bridge';
import { CAMRX, CAMRX_ROOT, CAMRX_SPEC } from '../bridge/src/camcluster';
import { encodeLine, parseEvent } from '../src/camera/ctl';
import { CameraFeeds, type FeedDeps } from '../src/camera/feeds';
import { camPolicy, CameraRequest, cookieOf, decide, ICAM2, XVIEW, type CamApi, type CamPolicy } from '../src/camera/request';
import type { WatchOpts, WatchResult } from '../src/platform/kitTypes';

/* ---------------- ручные таймеры ---------------- */

function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const setTimer = (fn: () => void, ms: number) => {
    const id = ++seq;
    timers.set(id, { at: now + ms, fn });
    return () => void timers.delete(id);
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return { now: () => now, setTimer, advance, pending: () => timers.size };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/* ---------------- ICAM2Proxy ---------------- */

interface Deferred {
  method: string;
  params: Record<string, unknown>;
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

function fakeIcam(deferProxy = false) {
  const calls: Deferred[] = [];
  const handlers = new Map<string, (v: unknown) => void>();
  const avail = new Map<string, (a: boolean) => void>();
  const subs = new Map<string, WatchResult>();
  const api: CamApi = {
    proxy: () => (deferProxy ? new Promise((resolve, reject) => void calls.push({ method: 'proxy', params: {}, resolve, reject })) : Promise.resolve({})),
    call: (_p, method, params) =>
      new Promise((resolve, reject) => {
        calls.push({ method, params, resolve, reject });
      }),
    watch: (iface, _inst, h, _log, opts?: WatchOpts) => {
      for (const k of Object.keys(h)) handlers.set(iface, h[k] as (v: unknown) => void);
      if (opts && opts.onAvailability) avail.set(iface, opts.onAvailability);
      const r: WatchResult = { available: iface === ICAM2, error: null, losses: 0, shutdown: () => Promise.resolve() };
      subs.set(iface, r);
      return Promise.resolve(r);
    },
  };
  return {
    api,
    calls,
    state: (application: string, perspective = 0) => handlers.get(ICAM2)!({ application, mode: 'MODE_MOSAIK', perspective }),
    xview: (application: string, perspective = 0) => handlers.get(XVIEW)!({ application, mode: 'MODE_MOSAIK', perspective }),
    availability: (a: boolean) => avail.get(ICAM2)!(a),
    /** Перезапуск провайдера: пропал, счётчик потерь +1, снова есть. */
    restart: () => {
      avail.get(ICAM2)!(false);
      subs.get(ICAM2)!.losses = (subs.get(ICAM2)!.losses ?? 0) + 1;
      avail.get(ICAM2)!(true);
    },
    sub: () => subs.get(ICAM2)!,
    named: (m: string) => calls.filter((c) => c.method === m),
  };
}

const NEED = { accept: [1, 3, 4, 5, 6, 7, 8, 9, 10], request: 7 };

async function requestRig(policy: CamPolicy = { requestEnabled: true, busyApps: [] }, deferProxy = false) {
  const c = clock();
  const f = fakeIcam(deferProxy);
  const lines: string[] = [];
  const r = new CameraRequest(f.api, c.now, c.setTimer, { info: (s: string) => lines.push(s), warn: (s: string) => lines.push(s) } as never, policy);
  r.setNeed(NEED);
  r.setWanted(true);
  await flush();
  return { c, f, r, lines };
}

describe('камеры: запрос вида (ICAM2Proxy)', () => {
  it('cookie — только целое число или {cookie}: коды ошибок и другие поля — не cookie', () => {
    assert.equal(cookieOf(42), 42);
    assert.equal(cookieOf({ cookie: 5 }), 5);
    assert.equal(cookieOf({ result: 1 }), null);
    assert.equal(cookieOf({ status: 0, cookie: 'x' }), null);
    assert.equal(cookieOf(-1), null);
    assert.equal(cookieOf(1.5), null);
  });

  it('открытая страница, блок готов, не штатный обзор и не DR_ACTIVE — косвенный запрос вида 7 (неизвестное application не простой и не занятость)', async () => {
    const { f, r, lines } = await requestRig();
    f.state('SOMETHING');
    await flush();
    assert.equal(f.named('clientAttach').length, 1);
    assert.deepEqual(f.named('clientAttach')[0].params, { type: 'CLIENT_INDIRECT' });
    assert.match(r.reason, /косвенным клиентом/);
    assert.ok(lines.some((l) => /application seen: SOMETHING/.test(l)), 'новое значение — в журнал');
    const base = { wanted: true, available: true, need: NEED, ownCookie: false, ownView: 0, triesLeft: true, verifying: false };
    const st = (application: string, perspective = 0) => ({ application, mode: '', perspective });
    assert.deepEqual(decide({ ...base, state: st('X') }), { act: 'request', view: 7, why: 'камеры не заняты штатным видом (X): просим вид 7 косвенным клиентом' });
    assert.equal(decide({ ...base, state: st('TOPREARVIEW') }).act, 'none');
    assert.equal(decide({ ...base, ownCookie: true, state: st('TOPREARVIEW') }).act, 'release');
    assert.match(decide({ ...base, state: st('DR_ACTIVE', 7) }).why, /только слушаем/);
    assert.match(decide({ ...base, state: st('DR_ACTIVE', 2) }).why, /не переопределяем/);
    assert.match(decide({ ...base, state: st('SIGNAL_UNFILLED') }).why, /не готов/);
    assert.match(decide({ ...base, state: st('X', 255) }).why, /не готов/);
    assert.match(decide({ ...base, state: st('X'), requestEnabled: false }).why, /XOP_CAM_REQUEST=off/);
    assert.match(decide({ ...base, state: st('TRAILER'), busyApps: ['TRAILER'] }).why, /XOP_CAM_BUSY/);
    assert.equal(decide({ ...base, state: st('X'), triesLeft: false }).act, 'none');
    assert.deepEqual(camPolicy({}), { requestEnabled: true, busyApps: [] });
    assert.deepEqual(camPolicy({ XOP_CAM_REQUEST: 'OFF', XOP_CAM_BUSY: 'A, 7,bad-name' }), { requestEnabled: false, busyApps: ['A', '7'] });
  });

  it('выключатель разработчика: только слушаем, ни одного attach', async () => {
    const { f } = await requestRig({ requestEnabled: false, busyApps: [] });
    f.state('IDLE');
    await flush();
    assert.equal(f.named('clientAttach').length, 0);
  });

  it('эпоха A2: ответ attach прошлой эпохи после свежего состояния нового провайдера — cookie не берётся, changeState не уходит, detach нет', async () => {
    const { f, r } = await requestRig();
    f.state('IDLE');
    await flush();
    assert.equal(f.named('clientAttach').length, 1);
    f.restart();
    f.state('IDLE'); // свежее состояние нового провайдера (запрос занят — решение после)
    await flush();
    f.named('clientAttach')[0].resolve({ cookie: 1 });
    await flush();
    assert.ok(f.named('changeState').every((c) => (c.params as { cookie: number }).cookie !== 1), 'cookie прошлой эпохи не используется');
    assert.equal(f.named('clientDetach').length, 0, 'и не отпускается (на новом провайдере он может быть чужим)');
    assert.notEqual(r.ownCookie, 1);
    // новая эпоха: новый attach, его cookie принимается
    assert.equal(f.named('clientAttach').length, 2);
    f.named('clientAttach')[1].resolve(9);
    await flush();
    assert.equal(r.ownCookie, 9);
    assert.deepEqual(f.named('changeState')[0].params, { cookie: 9, desiredState: { application: 'DR_ACTIVE', mode: 'MODE_MOSAIK', perspective: 7 } });
  });

  it('эпоха B2: прокси, полученный через смену эпохи, не используется; attach новой эпохи принимается и отпускается при уходе', async () => {
    const { f, r } = await requestRig(undefined, true);
    f.state('IDLE');
    await flush();
    assert.equal(f.named('proxy').length, 1);
    f.restart();
    f.state('IDLE');
    await flush();
    f.named('proxy')[0].resolve({ px: 'old' });
    await flush();
    assert.equal(f.named('clientAttach').length, 0, 'attach не уходит через прокси прошлой эпохи');
    assert.equal(f.named('proxy').length, 2, 'новая эпоха — новый прокси');
    f.named('proxy')[1].resolve({ px: 'new' });
    await flush();
    assert.equal(f.named('clientAttach').length, 1);
    f.named('clientAttach')[0].resolve(7);
    await flush();
    assert.equal(r.ownCookie, 7);
    f.named('changeState')[0].resolve(undefined);
    await flush();
    r.setWanted(false);
    await flush();
    assert.deepEqual(f.named('clientDetach').map((c) => c.params), [{ cookie: 7 }]);
  });

  it('эпоха C: changeState, завершившийся через смену эпохи, не делает вид своим; XView3D прошлой эпохи не основание для запроса', async () => {
    const { f, r } = await requestRig();
    f.xview('IDLE');
    f.state('IDLE');
    await flush();
    f.named('clientAttach')[0].resolve(5);
    await flush();
    f.restart();
    f.named('changeState')[0].resolve(undefined);
    await flush();
    assert.equal(r.ownCookie, null);
    assert.equal(f.named('clientDetach').length, 0);
    assert.equal(f.named('clientAttach').length, 1, 'без свежего состояния нового провайдера (XView3D тоже сброшен) — запроса нет');
    assert.match(r.reason, /состояния камер нет|прошлой эпохи|сменился/);
  });

  it('уход со страницы во время changeState: по его завершении свой cookie отпускается (ровно один detach)', async () => {
    const { f, r } = await requestRig();
    f.state('IDLE');
    await flush();
    f.named('clientAttach')[0].resolve(42);
    await flush();
    assert.equal(f.named('changeState').length, 1);
    r.setWanted(false);
    f.named('changeState')[0].resolve(undefined);
    await flush();
    const det = f.named('clientDetach');
    assert.equal(det.length, 1);
    assert.deepEqual(det[0].params, { cookie: 42 });
    det[0].resolve(undefined);
    await flush();
    assert.equal(r.ownCookie, null);
  });

  it('потеря провайдера: cookie забыт без detach; после возврата — новый attach, старый cookie не используется', async () => {
    const { f, r } = await requestRig();
    f.state('IDLE');
    await flush();
    f.named('clientAttach')[0].resolve(42);
    await flush();
    f.named('changeState')[0].resolve(undefined);
    await flush();
    assert.equal(r.ownCookie, 42);
    f.availability(false);
    await flush();
    assert.equal(r.ownCookie, null);
    assert.equal(f.named('clientDetach').length, 0, 'cookie прежнего провайдера не отпускается на новом');
    f.availability(true);
    f.state('IDLE');
    await flush();
    assert.equal(f.named('clientAttach').length, 2);
    // эпоха без события доступности (счётчик потерь вырос) — то же
    f.named('clientAttach')[1].resolve(43);
    await flush();
    f.named('changeState')[1].resolve(undefined);
    await flush();
    assert.equal(r.ownCookie, 43);
    f.sub().losses = 1;
    r.step();
    assert.equal(r.ownCookie, null);
    assert.ok(f.named('changeState').every((c) => (c.params as { cookie: number }).cookie !== 42 || c === f.named('changeState')[0]));
  });

  it('тайм-аут attach по именам enum — второго attach в ту же попытку нет; следующая попытка — номерами', async () => {
    const { c, f } = await requestRig();
    f.state('IDLE');
    await flush();
    f.named('clientAttach')[0].reject(new Error('callMethod timeout'));
    await flush();
    assert.equal(f.named('clientAttach').length, 1, 'после тайм-аута второй attach не уходит');
    await c.advance(1000);
    assert.equal(f.named('clientAttach').length, 2);
    assert.deepEqual(f.named('clientAttach')[1].params, { type: 1 });
  });

  it('штатный обзор: свой cookie отпускается; чужой DR_ACTIVE с принимаемым видом — только слушаем', async () => {
    const { f, r } = await requestRig();
    f.state('IDLE');
    await flush();
    f.named('clientAttach')[0].resolve(7);
    await flush();
    f.named('changeState')[0].resolve(undefined);
    await flush();
    f.state('RFK', 2);
    await flush();
    assert.equal(f.named('clientDetach').length, 1);
    f.named('clientDetach')[0].resolve(undefined);
    await flush();
    f.state('DR_ACTIVE', 7);
    await flush();
    assert.equal(f.named('clientAttach').length, 1);
    assert.match(r.reason, /только слушаем/);
  });
});

/* ---------------- соединение с мостом ---------------- */

describe('камеры: соединение с мостом — поколения', () => {
  it('поздний close/data/connect старого сокета не трогает новое соединение', () => {
    const conns: { on: Parameters<FeedDeps['connect']>[1]; written: string[]; ended: boolean }[] = [];
    let now = 0;
    const deps: FeedDeps = {
      connect: (_p, on) => {
        const c = { on, written: [] as string[], ended: false };
        conns.push(c);
        return { write: (s) => void c.written.push(s), end: () => void (c.ended = true) };
      },
      readHeader: () => null,
      now: () => now,
      setTimer: () => () => undefined,
    };
    const f = new CameraFeeds(deps);
    f.setWanted(true);
    conns[0].on.connect();
    f.setWanted(false);
    f.setWanted(true);
    assert.equal(conns.length, 2);
    conns[1].on.connect();
    conns[1].on.data(encodeLine({ ev: 'state', state: 'running', producer: 'camrx', views: ['front', 'left', 'right'], reason: '', frames: 1, accept: [7], request: 7 } as never));
    // поздние события старого сокета
    conns[0].on.data(encodeLine({ ev: 'state', state: 'error', producer: null, views: [], reason: 'old', frames: 0, accept: [], request: 0 } as never));
    conns[0].on.close('ECONNRESET');
    conns[0].on.connect();
    now = 10;
    const d = f.diagnostics();
    assert.equal(d.connected, true);
    assert.equal(d.bridge!.producer, 'camrx');
    assert.deepEqual(f.need(), { accept: [7], request: 7 });
    assert.equal(conns[0].written.filter((w) => w.indexOf('start') >= 0).length, 1, 'старый сокет не получил второго start');
  });
});

/* ---------------- мост ---------------- */

function bridgeRig() {
  const c = clock();
  const spawned: { child: ChildLike & { killed: string[]; input: string[]; ended: boolean }; hooks: SpawnHooks }[] = [];
  let installed = true;
  const st = (file: boolean) => ({ isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false, uid: 0, mode: file ? 0o755 : 0o755 });
  const deps: Deps = {
    fs: {
      realpathSync: (p) => {
        if (!installed) throw new Error('ENOENT');
        return p === CAMRX ? `${CAMRX_ROOT}/0.1.2/xop-camrx` : p;
      },
      lstatSync: (p) => st(p === `${CAMRX_ROOT}/0.1.2/xop-camrx`),
      existsSync: () => false,
    },
    spawn: (_file, _args, hooks) => {
      const child = { pid: 100 + spawned.length, killed: [] as string[], input: [] as string[], ended: false, write: (l: string) => void child.input.push(l), endInput: () => void (child.ended = true), kill: (s: string) => void child.killed.push(s) };
      spawned.push({ child, hooks });
      return child;
    },
    openVideo: () => ({ write: () => undefined, close: () => undefined }) as never,
    readHeader: () => null,
    unlink: () => undefined,
    now: c.now,
    setTimer: c.setTimer,
    log: () => undefined,
  };
  const b = new Bridge(deps);
  const peer = (): Peer & { got: string[]; closed: boolean } => {
    const p = { got: [] as string[], closed: false, send: (d: Buffer | string) => void p.got.push(String(d)), close: () => void (p.closed = true) };
    return p;
  };
  return { b, c, spawned, peer, setInstalled: (v: boolean) => (installed = v) };
}

describe('мост камер: источник кадров', () => {
  it('рабочий набор — только свой xop-camrx (без чужого mgu-camcluster)', () => {
    assert.deepEqual(PRODUCTION_PRODUCERS.map((p) => p.id), ['camrx']);
    assert.deepEqual(CAMRX_SPEC.args.slice(0, 2), ['--stream', 'media_transport.avb_streaming.1']);
  });

  it('start → stop → start: новый источник не запускается, пока прежний не завершился', async () => {
    const { b, c, spawned, peer } = bridgeRig();
    const p = peer();
    b.connect(p);
    b.data(p, encodeLine({ op: 'start' }));
    assert.equal(spawned.length, 1);
    b.data(p, encodeLine({ op: 'stop' }));
    assert.deepEqual(spawned[0].child.input, ['video on\n', 'video off\n']);
    b.data(p, encodeLine({ op: 'start' }));
    assert.equal(spawned.length, 1, 'второй процесс не запущен поверх останавливающегося');
    await c.advance(3000);
    assert.deepEqual(spawned[0].child.killed, ['SIGTERM']);
    spawned[0].hooks.onExit(null, 'SIGTERM');
    assert.equal(spawned.length, 2, 'после выхода прежнего — запуск');
  });

  it('новое соединение вытесняет прежнее; «start» в течение передачи — источник не перезапускается', async () => {
    const { b, c, spawned, peer } = bridgeRig();
    const p1 = peer();
    b.connect(p1);
    b.data(p1, encodeLine({ op: 'start' }));
    const p2 = peer();
    assert.equal(b.connect(p2), true);
    assert.equal(p1.closed, true);
    b.disconnect(p1); // поздний close старого — не трогает
    b.data(p2, encodeLine({ op: 'start' }));
    await c.advance(HANDOVER_MS + 100);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].child.input.indexOf('video off\n'), -1);
    // а без «start» — остановка
    const p3 = peer();
    b.connect(p3);
    await c.advance(HANDOVER_MS + 100);
    assert.ok(spawned[0].child.input.indexOf('video off\n') >= 0);
  });

  it('источник не установлен: «unavailable», затем повторная проверка — появился, запускается', async () => {
    const { b, c, spawned, peer, setInstalled } = bridgeRig();
    setInstalled(false);
    const p = peer();
    b.connect(p);
    b.data(p, encodeLine({ op: 'start' }));
    const last = () => parseEvent(p.got[p.got.length - 1].trim())!;
    assert.equal(last().state, 'unavailable');
    setInstalled(true);
    await c.advance(5000);
    assert.equal(spawned.length, 1);
  });
});

describe('мост камер: права ctl-сокета', () => {
  const GROUP = 'root:x:0:\nvideo:x:44:\ntm_oap_app:x:1234:a,b\n';
  it('группа приложений из /etc/group → root:gid 0660; числовой GID главнее; иначе 0600 с ошибкой, никогда 0666', () => {
    assert.deepEqual(socketAccess({ XOP_CTL_GROUP: 'tm_oap_app' }, GROUP), { gid: 1234, mode: 0o660, note: 'group tm_oap_app (gid 1234), 0660' });
    assert.equal(socketAccess({ XOP_CTL_GROUP: 'tm_oap_app', XOP_BRIDGE_GID: '77' }, GROUP).gid, 77);
    const missing = socketAccess({ XOP_CTL_GROUP: 'tm_oap_app' }, 'root:x:0:\n');
    assert.equal(missing.gid, null);
    assert.equal(missing.mode, 0o600);
    assert.match(missing.note, /ERROR: group tm_oap_app not in \/etc\/group/);
    assert.equal(socketAccess({}, GROUP).mode, 0o600);
    assert.equal(socketAccess({ XOP_CTL_GROUP: 'bad name;' }, GROUP).mode, 0o600);
    assert.equal(socketAccess({ XOP_CTL_GROUP: 'tm_oap_app' }, null).mode, 0o600);
  });
});
