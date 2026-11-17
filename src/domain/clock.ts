/**
 * Часы симуляции. Время идёт только в состоянии running; после паузы
 * продолжение начинается с того же simTime, без пропущенного реального времени.
 */
export interface SimClock {
  readonly running: boolean;
  readonly simTimeMs: number;
  /** Последняя метка реального времени, к которой приведён simTime. */
  readonly lastRealMs: number | null;
}

/** Ограничение шага: свёрнутая вкладка или зависание не дают скачка. */
export const MAX_STEP_MS = 250;

export function createClock(startSimMs = 0): SimClock {
  return { running: true, simTimeMs: startSimMs, lastRealMs: null };
}

export function tickClock(clock: SimClock, realNowMs: number): SimClock {
  if (!clock.running) return clock;
  if (clock.lastRealMs === null) return { ...clock, lastRealMs: realNowMs };
  const dt = Math.min(Math.max(realNowMs - clock.lastRealMs, 0), MAX_STEP_MS);
  return { ...clock, simTimeMs: clock.simTimeMs + dt, lastRealMs: realNowMs };
}

export function pauseClock(clock: SimClock): SimClock {
  return { ...clock, running: false, lastRealMs: null };
}

export function resumeClock(clock: SimClock, realNowMs: number): SimClock {
  if (clock.running) return clock;
  return { ...clock, running: true, lastRealMs: realNowMs };
}
