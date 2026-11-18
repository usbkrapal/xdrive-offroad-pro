// Модель нативного приложения: ровно один источник данных за раз.
// DEMO — тот же AppStore + MockTelemetryProvider, что и в браузере (сценарии, пауза, сессия).
// VEHICLE — VehicleAdapter (только чтение). Смена режима уничтожает источник И сессию:
// демо- и живые данные никогда не смешиваются, автоматического перехода live → demo нет.
// По умолчанию — автомобиль; демо только явно (приложение: XOP_DEV=demo при запуске, devAccess.ts).

import { AppStore } from '../../../src/app/store';
import { createSession, ingestSample, type SessionStats } from '../../../src/domain/session';
import { SCENARIO_IDS, type ScenarioId, type SignalMap, type TelemetrySnapshot } from '../../../src/domain/types';
import { MockTelemetryProvider } from '../../../src/providers/mock/MockTelemetryProvider';
import type { Now } from '../clock';
import type { Log, WatchFn } from '../platform/kitTypes';
import { logSummary, VehicleAdapter, type ExtraSignal, type VehicleDiagnostics, type VehicleStatus } from '../vehicle/adapter';
import { EXTRA_IDS, type ExtraId } from '../vehicle/uds/ecus';
import { UdsReader, type EcuDiagnostics } from '../vehicle/uds/reader';
import { ReadOnlyTasu, type TasuSignals, type TasuStats } from '../vehicle/uds/tasu';

export type DataMode = 'demo' | 'vehicle';
export const DATA_MODES: readonly DataMode[] = ['demo', 'vehicle'];
export const DEFAULT_MODE: DataMode = 'vehicle';

/** Снимок нативной модели. В режиме автомобиля сценария нет (null). */
export interface NativeSnapshot {
  readonly simTimeMs: number;
  readonly scenarioId: ScenarioId | null;
  readonly signals: SignalMap;
  /** Величины вне домена (диагностическое чтение): давление контуров тормоза, датчики высоты, шестерня EPS, EHC. */
  readonly extra: Readonly<Record<ExtraId, ExtraSignal>>;
}

const NO_EXTRA: Readonly<Record<ExtraId, ExtraSignal>> = EXTRA_IDS.reduce(
  (m, id) => ((m[id] = { value: null, quality: 'unavailable', updatedAt: null }), m),
  {} as Record<ExtraId, ExtraSignal>,
);

/** Диагностическое чтение (UDS) в снимке диагностики. */
export interface UdsDiagnosticsSnapshot {
  readonly available: boolean;
  readonly error: string | null;
  readonly visible: boolean;
  readonly stats: TasuStats;
  readonly ecus: readonly EcuDiagnostics[];
  readonly extraReasons: Readonly<Record<string, string>>;
}
export type ModelDiagnostics = VehicleDiagnostics & { readonly uds: UdsDiagnosticsSnapshot | null };

/**
 * Доменные функции сессии/производных читают только simTimeMs и signals; поле scenarioId
 * им не нужно. Приведение типа в одном месте, чтобы не менять общий доменный тип браузера.
 */
export const asDomain = (s: NativeSnapshot): TelemetrySnapshot => s as unknown as TelemetrySnapshot;

export interface NativeState {
  readonly mode: DataMode;
  readonly snapshot: NativeSnapshot;
  readonly session: SessionStats;
  /** Пауза — только у демо. */
  readonly paused: boolean;
  /** Выбранный демо-сценарий (сохраняется и в режиме автомобиля, но там не используется). */
  readonly scenarioId: ScenarioId;
  /** null в демо. */
  readonly vehicle: VehicleStatus | null;
  /** Увеличивается при смене режима или новой сессии — для сброса фаз анимации/кэшей. */
  readonly epoch: number;
}

export const isScenario = (v: unknown): v is ScenarioId => typeof v === 'string' && (SCENARIO_IDS as readonly string[]).indexOf(v) >= 0;
export const isMode = (v: unknown): v is DataMode => v === 'demo' || v === 'vehicle';

interface Source {
  state(): Omit<NativeState, 'mode' | 'scenarioId' | 'epoch'>;
  setScenario(id: ScenarioId): void;
  setPaused(p: boolean): boolean;
  newSession(): void;
  dispose(): void;
  /** Диагностика чтения (только автомобиль); по запросу экрана настроек, не на кадр. */
  diagnostics(): ModelDiagnostics | null;
  setVisible(v: boolean): void;
}

class DemoSource implements Source {
  private readonly store: AppStore;
  private readonly provider: MockTelemetryProvider;
  private wrappedFrom: unknown = null;
  private wrapped: NativeSnapshot | null = null;
  constructor(scenario: ScenarioId, now: Now) {
    this.provider = new MockTelemetryProvider(scenario, now);
    this.store = new AppStore(this.provider);
    this.provider.start();
  }
  state() {
    const s = this.store.getState();
    // тот же объект снимка, пока стор не сменил свой (пауза держит снимок)
    if (this.wrappedFrom !== s.snapshot) {
      this.wrappedFrom = s.snapshot;
      this.wrapped = { ...(s.snapshot as unknown as NativeSnapshot), extra: NO_EXTRA };
    }
    return { snapshot: this.wrapped as NativeSnapshot, session: s.session, paused: s.paused, vehicle: null };
  }
  setScenario(id: ScenarioId) {
    this.store.setScenario(id);
  }
  setPaused(p: boolean) {
    this.store.setPaused(p);
    return true;
  }
  newSession() {
    this.store.newSession();
  }
  dispose() {
    this.store.dispose();
  }
  diagnostics() {
    return null;
  }
  setVisible() {}
}

/**
 * Сессия (максимумы, история) — с частотой мок-провайдера (10 Гц). Снимок для кадра — НЕ по этому таймеру:
 * state() пересобирает его, как только адаптер принял новый отсчёт (revision) или прошло STALE_CHECK_MS (свежесть
 * по времени). Иначе уведомление (руль, педаль — только уведомления) ждало бы до 100 мс до ближайшего тика.
 */
const VEHICLE_TICK_MS = 100;
/** Сводка в журнал приложения (интервалы уведомлений, руль, UDS) — не чаще раза в 5 минут. */
export const LOG_SUMMARY_MS = 5 * 60 * 1000;
const STALE_CHECK_MS = 100;

class VehicleSource implements Source {
  private readonly adapter: VehicleAdapter;
  private readonly t0: number;
  private snapshot: NativeSnapshot;
  private builtRev = -1;
  private builtAt = 0;
  private session: SessionStats;
  private timer: ReturnType<typeof setInterval> | null;
  private readonly tasu: ReadOnlyTasu | null = null;
  private readonly uds: UdsReader | null = null;
  private visible = true;
  private disposed = false;
  /** Первая сводка — через 60 с после включения, затем раз в LOG_SUMMARY_MS. */
  private lastSummary = 60000 - LOG_SUMMARY_MS;
  constructor(
    watch: WatchFn,
    private readonly now: Now,
    private readonly log?: Log,
    tasuSignals?: TasuSignals,
  ) {
    this.t0 = now();
    this.adapter = new VehicleAdapter(watch, () => this.now() - this.t0, log);
    this.adapter.start();
    if (tasuSignals) {
      const tasu = new ReadOnlyTasu(tasuSignals);
      const uds = new UdsReader(tasu, () => this.now() - this.t0, (o) => this.adapter.putUds(o), undefined, { log });
      uds.setVisible(this.visible);
      this.tasu = tasu;
      this.uds = uds;
      void tasu.init().then(() => {
        if (this.disposed) return;
        if (tasu.error && log) log.warn(`uds: TASU unavailable: ${tasu.error}`);
        uds.start();
      });
    }
    this.snapshot = this.build();
    this.session = createSession(asDomain(this.snapshot));
    this.timer = setInterval(() => this.tick(), VEHICLE_TICK_MS);
  }
  private build(): NativeSnapshot {
    const simTimeMs = this.now() - this.t0;
    this.builtRev = this.adapter.revision;
    this.builtAt = simTimeMs;
    return { simTimeMs, scenarioId: null, signals: this.adapter.signals(simTimeMs), extra: this.adapter.extras(simTimeMs) };
  }
  /** Снимок свежий: ни нового отсчёта, ни STALE_CHECK_MS с прошлой сборки. */
  private current(): NativeSnapshot {
    if (this.adapter.isActive && (this.adapter.revision !== this.builtRev || this.now() - this.t0 - this.builtAt >= STALE_CHECK_MS)) this.snapshot = this.build();
    return this.snapshot;
  }
  tick() {
    if (!this.adapter.isActive) return;
    this.session = ingestSample(this.session, asDomain(this.current()));
    const at = this.now() - this.t0;
    if (this.log && at - this.lastSummary >= LOG_SUMMARY_MS) {
      this.lastSummary = at;
      this.logSummary();
    }
  }
  /** Ограниченная сводка в журнал приложения (обычный режим, без листа разработчика). */
  logSummary() {
    if (!this.log) return;
    const d = this.adapter.diagnostics(this.now() - this.t0);
    for (const line of logSummary(d)) this.log.info(line);
    if (this.tasu && this.uds) {
      const s = this.tasu.stats;
      this.log.info(`uds: ${this.tasu.available ? 'available' : 'unavailable'} requests ${s.requests} ok ${s.ok} nrc ${s.nrc} timeout ${s.timeouts} refused ${s.refused}; ${this.uds.diagnostics().map((e) => `${e.key}=${e.state}${e.identity ? `:${e.identity}` : ''}`).join(' ')}`);
    }
  }
  state() {
    return { snapshot: this.current(), session: this.session, paused: false, vehicle: this.adapter.status() };
  }
  setScenario() {}
  /** Живые данные не ставятся на паузу. */
  setPaused() {
    return false;
  }
  newSession() {
    this.session = createSession(asDomain(this.snapshot));
  }
  diagnostics(): ModelDiagnostics {
    const at = this.now() - this.t0;
    const extraReasons: Record<string, string> = {};
    this.adapter.extras(at, extraReasons);
    const uds = this.tasu && this.uds ? { available: this.tasu.available, error: this.tasu.error, visible: this.visible, stats: { ...this.tasu.stats }, ecus: this.uds.diagnostics(), extraReasons } : null;
    return { ...this.adapter.diagnostics(at), uds };
  }
  /** Экран не виден — диагностическое чтение стоит (подписки SOME/IP не трогаются). */
  setVisible(v: boolean) {
    this.visible = v;
    if (this.uds) this.uds.setVisible(v);
  }
  dispose() {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.uds) void this.uds.stop();
    void this.adapter.stop();
  }
}

export interface ModelDeps {
  readonly now: Now;
  readonly watch: WatchFn;
  readonly log?: Log;
  /** Только чтение по UDS (InternalTasu); без него — только SOME/IP. */
  readonly tasu?: TasuSignals;
}

export class NativeModel {
  private mode: DataMode;
  private scenario: ScenarioId;
  private source: Source;
  private epoch = 0;
  private disposed = false;

  constructor(
    private readonly deps: ModelDeps,
    mode: DataMode = DEFAULT_MODE,
    scenario: ScenarioId = 'mountainTrail',
  ) {
    this.mode = mode;
    this.scenario = scenario;
    this.source = this.create();
  }

  private create(): Source {
    return this.mode === 'vehicle' ? new VehicleSource(this.deps.watch, this.deps.now, this.deps.log, this.deps.tasu) : new DemoSource(this.scenario, this.deps.now);
  }

  getState(): NativeState {
    return { ...this.source.state(), mode: this.mode, scenarioId: this.scenario, epoch: this.epoch };
  }

  get dataMode(): DataMode {
    return this.mode;
  }

  /** Смена источника: старый уничтожается вместе с сессией и подписками. */
  setMode(mode: DataMode): void {
    if (this.disposed || mode === this.mode) return;
    this.source.dispose();
    this.mode = mode;
    this.epoch++;
    this.source = this.create();
  }

  setScenario(id: ScenarioId): void {
    this.scenario = id;
    this.source.setScenario(id);
  }

  /** false — в этом режиме пауза недоступна. */
  setPaused(paused: boolean): boolean {
    return this.source.setPaused(paused);
  }

  togglePause(): boolean {
    return this.setPaused(!this.source.state().paused);
  }

  newSession(): void {
    this.source.newSession();
    this.epoch++;
  }

  /** Снимок диагностики режима «Автомобиль» (null в демо). Собирается по запросу, не в цикле кадра. */
  diagnostics(): ModelDiagnostics | null {
    return this.disposed ? null : this.source.diagnostics();
  }

  /** Экран приложения виден (для диагностического чтения). */
  setVisible(v: boolean): void {
    this.source.setVisible(v);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source.dispose();
  }
}
