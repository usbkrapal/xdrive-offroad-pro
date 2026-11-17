import { SCENARIO_IDS, type ScenarioId } from '../domain/types';
import { useT } from '../i18n';
import { formatDuration } from '../i18n/format';

interface DemoToolbarProps {
  scenarioId: ScenarioId;
  paused: boolean;
  simTimeMs: number;
  onScenario: (id: ScenarioId) => void;
  onTogglePause: () => void;
  onNewSession: () => void;
}

/** Управление только локальной симуляцией. Ничего не отправляется автомобилю. */
export function DemoToolbar({ scenarioId, paused, simTimeMs, onScenario, onTogglePause, onNewSession }: DemoToolbarProps) {
  const t = useT();
  return (
    <footer className="demobar" role="region" aria-label={t.demo.toolbarAria}>
      <span className="demobar__title">{t.demo.title}</span>
      <label className="demobar__field">
        <span className="visually-hidden">{t.demo.scenarioLabel}</span>
        <select
          value={scenarioId}
          onChange={(e) => onScenario(e.target.value as ScenarioId)}
          className="demobar__select"
          title={t.demo.note}
        >
          {SCENARIO_IDS.map((id) => (
            <option key={id} value={id}>
              {t.scenarios[id].name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="demobar__btn" onClick={onTogglePause} aria-pressed={paused}>
        <span className={`demobar__icon ${paused ? 'is-play' : 'is-pause'}`} aria-hidden="true" />
        {paused ? t.demo.resume : t.demo.pause}
      </button>
      <button type="button" className="demobar__btn" onClick={onNewSession}>
        {t.demo.newSession}
      </button>
      <span className="demobar__desc">{t.scenarios[scenarioId].description}</span>
      <span className="demobar__time" aria-live="off">
        {t.demo.simTime} <b>{formatDuration(simTimeMs)}</b>
        <span className={`demobar__state${paused ? ' is-paused' : ''}`}>{paused ? t.demo.paused : t.demo.running}</span>
      </span>
    </footer>
  );
}
