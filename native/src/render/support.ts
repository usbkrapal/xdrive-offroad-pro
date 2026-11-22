// Скрытый лист поддержки для фото с экрана автомобиля (у владельца нет доступа к журналу): пять касаний уже
// открытой вкладки «Системы» или «Камеры» за 3 с (app.ts SupportTaps). Только чтение: сам лист ничего не запускает
// и не меняет (камеры остаются в том состоянии, в каком их держит страница «Камеры»), демо не включает, ничего не
// сохраняет; закрывается штатным «Назад». Первая страница — короткий снимок по открытой вкладке; дальше —
// полный лист диагностики (render/diagnostics.ts).

import type { ModelDiagnostics } from '../model/model';
import type { DiagLine } from './diagnostics';

export const SUPPORT_TAPS = 5;
export const SUPPORT_WINDOW_MS = 3000;

/** Счётчик касаний уже открытой вкладки: true — пятое касание за окно (счётчик сбрасывается). */
export class SupportTaps {
  private taps: number[] = [];

  /** Касание вкладки i при открытой странице page; eligible — страница, на которой лист разрешён. */
  tap(i: number, page: number, eligible: boolean, at: number): boolean {
    if (i !== page || !eligible) {
      this.taps = [];
      return false;
    }
    this.taps = this.taps.filter((t) => at - t <= SUPPORT_WINDOW_MS);
    this.taps.push(at);
    if (this.taps.length < SUPPORT_TAPS) return false;
    this.taps = [];
    return true;
  }

  reset(): void {
    this.taps = [];
  }
}

const clip = (s: string, n = 96) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** UDS кратко: блок, состояние, F150; записи — счётчики, период/промежуток, последнее сырьё. */
export function udsSupportLines(d: ModelDiagnostics | null): DiagLine[] {
  const out: DiagLine[] = [{ label: 'Диагностика (чтение UDS / OBD)', value: '', tone: 'head' }];
  const u = d ? d.uds : null;
  if (!u) return [...out, { label: 'нет', value: 'демо или транспорта TASU нет', tone: 'warn' }];
  const s = u.stats;
  out.push({ label: 'TASU', value: `${u.available ? 'есть' : `нет${u.error ? ` · ${clip(u.error, 40)}` : ''}`} · запросов ${s.requests} · ok ${s.ok} · NRC ${s.nrc} · нет ответа ${s.timeouts}`, tone: u.available ? 'dim' : 'warn' });
  for (const e of u.ecus) {
    out.push({ label: `${e.key} ${e.addr}`, value: clip(`${e.state}${e.identity ? ` · F150 ${e.identity}` : ''}${e.reason ? ` · ${e.reason}` : ''}`), tone: e.state === 'accepted' ? 'ok' : 'warn' });
    for (const r of e.records) {
      if (!r.ok && !r.failed) continue;
      const iv = r.intervalMs === null ? '' : ` · шаг ${Math.round(r.intervalMs)}/${Math.round(r.maxIntervalMs)} мс`;
      out.push({ label: `   ${r.did}`, value: clip(`ok ${r.ok} · ошибок ${r.failed} · период ${r.periodMs}${iv}${r.lastRaw ? ` · ${r.lastRaw}` : ''}${r.lastError ? ` · ${r.lastError}` : ''}`), tone: r.lastError ? 'warn' : 'dim' });
    }
  }
  return out;
}

/** LaneSlope (уклон дороги, масштаб неизвестен): состав поля и последнее сырьё известных членов. */
export function laneSlopeLines(d: ModelDiagnostics | null): DiagLine[] {
  const out: DiagLine[] = [{ label: 'LaneSlope (сырьё, масштаб неизвестен)', value: '', tone: 'head' }];
  if (!d) return [...out, { label: 'нет', value: 'демо', tone: 'dim' }];
  const shape = d.memberShapes ? d.memberShapes['VehicleModel.LaneSlope'] : undefined;
  if (shape && shape[0] === '{' && shape[shape.length - 1] === '}') {
    out.push({ label: 'члены (имя и тип, без значений)', value: '', tone: 'dim' });
    // На фото одна общая строка скрывала длинные имена квалификаторов, нужные для разбора уклона.
    // Число членов уже ограничено адаптером; каждая строка помещается в широкой колонке значений.
    for (const member of shape.slice(1, -1).split(', ').slice(0, 17)) {
      out.push({ label: '', value: member, tone: 'dim' });
    }
  } else out.push({ label: 'члены', value: clip(shape ?? 'отсчётов ещё не было', 120), tone: shape ? 'dim' : 'warn' });
  const last = d.latestSamples.filter((x) => x.field === 'LaneSlope').slice(-1)[0];
  if (last) for (const k of Object.keys(last.values)) out.push({ label: `   ${k}`, value: String(last.values[k]), tone: 'dim' });
  return out;
}

/** Первая страница листа: по открытой вкладке — сначала её данные, затем остальное коротко. */
export function supportLines(kind: 'systems' | 'cameras', d: ModelDiagnostics | null, camera: readonly DiagLine[], renderer: readonly DiagLine[], version: string): DiagLine[] {
  const head: DiagLine = { label: `Поддержка · Terrain Monitor ${version}`, value: kind === 'cameras' ? 'вкладка «Камеры»' : 'вкладка «Системы»', tone: 'head' };
  const uds = udsSupportLines(d);
  const lane = laneSlopeLines(d);
  return kind === 'cameras' ? [head, ...camera, ...renderer, ...uds, ...lane] : [head, ...uds, ...lane, ...camera, ...renderer];
}
