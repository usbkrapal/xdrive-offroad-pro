import { usableNumber } from '../domain/signal';
import type { Signal } from '../domain/types';
import { Readout } from './Readout';
import { useFormat } from './useFormat';

/** Угол рулевого колеса (не угол управляемых колёс). + влево — соглашение mock-модели. */
export function SteeringIndicator({ signal, size = 'lg' }: { signal: Signal<number>; size?: 'lg' | 'md' }) {
  const f = useFormat();
  const value = usableNumber(signal);
  const display = f.num(signal, 0, true);
  return (
    <div className={`steering${display.ok ? '' : ' is-missing'}`}>
      <svg className="steering__wheel" viewBox="-50 -50 100 100" aria-hidden="true">
        <g style={{ transform: `rotate(${value === null ? 0 : -value}deg)` }} className="steering__rot">
          <circle r="42" className="steering__rim" />
          <circle r="11" className="steering__hub" />
          <path d="M-11,2 L-41,8 M11,2 L41,8 M0,11 L0,41" className="steering__spoke" />
          {value !== null ? <rect x="-3" y="-47" width="6" height="10" className="steering__mark" /> : null}
        </g>
      </svg>
      <Readout
        label={f.t.terrain.steering}
        display={display}
        unit={f.t.units.deg}
        size={size}
        hint={f.t.terrain.steeringHint}
        signal={signal}
      />
    </div>
  );
}
