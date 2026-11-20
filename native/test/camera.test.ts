// Жизненный цикл камер: запрос вида (ICAM2Proxy, свой cookie), соединение с мостом (поколения), мост (источник кадров).
// Внешнее — подделки: SOME/IP-вызовы с отложенными ответами, ручные таймеры, сокеты и процессы.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bridge, HANDOVER_MS, PRODUCTION_PRODUCERS, socketAccess, stallLayer, type ChildLike, type Deps, type Peer, type SpawnHooks } from '../bridge/src/bridge';
import { CAMRX, CAMRX_ROOT, CAMRX_SPEC } from '../bridge/src/camcluster';
import { CTL_LINE_MAX, encodeLine, parseEvent } from '../src/camera/ctl';
import { CameraFeeds, type FeedDeps } from '../src/camera/feeds';
import { arbitrate, ATTACH_READY_MS, camPolicy, CameraRequest, cookieOf, decide, ICAM2, XVIEW, type CamApi, type CamPolicy } from '../src/camera/request';
import type { WatchOpts, WatchResult } from '../src/platform/kitTypes';
import { cameraLines, CAMERA_PAGE, startApp } from '../src/app';
import { PRODUCTION } from '../src/devAccess';
import { fakeCtx, fakeKit, FakeTransport, syntheticAssets } from './helpers';

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
    xvAvailability: (a: boolean) => avail.get(XVIEW)!(a),
    xvSub: () => subs.get(XVIEW)!,
    /** Текущий обработчик XView3D (для проверки, что обработчик прежней подписки ничего не меняет). */
    xvHandler: () => handlers.get(XVIEW)!,
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

  // Два источника состояния: XView3D (незаполненный на iDrive 7 до запуска блока) и ICAM2. Root воспроизвёл: XView3D
  // SIGNAL_UNFILLED/255 закрывал допустимое ICAM2 IDLE/0 — только attach, вида нет.
  it('состояние: незаполненный XView3D не закрывает допустимое ICAM2 (attach и вид 7); источник виден', async () => {
    const { f, r, lines } = await requestRig();
    f.xview('SIGNAL_UNFILLED', 255);
    f.state('IDLE', 0);
    await flush();
    assert.deepEqual(r.state, { application: 'IDLE', mode: 'MODE_MOSAIK', perspective: 0 });
    assert.equal(r.stateSource, 'ICAM2');
    f.named('clientAttach')[0].resolve({ cookie: 21 });
    await flush();
    assert.equal(f.named('changeState').length, 1);
    assert.equal((f.named('changeState')[0].params as { cookie: number }).cookie, 21);
    assert.ok(lines.some((l) => /состояние камер по ICAM2: IDLE\/0/.test(l)));
    assert.ok(lines.some((l) => /XView3D application seen: SIGNAL_UNFILLED/.test(l)));
  });

  it('состояние: штатный обзор у ЛЮБОГО живого источника главнее (свой cookie отпускается)', async () => {
    const { f, r } = await requestRig();
    f.xview('TOPREARVIEW', 1);
    f.state('IDLE', 0);
    await flush();
    assert.equal(r.stateSource, 'XView3D');
    assert.equal(f.named('clientAttach').length, 0, 'штатный обзор только у XView3D — не просим');
    f.xview('SOMETHING', 0);
    await flush();
    f.named('clientAttach')[0].resolve({ cookie: 22 });
    await flush();
    f.named('changeState')[0].resolve(0);
    await flush();
    f.state('SIDEVIEW', 2);
    await flush();
    assert.equal(r.stateSource, 'ICAM2');
    assert.deepEqual(f.named('clientDetach').map((c) => c.params), [{ cookie: 22 }], 'штатный обзор только у ICAM2 — тоже уступаем');
    assert.deepEqual(arbitrate({ application: 'SIGNAL_UNFILLED', mode: '', perspective: 255 }, null).source, 'XView3D');
    assert.equal(arbitrate({ application: 'DR_ACTIVE', mode: '', perspective: 7 }, { application: 'IDLE', mode: '', perspective: 0 }).source, 'XView3D');
    assert.equal(arbitrate({ application: 'IDLE', mode: '', perspective: 0 }, { application: 'DR_ACTIVE', mode: '', perspective: 7 }).source, 'ICAM2', 'DR_ACTIVE главнее «свободно»');
    assert.equal(arbitrate({ application: 'X', mode: '', perspective: 0 }, { application: 'Y', mode: '', perspective: 0 }).source, 'XView3D', 'равные — XView3D');
    assert.deepEqual(arbitrate(null, null), { state: null, source: null });
  });

  it('состояние: XView3D пропал (событие или счётчик потерь) — его штатный обзор больше не действует; вернулся — только свежее уведомление', async () => {
    const { f, r } = await requestRig();
    f.xview('TOPREARVIEW', 1);
    f.state('IDLE', 0);
    await flush();
    assert.equal(f.named('clientAttach').length, 0);
    f.xvAvailability(false);
    await flush();
    assert.equal(r.stateSource, 'ICAM2');
    assert.equal(f.named('clientAttach').length, 1, 'снимок пропавшего XView3D не держит камеры занятыми');
    f.xvAvailability(true);
    await flush();
    assert.equal(r.stateSource, 'ICAM2', 'вернувшийся XView3D без нового уведомления — без состояния');
    // перезапуск без события: вырос счётчик потерь
    f.xview('TOPREARVIEW', 1);
    await flush();
    assert.equal(r.stateSource, 'XView3D');
    f.xvSub().losses = (f.xvSub().losses ?? 0) + 1;
    assert.equal(r.stateSource, 'ICAM2');
  });

  it('состояние: обработчик прежней подписки XView3D (после ухода и возврата на страницу) ничего не меняет', async () => {
    const { f, r } = await requestRig();
    const old = f.xvHandler();
    r.setWanted(false);
    r.setWanted(true);
    await flush();
    f.state('IDLE', 0);
    old({ application: 'TOPREARVIEW', mode: '', perspective: 1 });
    await flush();
    assert.equal(r.stateSource, 'ICAM2');
    assert.equal(f.named('clientAttach').length, 1, 'поздний обратный вызов прежнего поколения не стал штатным обзором');
  });

  // G07 0.1.2: все виды «Недоступно». iDrive 7 запускает блок камер только после attach (Drive Recorder: около 10 с
  // SIGNAL_UNFILLED после attach). Прежнее решение ждало готовности до attach — без чужого клиента это навсегда.
  it('блок не готов (SIGNAL_UNFILLED) без чужого клиента: attach сразу, вид — только когда блок готов, тем же cookie', async () => {
    const { f, r } = await requestRig();
    f.state('SIGNAL_UNFILLED', 255);
    await flush();
    assert.equal(f.named('clientAttach').length, 1, 'attach, чтобы блок запустился');
    f.named('clientAttach')[0].resolve({ cookie: 11 });
    await flush();
    assert.equal(r.ownCookie, 11);
    assert.equal(f.named('changeState').length, 0, 'пока не готов — вид не просим (блок отбрасывает запрошенное)');
    assert.match(r.reason, /ждём готовности/);
    f.state('SIGNAL_UNFILLED', 255);
    await flush();
    assert.equal(f.named('clientAttach').length, 1, 'второго attach нет');
    f.state('DR_STANDBY', 0);
    await flush();
    assert.equal(f.named('changeState').length, 1);
    assert.deepEqual(f.named('changeState')[0].params, { cookie: 11, desiredState: { application: 'DR_ACTIVE', mode: 'MODE_MOSAIK', perspective: 7 } });
    assert.equal(f.named('clientDetach').length, 0);
  });

  it('блок не стал готов за ATTACH_READY_MS после своего attach — свой cookie отпускается; штатный обзор во время запуска — тоже', async () => {
    const { c, f, r } = await requestRig();
    f.state('SIGNAL_UNFILLED', 255);
    await flush();
    f.named('clientAttach')[0].resolve({ cookie: 12 });
    await flush();
    await c.advance(ATTACH_READY_MS + 1500);
    assert.equal(f.named('clientDetach').length, 1);
    assert.deepEqual(f.named('clientDetach')[0].params, { cookie: 12 });
    f.named('clientDetach')[0].resolve(0);
    await flush();
    assert.equal(r.ownCookie, null);
    assert.equal(f.named('changeState').length, 0);
    const base = { wanted: true, available: true, need: NEED, ownView: 0, triesLeft: true, verifying: false };
    const st = (application: string, perspective = 0) => ({ application, mode: '', perspective });
    assert.equal(decide({ ...base, ownCookie: false, state: st('SIGNAL_UNFILLED', 255) }).act, 'attach');
    assert.equal(decide({ ...base, ownCookie: false, state: st('SIGNAL_UNFILLED', 255), requestEnabled: false }).act, 'none');
    assert.equal(decide({ ...base, ownCookie: false, state: st('SIGNAL_UNFILLED', 255), triesLeft: false }).act, 'none');
    assert.equal(decide({ ...base, ownCookie: true, state: st('SIGNAL_UNFILLED', 255) }).act, 'none');
    assert.equal(decide({ ...base, ownCookie: true, state: st('TOPREARVIEW', 255) }).act, 'release', 'штатный обзор главнее и при запуске');
  });

  it('DR_ACTIVE с видом 0 после своего запроса (не применён): просим снова тем же cookie, а не отпускаем как чужую смену вида', async () => {
    const { c, f, r } = await requestRig();
    f.state('DR_STANDBY');
    await flush();
    f.named('clientAttach')[0].resolve({ cookie: 13 });
    await flush();
    f.named('changeState')[0].resolve(0);
    await flush();
    f.state('DR_ACTIVE', 0);
    await c.advance(7000);
    assert.equal(f.named('clientDetach').length, 0, 'вид 0 — не чужой вид');
    assert.equal(f.named('changeState').length, 2);
    assert.equal((f.named('changeState')[1].params as { cookie: number }).cookie, 13);
    assert.equal(r.ownCookie, 13);
    const base = { wanted: true, available: true, need: NEED, ownView: 7, triesLeft: true, verifying: false };
    assert.equal(decide({ ...base, ownCookie: false, state: { application: 'DR_ACTIVE', mode: '', perspective: 0 } }).act, 'none', 'чужой DR_ACTIVE/0 без своего cookie не трогаем');
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
  it('полная русская причина и отдельные счётчики I/IDR доходят до листа поддержки', () => {
    let hooks: Parameters<FeedDeps['connect']>[1] | undefined;
    const feeds = new CameraFeeds({
      connect: (_path, on) => { hooks = on; return { write: () => undefined, end: () => undefined }; },
      readHeader: () => null, now: () => 0, setTimer: () => () => undefined,
    });
    const recovery = { idr: 0, cleanIdr: 0, intra: 120, standaloneIntra: 118, nonProgressive: 2, waitingIdr: true };
    const line = encodeLine({ ev: 'state', state: 'stalled', producer: 'camrx', views: ['front', 'left', 'right'],
      reason: 'я'.repeat(160), frames: 0, ...NEED, recovery });
    assert.ok(Buffer.byteLength(line, 'utf8') > 512 && Buffer.byteLength(line, 'utf8') <= CTL_LINE_MAX);
    assert.deepEqual(parseEvent(line)!.recovery, recovery);
    feeds.setWanted(true);
    hooks!.connect();
    hooks!.data(line);
    const lines = cameraLines(feeds, null);
    assert.ok(lines.some((l) => l.label === 'IDR · целых / получено' && l.value === '0 / 0 · ожидание да'));
    assert.ok(lines.some((l) => l.label === 'I-кадры · получено / выведено отдельно' && l.value === '120 / 118'));
    feeds.dispose();
  });

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
  it('повторное открытие страницы не использует готовность прежнего приёмника', async () => {
    const f = fakeIcam();
    const connections: Parameters<FeedDeps['connect']>[1][] = [];
    const feeds: FeedDeps = {
      connect: (_path, on) => { connections.push(on); return { write: () => undefined, end: () => undefined }; },
      readHeader: () => null,
      now: () => 0,
      setTimer: () => () => undefined,
    };
    const app = startApp(fakeCtx(new FakeTransport(), {}, { own: true }), fakeKit(), syntheticAssets(), () => 0, PRODUCTION, { api: f.api, feeds });
    try {
      app.setPage(CAMERA_PAGE);
      await flush();
      f.state('IDLE');
      connections[0].connect();
      connections[0].data(encodeLine({ ev: 'state', state: 'starting', producer: 'camrx', views: ['front', 'left', 'right'], reason: '', frames: 0, ...NEED }));
      app.render();
      await flush();
      assert.equal(f.named('clientAttach').length, 1);
      f.named('clientAttach')[0].resolve(42);
      await flush();
      f.named('changeState')[0].resolve(0);
      await flush();
      app.setPage(0);
      await flush();
      f.named('clientDetach')[0].resolve(0);
      await flush();
      app.setPage(CAMERA_PAGE);
      await flush();
      f.state('IDLE');
      await flush();
      assert.equal(f.named('clientAttach').length, 1, 'старое need не запускает камеры до готовности нового соединения');
    } finally {
      await app.dispose();
    }
  });

  it('запрос ICAM2 ждёт регистрации AVB, включая caps до готовности и новый процесс', async () => {
    const { b, c, spawned } = bridgeRig();
    const f = fakeIcam();
    const request = new CameraRequest(f.api, c.now, c.setTimer);
    request.setWanted(true);
    await flush();
    f.state('IDLE');
    const peer: Peer = {
      send: (line) => {
        const ev = parseEvent(String(line).trim());
        if (ev) request.setNeed(ev.producer ? { accept: ev.accept, request: ev.request } : null);
      },
      close: () => undefined,
    };
    b.connect(peer);
    b.data(peer, encodeLine({ op: 'start' }));
    await flush();
    assert.equal(f.named('clientAttach').length, 0, 'запуск процесса ещё не означает готовность AVB');
    spawned[0].hooks.onLine('out', JSON.stringify({ ev: 'caps', views: ['front', 'left', 'right'], accept: [7], request: 7 }));
    await flush();
    assert.equal(f.named('clientAttach').length, 0, 'описание формата тоже не подтверждает регистрацию AVB');
    spawned[0].hooks.onLine('out', '{"ev":"receiver_ready"}');
    await flush();
    assert.equal(f.named('clientAttach').length, 1);
    f.named('clientAttach')[0].resolve(42);
    await flush();
    assert.equal(f.named('changeState').length, 1);
    f.named('changeState')[0].resolve(0);
    await flush();
    spawned[0].hooks.onExit(1, null);
    await flush();
    assert.equal(f.named('clientDetach').length, 1, 'исчезновение готового источника отпускает свой запрос');
    f.named('clientDetach')[0].resolve(0);
    await c.advance(5000);
    assert.equal(spawned.length, 2);
    assert.equal(f.named('clientAttach').length, 1, 'новый процесс снова ждёт готовности');
    spawned[0].hooks.onLine('out', '{"ev":"receiver_ready"}');
    await flush();
    assert.equal(f.named('clientAttach').length, 1, 'готовность прежнего процесса больше не действует');
    spawned[1].hooks.onLine('out', '{"ev":"receiver_ready"}');
    await flush();
    assert.equal(f.named('clientAttach').length, 2);
    request.setWanted(false);
    f.named('clientAttach')[1].resolve(43);
    await flush();
    f.named('clientDetach')[1].resolve(0);
    b.disconnect(peer);
  });

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

  it('нет кадров: причина «stalled» называет слой по статистике xop-camrx и не меняется от счётчиков', async () => {
    const S = (o: Record<string, unknown>) => JSON.stringify({ ev: 'stats', active: 1, packets: 0, units: 0, frames: 0, front: 0, left: 0, right: 0, wait_idr: 0, unlabelled: 0, decode_errors: 0, rtp_bad: 0, tag: '0/0/0/0', size: '0x0', ...o });
    assert.equal(stallLayer('not stats'), '');
    assert.match(stallLayer(S({ active: 0 })), /приёмник AVB не запущен/);
    assert.match(stallLayer(S({})), /пакетов нет/);
    assert.match(stallLayer(S({ packets: 900, rtp_bad: 3 })), /блоков H\.264 нет.*ошибок RTP 3/);
    assert.match(stallLayer(S({ packets: 900, units: 40, wait_idr: 40, tag: '1/51/50/9', size: '0x0' })), /ждём чистого IDR; метка 1\/51\/50\/9$/);
    assert.match(stallLayer(S({ packets: 900, units: 40, frames: 0, decode_errors: 2 })), /декодер с ошибками/);
    assert.match(stallLayer(S({ packets: 900, units: 40, frames: 30, unlabelled: 30 })), /нет метки камеры/);
    assert.match(stallLayer(S({ packets: 900, units: 40, frames: 30, tag: '1/51/50/7', size: '1280x960' })), /вид не разобран.*метка 1\/51\/50\/7, кадр 1280x960/);
    const side = { packets: 900, units: 40, frames: 30, tag: '1/51/50/10', size: '1280x480' };
    assert.match(stallLayer(S({ ...side, unmatched: 30, unlabelled: 1 })), /потерял привязку.*1\/51\/50\/10, кадр 1280x480/);
    assert.match(stallLayer(S({ ...side, bad_size: 30 })), /неподдерживаемый размер кадра/);
    assert.match(stallLayer(S({ ...side, not_shown: 30, wait_idr: 30 })), /ждём чистого IDR/);
    assert.match(stallLayer(S({ ...side, left: 30, right: 30, file_errors: 60 })), /ошибка записи файла/);
    assert.equal(stallLayer(S({ packets: 900, units: 40, frames: 30, front: 15 })), '');
    assert.equal(stallLayer(S({ packets: 100, wait_idr: 0 })), stallLayer(S({ packets: 9999, rtp_lost: 7 })), 'счётчики не меняют причину');

    const { b, c, spawned, peer } = bridgeRig();
    const p = peer();
    b.connect(p);
    b.data(p, encodeLine({ op: 'start' }));
    spawned[0].hooks.onLine('out', S({ packets: 5000, units: 300, wait_idr: 300, tag: '1/51/50/9' }));
    await c.advance(11000);
    const last = parseEvent(p.got[p.got.length - 1].trim())!;
    assert.equal(last.state, 'stalled');
    assert.match(last.reason, /нет кадров: блоки H\.264 есть, ждём чистого IDR; метка 1\/51\/50\/9/);
    const before = p.got.length;
    spawned[0].hooks.onLine('out', S({ packets: 6000, units: 360, wait_idr: 360, tag: '1/51/50/9' }));
    await c.advance(5000);
    assert.ok(p.got.slice(before).every((l) => parseEvent(l.trim())!.reason === last.reason), 'та же причина при новых счётчиках');

    spawned[0].hooks.onLine('out', S({ packets: 7000, units: 420, frames: 60, front: 30, wait_idr: 360 }));
    spawned[0].hooks.onLine('out', S({ packets: 8000, units: 480, frames: 120, front: 30, wait_idr: 360, unmatched: 60, tag: '1/51/50/10', size: '1280x480' }));
    await c.advance(1000);
    assert.match(parseEvent(p.got[p.got.length - 1].trim())!.reason, /декодер потерял привязку кадра/);
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
