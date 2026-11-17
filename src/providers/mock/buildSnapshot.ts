import { buildSignal } from '../../domain/signal';
import { SIGNAL_IDS } from '../../domain/signalCatalog';
import type { ScenarioId, Signal, SignalId, SignalMap, SignalValueMap, TelemetrySnapshot } from '../../domain/types';
import { SCENARIOS, activeLoss } from './scenarios';

/**
 * Чистая функция: снимок сценария на момент simTimeMs.
 * scenarioStartMs — simTime, когда был выбран сценарий (локальное время сценария = разность).
 */
export function buildSnapshot(scenarioId: ScenarioId, scenarioStartMs: number, simTimeMs: number): TelemetrySnapshot {
  const def = SCENARIOS[scenarioId];
  const t = Math.max(0, simTimeMs - scenarioStartMs) / 1000;
  const frame = def.generate(t);
  const frozenFrames = new Map<number, ReturnType<typeof def.generate>>();
  const signals: Partial<Record<SignalId, Signal<unknown>>> = {};

  for (const id of SIGNAL_IDS) {
    const loss = activeLoss(def, id, t);
    let raw: SignalValueMap[SignalId] | undefined = frame[id];
    let updatedAt = simTimeMs;
    if (loss?.kind === 'unavailable') {
      raw = undefined;
    } else if (loss?.kind === 'invalid') {
      raw = Number.NaN;
    } else if (loss?.kind === 'stale') {
      // Значение «замерло» в момент начала окна: старое значение и старый updatedAt.
      let frozen = frozenFrames.get(loss.frozenAt);
      if (!frozen) {
        frozen = def.generate(loss.frozenAt);
        frozenFrames.set(loss.frozenAt, frozen);
      }
      raw = frozen[id];
      updatedAt = scenarioStartMs + loss.frozenAt * 1000;
    }
    signals[id] = buildSignal(id, raw as never, updatedAt, simTimeMs);
  }

  return { simTimeMs, scenarioId, signals: signals as SignalMap };
}
