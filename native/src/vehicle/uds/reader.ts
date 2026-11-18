// Планировщик чтения UDS: сначала идентификация каждого блока (22 F150), затем — только для опознанного варианта —
// записи с их периодами; неопознанный вариант читается раз в UNVERIFIED_PERIOD_MS только в диагностику. Строго по
// одному запросу (транспорт сериализует), пауза GAP_MS между запросами, без экрана (скрыт/не на переднем плане) —
// ни одного запроса. stop() — цикл завершается, транспорт закрывается, поздние ответы ничего не меняют.

import type { ReadResult } from './tasu';
import { ECUS, recordsFor, UNVERIFIED_PERIOD_MS, type EcuKey, type EcuSpec, type RecordSpec, type Target } from './ecus';
import { decodeExact, hexBytes, identityHex, IDENT_DID, type DecodedRecord } from './records';

export interface ReadPort {
  readonly available: boolean;
  read(ecu: number, did: number): Promise<ReadResult>;
  close(): void;
}

/** Значение для приложения: цель, значение (null — нет), причина, время, срок свежести, поле-источник. */
export interface UdsOutput {
  readonly target: Target;
  readonly value: number | null;
  /** true — «значения нет» (не опознан, не поддерживается), а не недопустимое значение. */
  readonly absent: boolean;
  readonly reason: string | null;
  readonly at: number;
  readonly staleMs: number;
  readonly field: string;
}
export type UdsSink = (o: UdsOutput) => void;

/** Журнал приложения (ctx.log): только переходы состояний, без повтора на каждое чтение. */
export interface UdsLog {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
}
/** Предел строки журнала. Сырые байты — не больше 32 (hexBytes). */
const LOG_MAX = 240;

export const GAP_MS = 150;
const IDENT_BACKOFF_MS = [0, 5000, 10000, 20000, 40000, 60000];
/** Запись, которую блок отвергает (NRC), — реже: не забивать шину отказами. */
const REFUSED_PERIOD_MS = 30000;
/** Причина «нет данных» живёт столько, сколько её обновляют (идентификация повторяется). */
const ABSENT_STALE_MS = 120000;

export type IdentState = 'pending' | 'accepted' | 'unverified' | 'failed';

interface RecState {
  nextAt: number;
  ok: number;
  failed: number;
  lastAt: number | null;
  lastRaw: string | null;
  lastError: string | null;
  last: DecodedRecord | null;
}

interface EcuState {
  readonly spec: EcuSpec;
  ident: IdentState;
  identity: string | null;
  identAttempts: number;
  nextIdentAt: number;
  identError: string | null;
  readonly recs: Map<number, RecState>;
}

export interface RecordDiagnostics {
  readonly did: string;
  readonly name: string;
  readonly ok: number;
  readonly failed: number;
  readonly lastAt: number | null;
  readonly lastRaw: string | null;
  readonly lastError: string | null;
  /** Разбор по каталогу (у неопознанного блока — только кандидат, в сигналы не идёт). */
  readonly values: Readonly<Record<string, number | null>> | null;
}

export interface EcuDiagnostics {
  readonly key: EcuKey;
  readonly addr: string;
  readonly name: string;
  readonly state: IdentState;
  readonly identity: string | null;
  readonly variant: string | null;
  readonly reason: string | null;
  readonly records: readonly RecordDiagnostics[];
}

const did4 = (d: number) => d.toString(16).toUpperCase().padStart(4, '0');
const resultText = (r: ReadResult): string => (r.kind === 'nrc' ? `NRC ${r.nrc.toString(16).toUpperCase()}` : r.kind === 'refused' ? `отказ: ${r.detail}` : r.kind === 'timeout' ? 'нет ответа' : r.kind);

export class UdsReader {
  private readonly ecus: EcuState[];
  private readonly log: UdsLog | null;
  /** Последняя записанная в журнал строка по ключу (блок / запись): повтор той же строки не пишется. */
  private readonly logged = new Map<string, string>();
  private running = false;
  private visible = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly port: ReadPort,
    private readonly now: () => number,
    private readonly sink: UdsSink,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    opts: { readonly specs?: readonly EcuSpec[]; readonly log?: UdsLog } = {},
  ) {
    const specs = opts.specs ?? ECUS;
    this.log = opts.log ?? null;
    this.ecus = specs.map((spec) => ({ spec, ident: 'pending' as IdentState, identity: null, identAttempts: 0, nextIdentAt: 0, identError: null, recs: new Map() }));
  }

  /** Экран приложения виден: только тогда идут запросы. */
  setVisible(v: boolean): void {
    this.visible = v;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  stop(): Promise<void> {
    this.running = false;
    this.port.close();
    return this.loop ? this.loop.then(() => undefined, () => undefined) : Promise.resolve();
  }

  private async run(): Promise<void> {
    while (this.running) {
      if (!this.visible || !this.port.available) {
        await this.sleep(250);
        continue;
      }
      const did = await this.step();
      await this.sleep(did ? GAP_MS : 100);
    }
  }

  /** Один запрос, если какой-то срок наступил. true — запрос был. */
  async step(): Promise<boolean> {
    const job = this.next(this.now());
    if (!job) return false;
    const r = await this.port.read(job.ecu.spec.addr, job.rec ? job.rec.schema.did : IDENT_DID);
    if (!this.running && r.kind === 'closed') return true;
    if (job.rec) this.onRecord(job.ecu, job.rec, r);
    else this.onIdent(job.ecu, r);
    return true;
  }

  /** Наступившая идентификация — раньше любой записи (сначала понять, какой это блок); затем самая просроченная запись. */
  private next(t: number): { ecu: EcuState; rec: RecordSpec | null } | null {
    let best: { ecu: EcuState; rec: RecordSpec | null; due: number } | null = null;
    for (const e of this.ecus) {
      if ((e.ident === 'pending' || e.ident === 'failed') && e.nextIdentAt <= t && (!best || best.rec || e.nextIdentAt < best.due)) best = { ecu: e, rec: null, due: e.nextIdentAt };
    }
    if (best) return best;
    for (const e of this.ecus) {
      if (e.ident === 'pending' || e.ident === 'failed') continue;
      for (const rec of recordsFor(e.spec, e.identity)) {
        const st = this.rec(e, rec);
        if (st.nextAt <= t && (!best || st.nextAt < best.due)) best = { ecu: e, rec, due: st.nextAt };
      }
    }
    return best;
  }

  private rec(e: EcuState, rec: RecordSpec): RecState {
    let st = e.recs.get(rec.schema.did);
    if (!st) {
      st = { nextAt: 0, ok: 0, failed: 0, lastAt: null, lastRaw: null, lastError: null, last: null };
      e.recs.set(rec.schema.did, st);
    }
    return st;
  }

  private onIdent(e: EcuState, r: ReadResult): void {
    const t = this.now();
    e.identAttempts++;
    if (r.kind === 'ok' && r.payload.length > 0 && r.payload.length <= 8) {
      e.identity = identityHex(r.payload);
      e.identError = null;
      e.ident = e.spec.identities[e.identity] ? 'accepted' : 'unverified';
      this.note(e.spec.key, 'info', `uds ${e.spec.key} 0x${e.spec.addr.toString(16)}: F150 ${e.identity} -> ${e.ident === 'accepted' ? `accepted (${e.spec.identities[e.identity]})` : 'unverified variant: values diagnostics-only'}`);
      if (e.ident === 'unverified') this.absentAll(e, `${e.spec.name}: вариант ${e.identity} не из проверенных`, t);
      return;
    }
    e.ident = 'failed';
    e.identError = r.kind === 'ok' ? `ответ F150 длиной ${r.payload.length}` : resultText(r);
    e.nextIdentAt = t + IDENT_BACKOFF_MS[Math.min(e.identAttempts, IDENT_BACKOFF_MS.length - 1)];
    this.note(e.spec.key, 'warn', `uds ${e.spec.key} 0x${e.spec.addr.toString(16)}: identification failed: ${e.identError}`);
    this.absentAll(e, `${e.spec.name}: не опознан (${e.identError})`, t);
  }

  /** Строка в журнал, только если для этого ключа она другая, чем в прошлый раз. */
  private note(key: string, level: 'info' | 'warn', msg: string): void {
    if (!this.log || this.logged.get(key) === msg) return;
    this.logged.set(key, msg);
    const line = msg.length > LOG_MAX ? `${msg.slice(0, LOG_MAX - 1)}…` : msg;
    if (level === 'warn') this.log.warn(line);
    else this.log.info(line);
  }

  /** Состояние записи для журнала: «ok» (первый ответ / восстановление — с сырыми байтами) или текст ошибки. */
  private noteRecord(e: EcuState, rec: RecordSpec, st: RecState, error: string | null, d: DecodedRecord | null): void {
    const key = `${e.spec.key}:${did4(rec.schema.did)}`;
    const head = `uds ${e.spec.key} ${did4(rec.schema.did)}`;
    if (error) return this.note(key, 'warn', `${head}: ${error}${st.lastRaw && error.indexOf('длина') >= 0 ? ` raw ${st.lastRaw}` : ''}`);
    // «ok» — один раз до следующей ошибки; у неопознанного блока — с разбором-кандидатом (для сверки по журналу)
    if (this.logged.get(key)?.indexOf(`${head}: ok`) === 0) return;
    const vals = d && e.ident !== 'accepted' ? ` candidate ${Object.keys(d.values).map((k) => `${k}=${d.values[k]}`).join(' ')}` : '';
    this.note(key, 'info', `${head}: ok raw ${st.lastRaw}${vals}`);
  }

  private absentAll(e: EcuState, reason: string, at: number): void {
    for (const rec of recordsFor(e.spec, e.identity))
      for (const o of rec.outputs) this.sink({ target: o.target, value: null, absent: true, reason, at, staleMs: ABSENT_STALE_MS, field: this.field(e, rec) });
  }

  private field(e: EcuState, rec: RecordSpec): string {
    return `UDS ${e.spec.key} ${did4(rec.schema.did)}`;
  }

  private onRecord(e: EcuState, rec: RecordSpec, r: ReadResult): void {
    const t = this.now();
    const st = this.rec(e, rec);
    const accepted = e.ident === 'accepted';
    const period = accepted ? rec.periodMs : UNVERIFIED_PERIOD_MS;
    st.nextAt = t + period;
    if (r.kind !== 'ok') {
      st.failed++;
      st.lastError = resultText(r);
      this.noteRecord(e, rec, st, st.lastError, null);
      if (r.kind === 'nrc') {
        st.nextAt = t + Math.max(period, REFUSED_PERIOD_MS);
        if (accepted) for (const o of rec.outputs) this.sink({ target: o.target, value: null, absent: true, reason: `${e.spec.name} ${did4(rec.schema.did)}: ${st.lastError}`, at: t, staleMs: ABSENT_STALE_MS, field: this.field(e, rec) });
      }
      // нет ответа / отказ транспорта — не отсчёт: прежнее значение устареет само
      return;
    }
    st.lastRaw = hexBytes(r.payload);
    const d = decodeExact(rec.schema, r.payload);
    if (!d.ok) {
      st.failed++;
      st.lastError = d.error;
      st.last = null;
      this.noteRecord(e, rec, st, d.error, null);
      if (accepted) for (const o of rec.outputs) this.sink({ target: o.target, value: null, absent: false, reason: `${did4(rec.schema.did)}: ${d.error}`, at: t, staleMs: rec.staleMs, field: this.field(e, rec) });
      return;
    }
    st.ok++;
    st.lastAt = t;
    st.lastError = null;
    st.last = d.rec;
    this.noteRecord(e, rec, st, null, d.rec);
    if (!accepted) return;
    const others = (did: number) => {
      const o = e.recs.get(did);
      const spec = recordsFor(e.spec, e.identity).find((x) => x.schema.did === did);
      return o && o.last && o.lastAt !== null && spec && t - o.lastAt <= spec.staleMs ? o.last : null;
    };
    for (const o of rec.outputs) {
      const gate = rec.gate ? rec.gate(o.value, others) : null;
      const v = gate ? null : d.rec.values[o.value];
      const reason = gate ?? d.rec.reasons[o.value] ?? null;
      this.sink({ target: o.target, value: v === undefined ? null : v, absent: false, reason, at: t, staleMs: rec.staleMs, field: this.field(e, rec) });
    }
  }

  diagnostics(): EcuDiagnostics[] {
    return this.ecus.map((e) => ({
      key: e.spec.key,
      addr: `0x${e.spec.addr.toString(16).toUpperCase()}`,
      name: e.spec.name,
      state: e.ident,
      identity: e.identity,
      variant: e.identity ? e.spec.identities[e.identity] ?? null : null,
      reason:
        e.ident === 'failed'
          ? `идентификация: ${e.identError}`
          : e.ident === 'unverified'
            ? Object.keys(e.spec.identities).length
              ? `вариант ${e.identity} не из проверенных (${Object.keys(e.spec.identities).join(', ')}) — значения только в диагностике`
              : `вариант ${e.identity}: проверенных вариантов нет — значения только в диагностике`
            : e.ident === 'pending'
              ? 'ещё не опрошен'
              : null,
      records: recordsFor(e.spec, e.identity).map((rec) => {
        const st = e.recs.get(rec.schema.did);
        return {
          did: did4(rec.schema.did),
          name: rec.schema.name,
          ok: st ? st.ok : 0,
          failed: st ? st.failed : 0,
          lastAt: st ? st.lastAt : null,
          lastRaw: st ? st.lastRaw : null,
          lastError: st ? st.lastError : null,
          values: st && st.last ? st.last.values : null,
        };
      }),
    }));
  }
}
