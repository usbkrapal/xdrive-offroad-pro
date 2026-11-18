// Ограниченный журнал сырых значений для проверки на автомобиле (лист диагностики, см. INTEGRATION.md).
// Пишутся ТОЛЬКО заранее известные члены структур из allowlist (FieldSpec.diag): числа и имена enum.
// Никаких VIN, координат и т. п. — на такие поля приложение и не подписывается.
// Объём: последний отсчёт каждого поля (перезаписывается, время — момент получения), первый отсчёт каждого
// поля (история запуска) + общее кольцо изменений (RING_MAX записей), не чаще раза в CHANGE_MIN_MS на поле;
// покадрового журнала нет. Число полей ограничено allowlist.

export type DiagValue = number | string | boolean | null;

export interface DiagEntry {
  readonly at: number;
  readonly iface: string;
  readonly field: string;
  readonly values: Readonly<Record<string, DiagValue>>;
}

export const RING_MAX = 50;
export const CHANGE_MIN_MS = 1000;
const ENUM_RE = /^[A-Za-z0-9_]{1,48}$/;

/** Только конечные числа, булевы и короткие имена enum; прочее (объекты, длинные строки) — null. */
export function diagValue(x: unknown): DiagValue {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'boolean') return x;
  if (typeof x === 'string') return ENUM_RE.test(x) ? x : null;
  return null;
}

export class DiagLog {
  private readonly first = new Map<string, DiagEntry>();
  private readonly latest = new Map<string, DiagEntry>();
  private readonly lastKey = new Map<string, string>();
  private readonly lastAt = new Map<string, number>();
  private ring: DiagEntry[] = [];

  /** Записать отсчёт; возвращает разобранные известные члены (null — у поля их нет). */
  record(iface: string, field: string, members: readonly string[], v: unknown, at: number, changes: boolean): Readonly<Record<string, DiagValue>> | null {
    if (!members.length) return null;
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const values: Record<string, DiagValue> = {};
    for (const m of members) if (o[m] !== undefined) values[m] = diagValue(o[m]);
    const id = `${iface}|${field}`;
    const key = JSON.stringify(values);
    const entry: DiagEntry = { at, iface, field, values };
    this.latest.set(id, entry);
    if (!this.first.has(id)) {
      this.first.set(id, entry);
      this.lastKey.set(id, key);
      this.lastAt.set(id, at);
      return values;
    }
    if (!changes || this.lastKey.get(id) === key) return values;
    if (at - (this.lastAt.get(id) ?? -Infinity) < CHANGE_MIN_MS) return values;
    this.lastKey.set(id, key);
    this.lastAt.set(id, at);
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring = this.ring.slice(this.ring.length - RING_MAX);
    return values;
  }

  /** Последний отсчёт каждого поля (не реже каждого колбэка), at — время его получения. */
  latestSamples(): DiagEntry[] {
    return Array.from(this.latest.values());
  }

  firstSamples(): DiagEntry[] {
    return Array.from(this.first.values());
  }

  changes(): DiagEntry[] {
    return this.ring.slice();
  }
}
