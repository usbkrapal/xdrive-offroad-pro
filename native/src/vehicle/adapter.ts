// Read-only адаптер автомобиля (кандидат, на G07 не проверен).
// Подписывается ТОЛЬКО через ctx.signals.watch и ТОЛЬКО на поля из allowlist.ts.
// Не использует upstream Car: там авто-демо при тишине, «<400 об/мин = 0», угадывание передачи.
// Значение «измерено» появляется только из колбэка; неподдержанные сигналы — «нет данных»,
// никогда не подставляются из демо.
//
// Свежесть. Поля с геттером читаются периодически (FieldSpec.pollMs через opts.fieldPollMs watch):
// стоящий автомобиль не шлёт уведомлений «скорость всё ещё 0», а успешное чтение — это новый отсчёт.
// Неуспешное чтение колбэк не вызывает и время отсчёта не обновляет. Потеря провайдера интерфейса
// обесценивает ВСЕ его прежние отсчёты (по номеру отсчёта, не по времени): после возврата провайдера
// они не «воскресают», пока не придёт новый отсчёт. Передача (только уведомления при изменении)
// держится, пока провайдер непрерывно доступен; отсутствие/ошибка никогда не становится P.

import { buildSignal } from '../../../src/domain/signal';
import { SIGNAL_IDS } from '../../../src/domain/signalCatalog';
import { WHEELS, type Gear, type RuntimeSource, type Signal, type SignalId, type SignalMap, type SignalValueMap } from '../../../src/domain/types';
import type { FieldHandler, Log, WatchResult } from '../platform/kitTypes';
import { VEHICLE_FIELDS, VEHICLE_INTERFACES, VEHICLE_SIGNAL_IDS, SIGNAL_IFACE, type FieldOutput, type FieldSpec } from './allowlist';
import { GearboxOilGate, readTorqueSplit } from './bds';
import { INVALID } from './decode';
import { DiagLog, type DiagEntry } from './diag';
import { fuseGear, readGearbox, readSelection, type FusedGear, type TimedReading } from './gear';
import { TyreState, tyreSignalId } from './tpms';
import { EXTRA_IDS, type ExtraId } from './uds/ecus';
import type { UdsOutput } from './uds/reader';

/** Сигнал величины вне домена (давление контуров, датчик высоты, шестерня EPS, уровень EHC). */
export interface ExtraSignal {
  readonly value: number | null;
  readonly quality: 'valid' | 'stale' | 'unavailable' | 'invalid';
  readonly updatedAt: number | null;
}
/** Приоритет диагностического (UDS) источника: SOME/IP-источник того же сигнала главнее. */
const UDS_PRIORITY = 1;

/**
 * Пятый аргумент ctx.signals.watch (vendor kit/runtime/signals.js). Необязателен: со старым
 * рантаймом/обёрткой без него адаптер работает без опроса, а потерю провайдера видит по res.losses
 * или res.available в кадре.
 */
export interface WatchOpts {
  pollMs?: number;
  fieldPollMs?: Record<string, number>;
  onAvailability?: (available: boolean) => void;
}
/**
 * Статистика чтений геттером одного поля (vendor signals.js res.reads[field]): только счётчики,
 * время рантайма (Date.now, мс) и короткий текст последней ошибки — без значений поля.
 */
export interface GetterStats {
  readonly ok: number;
  readonly failed: number;
  readonly consecutiveFailures: number;
  /** Ответы, отброшенные из-за потери провайдера (начаты до неё или пришли без провайдера). */
  readonly dropped: number;
  /** Тики опроса, пропущенные, пока прежнее чтение ещё не завершилось. */
  readonly skipped: number;
  readonly lastOkAt: number | null;
  readonly lastFailAt: number | null;
  readonly lastError: string | null;
  /** Чтение в полёте с этого момента (время рантайма) или null. */
  readonly pendingSince: number | null;
}
/** Результат watch: необязательные поля пропатченного рантайма (старый рантайм их не даёт). */
export type TelemetryWatchResult = WatchResult & { losses?: number; reads?: Readonly<Record<string, Partial<GetterStats>>> };
/** Совместим с WatchFn из kitTypes (функция с четырьмя параметрами подходит сюда как есть). */
export type TelemetryWatchFn = (
  iface: string,
  instance: string,
  handlers: Record<string, FieldHandler>,
  log?: Log,
  opts?: WatchOpts,
) => Promise<TelemetryWatchResult>;

interface Sample {
  /** null — недопустимое значение (invalid). */
  readonly value: number | null;
  /** Свежий отсчёт «значения нет» (поле не заполнено, ждём единиц, ждём изменения) — unavailable. */
  readonly absent: boolean;
  readonly at: number;
  /** Порядковый номер отсчёта: сравнивается с потерей провайдера. */
  readonly seq: number;
  readonly staleMs: number;
  readonly priority: number;
  readonly source: RuntimeSource;
  readonly iface: string;
  /** Поле-источник (для диагностики: из какого поля показанное значение). */
  readonly field: string;
  /** Другие интерфейсы, от которых зависит значение (шины — от единиц Vehicle): их потеря тоже обесценивает. */
  readonly deps?: readonly string[];
  readonly reason: string | null;
}

interface GearSample extends TimedReading {
  readonly seq: number;
}

interface Sub {
  readonly iface: string;
  readonly res: TelemetryWatchResult;
  everAvailable: boolean;
  /** Доступность в прошлом кадре — для счёта потерь у транспорта без res.losses. */
  wasAvailable: boolean;
}

/** Сколько последних интервалов между отсчётами поля хранится (медиана/максимум в диагностике). */
const INTERVALS_MAX = 32;

interface FieldStats {
  samples: number;
  lastAt: number | null;
  /** Последние интервалы между отсчётами, мс (кольцо INTERVALS_MAX): частота уведомлений автомобиля. */
  intervals: number[];
  /** Колбэки, пришедшие, пока провайдер интерфейса недоступен (не отсчёты). */
  dropped: number;
}

export interface VehicleStatus {
  /** Подписка запрошена (режим «Автомобиль» включён). */
  readonly active: boolean;
  /** Интерфейсы, на которые подписка установлена. */
  readonly subscribed: number;
  readonly interfaces: number;
  /** Интерфейсы с ошибкой подписки (нет конфигурации, нет привязки someip и т. п.). */
  readonly errors: readonly string[];
  /** Есть хотя бы одно пригодное (валидное и свежее) измеренное значение. */
  readonly hasUsableData: boolean;
}

export interface InterfaceDiagnostics {
  readonly iface: string;
  readonly diagnosticOnly: boolean;
  readonly subscribed: boolean;
  readonly available: boolean;
  readonly error: string | null;
  /** Сколько раз провайдер пропадал (колбэк или res.losses/available в кадре). */
  readonly losses: number;
  readonly samples: number;
  readonly lastSampleAt: number | null;
  readonly fields: readonly FieldDiagnostics[];
}

export interface FieldDiagnostics {
  readonly field: string;
  readonly samples: number;
  readonly lastSampleAt: number | null;
  /** Колбэки без провайдера, отброшенные адаптером. */
  readonly droppedWhileUnavailable: number;
  /** Интервал между последними отсчётами поля, мс: медиана и максимум (null — меньше двух отсчётов). */
  readonly intervalMs: { readonly median: number; readonly max: number; readonly n: number } | null;
  /** Только у полей с геттером и только с пропатченным рантаймом; иначе null. */
  readonly getter: GetterStats | null;
}

/**
 * Масло КПП в диагностике: показывается; ждём изменения сырого (отсчёты BasicDataSet есть); провайдер BasicDataSet
 * доступен, но отсчётов нет; провайдер недоступен; подписки нет. «Ждём изменения» — только когда отсчёты есть.
 */
export type GearboxOilState = 'shown' | 'waitingChange' | 'noSamples' | 'providerUnavailable' | 'notSubscribed';

/** Снимок для листа диагностики (INTEGRATION.md): только известные поля, ограниченный объём. */
export interface VehicleDiagnostics {
  readonly at: number;
  readonly interfaces: readonly InterfaceDiagnostics[];
  /**
   * Почему сигнал сейчас без значения (ждём единиц, ждём изменения масла КПП, квалификатор …); у сигналов без
   * своей причины — состояние интерфейса-источника (нет подписки / провайдер недоступен / отсчётов не было).
   */
  readonly reasons: Readonly<Partial<Record<SignalId, string>>>;
  /** Поле, из которого взято показанное значение (valid или stale), — по сигналам. */
  readonly sources: Readonly<Partial<Record<SignalId, string>>>;
  readonly tyreUnits: { readonly pressure: string; readonly temperature: string };
  readonly gearboxOilPromoted: boolean;
  readonly gearboxOil: GearboxOilState;
  /** Последний отсчёт каждого поля с известными членами; at — время получения (часы адаптера). */
  readonly latestSamples: readonly DiagEntry[];
  /** История: первый отсчёт каждого поля с начала чтения. */
  readonly firstSamples: readonly DiagEntry[];
  readonly changes: readonly DiagEntry[];
}

const GEAR_STALE_MS = VEHICLE_FIELDS.reduce((m, f) => f.outputs.reduce((n, o) => (o.kind === 'gearbox' || o.kind === 'selection' ? Math.max(n, o.staleMs) : n), m), 0) || 60000;
const GEAR_IFACE = SIGNAL_IFACE.get('gear') ?? '';
const TYRE_IDS = new Set<SignalId>(WHEELS.reduce<SignalId[]>((a, w) => a.concat(tyreSignalId('pressure', w), tyreSignalId('temperature', w)), []));
/** Интерфейс единиц автомобиля и интерфейс масла КПП — по выходам allowlist. */
const UNITS_IFACE = VEHICLE_FIELDS.find((f) => f.outputs.some((o) => o.kind === 'units'))?.iface ?? '';
const GEARBOX_OIL_SPEC = VEHICLE_FIELDS.find((f) => f.outputs.some((o) => o.kind === 'gearboxOil'));
const GEARBOX_OIL_IFACE = GEARBOX_OIL_SPEC?.iface ?? '';
const GEARBOX_OIL_FIELD = GEARBOX_OIL_SPEC?.field ?? '';
const TPMS_FIELDS = VEHICLE_FIELDS.reduce<Partial<Record<'tyrePressure' | 'tyreTemperature', FieldSpec>>>((acc, f) => {
  for (const o of f.outputs) if (o.kind === 'tyrePressure' || o.kind === 'tyreTemperature') acc[o.kind] = f;
  return acc;
}, {});

/** Состояние интерфейса-источника — причина «нет данных» у сигнала без своей причины. */
function ifaceState(i: InterfaceDiagnostics): string {
  if (!i.subscribed) return i.error ? 'нет подписки на интерфейс' : 'подписка ещё не установлена';
  if (!i.available) return i.samples > 0 ? 'провайдер интерфейса сейчас недоступен' : 'провайдер интерфейса недоступен, отсчётов не было';
  return i.samples > 0 ? 'нет пригодного отсчёта' : 'провайдер доступен, отсчётов не было';
}

const shortIface = (s: string) => s.replace(/^de\.bmw\.(infotainment\.|infrastructure\.|powertrain\.|chassis\.)?/, '');
const clipLog = (s: string) => (s.length > 240 ? `${s.slice(0, 239)}…` : s);

/**
 * Сводка для журнала (раз в несколько минут, см. model): интервалы уведомлений полей, источник руля и последние сырые
 * значения обоих полей руля с возрастом. Ограничена по длине; идентификаторов (VIN и т. п.) в ней нет — их нет в снимке.
 */
export function logSummary(d: VehicleDiagnostics): string[] {
  const iv: string[] = [];
  for (const i of d.interfaces) for (const f of i.fields) if (f.intervalMs) iv.push(`${f.field}=${Math.round(f.intervalMs.median)}/${Math.round(f.intervalMs.max)}ms`);
  const steer = d.latestSamples
    .filter((e) => /SteeringAngle/.test(e.iface))
    .map((e) => `${e.field}=${JSON.stringify(e.values)}@${Math.round((d.at - e.at) / 100) / 10}s`);
  return [
    clipLog(`signal intervals (median/max): ${iv.join(' ') || 'none'}`),
    clipLog(`steering source ${d.sources.steeringWheelAngleDeg ?? 'none'}; latest raw ${steer.join(' ') || 'none'}`),
  ];
}

function intervalSummary(v: readonly number[]): { median: number; max: number; n: number } {
  const s = v.slice().sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], max: s[s.length - 1], n: s.length };
}

const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
const time = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Копия статистики рантайма: только известные ключи, числа и короткий текст (ничего из значений поля). */
function getterStats(r: Partial<GetterStats> | undefined): GetterStats | null {
  if (!r || typeof r !== 'object') return null;
  return {
    ok: count(r.ok),
    failed: count(r.failed),
    consecutiveFailures: count(r.consecutiveFailures),
    dropped: count(r.dropped),
    skipped: count(r.skipped),
    lastOkAt: time(r.lastOkAt),
    lastFailAt: time(r.lastFailAt),
    lastError: typeof r.lastError === 'string' ? r.lastError.replace(/[^\x20-\x7e]/g, '?').slice(0, 80) : null,
    pendingSince: time(r.pendingSince),
  };
}

/** Имена и типы членов значения поля (до 16, имена ≤ 40 символов) — без самих значений. */
export function memberShape(v: unknown): string {
  if (v === null || typeof v !== 'object') return typeof v;
  if (Array.isArray(v)) return `array[${v.length}]`;
  const keys = Object.keys(v as Record<string, unknown>);
  const parts = keys.slice(0, 16).map((k) => {
    const x = (v as Record<string, unknown>)[k];
    const t = x === null ? 'null' : Array.isArray(x) ? `array[${x.length}]` : typeof x === 'number' ? (Number.isInteger(x) ? 'int' : 'number') : typeof x;
    return `${k.replace(/[^\w.]/g, '?').slice(0, 40)}:${t}`;
  });
  return `{${parts.join(', ')}${keys.length > 16 ? `, …+${keys.length - 16}` : ''}}`;
}

export class VehicleAdapter {
  private gen = 0;
  private active = false;
  private seq = 0;
  private subs: Sub[] = [];
  private errors: string[] = [];
  /** id → источник (поле) → последний отсчёт. */
  private samples = new Map<SignalId, Map<string, Sample>>();
  private extraSamples = new Map<ExtraId, Sample>();
  private gearbox: GearSample | null = null;
  private selection: GearSample | null = null;
  private tyres = new TyreState();
  private gearboxOil = new GearboxOilGate();
  private diag = new DiagLog();
  /** Интерфейс → номер последнего отсчёта на момент потери провайдера (отсчёты ≤ него недействительны). */
  private lossSeq = new Map<string, number>();
  private lossCount = new Map<string, number>();
  /** Потери, уже учтённые колбэком onAvailability (чтобы res.losses их не посчитал второй раз). */
  private handledLosses = new Map<string, number>();
  /** Интерфейсы, о потере провайдера которых сообщил onAvailability(false) и ещё не вернувшиеся. */
  private down = new Set<string>();
  private stats = new Map<string, FieldStats>();
  private lastSignals: SignalMap | null = null;
  /** Растёт с каждым принятым отсчётом и потерей провайдера: модель пересобирает снимок сразу, а не по таймеру. */
  private rev = 0;

  constructor(
    private readonly watch: TelemetryWatchFn,
    /** Время адаптера, мс; та же шкала, что simTime снимка. */
    private readonly now: () => number,
    private readonly log?: Log,
  ) {}

  /** Подписаться на allowlist. Повторный вызов без stop() ничего не делает. */
  start(): void {
    if (this.active) return;
    this.active = true;
    const gen = ++this.gen;
    const byIface = new Map<string, { handlers: Record<string, FieldHandler>; fieldPollMs: Record<string, number> }>();
    for (const f of VEHICLE_FIELDS) {
      const entry = byIface.get(f.iface) ?? { handlers: {}, fieldPollMs: {} };
      entry.handlers[f.field] = (v) => this.receive(gen, f, v);
      if (f.flags === 'rs' && f.pollMs) entry.fieldPollMs[f.field] = f.pollMs;
      byIface.set(f.iface, entry);
    }
    byIface.forEach(({ handlers, fieldPollMs }, iface) => {
      const periods = Object.keys(fieldPollMs).map((k) => fieldPollMs[k]);
      const opts: WatchOpts = {
        onAvailability: (a) => {
          if (gen !== this.gen || !this.active) return;
          if (a) {
            this.down.delete(iface);
            return;
          }
          this.down.add(iface);
          this.handledLosses.set(iface, (this.handledLosses.get(iface) ?? 0) + 1);
          this.markLoss(iface);
        },
      };
      if (periods.length) {
        // pollMs — для рантайма без fieldPollMs (upstream): тогда все геттеры с самым коротким периодом.
        opts.pollMs = Math.min(...periods);
        opts.fieldPollMs = fieldPollMs;
      }
      let p: Promise<TelemetryWatchResult>;
      try {
        p = Promise.resolve(this.watch(iface, '1', handlers, this.log, opts));
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (res) => {
          // Поздний ответ после смены режима/закрытия: подписку сразу закрываем, данные не принимаем.
          if (gen !== this.gen || !this.active) {
            void Promise.resolve(res.shutdown()).catch(() => undefined);
            return;
          }
          if (res.error) this.errors.push(`${iface}: ${res.error}`);
          this.subs.push({ iface, res, everAvailable: !!res.available, wasAvailable: !!res.available });
        },
        (e: unknown) => {
          if (gen === this.gen && this.active) this.errors.push(`${iface}: ${String(e)}`);
        },
      );
    });
  }

  /** Отписаться и забыть все значения. Колбэки старых подписок после этого игнорируются. */
  stop(): Promise<void> {
    this.active = false;
    this.gen++;
    const subs = this.subs;
    this.subs = [];
    this.errors = [];
    this.samples.clear();
    this.extraSamples.clear();
    this.gearbox = null;
    this.selection = null;
    this.tyres = new TyreState();
    this.gearboxOil = new GearboxOilGate();
    this.diag = new DiagLog();
    this.lossSeq.clear();
    this.lossCount.clear();
    this.handledLosses.clear();
    this.down.clear();
    this.stats.clear();
    this.lastSignals = null;
    return Promise.all(subs.map((s) => Promise.resolve(s.res.shutdown()).catch(() => undefined))).then(() => undefined);
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Отсчёт диагностического чтения (vehicle/uds): доменный сигнал — в общее хранилище с приоритетом ниже SOME/IP,
   * величина вне домена — в extras. Время — часы адаптера в момент приёма.
   */
  putUds(o: UdsOutput): void {
    if (!this.active) return;
    const at = this.now();
    const seq = ++this.seq;
    this.rev++;
    const s: Sample = { value: o.value, absent: o.absent, at, seq, staleMs: o.staleMs, priority: UDS_PRIORITY, source: 'measured', iface: 'uds', field: o.field, reason: o.reason };
    if (o.target.kind === 'extra') this.extraSamples.set(o.target.id, s);
    else {
      const m = this.samples.get(o.target.id) ?? new Map<string, Sample>();
      m.set(o.field, s);
      this.samples.set(o.target.id, m);
    }
  }

  /** Величины вне домена: свежие допустимые — valid, старые — stale, отсутствие/недопустимое — без значения. */
  extras(nowMs: number = this.now(), reasons?: Record<string, string>): Record<ExtraId, ExtraSignal> {
    const out = {} as Record<ExtraId, ExtraSignal>;
    for (const id of EXTRA_IDS) {
      const s = this.extraSamples.get(id);
      if (s && s.reason && reasons) reasons[id] = s.reason;
      if (!s) out[id] = { value: null, quality: 'unavailable', updatedAt: null };
      else if (s.absent) out[id] = { value: null, quality: 'unavailable', updatedAt: null };
      else if (s.value === null) out[id] = { value: null, quality: 'invalid', updatedAt: s.at };
      else out[id] = { value: s.value, quality: nowMs - s.at <= s.staleMs ? 'valid' : 'stale', updatedAt: s.at };
    }
    return out;
  }

  /** Номер изменения данных адаптера (новый отсчёт, потеря провайдера). */
  get revision(): number {
    return this.rev;
  }

  private receive(gen: number, f: FieldSpec, v: unknown): void {
    if (gen !== this.gen || !this.active) return;
    const key = `${f.iface}|${f.field}`;
    const st = this.stats.get(key) ?? { samples: 0, lastAt: null, intervals: [], dropped: 0 };
    this.stats.set(key, st);
    // Провайдер известно недоступен: колбэк не отсчёт (иначе он пережил бы потерю).
    const sub = this.subs.find((x) => x.iface === f.iface);
    if (this.down.has(f.iface) || (sub && sub.everAvailable && sub.res.available === false)) {
      st.dropped++;
      return;
    }
    const at = this.now();
    const seq = ++this.seq;
    st.samples++;
    if (st.lastAt !== null) {
      st.intervals.push(at - st.lastAt);
      if (st.intervals.length > INTERVALS_MAX) st.intervals.shift();
    }
    st.lastAt = at;
    this.rev++;
    const raw = this.diag.record(f.iface, f.field, f.diag, v, at, !!f.diagChanges);
    // Журнал приложения (обычный режим): первый отсчёт каждого поля с известными членами — один раз за подписку
    if (st.samples === 1 && this.log) {
      this.log.info(clipLog(`signal ${shortIface(f.iface)}.${f.field}: first sample ${raw ? JSON.stringify(raw) : '(no known members)'}`));
      // состав поля (имена и типы членов, без значений): есть ли квалификатор/счётчик/CRC рядом со значением
      this.log.info(clipLog(`signal ${shortIface(f.iface)}.${f.field}: members ${memberShape(v)}`));
    }
    for (const o of f.outputs) {
      try {
        this.apply(f, o, v, at, seq);
      } catch (e) {
        // Один выход не валит остальные.
        if (this.log) this.log.warn(`${f.iface}.${f.field}: ${String(e)}`);
      }
    }
  }

  private put(id: SignalId, src: string, s: Omit<Sample, 'priority' | 'source' | 'reason' | 'field'> & Partial<Pick<Sample, 'priority' | 'source' | 'reason'>>): void {
    const m = this.samples.get(id) ?? new Map<string, Sample>();
    m.set(src, { priority: 0, source: 'measured', reason: null, ...s, field: src });
    this.samples.set(id, m);
  }

  private apply(f: FieldSpec, o: FieldOutput, v: unknown, at: number, seq: number): void {
    const base = { at, seq, iface: f.iface };
    switch (o.kind) {
      case 'number': {
        const raw = v && typeof v === 'object' ? (v as Record<string, unknown>)[o.member] : undefined;
        // Поле структуры отсутствует — это не отсчёт этого сигнала (значение не трогаем).
        if (raw === undefined) return;
        const d = o.decode(raw);
        this.put(o.id, f.field, { ...base, value: d === INVALID ? null : d, absent: false, staleMs: o.staleMs, priority: o.priority ?? 0 });
        return;
      }
      case 'gearbox':
        this.gearbox = { reading: readGearbox(v), at, seq };
        return;
      case 'selection':
        this.selection = { reading: readSelection(v), at, seq };
        return;
      case 'torqueSplit': {
        const r = readTorqueSplit(v);
        if (r === null) return;
        const s = { ...base, staleMs: o.staleMs };
        if (r.kind === 'split') {
          const note = r.qualifier === 'absent' ? 'квалификатор отсутствует (upstream допускает)' : null;
          this.put(o.rear, f.field, { ...s, value: r.rearPercent, absent: false, reason: note });
          this.put(o.front, f.field, { ...s, value: r.frontPercent, absent: false, source: 'estimated', reason: note });
        } else {
          const absent = r.kind === 'unfilled';
          this.put(o.rear, f.field, { ...s, value: null, absent, reason: r.reason });
          this.put(o.front, f.field, { ...s, value: null, absent, source: 'estimated', reason: r.reason });
        }
        return;
      }
      case 'gearboxOil': {
        const r = this.gearboxOil.read(v);
        if (r === null) return;
        const s = { ...base, staleMs: o.staleMs };
        if (r.kind === 'value') this.put(o.id, f.field, { ...s, value: r.c, absent: false });
        else this.put(o.id, f.field, { ...s, value: null, absent: r.kind === 'waiting', reason: r.reason });
        return;
      }
      case 'tyrePressure':
        this.tyres.receive('pressure', v, at, seq);
        return;
      case 'tyreTemperature':
        this.tyres.receive('temperature', v, at, seq);
        return;
      case 'units':
        this.tyres.receiveUnits(v, at, seq);
        return;
    }
  }

  private markLoss(iface: string, count = true): void {
    this.rev++;
    if (count && this.log) this.log.warn(`signal ${shortIface(iface)}: provider lost (${(this.lossCount.get(iface) ?? 0) + 1})`);
    this.lossSeq.set(iface, this.seq);
    if (count) this.lossCount.set(iface, (this.lossCount.get(iface) ?? 0) + 1);
    // Единицы, известные до потери, больше не верны (в машине их могли сменить); шины ждут свежих единиц и отсчётов.
    if (iface === UNITS_IFACE) this.tyres.unitsLost();
    // Изменение масла КПП до потери не доказывает, что поле заполнено после возврата.
    if (iface === GEARBOX_OIL_IFACE) this.gearboxOil.reset();
  }

  /** Потери провайдера, не пришедшие колбэком: res.losses вырос или провайдер сейчас недоступен. */
  private detectLosses(): void {
    for (const s of this.subs) {
      const losses = typeof s.res.losses === 'number' ? s.res.losses : 0;
      const handled = this.handledLosses.get(s.iface) ?? 0;
      if (losses > handled) {
        this.handledLosses.set(s.iface, losses);
        this.markLoss(s.iface);
      }
      const avail = s.res.available === true;
      // Провайдер сейчас недоступен: всё, что пришло до этого кадра, недействительно.
      if (!avail && s.everAvailable) this.markLoss(s.iface, s.wasAvailable && typeof s.res.losses !== 'number');
      if (avail) s.everAvailable = true;
      s.wasAvailable = avail;
    }
  }

  private sampleVoided(s: Sample): boolean {
    return this.voided(s.iface, s.seq) || (s.deps ?? []).some((d) => this.voided(d, s.seq));
  }

  private voided(iface: string, seq: number): boolean {
    return seq <= (this.lossSeq.get(iface) ?? 0);
  }

  /** Отсчёты сигнала: из хранилища или (шины) раскодированные из сырых с текущими единицами. */
  private samplesOf(id: SignalId): Sample[] {
    if (TYRE_IDS.has(id)) {
      const kind = id.startsWith('tyrePressure.') ? 'pressure' : 'temperature';
      const w = id.slice(id.indexOf('.') + 1) as (typeof WHEELS)[number];
      const t = this.tyres.sample(kind, w);
      const f = TPMS_FIELDS[kind === 'pressure' ? 'tyrePressure' : 'tyreTemperature'];
      const o = f?.outputs[0];
      if (!t || !f || !o || o.kind === 'units' || !('staleMs' in o)) return [];
      return [{ ...t, staleMs: o.staleMs, priority: 0, source: 'measured', iface: f.iface, field: f.field, deps: [UNITS_IFACE] }];
    }
    const m = this.samples.get(id);
    return m ? Array.from(m.values()) : [];
  }

  private numericSignal(id: SignalId, nowMs: number, reasons: Partial<Record<SignalId, string>>, sources: Partial<Record<SignalId, string>>): Signal<unknown> {
    const all = this.samplesOf(id);
    const live = all.filter((s) => !this.sampleVoided(s));
    const fresh = live.filter((s) => nowMs - s.at <= s.staleMs);
    const newest = (a: Sample, b: Sample) => b.at - a.at || b.seq - a.seq;
    const valid = fresh.filter((s) => !s.absent && s.value !== null).sort((a, b) => a.priority - b.priority || newest(a, b));
    const build = (s: Sample, raw: number) => buildSignal(id, raw as SignalValueMap[typeof id], s.at, s.at, s.source);
    if (valid.length) {
      if (valid[0].reason) reasons[id] = valid[0].reason;
      sources[id] = valid[0].field;
      return build(valid[0], valid[0].value as number);
    }
    // Свежий «нет значения»/недопустимый отсчёт стирает прежнее измерение (не показывается как stale).
    const last = fresh.sort(newest)[0];
    if (last) {
      if (last.reason) reasons[id] = last.reason;
      if (last.absent) return buildSignal(id, undefined, nowMs, nowMs, last.source);
      return build(last, Number.NaN);
    }
    // Свежих нет: последнее допустимое значение — только «устарело» (в т. ч. обесцененное потерей провайдера).
    const old = all.filter((s) => !s.absent && s.value !== null).sort(newest)[0];
    if (old) {
      reasons[id] = !this.sampleVoided(old)
        ? 'нет новых отсчётов'
        : this.voided(old.iface, old.seq)
          ? 'провайдер пропадал — ждём нового отсчёта'
          : 'провайдер единиц пропадал — ждём новых единиц и нового отсчёта';
      sources[id] = old.field;
      return { ...build(old, old.value as number), quality: 'stale' };
    }
    const any = all.sort(newest)[0];
    if (any?.reason) reasons[id] = any.reason;
    return buildSignal(id, undefined, nowMs, nowMs, any ? any.source : 'measured');
  }

  /** Полная карта сигналов на момент nowMs. Неподдержанные — unavailable, без значений. */
  signals(nowMs: number = this.now()): SignalMap {
    return this.compute(nowMs, {}, {});
  }

  private compute(nowMs: number, reasons: Partial<Record<SignalId, string>>, sources: Partial<Record<SignalId, string>>): SignalMap {
    this.detectLosses();
    const out: Partial<Record<SignalId, Signal<unknown>>> = {};
    for (const id of SIGNAL_IDS) out[id] = id === 'gear' ? this.gearSignal(nowMs) : this.numericSignal(id, nowMs, reasons, sources);
    this.lastSignals = out as SignalMap;
    return this.lastSignals;
  }

  /** Провайдер передачи сейчас доступен (и учтены все его потери) — отсчёт «при изменении» держится. */
  private gearHeld(): boolean {
    const s = this.subs.find((x) => x.iface === GEAR_IFACE);
    return !!s && !s.res.error && s.res.available === true;
  }

  private gearSignal(nowMs: number): Signal<Gear> {
    const live = (r: GearSample | null) => (r && !this.voided(GEAR_IFACE, r.seq) ? r : null);
    let fused: FusedGear = fuseGear(live(this.gearbox), live(this.selection), nowMs, this.gearHeld() ? Number.POSITIVE_INFINITY : GEAR_STALE_MS);
    // Всё обесценено потерей провайдера: последняя передача — только «устарело».
    if (fused.kind === 'none' && (this.gearbox || this.selection)) fused = fuseGear(this.gearbox, this.selection, nowMs, -1);
    switch (fused.kind) {
      case 'gear':
        return buildSignal('gear', fused.gear, fused.at, fused.at, 'measured');
      case 'stale': {
        if (fused.gear === null) return buildSignal('gear', undefined, nowMs, nowMs, 'measured');
        return { ...buildSignal('gear', fused.gear, fused.at, fused.at, 'measured'), quality: 'stale' };
      }
      case 'invalid':
        return { ...buildSignal('gear', undefined, fused.at, fused.at, 'measured'), updatedAt: fused.at, quality: 'invalid' };
      default:
        // Неоднозначно (N/P, номер без селектора) или нет отсчётов — «нет данных», без выдумывания P/D.
        return buildSignal('gear', undefined, nowMs, nowMs, 'measured');
    }
  }

  status(): VehicleStatus {
    const sig = this.lastSignals;
    const hasUsableData = sig !== null && SIGNAL_IDS.some((id) => sig[id].quality === 'valid' && sig[id].value !== null);
    return {
      active: this.active,
      subscribed: this.subs.filter((s) => !s.res.error).length,
      interfaces: VEHICLE_INTERFACES.length,
      errors: this.errors.slice(),
      hasUsableData,
    };
  }

  /** Диагностический снимок (не на каждый кадр: собирается по запросу экрана настроек). */
  diagnostics(nowMs: number = this.now()): VehicleDiagnostics {
    const reasons: Partial<Record<SignalId, string>> = {};
    const sources: Partial<Record<SignalId, string>> = {};
    const sig = this.compute(nowMs, reasons, sources);
    const interfaces = VEHICLE_INTERFACES.map((spec): InterfaceDiagnostics => {
      const sub = this.subs.find((s) => s.iface === spec.iface);
      const err = this.errors.find((e) => e.startsWith(`${spec.iface}: `));
      const fields = VEHICLE_FIELDS.filter((f) => f.iface === spec.iface).map((f) => {
        const st = this.stats.get(`${f.iface}|${f.field}`);
        return {
          field: f.field,
          samples: st ? st.samples : 0,
          lastSampleAt: st ? st.lastAt : null,
          droppedWhileUnavailable: st ? st.dropped : 0,
          intervalMs: st && st.intervals.length ? intervalSummary(st.intervals) : null,
          getter: f.flags === 'rs' && sub ? getterStats(sub.res.reads?.[f.field]) : null,
        };
      });
      const lastSampleAt = fields.reduce<number | null>((m, f) => (f.lastSampleAt === null ? m : m === null ? f.lastSampleAt : Math.max(m, f.lastSampleAt)), null);
      return {
        iface: spec.iface,
        diagnosticOnly: !!spec.diagnosticOnly,
        subscribed: !!sub && !sub.res.error,
        available: !!sub && sub.res.available === true,
        error: err ? err.slice(spec.iface.length + 2) : null,
        losses: this.lossCount.get(spec.iface) ?? 0,
        samples: fields.reduce((n, f) => n + f.samples, 0),
        lastSampleAt,
        fields,
      };
    });
    // Сигнал без значения и без своей причины: состояние интерфейса-источника (нет подписки / провайдер недоступен /
    // отсчётов не было) — чтобы «нет данных» не путалось с «ждём изменения».
    for (const id of VEHICLE_SIGNAL_IDS) {
      if (reasons[id] || sig[id].quality !== 'unavailable') continue;
      const i = interfaces.find((x) => x.iface === SIGNAL_IFACE.get(id));
      if (i) reasons[id] = ifaceState(i);
    }
    const bds = interfaces.find((i) => i.iface === GEARBOX_OIL_IFACE);
    const bdsField = bds && bds.fields.find((f) => f.field === GEARBOX_OIL_FIELD);
    const gearboxOil: GearboxOilState = this.gearboxOil.isPromoted
      ? 'shown'
      : !bds || !bds.subscribed
        ? 'notSubscribed'
        : !bds.available
          ? 'providerUnavailable'
          : bdsField && bdsField.samples > 0
            ? 'waitingChange'
            : 'noSamples';
    return {
      at: nowMs,
      interfaces,
      reasons,
      sources,
      tyreUnits: this.tyres.unitsSummary(),
      gearboxOilPromoted: this.gearboxOil.isPromoted,
      gearboxOil,
      latestSamples: this.diag.latestSamples(),
      firstSamples: this.diag.firstSamples(),
      changes: this.diag.changes(),
    };
  }
}
