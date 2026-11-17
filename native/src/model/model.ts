// Модель нативного приложения: ровно один источник данных за раз.
// DEMO — тот же AppStore + MockTelemetryProvider, что и в браузере (сценарии, пауза, сессия).
// VEHICLE — VehicleAdapter (только чтение). Смена режима уничтожает источник И сессию:
// демо- и живые данные никогда не смешиваются, автоматического перехода live → demo нет.

import { AppStore } from '../../../src/app/store';
import { createSession, ingestSample, type SessionStats } from '../../../src/domain/session';
import { SCENARIO_IDS, type ScenarioId, type SignalMap, type TelemetrySnapshot } from '../../../src/domain/types';
import { MockTelemetryProvider } from '../../../src/providers/mock/MockTelemetryProvider';
import type { Now } from '../clock';
import type { Log, WatchFn } from '../platform/kitTypes';
import { VehicleAdapter, type VehicleStatus } from '../vehicle/adapter';

export type DataMode = 'demo' | 'vehicle';
export const DATA_MODES: readonly DataMode[] = ['demo', 'vehicle'];
export const DEFAULT_MODE: DataMode = 'demo';

/** Снимок нативной модели. В режиме автомобиля сценария нет (null). */
export interface NativeSnapshot {
  readonly simTimeMs: number;
  readonly scenarioId: ScenarioId | null;
  readonly signals: SignalMap;
}

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
}

class DemoSource implements Source {
  private readonly store: AppStore;
  private readonly provider: MockTelemetryProvider;
  constructor(scenario: ScenarioId, now: Now) {
    this.provider = new MockTelemetryProvider(scenario, now);
    this.store = new AppStore(this.provider);
    this.provider.start();
  }
  state() {
    const s = this.store.getState();
    return { snapshot: s.snapshot, session: s.session, paused: s.paused, vehicle: null };
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
}

/** Опрос адаптера с частотой мок-провайдера (10 Гц); сессия — те же доменные агрегаты. */
const VEHICLE_TICK_MS = 100;

class VehicleSource implements Source {
  private readonly adapter: VehicleAdapter;
  private readonly t0: number;
  private snapshot: NativeSnapshot;
  private session: SessionStats;
  private timer: ReturnType<typeof setInterval> | null;
  constructor(
    watch: WatchFn,
    private readonly now: Now,
    log?: Log,
  ) {
    this.t0 = now();
    this.adapter = new VehicleAdapter(watch, () => this.now() - this.t0, log);
    this.adapter.start();
    this.snapshot = this.build();
    this.session = createSession(asDomain(this.snapshot));
    this.timer = setInterval(() => this.tick(), VEHICLE_TICK_MS);
  }
  private build(): NativeSnapshot {
    const simTimeMs = this.now() - this.t0;
    return { simTimeMs, scenarioId: null, signals: this.adapter.signals(simTimeMs) };
  }
  tick() {
    if (!this.adapter.isActive) return;
    this.snapshot = this.build();
    this.session = ingestSample(this.session, asDomain(this.snapshot));
  }
  state() {
    return { snapshot: this.snapshot, session: this.session, paused: false, vehicle: this.adapter.status() };
  }
  setScenario() {}
  /** Живые данные не ставятся на паузу. */
  setPaused() {
    return false;
  }
  newSession() {
    this.session = createSession(asDomain(this.snapshot));
  }
  dispose() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    void this.adapter.stop();
  }
}

export interface ModelDeps {
  readonly now: Now;
  readonly watch: WatchFn;
  readonly log?: Log;
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
    return this.mode === 'vehicle' ? new VehicleSource(this.deps.watch, this.deps.now, this.deps.log) : new DemoSource(this.scenario, this.deps.now);
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source.dispose();
  }
}
