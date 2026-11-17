import { useState } from 'react';
import type { AppState } from '../app/store';
import frontUrl from '../assets/camera-front-demo.png';
import leftUrl from '../assets/camera-left-demo.png';
import rightUrl from '../assets/camera-right-demo.png';
import { useT, type Dictionary } from '../i18n';
import { DEFAULT_PRIMARY_CAMERA, cameraLayout, type CameraId, type CameraView } from './cameraPresentation';

/** Локальные статичные демо-изображения; не кадры камер автомобиля. */
const CAMERA_SRC: Record<CameraId, string> = { front: frontUrl, left: leftUrl, right: rightUrl };

interface ViewProps {
  view: CameraView;
  isPrimary: boolean;
  loadFailed: boolean;
  onLoadError: (id: CameraId) => void;
  onPromote: (id: CameraId) => void;
  t: Dictionary;
}

function CameraPanel({ view, isPrimary, loadFailed, onLoadError, onPromote, t }: ViewProps) {
  const { id, availability } = view;
  const name = t.cameras.names[id];
  const nameId = `camview-${id}-name`;
  const reason = availability === 'simulatedLoss' ? t.cameras.simulatedLoss : loadFailed ? t.cameras.loadError : null;
  const action = isPrimary ? t.cameras.primary : t.cameras.enlarge;

  return (
    <section
      className={`camview camview--${id}${isPrimary ? ' is-primary' : ''}${reason ? ' is-unavailable' : ''}`}
      aria-labelledby={nameId}
    >
      <header className="camview__head">
        <div className="camview__titles">
          <h2 id={nameId} className="camview__name">
            {name}
          </h2>
          <span className="camview__demo">{t.cameras.demoLabel}</span>
        </div>
        <button
          type="button"
          className="camview__action"
          aria-pressed={isPrimary}
          aria-label={`${action}: ${name}`}
          onClick={isPrimary ? undefined : () => onPromote(id)}
        >
          {action}
        </button>
      </header>
      <div className="camview__frame">
        {reason ? (
          <div className={`camview__placeholder${availability === 'simulatedLoss' ? ' camview__placeholder--simulated' : ''}`}>
            <svg className="camview__placeholder-icon" viewBox="0 0 48 32" aria-hidden="true">
              <rect x="3" y="7" width="30" height="20" rx="2" />
              <path d="M33 14 L45 8 V26 L33 20" />
              <line x1="2" y1="30" x2="46" y2="2" />
            </svg>
            <strong className="camview__placeholder-title">{t.cameras.unavailable}</strong>
            <span className="camview__placeholder-reason">{reason}</span>
          </div>
        ) : (
          <img
            className="camview__img"
            src={CAMERA_SRC[id]}
            alt={t.cameras.alt[id]}
            decoding="async"
            draggable={false}
            onError={() => onLoadError(id)}
          />
        )}
      </div>
    </section>
  );
}

export function CamerasScreen({ state }: { state: AppState }) {
  const t = useT();
  // Выбор — только локальная раскладка экрана; тики телеметрии, пауза и сценарий его не трогают.
  const [primary, setPrimary] = useState<CameraId>(DEFAULT_PRIMARY_CAMERA);
  const [failed, setFailed] = useState<ReadonlySet<CameraId>>(() => new Set());
  const layout = cameraLayout(primary, state.scenarioId);

  const onLoadError = (id: CameraId) => setFailed((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  const panel = (view: CameraView, isPrimary: boolean) => (
    <CameraPanel
      key={view.id}
      view={view}
      isPrimary={isPrimary}
      loadFailed={failed.has(view.id)}
      onLoadError={onLoadError}
      onPromote={setPrimary}
      t={t}
    />
  );

  return (
    <div className="cameras">
      <div className="cameras__stage">
        <p className="cameras__note" role="note">
          {t.cameras.note}
        </p>
        {panel(layout.primary, true)}
        <div className="cameras__side">{layout.secondary.map((v) => panel(v, false))}</div>
      </div>
    </div>
  );
}
