// «Диагностика чтения» — лист внутри «Настроек» (ctx.settingsRow → open()): для проверки на своём автомобиле, что
// доступно, когда приходил последний отсчёт и какие сырые числа видны. Только снимок VehicleAdapter.diagnostics()
// (INTEGRATION.md): интерфейсы и поля из allowlist, члены из FieldSpec.diag — конечные числа (здесь показываются
// только они). VIN, координат и иных идентификаторов в снимке нет и здесь не собирается ничего сверх него.
// Сырые числа — без масштаба: значение сигнала остаётся «нет данных», пока масштаб не подтверждён.

import type { Surface, Theme } from '../platform/kitTypes';
import type { FieldDiagnostics, GetterStats, InterfaceDiagnostics, VehicleDiagnostics } from '../vehicle/adapter';
import { formatNumber } from '../format';
import { C } from './palette';

export type Tone = 'head' | 'ok' | 'warn' | 'dim';
export interface DiagLine {
  readonly label: string;
  readonly value: string;
  readonly tone: Tone;
}

/** Предел строк листа (снимок адаптера и так ограничен; это — защита от роста списков). */
export const MAX_LINES = 200;
/** Предел показанных сырых значений (по строке на член). */
export const MAX_RAW = 60;
const MAX_VALUE = 96;

export const DIAG = {
  title: 'Диагностика чтения автомобиля',
  row: 'Диагностика автомобиля',
  rowOpen: 'Открыть',
  rowDemo: 'Только в режиме «Автомобиль»',
  back: 'Назад',
  refresh: 'Обновить',
  demo: 'Источник данных — демо. Диагностика есть только в режиме «Автомобиль» (Настройки → Источник данных).',
  snapshot: 'Снимок',
  snapshotValue: (s: number) => `через ${s} с после включения чтения · обновляется кнопкой`,
  services: 'Сервисы (интерфейсы SOME/IP, только чтение)',
  available: 'доступен',
  unavailable: 'недоступен',
  notSubscribed: 'нет подписки',
  error: 'ошибка',
  samples: (n: number) => `отсчётов ${n}`,
  never: 'отсчётов не было',
  ago: (s: string) => `${s} с назад`,
  losses: (n: number) => `потерь ${n}`,
  diagOnly: 'только диагностика',
  droppedOffline: (n: number) => `без провайдера отброшено ${n}`,
  // чтение геттером (только поля с геттером и вендорный signals.js): счётчики, без времени
  read: 'чтение',
  readOk: (n: number) => `успешно ${n}`,
  readFailed: (n: number) => `ошибок ${n}`,
  readStreak: (n: number) => `подряд ${n}`,
  readDropped: (n: number) => `отброшено ${n}`,
  readSkipped: (n: number) => `пропущено ${n}`,
  readPending: 'ждёт ответа',
  errorNow: 'ошибка сейчас',
  errorPast: 'прошлая ошибка',
  reasons: 'Почему без значения',
  units: 'Единицы TPMS (давление / температура)',
  gearboxOil: 'Масло КПП',
  gearboxOilOn: 'показывается',
  gearboxOilWait: 'ждём изменения сырого значения',
  raw: 'Сырые числа (масштаб не подтверждён, не значения сигналов)',
  rawNone: 'сырых чисел ещё не было',
} as const;

const shortIface = (s: string) => s.replace(/^de\.bmw\.(infotainment\.|infrastructure\.|powertrain\.|chassis\.)?/, '');
const ageText = (at: number, last: number | null) => (last === null ? DIAG.never : DIAG.ago(formatNumber(Math.max(0, at - last) / 1000, 1)));
const clip = (s: string) => (s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}…` : s);

function ifaceLine(d: VehicleDiagnostics, i: InterfaceDiagnostics): DiagLine {
  if (i.error) return { label: shortIface(i.iface), value: clip(`${DIAG.error}: ${i.error}`), tone: 'warn' };
  const parts = [i.available ? DIAG.available : i.subscribed ? DIAG.unavailable : DIAG.notSubscribed, DIAG.samples(i.samples), ageText(d.at, i.lastSampleAt), DIAG.losses(i.losses)];
  if (i.diagnosticOnly) parts.push(DIAG.diagOnly);
  return { label: shortIface(i.iface), value: clip(parts.join(' · ')), tone: i.available && i.samples > 0 ? 'ok' : 'warn' };
}

function fieldLine(d: VehicleDiagnostics, f: FieldDiagnostics): DiagLine {
  const parts = [DIAG.samples(f.samples), ageText(d.at, f.lastSampleAt)];
  if (f.droppedWhileUnavailable > 0) parts.push(DIAG.droppedOffline(f.droppedWhileUnavailable));
  return { label: `   ${f.field}`, value: parts.join(' · '), tone: f.samples > 0 ? 'dim' : 'warn' };
}

/**
 * Чтение геттером (FieldDiagnostics.getter): счётчики и «ждёт ответа». Времена getter — Date.now() рантайма, а
 * d.at — часы адаптера: их не вычитаем. Ошибка «сейчас» — только при consecutiveFailures > 0; иначе последняя
 * ошибка — история (после неё были успешные чтения).
 */
export function getterLines(g: GetterStats): DiagLine[] {
  const parts = [DIAG.readOk(g.ok), DIAG.readFailed(g.failed)];
  if (g.consecutiveFailures > 0) parts.push(DIAG.readStreak(g.consecutiveFailures));
  if (g.dropped > 0) parts.push(DIAG.readDropped(g.dropped));
  if (g.skipped > 0) parts.push(DIAG.readSkipped(g.skipped));
  if (g.pendingSince !== null) parts.push(DIAG.readPending);
  const failing = g.consecutiveFailures > 0;
  const out: DiagLine[] = [{ label: `      ${DIAG.read}`, value: parts.join(' · '), tone: failing ? 'warn' : 'dim' }];
  if (g.lastError) out.push({ label: `      ${failing ? DIAG.errorNow : DIAG.errorPast}`, value: clip(g.lastError), tone: failing ? 'warn' : 'dim' });
  return out;
}

/** Строки листа из снимка. null — демо (снимка нет). Ограничено MAX_LINES. */
export function diagnosticsLines(d: VehicleDiagnostics | null): DiagLine[] {
  if (!d) return [{ label: DIAG.demo, value: '', tone: 'dim' }];
  const out: DiagLine[] = [];
  out.push({ label: DIAG.snapshot, value: DIAG.snapshotValue(Math.round(d.at / 1000)), tone: 'dim' });
  out.push({ label: DIAG.services, value: '', tone: 'head' });
  for (const i of d.interfaces) {
    out.push(ifaceLine(d, i));
    for (const f of i.fields) {
      out.push(fieldLine(d, f));
      if (f.getter) out.push(...getterLines(f.getter));
    }
  }
  const reasons = Object.entries(d.reasons).filter(([, r]) => !!r);
  if (reasons.length) {
    out.push({ label: DIAG.reasons, value: '', tone: 'head' });
    for (const [id, r] of reasons) out.push({ label: id, value: clip(String(r)), tone: 'dim' });
  }
  out.push({ label: DIAG.units, value: `${d.tyreUnits.pressure} / ${d.tyreUnits.temperature}`, tone: 'dim' });
  out.push({ label: DIAG.gearboxOil, value: d.gearboxOilPromoted ? DIAG.gearboxOilOn : DIAG.gearboxOilWait, tone: 'dim' });
  // последнее значение каждого поля: из кольца изменений (новее), иначе первый отсчёт; только конечные числа
  out.push({ label: DIAG.raw, value: '', tone: 'head' });
  const latest = new Map<string, { at: number; field: string; values: Readonly<Record<string, unknown>> }>();
  for (const e of [...d.firstSamples, ...d.changes]) {
    const k = `${e.iface}|${e.field}`;
    const prev = latest.get(k);
    if (!prev || e.at >= prev.at) latest.set(k, e);
  }
  // строка-заголовок на поле (возраст отсчёта), под ней по строке на каждый числовой член; строки и enum — не здесь
  let raw = 0;
  for (const e of latest.values()) {
    if (raw >= MAX_RAW) break;
    const nums = Object.entries(e.values).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)) as [string, number][];
    if (!nums.length) continue;
    out.push({ label: `   ${e.field}`, value: ageText(d.at, e.at), tone: 'dim' });
    for (const [m, v] of nums) {
      if (raw >= MAX_RAW) break;
      out.push({ label: `      ${m}`, value: String(v), tone: 'ok' });
      raw++;
    }
  }
  if (!raw) out.push({ label: `   ${DIAG.rawNone}`, value: '', tone: 'dim' });
  return out.slice(0, MAX_LINES);
}

/* ---------------- лист (kit sheet.js: draw / move / press / back / scroll) ---------------- */

const PAGE_W = 1600;
const TOP = 46;
const BOTTOM = 512;
const LINE_H = 30;
const LIST_Y = TOP + 74;

interface Target {
  x: number;
  y: number;
  w: number;
  h: number;
  act: () => unknown;
}

function fit(r: Surface, s: string, size: number, w: number): string {
  const o = { literal: true };
  if (r.textWidth(s, size, o) <= w) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (r.textWidth(`${s.slice(0, mid)}…`, size, o) <= w) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}…`;
}

function button(r: Surface, t: Theme, x: number, y: number, w: number, h: number, label: string): void {
  r.roundRect(x, y, w, h, h / 2, '#ffffff14');
  r.strokeRoundRect(x, y, w, h, h / 2, 1.5, '#ffffff38');
  r.text(label, x + w / 2, y + h / 2 + 9, 24, t.text, { align: 'center', font: 'bold', spacing: 1, literal: true });
}

const toneColor = (tone: Tone, t: Theme) => (tone === 'head' ? C.ice : tone === 'ok' ? t.text : tone === 'warn' ? C.warn : t.dim);

export interface DiagnosticsSheet {
  readonly title: string;
  lines: DiagLine[];
  offset: number;
  draw(r: Surface, t: Theme): Target[];
  move(d: number): void;
  press(): unknown;
  back(): unknown;
  top(): boolean;
  scroll(dy: number): void;
  release(): void;
  refresh(): void;
}

/** read() — снимок модели (по открытию и «Обновить»), не на каждый кадр. */
export function diagnosticsSheet(read: () => VehicleDiagnostics | null): DiagnosticsSheet {
  const sh: DiagnosticsSheet = {
    title: DIAG.title,
    lines: [],
    offset: 0,
    refresh() {
      let d: VehicleDiagnostics | null = null;
      try {
        d = read();
      } catch {
        d = null;
      }
      this.lines = diagnosticsLines(d);
    },
    draw(r, t) {
      r.clear(t.bg);
      const targets: Target[] = [];
      r.text(DIAG.title, 44, TOP + 40, 30, t.text, { font: 'bold', literal: true });
      const bw = 170;
      const by = TOP + 8;
      const bx = PAGE_W - 40 - bw;
      button(r, t, bx, by, bw, 46, DIAG.back);
      targets.push({ x: bx - 10, y: by - 6, w: bw + 20, h: 58, act: () => 'close' });
      const rx = bx - 20 - bw;
      button(r, t, rx, by, bw, 46, DIAG.refresh);
      targets.push({ x: rx - 10, y: by - 6, w: bw + 20, h: 58, act: () => (this.refresh(), null) });
      const bottom = BOTTOM + (r.extra || 0);
      const H = bottom - LIST_Y;
      const total = this.lines.length * LINE_H;
      this.offset = Math.max(0, Math.min(this.offset, Math.max(0, total - H)));
      r.clip(0, LIST_Y, PAGE_W, H);
      this.lines.forEach((ln, i) => {
        const y = LIST_Y + i * LINE_H - this.offset;
        if (y + LINE_H < LIST_Y || y > bottom) return;
        const base = y + LINE_H - 8;
        if (ln.tone === 'head') r.fillRect(40, y + 2, PAGE_W - 80, LINE_H - 4, '#ffffff0d');
        const labelW = ln.value ? 560 : PAGE_W - 120;
        r.text(fit(r, ln.label, 19, labelW), 52, base, 19, toneColor(ln.tone, t), { literal: true });
        if (ln.value) r.text(fit(r, ln.value, 19, PAGE_W - 80 - 640), 640, base, 19, ln.tone === 'warn' ? C.warn : t.dim, { literal: true });
      });
      r.noclip();
      if (total > H) {
        const sbh = Math.max(40, (H * H) / total);
        r.roundRect(PAGE_W - 22, LIST_Y + (H - sbh) * (this.offset / (total - H)), 6, sbh, 3, '#ffffff4d');
      }
      return targets;
    },
    move(d) {
      this.offset += d * LINE_H * 3;
    },
    press() {
      this.refresh();
      return null;
    },
    back() {
      return 'close';
    },
    top() {
      return true;
    },
    scroll(dy) {
      this.offset += dy;
    },
    release() {},
  };
  sh.refresh();
  return sh;
}
