import { usableValue } from '../domain/signal';
import { SUSPENSION_LEVELS, type Signal, type SuspensionLevel } from '../domain/types';
import { levelDisplay } from './displayHelpers';
import { Readout } from './Readout';
import { useFormat } from './useFormat';

/**
 * Текущий уровень подвески — единственный индикатор (не переключатель).
 * Шкала упорядочена от самого высокого уровня к самому низкому.
 */
export function LevelIndicator({ signal, variant, label }: { signal: Signal<SuspensionLevel>; variant: 'compact' | 'full'; label: string }) {
  const f = useFormat();
  const { t } = f;
  const current = usableValue(signal);
  const display = levelDisplay(signal, t);

  return (
    <div className={`level level--${variant}${display.ok ? '' : ' is-missing'}`}>
      <Readout label={label} display={display} size={variant === 'full' ? 'lg' : 'md'} signal={signal} className="level__readout" />
      {variant === 'compact' ? (
        <div className="level__notches" aria-hidden="true">
          {SUSPENSION_LEVELS.map((l) => (
            <i key={l} className={l === current ? 'is-current' : undefined} />
          ))}
        </div>
      ) : (
        <div className="level__scale">
          <div className="level__scale-title">{t.suspension.levelScale}</div>
          <ol className="level__ladder">
            {SUSPENSION_LEVELS.map((l) => (
              <li key={l} className={l === current ? 'is-current' : undefined} aria-current={l === current ? 'true' : undefined}>
                <span className="level__pip" aria-hidden="true" />
                {t.suspensionLevel[l]}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
