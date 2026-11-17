import type { Extremum } from '../domain/session';
import type { Gear, HdcStatus, Signal, SuspensionLevel } from '../domain/types';
import type { Dictionary } from '../i18n';
import { DASH, displaySignal, formatNumber, type Display } from '../i18n/format';

const NONE: Display = { text: DASH, quality: 'unavailable', ok: false };

/** Сессионный экстремум: null — ещё не было валидных отсчётов. */
export function extremumDisplay(e: Extremum | null, decimals: number, locale: string, signed = false): Display {
  return e === null ? NONE : { text: formatNumber(e.value, decimals, locale, signed), quality: 'valid', ok: true };
}

export function gearText(g: Gear): string {
  return g.gear !== null && (g.selector === 'D' || g.selector === 'M') ? `${g.selector}${g.gear}` : g.selector;
}

export const gearDisplay = (s: Signal<Gear>) => displaySignal(s, gearText);
export const hdcDisplay = (s: Signal<HdcStatus>, t: Dictionary) => displaySignal(s, (v) => t.hdc[v]);
export const levelDisplay = (s: Signal<SuspensionLevel>, t: Dictionary) => displaySignal(s, (v) => t.suspensionLevel[v]);
