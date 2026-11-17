import type { TelemetrySnapshot } from '../domain/types';

/**
 * Read-only источник телеметрии. Контракт намеренно не содержит методов записи,
 * управления подвеской/DSC/HDC, диагностики или очистки ошибок.
 */
export interface TelemetryProvider {
  getSnapshot(): TelemetrySnapshot;
  /** Возвращает функцию отписки. */
  subscribe(listener: (snapshot: TelemetrySnapshot) => void): () => void;
  dispose(): void;
}
