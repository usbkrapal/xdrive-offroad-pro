// Постоянные элементы: бейдж режима в заголовке (G.frame) и нижняя полоса —
// «Сценарий демо» как в браузере, или статус режима чтения автомобиля.

import { sessionElapsedMs } from '../../../src/domain/session';
import { formatDuration } from '../format';
import type { NativeState } from '../model/model';
import type { Badge, Surface } from '../platform/kitTypes';
import { T } from '../strings';
import { BAR_H, BAR_Y, M, W } from './layout';
import { C } from './palette';
import { caps, text, width } from './ui';

const n = T.native;

/** Бейдж всегда есть: ДЕМО в демо; в режиме чтения — «нет данных», пока не пришло пригодное значение. */
export function badges(state: NativeState): Badge[] {
  if (state.mode === 'demo') {
    const out: Badge[] = [{ text: n.badge.demo, color: C.warn }];
    if (state.paused) out.push({ text: n.badge.paused, color: C.dim });
    return out;
  }
  return [state.vehicle && state.vehicle.hasUsableData ? { text: n.badge.vehicle, color: C.cold } : { text: n.badge.vehicleNoData, color: C.warn }];
}

export type ToolbarButton = (x: number, y: number, w: number, h: number, label: string, run: () => unknown, key: string, primary?: boolean) => number;

export interface ToolbarActions {
  togglePause(): void;
  newSession(): void;
  nextScenario(): void;
}

export function toolbar(cv: Surface, state: NativeState, button: ToolbarButton | null, act: ToolbarActions): void {
  const y = BAR_Y;
  cv.fillRect(0, y - 3, W, 1, C.hair);
  const base = y + BAR_H / 2 + 6;
  let x = M + 4;
  if (state.mode === 'demo') {
    x += caps(cv, n.toolbar.demoTitle, x, base, 14, C.warn) + 18;
    const sc = T.scenarios[state.scenarioId];
    if (button) {
      x += button(x, y + 2, 156, BAR_H - 4, state.paused ? n.buttons.resume : n.buttons.pause, act.togglePause, 'tb-pause', state.paused) + 8;
      x += button(x, y + 2, 170, BAR_H - 4, n.buttons.newSession, act.newSession, 'tb-session') + 8;
      // w = 0: G.button сам берёт ширину по подписи (явную ширину он не подгоняет под текст),
      // самое длинное — «Диагональное вывешивание».
      x += button(x, y + 2, 0, BAR_H - 4, `${n.buttons.scenario}: ${sc.name}`, act.nextScenario, 'tb-scenario') + 14;
    } else {
      x += text(cv, sc.name, x, base, 17, C.text) + 14;
    }
    const right = W - M - 4;
    const timeLabel = `${n.toolbar.simTime} `;
    const time = formatDuration(state.snapshot.simTimeMs);
    const tag = state.paused ? T.demo.paused : T.demo.running;
    const tagW = width(cv, tag, 13) + 12;
    const tw = width(cv, time, 17);
    cv.strokeRoundRect(right - tagW, y + 9, tagW, 20, 3, 1, state.paused ? C.warn : C.dim);
    text(cv, tag, right - tagW / 2, base - 1, 13, state.paused ? C.warn : C.dim, { align: 'center' });
    text(cv, time, right - tagW - 10, base, 17, C.text, { align: 'right' });
    const lw = width(cv, timeLabel, 14);
    text(cv, timeLabel, right - tagW - 10 - tw - 4, base, 14, C.dim, { align: 'right' });
    const room = right - tagW - 24 - tw - lw - x;
    if (room > 120) text(cv, clip(cv, sc.description, 14, room), x, base, 14, C.dim);
    return;
  }
  x += caps(cv, n.toolbar.vehicleTitle, x, base, 14, C.cold) + 18;
  if (button) x += button(x, y + 2, 170, BAR_H - 4, n.buttons.newSession, act.newSession, 'tb-session') + 14;
  const right = W - M - 4;
  const time = formatDuration(sessionElapsedMs(state.session, state.snapshot.simTimeMs));
  const tw = width(cv, time, 17);
  text(cv, time, right, base, 17, C.text, { align: 'right' });
  const lw = text(cv, `${n.toolbar.sessionTime} `, right - tw - 4, base, 14, C.dim, { align: 'right' });
  const v = state.vehicle;
  const msg = v && v.errors.length
    ? `${n.toolbar.vehicleErrors} ${v.errors.length} из ${v.interfaces}. ${n.toolbar.vehicleCandidate}`
    : v && v.hasUsableData
      ? n.toolbar.vehicleCandidate
      : n.toolbar.vehicleWaiting;
  const room = right - tw - lw - 20 - x;
  if (room > 120) text(cv, clip(cv, msg, 14, room), x, base, 14, v && v.errors.length ? C.warn : C.dim);
}

/** Обрезать строку по ширине с многоточием. */
function clip(cv: Surface, s: string, size: number, room: number): string {
  if (width(cv, s, size) <= room) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (width(cv, `${s.slice(0, mid)}…`, size) <= room) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}…`;
}
