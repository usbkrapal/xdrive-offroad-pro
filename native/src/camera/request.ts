// Запрос обычного вида камер у блока камер (ICAM2Proxy) — узко и с уступкой штатным видам.
// Факты интерфейса (не код) — из изученных материалов Drive Recorder / Turn View (QA_CAR_FIX_0.1.2.md, «Камеры»):
//   ICAM2Proxy (экземпляр '1'): clientAttach({type: CLIENT_INDIRECT=1}) → cookie; changeState({cookie,
//   desiredState: {application: DR_ACTIVE=51, mode: MODE_MOSAIK=50, perspective: вид}}); clientDetach({cookie});
//   поле currentState {application, mode, perspective}. XView3D: поле CurrentState той же формы (главнее, если есть).
//   Не готов: application SIGNAL_UNFILLED/255 или perspective 255. Штатные обзоры (парковка и т. п.): application
//   TOPREARVIEW 1, SIDEVIEW 2, RFK 3, OFFROAD 20, REMOTE360 60. Виды: 1 передняя, 2 задняя, 3 левая, 4 правая,
//   5 передняя+задняя (кадры 5/6), 6 левая+правая (7/8), 7 все (9/10).
// Правила (решает decide(), чистая функция с тестами):
//   - во время штатного обзора — ни одного запроса; свой cookie при штатном обзоре отпускается;
//   - блок не готов (SIGNAL_UNFILLED/255): на iDrive 7 он запускается только после attach (Drive Recorder: около 10 с
//     «CAMERA_INITIALIZING» после attach) — без чужого клиента ждать бесполезно. Поэтому attach косвенным клиентом
//     (в пределах попыток), вид — только когда блок станет готов; не готов за ATTACH_READY_MS — cookie отпускается;
//   - если уже идёт DR_ACTIVE с видом, кадры которого источник умеет брать, — только слушаем (ничего не запрашиваем);
//   - чужой DR_ACTIVE с другим видом (обычно Drive Recorder пишет «все камеры») не переопределяется;
//   - запрос — когда страница открыта, блок готов, нет штатного обзора и нет DR_ACTIVE (ни чужого, ни своего с другим
//     видом): attach как КОСВЕННЫЙ клиент (CLIENT_INDIRECT) и changeState нужного вида; не больше TRIES попыток за
//     RETRY_MS, каждая проверяется по currentState. Так же ведут себя оба опубликованных клиента (Drive Recorder,
//     Turn View — только факты поведения: косвенный клиент уступает штатным видам, число попыток ограничено). Значения
//     «простоя» в источниках нет: неизвестное application не считается ни простоем, ни занятостью — запрос косвенный,
//     с ограничением попыток; каждое новое значение пишется в журнал. Разработчик: XOP_CAM_REQUEST=off — только
//     слушать; XOP_CAM_BUSY=ИМЯ[,…] — дополнительные application, при которых не просить;
//   - отпускается только СВОЙ cookie: уход со страницы, закрытие, штатный обзор, чужая смена вида.
//   - доступность ICAM2Proxy — только по его подписке (не по XView3D); потеря провайдера (новая эпоха) забывает
//     cookie без detach: на новом провайдере он не наш. Каждый асинхронный шаг (proxy, attach, changeState, detach)
//     привязан к эпохе, в которой начат: результат прошлой эпохи не принимается (cookie не берётся, вид не
//     запрашивается, кодирование не запоминается) и чужой по эпохе cookie не отпускается;
//   - изменения во время незавершённого вызова не теряются: по его окончании решение принимается заново (уход со
//     страницы во время changeState отпускает cookie).

import type { Log, WatchFn, WatchResult } from '../platform/kitTypes';

export const ICAM2 = 'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy';
export const XVIEW = 'de.bmw.dass.XView3D';
export const CAM_WIRE = { CLIENT_INDIRECT: 1, DR_ACTIVE: 51, MODE_MOSAIK: 50 } as const;
const PARKING = /^(TOPREARVIEW|SIDEVIEW|RFK|OFFROAD|REMOTE360|1|2|3|20|60)$/;
export const TRIES = 3;
export const RETRY_MS = 30000;
/** Сколько ждать, что запрошенный вид появился в currentState. */
export const VERIFY_MS = 6000;
export const STATE_POLL_MS = 2000;

export interface CamState {
  readonly application: string;
  readonly mode: string;
  readonly perspective: number;
}

/** Что умеет источник кадров (сообщает мост): какие показанные виды он берёт и какой просить, если камеры свободны. */
export interface ProducerNeed {
  /** perspective из currentState, кадры которого источник разбирает (например 1/5/6 для передней у mgu-camcluster). */
  readonly accept: readonly number[];
  /** Вид, который просить, когда камеры свободны (0 — не просить). */
  readonly request: number;
}

export function camState(v: unknown): CamState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.application === undefined || o.perspective === undefined) return null;
  const p = Number(o.perspective);
  return { application: String(o.application).slice(0, 32), mode: String(o.mode).slice(0, 32), perspective: Number.isFinite(p) ? p : -1 };
}

export const notReady = (s: CamState) => /^(SIGNAL_UNFILLED|255)$/.test(s.application) || s.perspective === 255;
export const parking = (s: CamState) => PARKING.test(s.application);
export const drActive = (s: CamState) => /^(DR_ACTIVE|51)$/.test(s.application);

export type StateSource = 'XView3D' | 'ICAM2';
/**
 * Одно состояние камер из двух живых источников (снимок пропавшего провайдера сюда не передаётся). Главнее то, что
 * осторожнее для штатных видов: штатный обзор у ЛЮБОГО источника, затем DR_ACTIVE, затем иное допустимое, и лишь
 * потом «не готов». Так незаполненный XView3D (SIGNAL_UNFILLED/255) не закрывает допустимое состояние ICAM2, а штатный
 * обзор, о котором сообщил только один источник, не теряется. Равные — XView3D (как у Drive Recorder).
 */
export function arbitrate(xv: CamState | null, icam: CamState | null): { state: CamState | null; source: StateSource | null } {
  const rank = (s: CamState) => (parking(s) ? 0 : drActive(s) ? 1 : notReady(s) ? 3 : 2);
  if (xv && (!icam || rank(xv) <= rank(icam))) return { state: xv, source: 'XView3D' };
  if (icam) return { state: icam, source: 'ICAM2' };
  return { state: null, source: null };
}

/**
 * iDrive 7: блок камер запускается ПОСЛЕ attach (Drive Recorder recorder.js: «CAMERA_INITIALIZING for about 10 s after
 * the attach», SIGNAL_UNFILLED / perspective 255, запрошенное в это время отбрасывается). Без чужого клиента состояние
 * «не готов» само не проходит: attach нужен, чтобы блок стал готов. Столько ждём готовности после своего attach.
 */
export const ATTACH_READY_MS = 20000;

export type Decision =
  | { readonly act: 'none'; readonly why: string }
  | { readonly act: 'request'; readonly view: number; readonly why: string }
  | { readonly act: 'attach'; readonly why: string }
  | { readonly act: 'release'; readonly why: string };

export interface DecideInput {
  readonly wanted: boolean;
  readonly available: boolean;
  readonly state: CamState | null;
  readonly need: ProducerNeed | null;
  readonly ownCookie: boolean;
  /** Вид, который мы запросили своим cookie (0 — не запрашивали). */
  readonly ownView: number;
  readonly triesLeft: boolean;
  readonly verifying: boolean;
  /** Запрос вида разрешён (по умолчанию да; XOP_CAM_REQUEST=off — только слушать). */
  readonly requestEnabled?: boolean;
  /** Дополнительные application, при которых не просить (наблюдённые занятые; XOP_CAM_BUSY). */
  readonly busyApps?: readonly string[];
  /** Свой cookie взят, а блок так и не стал готов за ATTACH_READY_MS. */
  readonly attachWaitOver?: boolean;
}

export function decide(i: DecideInput): Decision {
  if (!i.wanted) return i.ownCookie ? { act: 'release', why: 'страница не на экране' } : { act: 'none', why: 'страница не на экране' };
  if (!i.available) return { act: 'none', why: 'ICAM2Proxy недоступен' };
  const s = i.state;
  if (!s) return { act: 'none', why: 'состояния камер нет' };
  if (parking(s)) return i.ownCookie ? { act: 'release', why: `штатный обзор (${s.application}): уступаем` } : { act: 'none', why: `штатный обзор (${s.application})` };
  if (!i.need || !i.need.accept.length) return i.ownCookie ? { act: 'release', why: 'источника кадров нет' } : { act: 'none', why: 'источника кадров нет' };
  if (notReady(s)) {
    // iDrive 7: блок запускается только после attach (ATTACH_READY_MS); вид просим, когда станет готов
    if (i.ownCookie) {
      return i.attachWaitOver
        ? { act: 'release', why: `блок камер не стал готов за ${ATTACH_READY_MS / 1000} с после attach: отпускаем` }
        : { act: 'none', why: 'блок камер запускается после attach: ждём готовности' };
    }
    if (!i.need.request) return { act: 'none', why: 'блок камер не готов; источник не просит вид' };
    if (i.requestEnabled === false) return { act: 'none', why: 'блок камер не готов; запрос выключен разработчиком (XOP_CAM_REQUEST=off)' };
    if (!i.triesLeft) return { act: 'none', why: `блок камер не готов; попытки исчерпаны: повтор через ${RETRY_MS / 1000} с` };
    return { act: 'attach', why: `блок камер не готов (${s.application}/${s.perspective}): attach косвенным клиентом, чтобы он запустился` };
  }
  if (drActive(s) && i.need.accept.indexOf(s.perspective) >= 0) return { act: 'none', why: `вид ${s.perspective} уже идёт: только слушаем` };
  // DR_ACTIVE с видом 0: запрос ещё не применён (чёрная заливка; 0 — не вид, его никто не просит) — при своём cookie
  // просим снова в пределах попыток, а не отпускаем как «чужую смену вида»
  const unapplied = drActive(s) && s.perspective === 0 && i.ownCookie;
  if (drActive(s) && !unapplied) {
    if (i.ownCookie && i.verifying) return { act: 'none', why: `ждём вид ${i.ownView}` };
    if (i.ownCookie) return { act: 'release', why: `вид сменён на ${s.perspective} не нами: не спорим` };
    return { act: 'none', why: `камеры заняты видом ${s.perspective} (Drive Recorder или другое приложение): не переопределяем` };
  }
  if (!i.need.request) return { act: 'none', why: 'источник не просит вид' };
  if (i.requestEnabled === false) return { act: 'none', why: 'запрос вида выключен разработчиком (XOP_CAM_REQUEST=off): только слушаем' };
  if (i.busyApps && i.busyApps.indexOf(s.application) >= 0) return { act: 'none', why: `камеры заняты (${s.application}, список XOP_CAM_BUSY): не просим` };
  if (i.verifying) return { act: 'none', why: `ждём вид ${i.ownView}` };
  if (!i.triesLeft) return { act: 'none', why: `попытки исчерпаны: повтор через ${RETRY_MS / 1000} с` };
  return { act: 'request', view: i.need.request, why: `камеры не заняты штатным видом (${s.application}): просим вид ${i.need.request} косвенным клиентом` };
}

/** Настройки разработчика из окружения: XOP_CAM_REQUEST=off (только слушать), XOP_CAM_BUSY=ИМЯ[,…] (до 8 имён/чисел enum). */
export const CAM_REQUEST_ENV = 'XOP_CAM_REQUEST';
export const CAM_BUSY_ENV = 'XOP_CAM_BUSY';
export interface CamPolicy {
  readonly requestEnabled: boolean;
  readonly busyApps: readonly string[];
}
export function camPolicy(env: Readonly<Record<string, string | undefined>>): CamPolicy {
  return {
    requestEnabled: String(env[CAM_REQUEST_ENV] || '').toLowerCase() !== 'off',
    busyApps: String(env[CAM_BUSY_ENV] || '')
      .split(/[,\s]+/)
      .filter((t) => /^[A-Z0-9_]{1,32}$/.test(t))
      .slice(0, 8),
  };
}

/** Результат прошлой эпохи провайдера: ничего из него не принимается. */
class StaleEpoch extends Error {}

/** Вызовы SOME/IP, нужные контроллеру (kit signals.js). */
export interface CamApi {
  proxy(iface: string, instance: string): Promise<unknown>;
  call(p: unknown, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  watch: WatchFn;
}

const errText = (e: unknown) => String(e && (e as Error).message ? (e as Error).message : e).slice(0, 100);

/** Cookie из ответа clientAttach: только целое число или {cookie: целое}. Иное (коды ошибок, другие поля) — не cookie. */
export function cookieOf(r: unknown): number | null {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (ok(r)) return r;
  if (r && typeof r === 'object' && ok((r as Record<string, unknown>).cookie)) return (r as Record<string, number>).cookie;
  return null;
}

/** Ошибка кодирования параметров (имя enum не принято), а не тайм-аут/транспорт: тогда можно сразу попробовать номера. */
const encodingError = (e: unknown) => /enum|encod|invalid|argument|type|convert|unknown value/i.test(errText(e)) && !/time/i.test(errText(e));

export class CameraRequest {
  private wanted = false;
  private need: ProducerNeed | null = null;
  private icamState: CamState | null = null;
  private xvState: CamState | null = null;
  private subs: WatchResult[] = [];
  private gen = 0;
  private px: unknown = null;
  private cookie: number | null = null;
  private ownView = 0;
  private verifyUntil = 0;
  private tries = 0;
  private triesAt = 0;
  private busy = false;
  /** step() пришёлся на незавершённый вызов: решить заново по его окончании. */
  private dirty = false;
  private lastWhy = '';
  private timer: (() => void) | null = null;
  /** Какое кодирование enum принял провайдер ('name' / 'number'); null — ещё не известно. */
  private encoding: 'name' | 'number' | null = null;
  private firstTry: 'name' | 'number' = 'name';
  private icamSub: WatchResult | null = null;
  private icamUp = false;
  private icamLosses = 0;
  private xvSub: WatchResult | null = null;
  private xvUp = false;
  private xvLosses = 0;
  private lastSource = '';
  private readonly seenApps = new Set<string>();
  /** Эпоха провайдера ICAM2Proxy: растёт при каждой его потере/перезапуске. */
  private epoch = 0;
  /** Эпоха, в которой получен свой cookie. */
  private cookieEpoch = -1;
  /** Когда взят свой cookie (null — нет): срок готовности блока после attach. */
  private attachedAt: number | null = null;

  constructor(
    private readonly api: CamApi,
    private readonly now: () => number,
    private readonly setTimer: (fn: () => void, ms: number) => () => void,
    private readonly log?: Log,
    private readonly policy: CamPolicy = { requestEnabled: true, busyApps: [] },
  ) {}

  private note(s: string): void {
    if (s === this.lastWhy || !this.log) return;
    this.lastWhy = s;
    this.log.info(`camera request: ${s}`.slice(0, 240));
  }

  /** Решающее состояние: живые XView3D и ICAM2 по arbitrate(). */
  get state(): CamState | null {
    return this.arbitrated().state;
  }
  /** Откуда решающее состояние (журнал и лист диагностики). */
  get stateSource(): StateSource | null {
    return this.arbitrated().source;
  }
  private arbitrated(): { state: CamState | null; source: StateSource | null } {
    this.syncXview();
    return arbitrate(this.xvUp ? this.xvState : null, this.icamState);
  }

  /** XView3D перезапущен без события доступности (вырос счётчик потерь): его прежний снимок не действителен. */
  private syncXview(): void {
    const losses = this.xvSub?.losses;
    if (losses !== undefined && losses !== this.xvLosses) {
      this.xvLosses = losses;
      this.xvLost('XView3D перезапущен');
    }
  }
  private xvLost(why: string): void {
    if (this.xvState) this.log?.info(`camera request: ${why}: состояние ${this.xvState.application}/${this.xvState.perspective} больше не действует`.slice(0, 240));
    this.xvState = null;
  }
  get ownCookie(): number | null {
    return this.cookie;
  }
  get reason(): string {
    return this.lastWhy;
  }

  /** Страница «Камеры» на экране (с данными автомобиля). */
  setWanted(on: boolean): void {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) this.subscribe();
    this.step();
    if (!on) this.unsubscribe();
  }

  setNeed(need: ProducerNeed | null): void {
    const k = JSON.stringify(need);
    if (k === JSON.stringify(this.need)) return;
    this.need = need;
    this.step();
  }

  private subscribe(): void {
    const g = ++this.gen;
    const watchOne = (iface: string, field: string, set: (s: CamState | null) => void, onAvailability?: (a: boolean) => void) =>
      this.api
        .watch(iface, '1', { [field]: (v) => g === this.gen && (set(camState(v)), this.step()) }, this.log, {
          fieldPollMs: { [field]: STATE_POLL_MS },
          pollMs: STATE_POLL_MS,
          onAvailability: onAvailability && ((a) => g === this.gen && onAvailability(a)),
        })
        .then((r) => {
          if (g !== this.gen) return void r.shutdown();
          this.subs.push(r);
          if (iface === ICAM2) {
            this.icamSub = r;
            this.icamUp = r.available;
            this.icamLosses = r.losses ?? 0;
          } else {
            this.xvSub = r;
            // уведомление уже пришло — провайдер жив (watch не доставляет уведомлений, пока он известно недоступен)
            this.xvUp = this.xvUp || r.available;
            this.xvLosses = r.losses ?? 0;
          }
          if (r.error) this.note(`${iface}: ${r.error}`);
          this.step();
        })
        .catch((e) => this.note(`${iface}: ${errText(e)}`));
    void watchOne(
      ICAM2,
      'currentState',
      (s) => {
        this.icamState = s;
        if (s && !this.seenApps.has(s.application) && this.seenApps.size < 16) {
          this.seenApps.add(s.application);
          this.log?.info(`camera request: ICAM2 application seen: ${s.application} mode ${s.mode} perspective ${s.perspective}`.slice(0, 240));
        }
      },
      (a) => {
        if (!a && this.icamUp) this.providerLost('ICAM2Proxy пропал');
        // потеря уже учтена событием доступности: счётчик потерь подписки — та же потеря, не новая эпоха
        if (a && this.icamSub && this.icamSub.losses !== undefined) this.icamLosses = this.icamSub.losses;
        this.icamUp = a;
        this.step();
      },
    );
    void watchOne(
      XVIEW,
      'CurrentState',
      (s) => {
        this.syncXview();
        this.xvState = s;
        // доставленное уведомление — живой провайдер (недоступному watch уведомлений не доставляет)
        this.xvUp = true;
        if (s && !this.seenApps.has(`xv:${s.application}`) && this.seenApps.size < 16) {
          this.seenApps.add(`xv:${s.application}`);
          this.log?.info(`camera request: XView3D application seen: ${s.application} mode ${s.mode} perspective ${s.perspective}`.slice(0, 240));
        }
      },
      (a) => {
        // пропал — его снимок (в том числе штатный обзор) больше не действует; вернулся — ждём свежего уведомления
        if (!a) this.xvLost('XView3D пропал');
        if (this.xvSub && this.xvSub.losses !== undefined) this.xvLosses = this.xvSub.losses;
        this.xvUp = a;
        this.step();
      },
    );
    if (!this.timer) this.tick();
  }

  private unsubscribe(): void {
    this.gen++;
    const subs = this.subs;
    this.subs = [];
    for (const s of subs) void Promise.resolve(s.shutdown()).catch(() => undefined);
    this.icamState = this.xvState = null;
    this.icamSub = null;
    this.icamUp = false;
    this.xvSub = null;
    this.xvUp = false;
    if (this.timer) {
      this.timer();
      this.timer = null;
    }
    // свой cookie ещё не отпущен (вызов не завершён): проверка продолжается, пока он не отпущен
    if (this.cookie !== null || this.busy) this.tick();
  }

  /** Провайдер ICAM2Proxy пропал / сменил эпоху: прежний cookie на новом провайдере не наш — забыть без detach. */
  private providerLost(why: string): void {
    this.epoch++;
    if (this.cookie !== null) this.note(`${why}: cookie ${this.cookie} забыт (на новом провайдере не наш), без detach`);
    this.cookie = null;
    this.cookieEpoch = -1;
    this.attachedAt = null;
    this.ownView = 0;
    this.verifyUntil = 0;
    this.px = null;
    // состояние прежней эпохи (и XView3D) не основание для запроса на новом провайдере: ждём свежее
    this.icamState = null;
    this.xvState = null;
    this.encoding = null;
  }

  /** Сверить эпоху по счётчику потерь подписки (перезапуск без события доступности). */
  private syncEpoch(): void {
    const losses = this.icamSub?.losses;
    if (losses !== undefined && losses !== this.icamLosses) {
      this.icamLosses = losses;
      this.providerLost('ICAM2Proxy перезапущен');
    }
  }

  /** После каждого ожидания: эпоха та же, иначе результат не принимается. */
  private still(ep: number): void {
    this.syncEpoch();
    if (ep !== this.epoch) throw new StaleEpoch('провайдер сменился во время вызова');
  }

  /** Раз в секунду: проверка запроса и срок попыток. */
  private tick(): void {
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.step();
      if (this.wanted || this.cookie !== null || this.busy) this.tick();
    }, 1000);
  }

  /** Только подписка ICAM2Proxy (XView3D не говорит, доступен ли ICAM2Proxy). */
  private available(): boolean {
    return this.icamSub !== null && this.icamUp;
  }

  step(): void {
    // откуда решающее состояние — в журнал при каждой смене (и во время незавершённого вызова)
    const a = this.arbitrated();
    const src = a.state ? `${a.source}: ${a.state.application}/${a.state.perspective}` : '';
    if (src !== this.lastSource) {
      this.lastSource = src;
      if (src) this.log?.info(`camera request: состояние камер по ${src}`.slice(0, 240));
    }
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    // новая эпоха провайдера (счётчик потерь вырос) без события доступности
    this.syncEpoch();
    const t = this.now();
    if (this.verifyUntil && t > this.verifyUntil) {
      this.verifyUntil = 0;
      const s = this.state;
      if (!(s && drActive(s) && this.need && this.need.accept.indexOf(s.perspective) >= 0)) this.note(`вид ${this.ownView} не появился за ${VERIFY_MS / 1000} с`);
    }
    if (t - this.triesAt > RETRY_MS) {
      this.tries = 0;
      this.triesAt = t;
    }
    const d = this.decideNow();
    this.note(d.why);
    if (d.act === 'request') void this.request(d.view);
    else if (d.act === 'attach') void this.request(0);
    else if (d.act === 'release') void this.release(d.why);
  }

  private decideNow(): Decision {
    return decide({
      wanted: this.wanted,
      available: this.available(),
      state: this.state,
      need: this.need,
      ownCookie: this.cookie !== null,
      ownView: this.ownView,
      triesLeft: this.tries < TRIES,
      verifying: this.verifyUntil > 0,
      requestEnabled: this.policy.requestEnabled,
      busyApps: this.policy.busyApps,
      attachWaitOver: this.cookie !== null && this.ownView === 0 && this.attachedAt !== null && this.now() - this.attachedAt > ATTACH_READY_MS,
    });
  }

  /** Прокси текущей эпохи; полученный после смены эпохи — не кэшируется и не используется. */
  private async proxy(ep: number): Promise<unknown> {
    this.still(ep);
    if (this.px) return this.px;
    const p = await this.api.proxy(ICAM2, '1');
    this.still(ep);
    this.px = p;
    return p;
  }

  /**
   * Имена enum, затем номера (привязка может принимать одно или другое). Номера — сразу только при ошибке
   * кодирования; после тайм-аута второй вызов не делается (первый мог пройти: второй attach оставил бы чужой
   * cookie) — следующая попытка начнёт с другого кодирования. Принятое кодирование запоминается.
   */
  private async callEither(ep: number, p: unknown, method: string, byName: Record<string, unknown>, byNumber: Record<string, unknown>): Promise<unknown> {
    const first = this.encoding ?? this.firstTry;
    const args = (k: 'name' | 'number') => (k === 'name' ? byName : byNumber);
    try {
      this.still(ep);
      const r = await this.api.call(p, method, args(first), 5000);
      // результат прошлой эпохи: ни кодирование, ни ответ не принимаются (вызывающий решит, что с ним делать)
      if (ep === this.epoch) this.encoding = first;
      return r;
    } catch (e) {
      if (e instanceof StaleEpoch) throw e;
      const other = first === 'name' ? 'number' : 'name';
      if (this.encoding !== null || !encodingError(e) || ep !== this.epoch) {
        // тайм-аут/транспорт при неизвестном кодировании: следующая попытка начнёт с другого
        if (this.encoding === null && ep === this.epoch) this.firstTry = other;
        throw e;
      }
      this.note(`${method}: ${errText(e)}; пробуем ${other === 'number' ? 'номера' : 'имена'} enum`);
      this.still(ep);
      const r = await this.api.call(p, method, args(other), 5000);
      if (ep === this.epoch) this.encoding = other;
      return r;
    }
  }

  private async request(view: number): Promise<void> {
    this.busy = true;
    this.tries++;
    this.syncEpoch();
    const ep = this.epoch;
    let stale = false;
    try {
      if (this.cookie === null) {
        const p = await this.proxy(ep);
        const r = await this.callEither(ep, p, 'clientAttach', { type: 'CLIENT_INDIRECT' }, { type: CAM_WIRE.CLIENT_INDIRECT });
        const c = cookieOf(r);
        this.syncEpoch();
        if (ep !== this.epoch) {
          // выдан провайдером, которого больше нет: чей он на новом — неизвестно; не берём и не отпускаем
          this.note(`attach: ответ прошлой эпохи провайдера (cookie ${c === null ? '—' : c}) не принят и не отпускается`);
          stale = true;
          return;
        }
        if (c === null) throw new Error('clientAttach: no cookie');
        this.cookie = c;
        this.cookieEpoch = ep;
        this.attachedAt = this.now();
        this.note(`attach: cookie ${c}`);
      }
      // уход со страницы во время attach: сразу отпустить
      if (!this.wanted) return void (await this.releaseNow('страница закрыта во время запроса'));
      // состояние могло смениться за время attach (штатный обзор, чужой вид, блок ещё запускается): решить заново,
      // не просить вслепую; вид — из нового решения (attach без вида — когда блок не был готов)
      const again = this.decideNow();
      if (again.act !== 'request') return void this.note(again.why);
      view = again.view;
      const p = await this.proxy(ep);
      const cookie = this.cookie;
      const st = (application: unknown, mode: unknown) => ({ cookie, desiredState: { application, mode, perspective: view } });
      await this.callEither(ep, p, 'changeState', st('DR_ACTIVE', 'MODE_MOSAIK'), st(CAM_WIRE.DR_ACTIVE, CAM_WIRE.MODE_MOSAIK));
      this.still(ep);
      this.ownView = view;
      this.verifyUntil = this.now() + VERIFY_MS;
      this.note(`запрошен вид ${view} (cookie ${cookie}), попытка ${this.tries}/${TRIES}`);
      // уход со страницы во время changeState
      if (!this.wanted) await this.releaseNow('страница закрыта во время запроса');
    } catch (e) {
      if (e instanceof StaleEpoch) stale = true;
      this.note(`запрос вида ${view}: ${errText(e)}`);
    } finally {
      this.busy = false;
      // после смены эпохи — решить заново (свежее состояние нового провайдера)
      if (this.dirty || stale) this.step();
    }
  }

  private async release(why: string): Promise<void> {
    this.busy = true;
    try {
      await this.releaseNow(why);
    } finally {
      this.busy = false;
      if (this.dirty) this.step();
    }
  }

  private async releaseNow(why: string): Promise<void> {
    this.syncEpoch();
    const c = this.cookie;
    const ep = this.cookieEpoch;
    if (c === null) return;
    this.cookie = null;
    this.cookieEpoch = -1;
    this.attachedAt = null;
    this.ownView = 0;
    this.verifyUntil = 0;
    // cookie другой эпохи провайдера — не наш на текущем: не отпускаем (providerLost уже забыл бы его)
    if (ep !== this.epoch) return void this.note(`cookie ${c} прошлой эпохи провайдера: не отпускается`);
    try {
      const p = await this.proxy(ep);
      this.still(ep);
      await this.api.call(p, 'clientDetach', { cookie: c }, 5000);
      this.note(`detach cookie ${c}: ${why}`);
    } catch (e) {
      this.note(`detach cookie ${c}: ${errText(e)}`);
    }
  }

  /**
   * Закрытие приложения: отпустить свой cookie. Ожидает незавершённый вызов (не дольше ~6 с) — его cookie тоже
   * отпускается. Принудительное завершение процесса (SIGKILL, process 'exit') асинхронный detach не допускает.
   */
  async dispose(): Promise<void> {
    this.wanted = false;
    for (let i = 0; i < 60 && this.busy; i++) await new Promise<void>((r) => this.setTimer(r, 100));
    await this.releaseNow('приложение закрывается');
    this.unsubscribe();
  }
}
