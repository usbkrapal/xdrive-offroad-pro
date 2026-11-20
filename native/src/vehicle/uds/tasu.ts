// Узкий транспорт диагностического ЧТЕНИЯ через TASU головного устройства (InternalTasu, как BMW ts_diagnostic_service).
// Формат кадра и вердиктов — по MIT idrive7-apps kit/runtime/diag.js (082d42d), переписано, без импорта его Diag:
// наружу отдаётся только read(ecu, did) — служба 0x22 ReadDataByIdentifier и только для пар из READ_ALLOWLIST.
// Никаких других служб (0x10/0x11/0x14/0x19/0x27/0x2E/0x2F/0x31…), функциональных (0xDF) запросов, перебора
// идентификаторов, сессий и доступа безопасности: такого запроса этот модуль собрать не может.
//
//   запрос: sendTasuRequest{ sourceAddress 0xF2, targetAddress ecu, serviceID 0x22, subroutineID 0,
//           udsDataLength 2, udsData [DID hi, DID lo], deadlockTime 0 }
//   ответ:  событие sendTasuResponse{ udsResponse, errorCode }; кадр: [2] = 0x7F — отказ транспорта (код в [4]),
//           [6] — адрес ответившего блока, UDS-ответ с [9]. 0x7F 22 78 — «ответ задерживается» (ждём дольше, в пределах).
//
// Запросы строго по одному (очередь), у каждого предельное время; «транспорт занят» — не больше одного повтора.
// close(): ожидающие запросы завершаются 'closed', новые не принимаются, поздние кадры игнорируются.

export const TASU_IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
export const TASU_INSTANCE = 'SystemFunctionsInternalTasuInst1';
export const TASU_METHOD = 'sendTasuRequest';
export const TASU_EVENT = 'sendTasuResponse';
const TESTER = 0xf2;
const SID_READ = 0x22;

/** Блоки и идентификаторы, которые разрешено читать (0x22). F150 — идентификация (SGBD-индекс). */
export const READ_ALLOWLIST: Readonly<Record<number, readonly number[]>> = {
  0x01: [0xf150, 0x4101], // ACSM: идентификация, IMU — только сырьё (раскладка не установлена)
  0x0f: [0xf150, 0x4013, 0xdc4c, 0x4005, 0x4012, 0x4007, 0x401b, 0xdc47, 0x400f, 0x4014, 0x4015, 0x4016], // GHAS/GSD: состояние, момент блокировки, заданный, положение, Δn, масло, флаги
  0x18: [0xf150, 0x6000, 0xda12], // EGS: идентификация, температура масла АКПП (GSZFBCE 6000 / GSZFB1 DA12)
  0x19: [0xf150, 0xdb32], // LMV: идентификация, момент передней оси
  0x29: [0xf150, 0xdbe4, 0xdbe5, 0xdb29, 0xdc6c, 0xdc6d, 0xdc6e, 0xdc70], // DSC/IB: колёса, давления, состояния ABS/ASC/FDR/HDC
  0x30: [0xf150, 0xdb57], // EPS: идентификация, угол шестерни
  0x40: [0xf150, 0xe468, 0xd54d], // BDC: идентификация, режим движения (FES), статический тангаж LWR (к осям)
  0x76: [0xf150, 0xdc05, 0xdc06, 0xdc31, 0xd8ec], // VDP: идентификация, высоты, состояние датчиков, нуль, уровень
};

export const allowedRead = (ecu: number, did: number): boolean => (READ_ALLOWLIST[ecu] || []).indexOf(did) >= 0;

/** Часть ctx.signals (vendor kit/runtime/signals.js), нужная транспорту. */
export interface TasuSignals {
  proxy(iface: string, instance: string): Promise<unknown>;
  call(p: unknown, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  on(p: unknown, name: string, fn: (v: unknown) => void, log?: unknown): Promise<unknown>;
  onAvailable(p: unknown, fn: (a: boolean) => void): Promise<unknown>;
}

export type ReadResult =
  | { readonly kind: 'ok'; readonly payload: readonly number[] }
  | { readonly kind: 'nrc'; readonly nrc: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'refused'; readonly detail: string }
  | { readonly kind: 'closed' };

export interface TasuTiming {
  /** Предел на вызов метода (транспорт принял/отказал). */
  readonly callTimeoutMs: number;
  /** Ждать ответа блока после приёма транспортом. */
  readonly replyTimeoutMs: number;
  /** Абсолютный предел запроса, включая «ответ задерживается». */
  readonly hardTimeoutMs: number;
  /** Пауза перед единственным повтором, если транспорт занят. */
  readonly busyRetryMs: number;
}

export const DEFAULT_TIMING: TasuTiming = { callTimeoutMs: 2500, replyTimeoutMs: 1500, hardTimeoutMs: 4000, busyRetryMs: 500 };

export function toBytes(b: unknown): number[] {
  if (!b) return [];
  if (b instanceof Uint8Array) return Array.prototype.slice.call(b) as number[];
  if (Array.isArray(b)) return b.filter((x) => typeof x === 'number');
  const o = b as { data?: unknown; length?: unknown };
  if (o.data !== undefined) return toBytes(o.data);
  if (typeof o.length === 'number') return Array.prototype.slice.call(b) as number[];
  return [];
}

/** Вердикт метода sendTasuRequest (строка enum или объект с ней), как его читает MIT diag.js. */
export function verdictOf(r: unknown): string {
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    const v = o.TasuErrorEnum ?? Object.keys(o).map((k) => o[k]).find((x) => typeof x === 'string');
    return v === undefined ? 'NO_ERROR' : String(v);
  }
  return r === undefined ? 'NO_ERROR' : String(r);
}
const accepted = (v: string) => v === 'NO_ERROR' || v === 'REQUEST_PENDING' || v === '0' || v === '1';
const busy = (v: string) => /TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(v);

export interface Frame {
  readonly ecu: number;
  readonly uds: readonly number[];
}
export type FrameEvent = { readonly kind: 'frame'; readonly frame: Frame } | { readonly kind: 'reject'; readonly code: number } | { readonly kind: 'error'; readonly text: string } | { readonly kind: 'short' };

/** Разбор события sendTasuResponse. */
export function parseEvent(v: unknown): FrameEvent {
  const o = (v && typeof v === 'object' ? v : {}) as { errorCode?: unknown; udsResponse?: unknown };
  const err = o.errorCode;
  if (err !== undefined && err !== 'NO_ERROR' && err !== 0) return { kind: 'error', text: String(err).slice(0, 60) };
  const b = toBytes(o.udsResponse !== undefined ? o.udsResponse : v);
  if (b.length >= 5 && b[2] === 0x7f) return { kind: 'reject', code: b[4] };
  if (b.length < 10) return { kind: 'short' };
  return { kind: 'frame', frame: { ecu: b[6], uds: b.slice(9) } };
}

interface Pending {
  readonly ecu: number;
  readonly did: number;
  readonly done: (r: ReadResult) => void;
  /** Транспорт принял запрос — с этого момента считается ожидание ответа. */
  sent: boolean;
}

/** Статистика транспорта (лист диагностики). */
export interface TasuStats {
  requests: number;
  ok: number;
  nrc: number;
  timeouts: number;
  refused: number;
  busyRetries: number;
  lastError: string | null;
}

export class ReadOnlyTasu {
  private p: unknown = null;
  private avail = false;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private initError: string | null = null;
  readonly stats: TasuStats = { requests: 0, ok: 0, nrc: 0, timeouts: 0, refused: 0, busyRetries: 0, lastError: null };

  constructor(
    private readonly signals: TasuSignals,
    private readonly timing: TasuTiming = DEFAULT_TIMING,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async init(): Promise<this> {
    try {
      const p = await this.signals.proxy(TASU_IFACE, TASU_INSTANCE);
      if (this.closed) return this;
      this.p = p;
      await this.signals.on(p, TASU_EVENT, (v) => this.onEvent(v));
      await this.signals.onAvailable(p, (a) => {
        this.avail = !!a;
        // провайдер пропал: ответа на текущий запрос не будет
        if (!a && this.pending) this.finish({ kind: 'refused', detail: 'TASU unavailable' });
      });
    } catch (e) {
      this.initError = String(e).slice(0, 120);
    }
    return this;
  }

  get available(): boolean {
    return !this.closed && !!this.p && this.avail;
  }
  get error(): string | null {
    return this.initError;
  }

  /** Прочитать один разрешённый идентификатор. Запросы идут строго по очереди. */
  read(ecu: number, did: number): Promise<ReadResult> {
    if (!allowedRead(ecu, did)) return Promise.reject(new Error(`read ${ecu.toString(16)}/${did.toString(16)} is not allowed`));
    const run = () => this.readNow(ecu, did);
    const r = this.chain.then(run, run);
    this.chain = r.catch(() => undefined);
    return r;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) this.finish({ kind: 'closed' });
  }

  private finish(r: ReadResult): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.done(r);
  }

  private onEvent(v: unknown): void {
    const p = this.pending;
    if (this.closed || !p) return;
    const e = parseEvent(v);
    // отказ транспорта без адреса блока относится к единственному запросу в полёте
    if (e.kind === 'reject') return this.finish({ kind: 'refused', detail: `transport 7F ${e.code.toString(16)}` });
    if (e.kind === 'error') return this.finish({ kind: 'refused', detail: e.text });
    if (e.kind !== 'frame' || e.frame.ecu !== p.ecu) return;
    const u = e.frame.uds;
    // ответы на чужие запросы (другие приложения говорят с тем же блоком) не наши
    if (u[0] === 0x7f && u[1] === SID_READ) {
      if (u[2] === 0x78) {
        this.pendingSeen = true;
        return;
      }
      return this.finish({ kind: 'nrc', nrc: u[2] });
    }
    if (u[0] === SID_READ + 0x40 && u[1] === p.did >> 8 && u[2] === (p.did & 0xff)) this.finish({ kind: 'ok', payload: u.slice(3) });
  }
  private pendingSeen = false;

  private async readNow(ecu: number, did: number): Promise<ReadResult> {
    if (this.closed) return { kind: 'closed' };
    if (!this.p) return { kind: 'refused', detail: this.initError || 'no TASU proxy' };
    if (!this.avail) return { kind: 'refused', detail: 'TASU unavailable' };
    this.stats.requests++;
    this.pendingSeen = false;
    const t = this.timing;
    const result = new Promise<ReadResult>((resolve) => {
      this.pending = { ecu, did, done: resolve, sent: false };
    });
    let hard: ReturnType<typeof setTimeout> | null = setTimeout(() => this.finish({ kind: 'timeout' }), t.hardTimeoutMs);
    let reply: ReturnType<typeof setTimeout> | null = null;
    const params = { sourceAddress: TESTER, targetAddress: ecu, serviceID: SID_READ, subroutineID: 0, udsDataLength: 2, udsData: Buffer.from([did >> 8, did & 0xff]), deadlockTime: 0 };
    try {
      for (let attempt = 0; this.pending; attempt++) {
        const verdict = verdictOf(await this.signals.call(this.p, TASU_METHOD, params, t.callTimeoutMs));
        if (!this.pending) break;
        if (accepted(verdict)) {
          this.pending.sent = true;
          // ожидание ответа; «ответ задерживается» (78) продлевает до hardTimeoutMs, не дальше
          const wait = () => {
            reply = setTimeout(() => (this.pendingSeen ? wait() : this.finish({ kind: 'timeout' })), t.replyTimeoutMs);
            this.pendingSeen = false;
          };
          wait();
          break;
        }
        if (busy(verdict) && attempt === 0) {
          this.stats.busyRetries++;
          await this.sleep(t.busyRetryMs);
          continue;
        }
        this.finish({ kind: 'refused', detail: verdict.slice(0, 60) });
      }
    } catch (e) {
      this.finish({ kind: 'refused', detail: String(e).slice(0, 80) });
    }
    const r = await result;
    if (hard) clearTimeout(hard);
    if (reply) clearTimeout(reply);
    hard = reply = null;
    if (r.kind === 'ok') this.stats.ok++;
    else if (r.kind === 'nrc') this.stats.nrc++;
    else if (r.kind === 'timeout') this.stats.timeouts++;
    else if (r.kind === 'refused') this.stats.refused++;
    if (r.kind !== 'ok') this.stats.lastError = r.kind === 'nrc' ? `NRC ${r.nrc.toString(16)}` : r.kind === 'refused' ? r.detail : r.kind;
    return r;
  }
}
