// Передача из двух разных полей VehicleInformation с РАЗНЫМИ таблицами enum (SIGNALS.md, upstream car.js).
// Привязка SOME/IP отдаёт enum либо именем, либо номером на проводе — принимаются оба вида.
// Принцип: P никогда не придумывается. «N или P» без положения селектора — неоднозначно (нет данных).
// Номер ступени без положения селектора тоже неоднозначен (D или M) — не показывается как «D».

import type { Gear } from '../../../src/domain/types';

export type Stage = 'P' | 'R' | 'N' | 'D';

/** Итог одного отсчёта поля: передача, неоднозначно (нельзя честно решить) или недопустимое значение. */
export type GearReading =
  | { readonly kind: 'gear'; readonly gear: Gear; readonly forward: number | null }
  | { readonly kind: 'ambiguous'; readonly forward: number | null }
  | { readonly kind: 'invalid' };

const AMBIGUOUS: GearReading = { kind: 'ambiguous', forward: null };
const INVALID_READING: GearReading = { kind: 'invalid' };

/** statusGearboxDrive.statusActualGearDrive: G1…G10 = 3…12, R = 1, N_OR_P = 2. */
export type ActualGear = { kind: 'forward'; n: number } | { kind: 'reverse' } | { kind: 'nOrP' };
export function actualGearOf(x: unknown): ActualGear | null {
  if (typeof x === 'number' && Number.isInteger(x)) {
    if (x >= 3 && x <= 12) return { kind: 'forward', n: x - 2 };
    if (x === 1) return { kind: 'reverse' };
    if (x === 2) return { kind: 'nOrP' };
    return null;
  }
  if (typeof x !== 'string') return null;
  const m = /^G(10|[1-9])$/.exec(x);
  if (m) return { kind: 'forward', n: Number(m[1]) };
  if (x === 'R') return { kind: 'reverse' };
  if (x === 'N_OR_P') return { kind: 'nOrP' };
  return null;
}

/** statusGearboxDrive.statusActualStageDrive: P = 1, R = 2, N = 3, D = 4. */
export function stageOf(x: unknown): Stage | null {
  if (typeof x === 'number' && Number.isInteger(x)) return x === 1 ? 'P' : x === 2 ? 'R' : x === 3 ? 'N' : x === 4 ? 'D' : null;
  return x === 'P' || x === 'R' || x === 'N' || x === 'D' ? x : null;
}

/** Отсчёт statusGearboxDrive. */
export function readGearbox(v: unknown): GearReading {
  if (!v || typeof v !== 'object') return INVALID_READING;
  const o = v as Record<string, unknown>;
  const hasGear = o.statusActualGearDrive !== undefined && o.statusActualGearDrive !== null;
  const hasStage = o.statusActualStageDrive !== undefined && o.statusActualStageDrive !== null;
  const gear = hasGear ? actualGearOf(o.statusActualGearDrive) : null;
  const stage = hasStage ? stageOf(o.statusActualStageDrive) : null;
  if ((hasGear && gear === null) || (hasStage && stage === null) || (!hasGear && !hasStage)) return INVALID_READING;
  const forward = gear && gear.kind === 'forward' ? gear.n : null;
  if (stage === 'P' || stage === 'R' || stage === 'N') return { kind: 'gear', gear: { selector: stage, gear: null }, forward };
  if (stage === 'D') return { kind: 'gear', gear: { selector: 'D', gear: forward }, forward };
  // Положения селектора нет: однозначен только задний ход.
  if (gear && gear.kind === 'reverse') return { kind: 'gear', gear: { selector: 'R', gear: null }, forward: null };
  return { kind: 'ambiguous', forward };
}

/** DataPowerTrain2.statusGearSelectionDrive: N = 1, R = 2, P = 3, NP = 4, _1…_9 = 5…13. */
export function readSelection(v: unknown): GearReading {
  const raw = v && typeof v === 'object' ? (v as Record<string, unknown>).statusGearSelectionDrive : undefined;
  let n: number | null = null;
  if (typeof raw === 'number' && Number.isInteger(raw)) n = raw;
  else if (typeof raw === 'string') {
    const named: Record<string, number> = { N: 1, R: 2, P: 3, NP: 4 };
    if (Object.prototype.hasOwnProperty.call(named, raw)) n = named[raw];
    else if (/^_[1-9]$/.test(raw)) n = 4 + Number(raw.slice(1));
  }
  if (n === 1) return { kind: 'gear', gear: { selector: 'N', gear: null }, forward: null };
  if (n === 2) return { kind: 'gear', gear: { selector: 'R', gear: null }, forward: null };
  if (n === 3) return { kind: 'gear', gear: { selector: 'P', gear: null }, forward: null };
  if (n === 4) return AMBIGUOUS;
  if (n !== null && n >= 5 && n <= 13) return { kind: 'ambiguous', forward: n - 4 };
  return INVALID_READING;
}

export interface TimedReading {
  readonly reading: GearReading;
  readonly at: number;
}

export type FusedGear =
  | { kind: 'gear'; gear: Gear; at: number }
  | { kind: 'ambiguous'; at: number }
  | { kind: 'invalid'; at: number }
  /** Свежих отсчётов нет; gear — последняя однозначная передача (показывается только как «устарело»). */
  | { kind: 'stale'; at: number; gear: Gear | null }
  | { kind: 'none' };

type ValidReading = Exclude<GearReading, { kind: 'invalid' }>;
interface TimedValid {
  readonly reading: ValidReading;
  readonly at: number;
}
type Resolved = { kind: 'gear'; gear: Gear; at: number } | { kind: 'ambiguous'; at: number };

/** Какие положения селектора допускает отсчёт: «N или P» — N/P; номер без селектора — D/M. */
function options(r: ValidReading): readonly Gear['selector'][] {
  if (r.kind === 'gear') return [r.gear.selector];
  return r.forward !== null ? ['D', 'M'] : ['N', 'P'];
}

/**
 * Два отсчёта (любой может отсутствовать) → передача. Согласные отсчёты дополняют друг друга;
 * при противоречии верен более новый, а одновременные противоречащие — неоднозначны.
 * Время итога — время самого старого из отсчётов, на которых он держится.
 */
function resolve(x: TimedReading | null, y: TimedReading | null): Resolved | null {
  const rs = [x, y].filter((r): r is TimedValid => r !== null && r.reading.kind !== 'invalid').sort((a, b) => b.at - a.at);
  if (!rs.length) return null;
  const single = (r: TimedValid): Resolved => (r.reading.kind === 'gear' ? { kind: 'gear', gear: r.reading.gear, at: r.at } : { kind: 'ambiguous', at: r.at });
  const [n, o] = rs;
  if (!o) return single(n);
  const co = options(o.reading);
  if (!options(n.reading).some((c) => co.indexOf(c) >= 0)) return n.at === o.at ? { kind: 'ambiguous', at: n.at } : single(n);
  // Согласны. Селектор даёт только однозначный отсчёт; два неоднозначных его не дают (N_OR_P + NP — не P).
  const selSrc = n.reading.kind === 'gear' ? n : o.reading.kind === 'gear' ? o : null;
  if (!selSrc || selSrc.reading.kind !== 'gear') return { kind: 'ambiguous', at: n.at };
  const selector = selSrc.reading.gear.selector;
  if (selector !== 'D') return { kind: 'gear', gear: { selector, gear: null }, at: selSrc.at };
  // D: номер — самый свежий из имеющихся (селектор и номер могут прийти из разных полей).
  const numSrc = n.reading.forward !== null ? n : o.reading.forward !== null ? o : null;
  if (!numSrc) return { kind: 'gear', gear: { selector: 'D', gear: null }, at: selSrc.at };
  return { kind: 'gear', gear: { selector: 'D', gear: numSrc.reading.forward }, at: Math.min(selSrc.at, numSrc.at) };
}

/**
 * Свежие отсчёты двух полей → одна передача. Ни одно поле не главнее: устаревший по времени
 * селектор не перекрывает более новый явный P/R/N. Номер ступени без селектора сам «D» не задаёт.
 */
export function fuseGear(gearbox: TimedReading | null, selection: TimedReading | null, now: number, staleMs: number): FusedGear {
  const fresh = (r: TimedReading | null) => (r !== null && now - r.at <= staleMs ? r : null);
  const g = fresh(gearbox);
  const s = fresh(selection);
  const r = resolve(g, s);
  if (r && r.kind === 'gear') return r;
  const latest = [g, s].filter((t): t is TimedReading => t !== null).sort((a, b) => b.at - a.at)[0];
  if (latest) return latest.reading.kind === 'invalid' ? { kind: 'invalid', at: latest.at } : { kind: 'ambiguous', at: r ? r.at : latest.at };
  if (!gearbox && !selection) return { kind: 'none' };
  const old = resolve(gearbox, selection);
  if (old && old.kind === 'gear') return { kind: 'stale', at: old.at, gear: old.gear };
  return { kind: 'stale', at: Math.max(gearbox ? gearbox.at : -Infinity, selection ? selection.at : -Infinity), gear: null };
}
