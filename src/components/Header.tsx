import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useT } from '../i18n';

export const TAB_IDS = ['terrain', 'traction', 'suspension', 'systems', 'cameras'] as const;
export type TabId = (typeof TAB_IDS)[number];

export const tabDomId = (id: TabId) => `tab-${id}`;
export const panelDomId = (id: TabId) => `panel-${id}`;

export function MStripe({ className }: { className?: string }) {
  return (
    <span className={`mstripe${className ? ` ${className}` : ''}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/** Если полоса вкладок прокручивается, сдвигает только её, чтобы вкладка была видна; страница не двигается. */
function revealTab(tab: HTMLElement | null | undefined) {
  const list = tab?.parentElement;
  if (!tab || !list || list.scrollWidth <= list.clientWidth) return;
  const l = list.getBoundingClientRect();
  const r = tab.getBoundingClientRect();
  if (r.left < l.left) list.scrollLeft -= l.left - r.left;
  else if (r.right > l.right) list.scrollLeft += r.right - l.right;
}

interface HeaderProps {
  active: TabId;
  onSelect: (id: TabId) => void;
  sessionClock: string;
}

export function Header({ active, onSelect, sessionClock }: HeaderProps) {
  const t = useT();
  const refs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  useEffect(() => revealTab(refs.current[active]), [active]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TAB_IDS.indexOf(active);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (i + 1) % TAB_IDS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TAB_IDS.length) % TAB_IDS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TAB_IDS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const id = TAB_IDS[next];
    onSelect(id);
    refs.current[id]?.focus({ preventScroll: true });
    revealTab(refs.current[id]);
  };

  return (
    <header className="header">
      <div className="header__brand">
        <MStripe />
        <div className="header__titles">
          <span className="header__title">{t.app.title}</span>
          <span className="header__subtitle">{t.app.subtitle}</span>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label={t.tabs.ariaLabel} onKeyDown={onKeyDown}>
        {TAB_IDS.map((id) => (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            id={tabDomId(id)}
            role="tab"
            type="button"
            aria-selected={active === id}
            aria-controls={panelDomId(id)}
            tabIndex={active === id ? 0 : -1}
            className={`tab${active === id ? ' is-active' : ''}`}
            onClick={() => onSelect(id)}
            onFocus={(e) => revealTab(e.currentTarget)}
          >
            {t.tabs[id]}
          </button>
        ))}
      </div>
      <div className="header__right">
        <span className="demo-badge" role="note" aria-label={t.app.demoBadgeAria}>
          {t.app.demoBadge}
        </span>
        <span className="header__clock">
          <span className="header__clock-label">{t.app.sessionClock}</span>
          <span className="header__clock-value">{sessionClock}</span>
        </span>
      </div>
      <div className="header__rule" aria-hidden="true" />
    </header>
  );
}
