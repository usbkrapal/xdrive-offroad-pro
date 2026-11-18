import type { AppState } from '../app/store';
import type { Extremum } from '../domain/session';
import { usableNumber, usableValue } from '../domain/signal';
import { WHEELS, type Signal, type Wheel } from '../domain/types';
import { extremumDisplay, gearDisplay, hdcDisplay } from '../components/displayHelpers';
import { BarGauge, Panel } from '../components/Panel';
import { Readout } from '../components/Readout';
import { StatusTag } from '../components/StatusTag';
import { TopDownCar } from '../components/TopDownCar';
import { useFormat, type Format } from '../components/useFormat';

const G_LIMIT = 0.5;

function TempRow({ label, signal, max, f }: { label: string; signal: Signal<number>; max: Extremum | null; f: Format }) {
  const { t } = f;
  const v = usableNumber(signal);
  const m = extremumDisplay(max, 0, t.locale);
  return (
    <div className="temprow">
      <Readout
        label={label}
        display={f.num(signal, 0)}
        unit={t.units.celsius}
        size="lg"
        signal={signal}
        hint={`${t.systems.sessionMax} ${m.text}${m.ok ? ` ${t.units.celsius}` : ''}`}
      >
        <BarGauge value={v} min={40} max={140} tone={v !== null && v >= 115 ? 'warn' : 'ice'} />
      </Readout>
    </div>
  );
}

function TyreBlock({ wheel, state, f }: { wheel: Wheel; state: AppState; f: Format }) {
  const { t } = f;
  const s = state.snapshot.signals;
  const p = f.num(s[`tyrePressure.${wheel}`], 1);
  const temp = f.num(s[`tyreTemperature.${wheel}`], 0);
  return (
    <div className={`tyre tyre--${wheel.toLowerCase()}`} aria-label={`${t.wheels[wheel].long} (${t.wheels[wheel].code})`} role="group">
      <div className="tyre__head">
        <b>{t.wheels[wheel].short}</b> {t.wheels[wheel].code}
      </div>
      <div className="tyre__val" title={f.provenance(s[`tyrePressure.${wheel}`])}>
        <span className="tyre__label">{t.systems.pressure}</span>
        <span className="tyre__num">{p.text}</span>
        {p.ok ? <span className="tyre__unit">{t.units.bar}</span> : <StatusTag quality={p.quality} compact />}
      </div>
      <div className="tyre__val" title={f.provenance(s[`tyreTemperature.${wheel}`])}>
        <span className="tyre__label">{t.systems.tyreTemp}</span>
        <span className="tyre__num tyre__num--sm">{temp.text}</span>
        {temp.ok ? <span className="tyre__unit">{t.units.celsius}</span> : <StatusTag quality={temp.quality} compact />}
      </div>
    </div>
  );
}

function GPlot({ longG, latG, aria, limitLabel }: { longG: number | null; latG: number | null; aria: string; limitLabel: string }) {
  const ok = longG !== null && latG !== null;
  const k = 80 / G_LIMIT;
  const cx = ok ? Math.max(-G_LIMIT, Math.min(G_LIMIT, latG)) * k : 0;
  const cy = ok ? -Math.max(-G_LIMIT, Math.min(G_LIMIT, longG)) * k : 0;
  return (
    <svg className="gplot" viewBox="-100 -100 200 200" role="img" aria-label={aria}>
      <circle r="80" className="gplot__ring" />
      <circle r="40" className="gplot__ring gplot__ring--inner" />
      <line x1="-90" y1="0" x2="90" y2="0" className="gplot__axis" />
      <line x1="0" y1="-90" x2="0" y2="90" className="gplot__axis" />
      <text x="0" y="-86" textAnchor="middle" className="gplot__num">
        {limitLabel}
      </text>
      {ok ? <circle cx={cx} cy={cy} r="7" className="gplot__dot" /> : null}
    </svg>
  );
}

export function SystemsScreen({ state }: { state: AppState }) {
  const f = useFormat();
  const { t } = f;
  const { snapshot, session } = state;
  const s = snapshot.signals;
  const hdcActive = usableValue(s['hdc.status']) === 'active';

  return (
    <div className="systems">
      <Panel title={t.systems.powertrain} className="systems__power">
        <div className="pair">
          <Readout label={t.systems.gear} display={gearDisplay(s.gear)} size="xl" signal={s.gear} className="gear" />
          <Readout
            label={t.systems.engineTorque}
            display={f.num(s['engine.torqueNm'], 0)}
            unit={t.units.nm}
            size="lg"
            signal={s['engine.torqueNm']}
            hint={`${t.systems.sessionMax} ${extremumDisplay(session.maxEngineTorque, 0, t.locale).text}`}
          />
        </div>
        <Readout label={t.systems.rpm} display={f.num(s['engine.rpm'], 0)} unit={t.units.rpm} size="md" signal={s['engine.rpm']} />
        <Readout label={t.systems.pedal} display={f.num(s.acceleratorPedalPercent, 0)} unit={t.units.percent} size="md" signal={s.acceleratorPedalPercent}>
          <BarGauge value={usableNumber(s.acceleratorPedalPercent)} max={100} />
        </Readout>
        <Readout label={t.systems.throttle} display={f.num(s['engine.throttlePercent'], 0)} unit={t.units.percent} size="md" signal={s['engine.throttlePercent']}>
          <BarGauge value={usableNumber(s['engine.throttlePercent'])} max={100} tone="dim" />
        </Readout>
      </Panel>

      <div className="systems__col">
        <Panel title={t.systems.assists} aside={<span className="panel__hint">{t.systems.assistsNote}</span>}>
          <div className="assists">
            <Readout
              label={t.systems.hdc}
              display={hdcDisplay(s['hdc.status'], t)}
              size="md"
              signal={s['hdc.status']}
              className={hdcActive ? 'is-active' : undefined}
            />
            <Readout label={t.systems.hdcSet} display={f.num(s['hdc.setSpeedKmh'], 0)} unit={t.units.km_h} size="md" signal={s['hdc.setSpeedKmh']} />
            <Readout label={t.systems.dsc} display={f.bool(s['dsc.status'])} size="md" signal={s['dsc.status']} />
            <Readout label={t.systems.dtc} display={f.bool(s['dtc.status'])} size="md" signal={s['dtc.status']} />
          </div>
        </Panel>
        <Panel title={t.systems.temps} className="systems__temps">
          <TempRow label={t.systems.gearbox} signal={s['temperature.gearboxC']} max={session.maxGearboxTemp} f={f} />
          <TempRow label={t.systems.coolant} signal={s['temperature.coolantC']} max={session.maxCoolantTemp} f={f} />
          <TempRow label={t.systems.oil} signal={s['temperature.engineOilC']} max={session.maxOilTemp} f={f} />
        </Panel>
      </div>

      <Panel title={t.systems.tyres} className="systems__tyres">
        <div className="tyres">
          <TyreBlock wheel="FL" state={state} f={f} />
          <TyreBlock wheel="FR" state={state} f={f} />
          <div className="tyres__car">
            <TopDownCar
              ariaLabel={t.systems.tyresAria}
              showLabels={false}
              // Нет давления по шине — пунктирный контур именно этой шины, а не «0 бар».
              tyreClass={Object.fromEntries(WHEELS.map((w) => [w, usableNumber(s[`tyrePressure.${w}`]) === null ? 'is-missing' : 'is-known']))}
            />
          </div>
          <TyreBlock wheel="RL" state={state} f={f} />
          <TyreBlock wheel="RR" state={state} f={f} />
        </div>
      </Panel>

      <Panel title={t.systems.dynamics} className="systems__dyn">
        <GPlot longG={usableNumber(s['acceleration.longG'])} latG={usableNumber(s['acceleration.latG'])} aria={t.systems.gPlotAria}
          limitLabel={`${f.value(G_LIMIT, 1, true)} ${t.units.g}`}
        />
        <Readout label={t.systems.longG} display={f.num(s['acceleration.longG'], 2, true)} unit={t.units.g} size="md" signal={s['acceleration.longG']} />
        <Readout label={t.systems.latG} display={f.num(s['acceleration.latG'], 2, true)} unit={t.units.g} size="md" signal={s['acceleration.latG']} />
        <Readout label={t.systems.yaw} display={f.num(s.yawRateDegS, 1, true)} unit={t.units.deg_s} size="md" signal={s.yawRateDegS} />
      </Panel>
    </div>
  );
}
