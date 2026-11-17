import { createSession, ingestSample, type SessionStats } from '../domain/session';
import type { ScenarioId, TelemetrySnapshot } from '../domain/types';
import { MockTelemetryProvider } from '../providers/mock/MockTelemetryProvider';

export interface AppState {
  readonly snapshot: TelemetrySnapshot;
  readonly session: SessionStats;
  readonly paused: boolean;
  readonly scenarioId: ScenarioId;
}

/** Состояние приложения вне React: провайдер + сессия. React лишь подписывается. */
export class AppStore {
  private state: AppState;
  private readonly listeners = new Set<() => void>();
  private readonly provider: MockTelemetryProvider;
  private readonly unsubscribe: () => void;

  constructor(provider: MockTelemetryProvider) {
    this.provider = provider;
    const snapshot = provider.getSnapshot();
    this.state = { snapshot, session: createSession(snapshot), paused: provider.paused, scenarioId: provider.scenario };
    this.unsubscribe = provider.subscribe((s) => {
      this.set({ snapshot: s, session: ingestSample(this.state.session, s), scenarioId: provider.scenario });
    });
  }

  getState = (): AppState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setScenario(id: ScenarioId): void {
    this.provider.setScenario(id);
  }

  setPaused(paused: boolean): void {
    this.provider.setPaused(paused);
    this.set({ paused });
  }

  /** Новая сессия: текущий снимок становится первым измерением. */
  newSession(): void {
    this.set({ session: createSession(this.state.snapshot) });
  }

  dispose(): void {
    this.unsubscribe();
    this.provider.dispose();
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}
