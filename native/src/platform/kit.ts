import type { GaugesApi, MguApi, RecordApi } from './kitTypes';

export interface Kit {
  readonly mgu: MguApi;
  readonly G: GaugesApi;
  readonly record: RecordApi;
}

/**
 * Рантайм upstream подключается во время выполнения: build.py кладёт kit/ рядом с app.js
 * (наш main.js). Пути буквальные — сборка оставляет их внешними (native/scripts/build.ts).
 */
export function loadKit(): Kit {
  return {
    mgu: require('./kit/mgu') as MguApi,
    G: require('./kit/gauges') as GaugesApi,
    record: require('./kit/record') as RecordApi,
  };
}
