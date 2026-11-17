import type { AppState } from '../app/store';
import { maxSlipNow } from '../domain/derived';
import { usableNumber, usableValue } from '../domain/signal';
import { WHEELS, type Wheel } from '../domain/types';
import { extremumDisplay } from '../components/displayHelpers';
import { BarGauge, Panel } from '../components/Panel';
import { Readout } from '../components/Readout';
import { StatusTag } from '../components/StatusTag';
import { DrivetrainStage } from '../components/DrivetrainStage';
import { useFormat, type Format } from '../components/useFormat';
import { displaySignal } from '../i18n/format';

function WheelCard({ wheel, state, f }: { wheel: Wheel; state: AppState; f: Format }) {
  const { t } = f;
  const s = state.snapshot.signals;
  const slipSig = s[`wheelSlip.${wheel}`];
  const brakeSig = s[`brakeIntervention.${wheel}`];
  const brake = displaySignal(brakeSig, (v) => (v ? t.brake.active : t.brake.inactive));
  const braking = usableValue(brakeSig) === true;
  return (
    <section
      className={`wheelcard wheelcard--${wheel.toLowerCase()}${braking ? ' is-braking' : ''}`}
      aria-label={`${t.wheels[wheel].long} (${t.wheels[wheel].code})`}
    >
      <header className="wheelcard__head">
        <span className="wheelcard__short">{t.wheels[wheel].short}</span>
        <span className="wheelcard__name">
          {t.wheels[wheel].code} · {t.wheels[wheel].long}
        </span>
      </header>
      <div className="wheelcard__row">
        <Readout label={t.traction.wheelSpeed} display={f.num(s[`wheelSpeed.${wheel}`], 1)} unit={t.units.km_h} size="md" signal={s[`wheelSpeed.${wheel}`]} />
        <Readout label={t.traction.slip} display={f.num(slipSig, 0)} unit={t.units.percent} size="md" signal={slipSig}>
          <BarGauge value={usableNumber(slipSig)} max={100} tone={(usableNumber(slipSig) ?? 0) >= 30 ? 'warn' : 'ice'} />
        </Readout>
      </div>
      <div className="wheelcard__brake" title={f.provenance(brakeSig)}>
        <span className="wheelcard__brake-label">{t.traction.brakeIntervention}</span>
        <span className={`wheelcard__brake-value${braking ? ' is-on' : ''}`}>
          <span className="brake-mark" aria-hidden="true" />
          {brake.text}
          {!brake.ok ? <StatusTag quality={brake.quality} compact /> : null}
        </span>
      </div>
    </section>
  );
}

export function TractionScreen({ state }: { state: AppState }) {
  const f = useFormat();
  const { t } = f;
  const { snapshot, session } = state;
  const s = snapshot.signals;
  const locale = t.locale;
  const front = f.num(s['xdrive.frontPercent'], 0);
  const rear = f.num(s['xdrive.rearPercent'], 0);
  const frontV = usableNumber(s['xdrive.frontPercent']);
  const splitSource = s['xdrive.rearPercent'].runtimeSource;
  const nowMax = maxSlipNow(snapshot);
  const diffState = displaySignal(s['rearDiff.lockState'], (v) => t.diffLock[v]);

  return (
    <div className="traction">
      <Panel title={t.traction.split} className="traction__split" aside={<span className="source-chip">{t.source[splitSource]}</span>}>
        <div className="split">
          <Readout label={t.traction.front} display={front} unit={t.units.percent} size="xl" signal={s['xdrive.frontPercent']} />
          <Readout label={t.traction.rear} display={rear} unit={t.units.percent} size="xl" signal={s['xdrive.rearPercent']} className="split__rear" />
        </div>
        <div className={`splitbar${frontV === null ? ' is-empty' : ''}`} aria-hidden="true">
          {frontV !== null ? (
            <>
              <span className="splitbar__front" style={{ width: `${frontV}%` }} />
              <span className="splitbar__rear" />
            </>
          ) : null}
        </div>
        <div className="split__torque">
          <Readout label={t.traction.frontTorque} display={f.num(s['xdrive.frontTorqueNm'], 0)} unit={t.units.nm} size="lg" signal={s['xdrive.frontTorqueNm']} />
          <Readout
            label={t.traction.rearTorque}
            display={f.num(s['xdrive.rearTorqueNm'], 0)}
            unit={t.units.nm}
            size="lg"
            signal={s['xdrive.rearTorqueNm']}
          />
        </div>
        <dl className="kv">
          <dt>{t.traction.splitSource}</dt>
          <dd>
            <span className="source-chip">{t.source[splitSource]}</span>
          </dd>
        </dl>
      </Panel>

      <div className="traction__wheels">
        <WheelCard wheel="FL" state={state} f={f} />
        <WheelCard wheel="FR" state={state} f={f} />
        <div className="traction__car">
          <DrivetrainStage signals={s} paused={state.paused} compact />
        </div>
        <WheelCard wheel="RL" state={state} f={f} />
        <WheelCard wheel="RR" state={state} f={f} />
      </div>

      <div className="traction__side">
        <Panel title={t.traction.diff}>
          <div className="pair pair--wrap">
            <Readout label={t.traction.diffState} display={diffState} size="md" signal={s['rearDiff.lockState']} />
            <Readout label={t.traction.diffPercent} display={f.num(s['rearDiff.lockPercent'], 0)} unit={t.units.percent} size="md" signal={s['rearDiff.lockPercent']} />
          </div>
        </Panel>
        <Panel title={t.traction.keyMetrics}>
          <div className="pair">
            <Readout label={t.terrain.steering} display={f.num(s.steeringWheelAngleDeg, 0, true)} unit={t.units.deg} size="md" signal={s.steeringWheelAngleDeg} />
            <Readout label={t.terrain.speed} display={f.num(s.vehicleSpeedKmh, 1)} unit={t.units.km_h} size="md" signal={s.vehicleSpeedKmh} />
          </div>
          <div className="pair">
            <Readout
              label={t.session.maxSlip}
              display={extremumDisplay(session.maxSlipOverall, 0, locale)}
              unit={session.maxSlipOverall ? `${t.units.percent} ${t.wheels[session.maxSlipOverall.wheel].short}` : t.units.percent}
              size="md"
              hint={nowMax ? `${f.value(nowMax.value, 0)} ${t.units.percent} ${t.wheels[nowMax.wheel].short} · ${t.traction.now}` : undefined}
            />
            <Readout label={t.session.maxTorque} display={extremumDisplay(session.maxEngineTorque, 0, locale)} unit={t.units.nm} size="md" />
          </div>
          <div className="wheelmax" aria-label={t.session.maxSlipWheel}>
            <span className="wheelmax__title">{t.session.maxSlipWheel}</span>
            {WHEELS.map((w) => {
              const d = extremumDisplay(session.maxSlip[w], 0, locale);
              return (
                <span key={w} className="wheelmax__item">
                  <b>{t.wheels[w].short}</b> {d.text}
                  {d.ok ? ` ${t.units.percent}` : ''}
                </span>
              );
            })}
          </div>
        </Panel>
      </div>
    </div>
  );
}
