// Общие примитивы страниц: панель, подпись + значение (Readout браузера), статус качества, полоса.
// Весь текст рисуется с literal: true — строки уже русские, kit/i18n t() их не трогает.
// Числа — шрифтом 'num' (в крупных атласах только цифры и ' %+,-./:'), остальное — 'label'
// (с кириллицей kit сам берёт атлас cyrillic, если сборка --language ru).
//
// 0.1.8: шрифт уменьшен относительно 0.1.7 (1,38 → 1,25, нижняя граница 18 → 16 px), и каждый элемент с известной
// ячейкой подгоняется по измеренной ширине (record.js textWidth — та же формула, что рисует text(); кириллический
// атлас один, ширина линейна по размеру). Порядок уступок в readout(): подпись → единица → число; подпись при нехватке
// места уменьшается до FIT_MIN_PX и только затем сокращается многоточием; числа и единицы не обрезаются никогда —
// они только уменьшаются (не ниже VALUE_MIN доли), остальное ловят тесты вёрстки.

import type { Quality } from '../../../src/domain/types';
import type { Shown } from '../format';
import type { Color, Surface, TextOpts } from '../platform/kitTypes';
import { T } from '../strings';
import { C, QUALITY_COLOR, withA } from './palette';

export const FONT_SCALE = 1.25;
/** Нижняя граница обычного текста, логические px (≈ 18,6 px на экране 1920 × 720 при масштабе kit 1,164). */
export const MIN_PX = 16;
/** Нижняя граница при подгонке к ширине ячейки (≈ 16,3 px на экране). */
export const FIT_MIN_PX = 14;
/** Число уменьшается не сильнее этой доли своего размера. */
const VALUE_MIN = 0.55;
export const fontSize = (size: number): number => Math.max(MIN_PX, size * FONT_SCALE);

const NUM_OK = /^[0-9 ,.+\-/:%]*$/;
const CYR = /[Ѐ-ӿ]/;

export interface FitOpts extends TextOpts {
  /** Ширина ячейки (логические px): текст уменьшается до minPx, затем (если можно) сокращается многоточием. */
  maxW?: number;
  minPx?: number;
  /** false — не сокращать (числа, единицы, статусы): только уменьшение. */
  ellipsis?: boolean;
  /** Часть одного элемента с предыдущим текстом (метка колеса и её код, метка и значение пика): не отдельный показатель. */
  attach?: boolean;
}

/* ---------------- зонд вёрстки (тесты): панели и каждый нарисованный текст ---------------- */

export interface ProbeText {
  readonly s: string;
  readonly x: number;
  readonly y: number;
  readonly px: number;
  readonly w: number;
  readonly align: 'left' | 'center' | 'right';
  readonly maxW: number | null;
  /** Слова записи Recorder до и после text() (тест разбирает глифы этого вызова). */
  readonly n0: number;
  readonly n1: number;
  /** Поверхность, на которой нарисован (кадр страницы или кэшируемый слой G.layer). */
  readonly cv: unknown;
  /** Единица, приклеенная к предыдущему тексту (числу своего readout): зазор между ними задан явно. */
  readonly attached: boolean;
}
export interface LayoutProbe {
  readonly panels: { x: number; y: number; w: number; h: number }[];
  readonly texts: ProbeText[];
}
let probe: LayoutProbe | null = null;
export function setLayoutProbe(p: LayoutProbe | null): void {
  probe = p;
}

/* ---------------- текст ---------------- */

const lit = (o: TextOpts): TextOpts => ({ ...o, literal: true });

export function widthPx(cv: Surface, s: string, px: number, opts: TextOpts = {}): number {
  return cv.textWidth(s, px, lit(opts));
}

/** Размер (px), при котором s помещается в maxW: от px вниз, не ниже minPx (тогда может не поместиться). */
export function fitPx(cv: Surface, s: string, px: number, maxW: number, minPx: number, opts: TextOpts = {}): number {
  let size = px;
  for (let i = 0; i < 3; i++) {
    const w = widthPx(cv, s, size, opts);
    if (w <= maxW || size <= minPx) break;
    // ширина линейна по размеру, кроме разрядки (spacing × (n − 1)): ещё одна итерация её учитывает
    size = Math.max(minPx, Math.floor(((size * maxW) / w) * 4) / 4 - 0.25);
  }
  return size;
}

/** Строка, сокращённая многоточием до maxW при размере px (не короче одного символа). */
export function ellipsize(cv: Surface, s: string, px: number, maxW: number, opts: TextOpts = {}): string {
  if (widthPx(cv, s, px, opts) <= maxW) return s;
  const dots = CYR.test(s) ? '…' : '...';
  const chars = Array.from(s);
  let lo = 1;
  let hi = chars.length - 1;
  let best = chars[0] + dots;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = chars.slice(0, mid).join('').replace(/\s+$/, '') + dots;
    if (widthPx(cv, cand, px, opts) <= maxW) {
      best = cand;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Текст номинального размера size (× FONT_SCALE); с maxW — подогнан по ширине. Возвращает нарисованную ширину. */
export function text(cv: Surface, s: string, x: number, y: number, size: number, c: Color, opts: FitOpts = {}): number {
  const { maxW, minPx, ellipsis, attach, ...o } = opts;
  let px = fontSize(size);
  let str = s;
  if (maxW !== undefined && Number.isFinite(maxW)) {
    px = fitPx(cv, str, px, maxW, Math.min(px, minPx ?? FIT_MIN_PX), o);
    if (ellipsis !== false && widthPx(cv, str, px, o) > maxW + 0.01) str = ellipsize(cv, str, px, maxW, o);
  }
  return textPx(cv, str, x, y, px, c, o, maxW ?? null, !!attach);
}

/** Текст ровно размера px (уже подогнанного). */
export function textPx(cv: Surface, s: string, x: number, y: number, px: number, c: Color, o: TextOpts = {}, maxW: number | null = null, attached = false): number {
  const n0 = probe ? ((cv as unknown as { n?: number }).n ?? 0) : 0;
  const w = cv.text(s, x, y, px, c, lit(o));
  if (probe) probe.texts.push({ s, x, y, px, w: widthPx(cv, s, px, o), align: o.align ?? 'left', maxW, n0, n1: (cv as unknown as { n?: number }).n ?? 0, cv, attached });
  return w;
}

export function width(cv: Surface, s: string, size: number, opts: TextOpts = {}): number {
  return widthPx(cv, s, fontSize(size), opts);
}

/** Переносит длинные подписи по измеренной ширине; maxLines — последняя строка сокращается многоточием. */
export function wrapText(cv: Surface, s: string, size: number, maxWidth: number, opts: TextOpts = {}, maxLines = Infinity): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
    const joined = line ? `${line} ${word}` : word;
    if (width(cv, joined, size, opts) <= maxWidth) { line = joined; continue; }
    if (line) { lines.push(line); line = ''; }
    for (const char of word) {
      if (line && width(cv, line + char, size, opts) > maxWidth) { lines.push(line); line = ''; }
      line += char;
    }
  }
  if (line || !lines.length) lines.push(line);
  if (lines.length > maxLines) {
    const keep = lines.slice(0, maxLines);
    keep[maxLines - 1] = ellipsize(cv, lines.slice(maxLines - 1).join(' '), fontSize(size), maxWidth, opts);
    return keep;
  }
  return lines;
}

const numFont = (s: string): TextOpts['font'] => (NUM_OK.test(s) ? 'num' : 'label');

/** Число цифровым шрифтом, если все символы есть в атласе, иначе обычным. */
export function numText(cv: Surface, s: string, x: number, y: number, size: number, c: Color, align: TextOpts['align'] = 'left'): number {
  return text(cv, s, x, y, size, c, { font: numFont(s), align });
}
export function numWidth(cv: Surface, s: string, size: number): number {
  return width(cv, s, size, { font: numFont(s) });
}

/** Заголовок панели: прописные, разрядка, как .panel__title. */
export function caps(cv: Surface, s: string, x: number, y: number, size = 14, c: Color = C.text, align: TextOpts['align'] = 'left', maxW?: number): number {
  return text(cv, s.toUpperCase(), x, y, size, c, { spacing: 1.6, align, maxW });
}

export interface PanelOpts {
  title?: string;
  /** Цвет верхней акцентной черты (по умолчанию светло-голубой; янтарь — тормоз/внимание). */
  accent?: Color;
  /** Полная верхняя линия (карточки колёс с вмешательством тормоза). */
  topLine?: Color;
}

/** Высота заголовка панели (одна строка): содержимое панели с заголовком начинается не выше y + PANEL_TITLE_H. */
export const PANEL_TITLE_H = 40;

/** Панель: сплошной фон (совпадает с заливкой растров), короткая акцентная черта сверху слева. Заголовок — одна строка. */
export function panel(cv: Surface, x: number, y: number, w: number, h: number, opts: PanelOpts = {}): void {
  if (probe) probe.panels.push({ x, y, w, h });
  cv.fillRect(x, y, w, h, C.panel);
  if (opts.topLine) cv.fillRect(x, y, w, 3, opts.topLine);
  else cv.fillRect(x, y, 56, 3, opts.accent ?? withA(C.ice, 0.85));
  if (opts.title) caps(cv, opts.title, x + 16, y + 29, 14, C.text, 'left', w - 32);
}

export const QUALITY_TEXT: Record<Quality, string> = T.quality;

/** Текстовый статус вместо числа (StatusTag): «Нет данных», «Устарело», «Ошибка данных». Возвращает ширину рамки. */
export function statusTag(cv: Surface, q: Quality, x: number, baseY: number, size = 15, maxW = Infinity): number {
  const label = QUALITY_TEXT[q];
  const c = QUALITY_COLOR[q];
  const px = fitPx(cv, label, fontSize(size), maxW - 12, Math.min(fontSize(size), FIT_MIN_PX));
  const w = widthPx(cv, label, px) + 12;
  cv.strokeRoundRect(x, baseY - px - 2, w, px + 8, 3, 1.2, withA(typeof c === 'string' ? c : C.warn, 0.85));
  textPx(cv, label, x + 6, baseY + 1, px, c, {}, maxW - 12, true);
  return w;
}
/** Ширина рамки статуса при размере size без ограничения. */
export function statusWidth(cv: Surface, q: Quality, size = 15): number {
  return width(cv, QUALITY_TEXT[q], size) + 12;
}

export type ReadoutSize = 'xl' | 'lg' | 'md' | 'sm';
export const READOUT: Record<ReadoutSize, { value: number; unit: number; label: number }> = {
  xl: { value: 52, unit: 18, label: 15 },
  lg: { value: 40, unit: 16, label: 14 },
  md: { value: 30, unit: 15, label: 14 },
  sm: { value: 24, unit: 14, label: 13 },
};
/** Зазор между подписью и значением. */
const LABEL_GAP = 6;

export interface ReadoutOpts {
  label: string;
  shown: Shown;
  unit?: string;
  size?: ReadoutSize;
  hint?: string;
  hintColor?: Color;
  align?: 'left' | 'right';
  valueColor?: Color;
  /** Узкая парная колонка: статус под прочерком, чтобы соседние значения не пересекались. */
  statusBelow?: boolean;
  /** Ширина ячейки, логические px (всё — подпись, значение с единицей, статус, подсказка — внутри неё). */
  maxW: number;
}

/** Высота блока readout без подсказки (для раскладки страниц до рисования). */
export function readoutHeight(size: ReadoutSize, statusBelow = false): number {
  const S = READOUT[size];
  return fontSize(S.label) + LABEL_GAP + fontSize(S.value) + (statusBelow ? fontSize(Math.min(15, S.label)) + 12 : 0);
}

/**
 * Подпись + крупное значение (+ единица) + подсказка. y — верх подписи. Возвращает высоту блока.
 * Градус пишется вплотную к числу; без данных — «—» и статус, без единицы.
 */
export function readout(cv: Surface, x: number, y: number, o: ReadoutOpts): number {
  const S = READOUT[o.size ?? 'md'];
  const right = o.align === 'right';
  const maxW = o.maxW;
  const labelPx = fontSize(S.label);
  if (o.label) text(cv, o.label, x, y + labelPx * 0.92, S.label, C.dim, { align: right ? 'right' : 'left', maxW });
  const valuePx = fontSize(S.value);
  const base = y + labelPx + LABEL_GAP + valuePx * 0.82;
  let h = labelPx + LABEL_GAP + valuePx;
  if (o.shown.ok) {
    const tight = o.unit === T.units.deg;
    const unit = o.unit ? (tight ? o.unit : ` ${o.unit}`) : '';
    const font = numFont(o.shown.text);
    let vPx = valuePx;
    let uPx = tight ? valuePx * 0.8 : fontSize(S.unit);
    const nw = widthPx(cv, o.shown.text, vPx, { font });
    const uw = unit ? widthPx(cv, unit, uPx) : 0;
    const gap = unit ? (tight ? 1 : 3) : 0;
    if (nw + gap + uw > maxW) {
      // уменьшаются оба, единица — не ниже FIT_MIN_PX, число — не ниже VALUE_MIN своего размера
      const k = Math.max(VALUE_MIN, (maxW - gap) / (nw + uw));
      vPx = Math.max(valuePx * VALUE_MIN, vPx * k);
      uPx = tight ? vPx * 0.8 : Math.max(Math.min(uPx, FIT_MIN_PX), uPx * k);
      const nw2 = widthPx(cv, o.shown.text, vPx, { font });
      const uw2 = unit ? widthPx(cv, unit, uPx) : 0;
      if (nw2 + gap + uw2 > maxW) vPx = Math.max(valuePx * VALUE_MIN, vPx * ((maxW - gap - uw2) / nw2));
    }
    const nw3 = widthPx(cv, o.shown.text, vPx, { font });
    const uw3 = unit ? widthPx(cv, unit, uPx) : 0;
    const x0 = right ? x - nw3 - gap - uw3 : x;
    textPx(cv, o.shown.text, x0, base, vPx, o.valueColor ?? C.text, { font }, maxW);
    if (unit) textPx(cv, unit, x0 + nw3 + gap, base, uPx, tight ? (o.valueColor ?? C.text) : C.dim, {}, maxW, true);
  } else {
    const dashPx = valuePx * 0.8;
    const dw = widthPx(cv, '—', dashPx);
    const tagSize = Math.min(15, S.label);
    const tagW = statusWidth(cv, o.shown.quality, tagSize);
    const below = o.statusBelow || dw + 10 + tagW > maxW;
    const x0 = right ? x - dw - (below ? 0 : 10 + tagW) : x;
    textPx(cv, '—', x0, base, dashPx, C.dim);
    if (below) {
      const tw = Math.min(tagW, maxW);
      const by = base + fontSize(tagSize) + 8;
      statusTag(cv, o.shown.quality, right ? x - tw : x, by, tagSize, maxW);
      h += fontSize(tagSize) + 12;
    } else statusTag(cv, o.shown.quality, x0 + dw + 10, base - valuePx * 0.16, tagSize, maxW - dw - 10);
  }
  if (o.hint) {
    text(cv, o.hint, x, y + h + fontSize(13), 13, o.hintColor ?? C.dim, { align: right ? 'right' : 'left', maxW });
    h += fontSize(13) + 6;
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
export function chip(cv: Surface, label: string, x: number, baseY: number, c: Color = C.warn, maxW = Infinity): number {
  const px = fitPx(cv, label, fontSize(13), maxW - 12, FIT_MIN_PX);
  const w = widthPx(cv, label, px) + 12;
  cv.strokeRoundRect(x, baseY - px - 1, w, px + 7, 3, 1.2, c);
  textPx(cv, label, x + 6, baseY + 1, px, c, {}, maxW - 12, true);
  return w;
}

/** Разделитель внутри панели. */
export function hline(cv: Surface, x: number, y: number, w: number): void {
  cv.fillRect(x, y, w, 1, C.hair);
}
