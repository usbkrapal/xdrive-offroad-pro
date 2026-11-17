// Общие примитивы страниц: панель, подпись + значение (Readout браузера), статус качества, полоса.
// Весь текст рисуется с literal: true — строки уже русские, kit/i18n t() их не трогает.
// Числа — шрифтом 'num' (в крупных атласах только цифры и ' %+,-./:'), остальное — 'label'
// (с кириллицей kit сам берёт атлас cyrillic, если сборка --language ru).

import type { Quality } from '../../../src/domain/types';
import type { Shown } from '../format';
import type { Color, Surface, TextOpts } from '../platform/kitTypes';
import { T } from '../strings';
import { C, QUALITY_COLOR, withA } from './palette';

const NUM_OK = /^[0-9 ,.+\-/:%]*$/;

export function text(cv: Surface, s: string, x: number, y: number, size: number, c: Color, opts: TextOpts = {}): number {
  return cv.text(s, x, y, size, c, { ...opts, literal: true });
}

export function width(cv: Surface, s: string, size: number, opts: TextOpts = {}): number {
  return cv.textWidth(s, size, { ...opts, literal: true });
}

/** Число цифровым шрифтом, если все символы есть в атласе, иначе обычным. */
export function numText(cv: Surface, s: string, x: number, y: number, size: number, c: Color, align: TextOpts['align'] = 'left'): number {
  return text(cv, s, x, y, size, c, { font: NUM_OK.test(s) ? 'num' : 'label', align });
}
export function numWidth(cv: Surface, s: string, size: number): number {
  return width(cv, s, size, { font: NUM_OK.test(s) ? 'num' : 'label' });
}

/** Заголовок панели: прописные, разрядка, как .panel__title. */
export function caps(cv: Surface, s: string, x: number, y: number, size = 14, c: Color = C.text, align: TextOpts['align'] = 'left'): number {
  return text(cv, s.toUpperCase(), x, y, size, c, { spacing: 1.6, align });
}

export interface PanelOpts {
  title?: string;
  /** Цвет верхней акцентной черты (по умолчанию светло-голубой; янтарь — тормоз/внимание). */
  accent?: Color;
  /** Полная верхняя линия (карточки колёс с вмешательством тормоза). */
  topLine?: Color;
}

/** Панель: сплошной фон (совпадает с заливкой растров), короткая акцентная черта сверху слева. */
export function panel(cv: Surface, x: number, y: number, w: number, h: number, opts: PanelOpts = {}): void {
  cv.fillRect(x, y, w, h, C.panel);
  if (opts.topLine) cv.fillRect(x, y, w, 3, opts.topLine);
  else cv.fillRect(x, y, 56, 3, opts.accent ?? withA(C.ice, 0.85));
  if (opts.title) caps(cv, opts.title, x + 16, y + 30, 15);
}

export const QUALITY_TEXT: Record<Quality, string> = T.quality;

/** Текстовый статус вместо числа (StatusTag): «Нет данных», «Устарело», «Ошибка данных». */
export function statusTag(cv: Surface, q: Quality, x: number, baseY: number, size = 15): number {
  const label = QUALITY_TEXT[q];
  const c = QUALITY_COLOR[q];
  const w = width(cv, label, size) + 14;
  cv.strokeRoundRect(x, baseY - size - 3, w, size + 10, 3, 1.2, withA(typeof c === 'string' ? c : C.warn, 0.85));
  text(cv, label, x + 7, baseY + 1, size, c);
  return w;
}

export type ReadoutSize = 'xl' | 'lg' | 'md' | 'sm';
export const READOUT: Record<ReadoutSize, { value: number; unit: number; label: number; gap: number }> = {
  xl: { value: 60, unit: 20, label: 16, gap: 58 },
  lg: { value: 46, unit: 18, label: 16, gap: 46 },
  md: { value: 34, unit: 16, label: 15, gap: 36 },
  sm: { value: 26, unit: 15, label: 14, gap: 28 },
};

export interface ReadoutOpts {
  label: string;
  shown: Shown;
  unit?: string;
  size?: ReadoutSize;
  hint?: string;
  hintColor?: Color;
  align?: 'left' | 'right';
  valueColor?: Color;
}

/**
 * Подпись + крупное значение (+ единица) + подсказка. y — верх подписи. Возвращает высоту блока.
 * Градус пишется вплотную к числу; без данных — «—» и статус, без единицы.
 */
export function readout(cv: Surface, x: number, y: number, o: ReadoutOpts): number {
  const S = READOUT[o.size ?? 'md'];
  const right = o.align === 'right';
  text(cv, o.label, x, y + S.label, S.label, C.dim, { align: right ? 'right' : 'left' });
  const base = y + S.label + 6 + S.value * 0.86;
  if (o.shown.ok) {
    const tight = o.unit === T.units.deg;
    const unit = o.unit ? (tight ? o.unit : ` ${o.unit}`) : '';
    const uSize = tight ? S.value * 0.8 : S.unit;
    const nw = numWidth(cv, o.shown.text, S.value);
    const uw = unit ? width(cv, unit, uSize) : 0;
    const x0 = right ? x - nw - uw : x;
    numText(cv, o.shown.text, x0, base, S.value, o.valueColor ?? C.text);
    if (unit) text(cv, unit, x0 + nw + (tight ? 1 : 3), tight ? base : base, uSize, tight ? (o.valueColor ?? C.text) : C.dim);
  } else {
    const dw = width(cv, '—', S.value * 0.8);
    const x0 = right ? x - dw - 140 : x;
    text(cv, '—', x0, base, S.value * 0.8, C.dim);
    statusTag(cv, o.shown.quality, x0 + dw + 10, base - S.value * 0.18, Math.min(15, S.label));
  }
  let h = S.label + 6 + S.value;
  if (o.hint) {
    text(cv, o.hint, x, y + h + 14, 13, o.hintColor ?? C.dim, { align: right ? 'right' : 'left' });
    h += 18;
  }
  return h;
}

/** Полоса BarGauge: value в [min, max]; null — пустая дорожка. */
export function bar(cv: Surface, x: number, y: number, w: number, value: number | null, min: number, max: number, tone: Color = C.ice, h = 5): void {
  cv.fillRect(x, y, w, h, C.track);
  if (value === null) return;
  const f = Math.max(0, Math.min(1, (value - min) / (max - min)));
  if (f > 0) cv.fillRect(x, y, Math.max(2, w * f), h, tone);
}

/** Цветной чип источника (Демо / Измерено). */
export function chip(cv: Surface, label: string, x: number, baseY: number, c: Color = C.warn): number {
  const w = width(cv, label, 14) + 14;
  cv.strokeRoundRect(x, baseY - 15, w, 21, 3, 1.2, c);
  text(cv, label, x + 7, baseY + 1, 14, c);
  return w;
}

/** Разделитель внутри панели. */
export function hline(cv: Surface, x: number, y: number, w: number): void {
  cv.fillRect(x, y, w, 1, C.hair);
}
