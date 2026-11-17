import type { AppState } from '../app/store';
import { usableValue } from '../domain/signal';
import { altitudeChangeFromStart, sessionElapsedMs } from '../domain/session';
import { AttitudeDial } from '../components/AttitudeDial';
import { extremumDisplay, gearDisplay, hdcDisplay } from '../components/displayHelpers';
import { LevelIndicator } from '../components/LevelIndicator';
import { Panel } from '../components/Panel';
import { Readout } from '../components/Readout';
import { SteeringIndicator } from '../components/SteeringIndicator';
import { useFormat } from '../components/useFormat';
import { DrivetrainStage } from '../components/DrivetrainStage';
import { formatDuration } from '../i18n/format';

export function TerrainScreen({ state }: { state: AppState }) {
  const f = useFormat();
  const { t } = f;
  const { snapshot, session } = state;
  const s = snapshot.signals;
  const locale = t.locale;

  const altChange = altitudeChangeFromStart(session, snapshot);
  const hdc = hdcDisplay(s['hdc.status'], t);
  const hdcActive = usableValue(s['hdc.status']) === 'active';
  const setSpeed = f.num(s['hdc.setSpeedKmh'], 0);
  const slipMax = session.maxSlipOverall;

  return (
    <div className="terrain">
      <div className="terrain__attitude">
        <Panel className="panel--attitude">
          <AttitudeDial kind="pitch" signal={s['attitude.pitchDeg']} paused={state.paused} />
        </Panel>
        <Panel className="panel--attitude">
          <AttitudeDial kind="roll" signal={s['attitude.rollDeg']} paused={state.paused} />
        </Panel>
      </div>

      <div className="terrain__stage">
        <DrivetrainStage signals={s} paused={state.paused} />
      </div>

      <div className="terrain__side">
        <Panel className="panel--metric">
          <Readout
            label={t.terrain.altitude}
            display={f.num(s.altitudeM, 0)}
            unit={t.units.m}
            size="lg"
            signal={s.altitudeM}
            hint={
              altChange !== null ? (
                <span className="delta">
                  {f.value(altChange, 1, true)} {t.units.m} {t.terrain.altitudeChange}
                </span>
              ) : undefined
            }
          />
        </Panel>
        <Panel className="panel--metric">
          <SteeringIndicator signal={s.steeringWheelAngleDeg} />
        </Panel>
        <Panel className="panel--metric">
          <LevelIndicator signal={s['suspension.level']} variant="compact" label={t.terrain.suspensionLevel} />
        </Panel>
      </div>

      <div className="terrain__strip">
        <div className="strip__group strip__group--drive">
          <Readout label={t.terrain.speed} display={f.num(s.vehicleSpeedKmh, 1)} unit={t.units.km_h} size="lg" signal={s.vehicleSpeedKmh} />
          <Readout label={t.terrain.gear} display={gearDisplay(s.gear)} size="lg" signal={s.gear} />
          <Readout
            label={t.terrain.hdc}
            display={hdc}
            size="md"
            signal={s['hdc.status']}
            className={hdcActive ? 'is-active' : undefined}
            hint={
              setSpeed.ok ? (
                <>
                  {t.terrain.hdcSet} {setSpeed.text} {t.units.km_h}
                </>
              ) : hdcActive || setSpeed.quality !== 'unavailable' ? (
                <>
                  {t.terrain.hdcSet} — {t.quality[setSpeed.quality]}
                </>
              ) : undefined
            }
          />
        </div>
        <div className="strip__group strip__group--session" aria-label={t.terrain.sessionTitle}>
          <span className="strip__caption">{t.terrain.sessionTitle}</span>
          <Readout
            label={t.session.elapsed}
            display={{ text: formatDuration(sessionElapsedMs(session, snapshot.simTimeMs)), quality: 'valid', ok: true }}
            size="sm"
          />
          <Readout label={t.session.maxAbsPitch} display={extremumDisplay(session.maxAbsPitch, 1, locale)} unit={t.units.deg} size="sm" />
          <Readout label={t.session.maxAbsRoll} display={extremumDisplay(session.maxAbsRoll, 1, locale)} unit={t.units.deg} size="sm" />
          <Readout
            label={t.session.altitudeRange}
            display={
              session.minAltitude && session.maxAltitude
                ? {
                    text: `${f.value(session.minAltitude.value, 0)} / ${f.value(session.maxAltitude.value, 0)}`,
                    quality: 'valid',
                    ok: true,
                  }
                : extremumDisplay(null, 0, locale)
            }
            unit={t.units.m}
            size="sm"
          />
          <Readout
            label={t.session.maxSlip}
            display={extremumDisplay(slipMax, 0, locale)}
            unit={slipMax ? `${t.units.percent} ${t.wheels[slipMax.wheel].short}` : t.units.percent}
            size="sm"
          />
        </div>
      </div>
    </div>
  );
}
