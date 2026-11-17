import type { AppState } from '../app/store';
import { cornerHeights, heightDeltas } from '../domain/derived';
import { WHEELS, type Wheel } from '../domain/types';
import { extremumDisplay } from '../components/displayHelpers';
import { LevelIndicator } from '../components/LevelIndicator';
import { Panel } from '../components/Panel';
import { Readout } from '../components/Readout';
import { SPRING_POS, TopDownCar } from '../components/TopDownCar';
import { useFormat, type Format } from '../components/useFormat';
import { DASH, type Display } from '../i18n/format';

const GAUGE_MM = 120;

function HeightGauge({ value }: { value: number | null }) {
  const v = value === null ? 0 : Math.max(-GAUGE_MM, Math.min(GAUGE_MM, value));
  const pct = (Math.abs(v) / GAUGE_MM) * 50;
  return (
    <div className={`vgauge${value === null ? ' is-empty' : ''}`} aria-hidden="true">
      <span className="vgauge__zero" />
      {value !== null ? <span className={`vgauge__fill ${v >= 0 ? 'is-up' : 'is-down'}`} style={{ height: `${pct}%` }} /> : null}
    </div>
  );
}

function CornerCard({ wheel, value, f, state }: { wheel: Wheel; value: number | null; f: Format; state: AppState }) {
  const { t } = f;
  const sig = state.snapshot.signals[`suspensionHeight.${wheel}`];
  return (
    <section className={`corner corner--${wheel.toLowerCase()}`} aria-label={`${t.wheels[wheel].long} (${t.wheels[wheel].code})`}>
      <header className="wheelcard__head">
        <span className="wheelcard__short">{t.wheels[wheel].short}</span>
        <span className="wheelcard__name">
          {t.wheels[wheel].code} · {t.wheels[wheel].long}
        </span>
      </header>
      <div className="corner__body">
        <Readout label={t.suspension.cornerLabel} display={f.num(sig, 0, true)} unit={t.units.mm} size="lg" signal={sig} />
        <HeightGauge value={value} />
      </div>
    </section>
  );
}

/** Полный ход маркера высоты на схеме, ед. рендера (≈ треть длины шины). */
const MARK_LEN = 110;

/** Маркеры высоты на пружинах стоек: вверх — выше нормы, вниз — ниже; нет данных — пунктирное кольцо. */
function CornerMarkers({ heights }: { heights: Record<Wheel, number | null> }) {
  return (
    <g className="hmarks">
      {WHEELS.map((w) => {
        const p = SPRING_POS[w];
        const v = heights[w];
        if (v === null) {
          return <circle key={w} cx={p.x} cy={p.y} r={24} vectorEffect="non-scaling-stroke" className="hmark hmark--missing" data-corner={w} />;
        }
        const len = (Math.max(-GAUGE_MM, Math.min(GAUGE_MM, v)) / GAUGE_MM) * MARK_LEN;
        return (
          <g key={w} data-corner={w}>
            <circle cx={p.x} cy={p.y} r={30} className="hmark__base" />
            <line x1={p.x - 40} y1={p.y} x2={p.x + 40} y2={p.y} vectorEffect="non-scaling-stroke" className="hmark__zero" />
            <line x1={p.x} y1={p.y} x2={p.x} y2={p.y - len} vectorEffect="non-scaling-stroke" className={`hmark ${v >= 0 ? 'is-up' : 'is-down'}`} />
            <circle cx={p.x} cy={p.y - len} r={13} className={`hmark__dot ${v >= 0 ? 'is-up' : 'is-down'}`} />
          </g>
        );
      })}
    </g>
  );
}

export function SuspensionScreen({ state }: { state: AppState }) {
  const f = useFormat();
  const { t } = f;
  const { snapshot, session } = state;
  const heights = cornerHeights(snapshot);
  const d = heightDeltas(heights);
  const mm = (v: number | null, signed = true): Display =>
    v === null ? { text: DASH, quality: 'unavailable', ok: false } : { text: f.value(v, 0, signed), quality: 'valid', ok: true };

  const rows: { label: string; value: number | null; signed: boolean }[] = [
    { label: t.suspension.frontDelta, value: d.frontDelta, signed: true },
    { label: t.suspension.rearDelta, value: d.rearDelta, signed: true },
    { label: t.suspension.leftRight, value: d.leftRight, signed: true },
    { label: t.suspension.frontRear, value: d.frontRear, signed: true },
    { label: t.suspension.range, value: d.range, signed: false },
  ];

  return (
    <div className="suspension">
      <Panel title={t.suspension.level} className="suspension__level">
        <LevelIndicator signal={snapshot.signals['suspension.level']} variant="full" label={t.suspension.level} />
      </Panel>

      <div className="suspension__corners">
        <CornerCard wheel="FL" value={heights.FL} f={f} state={state} />
        <CornerCard wheel="FR" value={heights.FR} f={f} state={state} />
        <div className="suspension__car">
          <TopDownCar ariaLabel={t.suspension.schemaAria} className="topcar--ghost" over={<CornerMarkers heights={heights} />} />
        </div>
        <CornerCard wheel="RL" value={heights.RL} f={f} state={state} />
        <CornerCard wheel="RR" value={heights.RR} f={f} state={state} />
        <p className="traction__note">{t.suspension.unitNote}</p>
      </div>

      <Panel title={t.suspension.deltas} className="suspension__deltas">
        <ul className="deltas">
          {rows.map((r) => {
            const disp = mm(r.value, r.signed);
            return (
              <li key={r.label} className="deltas__row">
                <Readout label={r.label} display={disp} unit={t.units.mm} size="md" />
              </li>
            );
          })}
          <li className="deltas__row deltas__row--session">
            <Readout label={t.session.maxHeightRange} display={extremumDisplay(session.maxHeightRange, 0, t.locale)} unit={t.units.mm} size="md" />
          </li>
        </ul>
      </Panel>
    </div>
  );
}
