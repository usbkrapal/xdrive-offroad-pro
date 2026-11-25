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

const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));
const DEG = 180 / Math.PI;

/**
 * Наклон стоящей машины по вектору тяжести ACSM5 (ускорения X/Y/Z, м/с²): pitch = atan2(ax, √(ay² + az²)),
 * roll = atan2(ay, az). Только кандидат для сверки с xView: оси и знаки монтажа ACSM не сверены, в движении ускорения
 * не равны наклону — поэтому только при известной нулевой скорости и всех трёх квалификаторах 2. Не на экран.
 */
export function standingTiltCandidate(acc: Readonly<Record<string, number | null>> | null, standing: boolean | null): { pitch: number; roll: number } | null {
  if (!acc || standing !== true) return null;
  const ax = acc.accX, ay = acc.accY, az = acc.accZ;
  if (ax == null || ay == null || az == null || acc.accXQualifier !== 2 || acc.accYQualifier !== 2 || acc.accZQualifier !== 2) return null;
  const g = Math.sqrt(ax * ax + ay * ay + az * az);
  if (!(g > 7 && g < 12.5)) return null; // не вектор тяжести (тряска, неверная ось или масштаб)
  return { pitch: Math.atan2(ax, Math.sqrt(ay * ay + az * az)) * DEG, roll: Math.atan2(ay, az) * DEG };
}

/**
 * Углы для сверки со штатным xView (фото экрана и xView в одну секунду, машина стоит): сырой LaneSlope, ACSM5 и
 * кандидат наклона стоя, BDC D54D (кузов к осям — другая величина), время снимка. Ни одна строка не идёт в «Тангаж/Крен».
 */
export function attitudeLines(d: ModelDiagnostics | null, standing: boolean | null, now: Date): DiagLine[] {
  const out: DiagLine[] = [{ label: 'Углы: сверка с xView (кандидаты, не на экране)', value: `снимок ${now.toTimeString().slice(0, 8)}`, tone: 'head' }];
  out.push({ label: 'как снять', value: 'машина стоит; фото этого листа и xView в одну секунду; 3–4 места, одно — после разворота на 180°', tone: 'dim' });
  if (!d) return [...out, { label: 'нет', value: 'демо', tone: 'dim' }];
  const lane = d.latestSamples.filter((x) => x.field === 'LaneSlope').slice(-1)[0];
  if (lane) {
    const v = lane.values as Record<string, unknown>;
    const age = Math.round((d.at - lane.at) / 100) / 10;
    out.push({ label: 'LaneSlope продольный / поперечный (сырьё)', value: `${String(v.actualValueLongitudinalGradientRoadway ?? '—')} / ${String(v.actualValueTransverseGradientRoadway ?? '—')} · ${num(age, 1)} с назад`, tone: 'ok' });
  } else out.push({ label: 'LaneSlope', value: 'отсчётов не было', tone: 'warn' });
  const rec = (key: string, did: string) => {
    const e = d.uds ? d.uds.ecus.find((x) => x.key === key) : undefined;
    return { e, r: e ? e.records.find((x) => x.did === did) : undefined };
  };
  const acsm = rec('ACSM', '4101');
  if (acsm.r && acsm.r.values) {
    const v = acsm.r.values;
    const age = acsm.r.lastAt !== null && d.uds ? ` · ${num((d.at - acsm.r.lastAt) / 1000, 1)} с назад` : '';
    out.push({ label: `ACSM ${acsm.e!.identity ?? '?'} ускорения X / Y / Z, м/с²`, value: `${num(v.accX)} / ${num(v.accY)} / ${num(v.accZ)} · кв. ${v.accXQualifier ?? '—'}/${v.accYQualifier ?? '—'}/${v.accZQualifier ?? '—'}${age}`, tone: 'ok' });
    const c = standingTiltCandidate(v, standing);
    out.push({
      label: 'кандидат наклона стоя (оси ACSM не сверены)',
      value: c ? `тангаж ${num(c.pitch, 1)}° · крен ${num(c.roll, 1)}°` : standing === true ? 'нет: квалификатор ≠ 2 или |g| вне 7…12,5 м/с²' : 'только при известной нулевой скорости',
      tone: c ? 'ok' : 'dim',
    });
  } else {
    out.push({ label: 'ACSM 4101', value: acsm.r ? (acsm.r.lastError ?? 'разбора нет (вариант не опознан)') : 'не читается', tone: 'warn' });
    out.push({ label: 'кандидат наклона стоя (оси ACSM не сверены)', value: 'нет: нет разобранного ответа ACSM5 (F150 0F2040)', tone: 'dim' });
  }
  const bdc = rec('BDC', 'D54D');
  if (bdc.r && bdc.r.values) {
    const v = bdc.r.values;
    out.push({ label: 'BDC D54D кузов к осям (не к горизонту)', value: `${num(v.pitchCandidateDeg)}° · источник ${v.source ?? '—'} · кв. ${v.qualifier ?? '—'}`, tone: 'dim' });
  }
  return out;
}

/** Первая страница листа: по открытой вкладке — сначала её данные, затем остальное коротко. */
export function supportLines(kind: 'systems' | 'cameras', d: ModelDiagnostics | null, camera: readonly DiagLine[], renderer: readonly DiagLine[], version: string, standing: boolean | null = null, now: Date = new Date()): DiagLine[] {
  const head: DiagLine = { label: `Поддержка · Terrain Monitor ${version}`, value: kind === 'cameras' ? 'вкладка «Камеры»' : 'вкладка «Системы»', tone: 'head' };
  const uds = udsSupportLines(d);
  const lane = [...attitudeLines(d, standing, now), ...laneSlopeLines(d)];
  return kind === 'cameras' ? [head, ...camera, ...renderer, ...uds, ...lane] : [head, ...lane, ...uds, ...camera, ...renderer];
}
