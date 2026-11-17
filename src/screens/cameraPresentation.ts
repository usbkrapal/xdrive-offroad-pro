import type { ScenarioId } from '../domain/types';

/**
 * Локальная модель демонстрационных видов камер. Это не сигналы телеметрии и не камеры автомобиля:
 * три статичных изображения и детерминированная доступность по демо-сценарию.
 */
export const CAMERA_IDS = ['front', 'left', 'right'] as const;
export type CameraId = (typeof CAMERA_IDS)[number];

export const DEFAULT_PRIMARY_CAMERA: CameraId = 'front';

/** available — показываем локальное изображение; simulatedLoss — смоделированная потеря, только заглушка. */
export type CameraAvailability = 'available' | 'simulatedLoss';

const SIMULATED_LOSS: Partial<Record<ScenarioId, readonly CameraId[]>> = {
  partialLoss: ['left'],
};

export function cameraAvailability(scenarioId: ScenarioId, id: CameraId): CameraAvailability {
  return SIMULATED_LOSS[scenarioId]?.includes(id) ? 'simulatedLoss' : 'available';
}

export interface CameraView {
  readonly id: CameraId;
  readonly availability: CameraAvailability;
}

export interface CameraLayout {
  readonly primary: CameraView;
  readonly secondary: readonly CameraView[];
}

/**
 * Раскладка зависит только от выбора пользователя: сценарий меняет доступность, но не основной вид.
 * Недоступный вид остаётся основным, если выбран, — его заглушку можно рассмотреть крупно.
 */
export function cameraLayout(primary: CameraId, scenarioId: ScenarioId): CameraLayout {
  const view = (id: CameraId): CameraView => ({ id, availability: cameraAvailability(scenarioId, id) });
  return {
    primary: view(primary),
    secondary: CAMERA_IDS.filter((id) => id !== primary).map(view),
  };
}
