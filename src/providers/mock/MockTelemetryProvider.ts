import { createClock, pauseClock, resumeClock, tickClock, type SimClock } from '../../domain/clock';
import type { ScenarioId, TelemetrySnapshot } from '../../domain/types';
import type { TelemetryProvider } from '../TelemetryProvider';
import { buildSnapshot } from './buildSnapshot';

const TICK_MS = 100;

/**
 * Локальный демо-источник. Управляет только симуляцией (сценарий, пауза),
 * никаких обращений к автомобилю или сети.
 */
export class MockTelemetryProvider implements TelemetryProvider {
  private clock: SimClock;
  private scenarioId: ScenarioId;
  private scenarioStartMs = 0;
  private snapshot: TelemetrySnapshot;
  private readonly listeners = new Set<(s: TelemetrySnapshot) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(scenarioId: ScenarioId, now: () => number = () => performance.now()) {
    this.now = now;
    this.scenarioId = scenarioId;
    this.clock = createClock();
    this.snapshot = buildSnapshot(scenarioId, this.scenarioStartMs, this.clock.simTimeMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.clock = tickClock(this.clock, this.now());
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  getSnapshot(): TelemetrySnapshot {
    return this.snapshot;
  }

  subscribe(listener: (s: TelemetrySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  get paused(): boolean {
    return !this.clock.running;
  }

  get scenario(): ScenarioId {
    return this.scenarioId;
  }

  setPaused(paused: boolean): void {
    this.clock = paused ? pauseClock(this.clock) : resumeClock(this.clock, this.now());
  }

  /** Смена сценария начинает его локальное время с нуля; simTime и сессия продолжаются. */
  setScenario(id: ScenarioId): void {
    this.scenarioId = id;
    this.scenarioStartMs = this.clock.simTimeMs;
    this.publish();
  }

  private tick(): void {
    const next = tickClock(this.clock, this.now());
    if (next === this.clock) return;
    this.clock = next;
    this.publish();
  }

  private publish(): void {
    this.snapshot = buildSnapshot(this.scenarioId, this.scenarioStartMs, this.clock.simTimeMs);
    for (const l of this.listeners) l(this.snapshot);
  }
}
