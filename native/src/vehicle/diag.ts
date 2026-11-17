// Ограниченный журнал сырых значений для проверки на автомобиле (экран «Настройки» позже, см. INTEGRATION.md).
// Пишутся ТОЛЬКО заранее известные члены структур из allowlist (FieldSpec.diag): числа и имена enum.
// Никаких VIN, координат и т. п. — на такие поля приложение и не подписывается.
// Объём: первый отсчёт каждого поля + общее кольцо изменений (RING_MAX записей), не чаще раза
// в CHANGE_MIN_MS на поле; покадрового журнала нет.

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
  private readonly lastKey = new Map<string, string>();
  private readonly lastAt = new Map<string, number>();
  private ring: DiagEntry[] = [];

  record(iface: string, field: string, members: readonly string[], v: unknown, at: number, changes: boolean): void {
    if (!members.length) return;
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const values: Record<string, DiagValue> = {};
    for (const m of members) if (o[m] !== undefined) values[m] = diagValue(o[m]);
    const id = `${iface}|${field}`;
    const key = JSON.stringify(values);
    const entry: DiagEntry = { at, iface, field, values };
    if (!this.first.has(id)) {
      this.first.set(id, entry);
      this.lastKey.set(id, key);
      this.lastAt.set(id, at);
      return;
    }
    if (!changes || this.lastKey.get(id) === key) return;
    if (at - (this.lastAt.get(id) ?? -Infinity) < CHANGE_MIN_MS) return;
    this.lastKey.set(id, key);
    this.lastAt.set(id, at);
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring = this.ring.slice(this.ring.length - RING_MAX);
  }

  firstSamples(): DiagEntry[] {
    return Array.from(this.first.values());
  }

  changes(): DiagEntry[] {
    return this.ring.slice();
  }
}
