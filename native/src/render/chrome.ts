// Бейдж режима в шапке (G.frame). Данные автомобиля — обычный режим, бейджа нет; демо разработчика
// (XOP_DEV=demo) помечено всегда, чтобы смоделированные данные нельзя было принять за данные автомобиля.
// Нижней строки статуса нет: всё место страницы — содержимому.

import type { NativeState } from '../model/model';
import type { Badge } from '../platform/kitTypes';
import { T } from '../strings';
import { C } from './palette';

const n = T.native;

export function badges(state: NativeState): Badge[] {
  if (state.mode !== 'demo') return [];
  const out: Badge[] = [{ text: n.badge.demo, color: C.warn }];
  if (state.paused) out.push({ text: n.badge.paused, color: C.dim });
  return out;
}
