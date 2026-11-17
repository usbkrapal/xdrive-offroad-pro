import type { Quality } from '../domain/types';
import { useT } from '../i18n';

/** Текстовый статус качества. Для valid ничего не выводит. */
export function StatusTag({ quality, compact = false }: { quality: Quality; compact?: boolean }) {
  const t = useT();
  if (quality === 'valid') return null;
  return (
    <span className={`status status--${quality}${compact ? ' status--compact' : ''}`}>
      <span className="status__mark" aria-hidden="true" />
      {t.quality[quality]}
    </span>
  );
}
