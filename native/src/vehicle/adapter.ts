// Read-only адаптер автомобиля (кандидат, на G07 не проверен).
// Подписывается ТОЛЬКО через ctx.signals.watch и ТОЛЬКО на поля из allowlist.ts.
// Не использует upstream Car: там авто-демо при тишине, «<400 об/мин = 0», угадывание передачи.
// Значение «измерено» появляется только из колбэка; неподдержанные сигналы — «нет данных»,
// никогда не подставляются из демо.

import { buildSignal } from '../../../src/domain/signal';
import { SIGNAL_IDS } from '../../../src/domain/signalCatalog';
import type { Gear, Signal, SignalId, SignalMap, SignalValueMap } from '../../../src/domain/types';
import type { FieldHandler, Log, WatchFn, WatchResult } from '../platform/kitTypes';
import { VEHICLE_FIELDS, VEHICLE_INTERFACES, type FieldSpec, type NumericOutput } from './allowlist';
import { INVALID } from './decode';
import { fuseGear, readGearbox, readSelection, type TimedReading } from './gear';

interface NumSample {
  /** null — пришёл сентинел/мусор (invalid). */
  readonly value: number | null;
  readonly at: number;
  readonly staleMs: number;
}

interface Sub {
  readonly iface: string;
  readonly res: WatchResult;
  everAvailable: boolean;
}

export interface VehicleStatus {
  /** Подписка запрошена (режим «Автомобиль» включён). */
  readonly active: boolean;
  /** Интерфейсы, на которые подписка установлена. */
  readonly subscribed: number;
  readonly interfaces: number;
  /** Интерфейсы с ошибкой подписки (нет конфигурации, нет привязки someip и т. п.). */
  readonly errors: readonly string[];
  /** Есть хотя бы одно пригодное (валидное и свежее) измеренное значение. */
  readonly hasUsableData: boolean;
}

const GEAR_STALE_MS = (VEHICLE_FIELDS.find((f) => f.outputs.some((o) => o.id === 'gear'))?.outputs[0].staleMs) ?? 60000;

export class VehicleAdapter {
  private gen = 0;
  private active = false;
  private subs: Sub[] = [];
  private errors: string[] = [];
  private nums = new Map<SignalId, NumSample>();
  private gearbox: TimedReading | null = null;
  private selection: TimedReading | null = null;
  private lastSignals: SignalMap | null = null;

  constructor(
    private readonly watch: WatchFn,
    /** Время адаптера, мс; та же шкала, что simTime снимка. */
    private readonly now: () => number,
    private readonly log?: Log,
  ) {}

  /** Подписаться на allowlist. Повторный вызов без stop() ничего не делает. */
  start(): void {
    if (this.active) return;
    this.active = true;
    const gen = ++this.gen;
    const byIface = new Map<string, Record<string, FieldHandler>>();
    for (const f of VEHICLE_FIELDS) {
      const handlers = byIface.get(f.iface) ?? {};
      handlers[f.field] = (v) => this.receive(gen, f, v);
      byIface.set(f.iface, handlers);
    }
    byIface.forEach((handlers, iface) => {
      let p: Promise<WatchResult>;
      try {
        p = Promise.resolve(this.watch(iface, '1', handlers, this.log));
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (res) => {
          // Поздний ответ после смены режима/закрытия: подписку сразу закрываем, данные не принимаем.
          if (gen !== this.gen || !this.active) {
            void Promise.resolve(res.shutdown()).catch(() => undefined);
            return;
          }
          if (res.error) this.errors.push(`${iface}: ${res.error}`);
          this.subs.push({ iface, res, everAvailable: !!res.available });
        },
        (e: unknown) => {
          if (gen === this.gen && this.active) this.errors.push(`${iface}: ${String(e)}`);
        },
      );
    });
  }

  /** Отписаться и забыть все значения. Колбэки старых подписок после этого игнорируются. */
  stop(): Promise<void> {
    this.active = false;
    this.gen++;
    const subs = this.subs;
    this.subs = [];
    this.errors = [];
    this.nums.clear();
    this.gearbox = null;
    this.selection = null;
    this.lastSignals = null;
    return Promise.all(subs.map((s) => Promise.resolve(s.res.shutdown()).catch(() => undefined))).then(() => undefined);
  }

  get isActive(): boolean {
    return this.active;
  }

  private receive(gen: number, f: FieldSpec, v: unknown): void {
    if (gen !== this.gen || !this.active) return;
    const at = this.now();
    for (const o of f.outputs) {
      if (o.kind === 'number') this.receiveNumber(o, v, at);
      else if (o.kind === 'gearbox') this.gearbox = { reading: readGearbox(v), at };
      else this.selection = { reading: readSelection(v), at };
    }
  }

  private receiveNumber(o: NumericOutput, v: unknown, at: number): void {
    const raw = v && typeof v === 'object' ? (v as Record<string, unknown>)[o.member] : undefined;
    // Поле структуры отсутствует — это не отсчёт этого сигнала (значение не трогаем).
    if (raw === undefined) return;
    const d = o.decode(raw);
    this.nums.set(o.id, { value: d === INVALID ? null : d, at, staleMs: o.staleMs });
  }

  /** Провайдер интерфейса был доступен, а теперь нет — значения этого интерфейса устарели. */
  private lostIfaces(): Set<string> {
    const lost = new Set<string>();
    for (const s of this.subs) {
      if (s.res.available) s.everAvailable = true;
      else if (s.everAvailable) lost.add(s.iface);
    }
    return lost;
  }

  /** Полная карта сигналов на момент nowMs. Неподдержанные — unavailable, без значений. */
  signals(nowMs: number = this.now()): SignalMap {
    const lost = this.lostIfaces();
    const ifaceOf = new Map<SignalId, string>();
    for (const f of VEHICLE_FIELDS) for (const o of f.outputs) ifaceOf.set(o.id, f.iface);
    const isLost = (id: SignalId) => {
      const i = ifaceOf.get(id);
      return i !== undefined && lost.has(i);
    };
    const out: Partial<Record<SignalId, Signal<unknown>>> = {};
    for (const id of SIGNAL_IDS) {
      if (id === 'gear') {
        out.gear = this.gearSignal(nowMs, isLost('gear'));
        continue;
      }
      const s = this.nums.get(id);
      if (!s) {
        out[id] = buildSignal(id, undefined, nowMs, nowMs, 'measured');
        continue;
      }
      const raw = (s.value === null ? Number.NaN : s.value) as SignalValueMap[typeof id];
      const sig = buildSignal(id, raw, s.at, s.at, 'measured');
      out[id] = sig.quality === 'valid' && (nowMs - s.at > s.staleMs || isLost(id)) ? { ...sig, quality: 'stale' } : sig;
    }
    this.lastSignals = out as SignalMap;
    return this.lastSignals;
  }

  private gearSignal(nowMs: number, lost: boolean): Signal<Gear> {
    const fused = fuseGear(this.gearbox, this.selection, nowMs, lost ? -1 : GEAR_STALE_MS);
    switch (fused.kind) {
      case 'gear':
        return buildSignal('gear', fused.gear, fused.at, fused.at, 'measured');
      case 'stale': {
        if (fused.gear === null) return buildSignal('gear', undefined, nowMs, nowMs, 'measured');
        return { ...buildSignal('gear', fused.gear, fused.at, fused.at, 'measured'), quality: 'stale' };
      }
      case 'invalid':
        return { ...buildSignal('gear', undefined, fused.at, fused.at, 'measured'), updatedAt: fused.at, quality: 'invalid' };
      default:
        // Неоднозначно (N/P, номер без селектора) или нет отсчётов — «нет данных», без выдумывания P/D.
        return buildSignal('gear', undefined, nowMs, nowMs, 'measured');
    }
  }

  status(): VehicleStatus {
    const sig = this.lastSignals;
    const hasUsableData = sig !== null && SIGNAL_IDS.some((id) => sig[id].quality === 'valid' && sig[id].value !== null);
    return {
      active: this.active,
      subscribed: this.subs.filter((s) => !s.res.error).length,
      interfaces: VEHICLE_INTERFACES.length,
      errors: this.errors.slice(),
      hasUsableData,
    };
  }
}
