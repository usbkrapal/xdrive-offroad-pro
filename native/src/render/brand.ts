// Бренд как в веб-версии (src/components/Header.tsx: MStripe + header__titles; src/styles.css .mstripe):
// три наклонные полосы ice / m-blue / m-red (skewX −20°) и две строки — «Terrain Monitor» (заголовок) и
// «xDrive Offroad Pro» (подзаголовок, src/i18n/ru.ts app.title / app.subtitle). Те же полосы — иконка приложения
// (native/scripts/icon.ts).

import type { Color, Surface, Theme } from '../platform/kitTypes';
import { T } from '../strings';
import { C } from './palette';

/** Цвета полос в порядке веба (.mstripe i, i:nth-child(2), i:nth-child(3)). */
export const STRIPE_COLORS: readonly Color[] = [C.ice, C.mBlue, C.mRed];
/** tan(20°): наклон skewX(-20deg). */
const SKEW = Math.tan((20 * Math.PI) / 180);

/**
 * Три наклонные полосы в рамке (x, y) — (x + stripeWidth(h, bw, gap), y + h). Пропорции веба: полоса 9 × 22,
 * зазор 3 — масштабируются через h и bw.
 */
export function drawStripe(cv: Surface, x: number, y: number, h: number, bw: number, gap: number): void {
  const off = h * SKEW;
  STRIPE_COLORS.forEach((c, i) => {
    const bx = x + i * (bw + gap);
    // skewX(-20deg): верх сдвинут вправо относительно низа
    cv.quad(
      [
        [bx + off, y],
        [bx + off + bw, y],
        [bx + bw, y + h],
        [bx, y + h],
      ],
      c,
    );
  });
}
export const stripeWidth = (h: number, bw: number, gap: number) => 3 * bw + 2 * gap + h * SKEW;

/** Шапка kit (display.brand): полосы + две строки. Ширина измеряется по настоящему шрифту kit. */
export interface HeaderBrand {
  width(c: Surface): number;
  draw(c: Surface, x: number, y: number, w: number, h: number, theme: Theme): void;
}

const PAD = 18;
const BAR_H = 34;
const BAR_W = 13;
const BAR_GAP = 4;
const TEXT_GAP = 14;
const TITLE_SIZE = 34.5;
const SUB_SIZE = 22.08;
const END = 14;
const TITLE_OPTS = { font: 'bold' as const, spacing: 0.4, literal: true };
const SUB_OPTS = { spacing: 0.6, literal: true };

export const HEADER_BRAND: HeaderBrand = {
  width(c) {
    const tw = Math.max(c.textWidth(T.app.title, TITLE_SIZE, TITLE_OPTS), c.textWidth(T.app.subtitle, SUB_SIZE, SUB_OPTS));
    return Math.ceil(PAD + stripeWidth(BAR_H, BAR_W, BAR_GAP) + TEXT_GAP + tw + END);
  },
  draw(c, x, y, _w, h) {
    const cy = y + h / 2;
    drawStripe(c, x + PAD, cy - BAR_H / 2, BAR_H, BAR_W, BAR_GAP);
    const tx = x + PAD + stripeWidth(BAR_H, BAR_W, BAR_GAP) + TEXT_GAP;
    // две строки внутри 80 px шапки: заголовок над серединой, подзаголовок под ней
    c.text(T.app.title, tx, cy - 3, TITLE_SIZE, C.text, TITLE_OPTS);
    c.text(T.app.subtitle, tx, cy + 23, SUB_SIZE, C.dim, SUB_OPTS);
  },
};

/**
 * Запасной путь (программная отрисовка, стандартная раскладка): kit рисует вкладки полосой 36 px внутри страницы
 * (G.frame без cv.chrome). Бренд — между вкладками и бейджами (бейджи kit: справа от W − 16). Возвращает x бренда
 * или null, если места нет (тогда имя остаётся в заголовке HMI над страницей).
 */
export function drawPageBrand(cv: Surface, tabRects: readonly { x: number; w: number }[] | null | undefined, badges: readonly { text: string }[], pageW: number): number | null {
  const bopt = { font: 'bold' as const, spacing: 1.5, literal: true };
  // ширина ряда бейджей как в gauges.js badgeRow (h 24, size 18)
  const badgesW = badges.reduce((a, b) => a + Math.max(24 * 2.2, cv.textWidth(b.text, 24.84, bopt) + 24) + 24 * 0.4, 0);
  const tabsEnd = (tabRects || []).reduce((m, q) => Math.max(m, q.x + q.w), 0);
  const tOpts = { font: 'bold' as const, spacing: 0.3, literal: true };
  const sOpts = { spacing: 0.4, literal: true };
  const bh = 32;
  const sw = stripeWidth(bh, 8, 3);
  const bw = sw + 10 + Math.max(cv.textWidth(T.app.title, 22.08, tOpts), cv.textWidth(T.app.subtitle, 18.4, sOpts));
  const x = pageW - 16 - badgesW - 16 - bw;
  if (x < tabsEnd + 16) return null;
  drawStripe(cv, x, 2, bh, 8, 3);
  cv.text(T.app.title, x + sw + 10, 19, 22.08, C.text, tOpts);
  cv.text(T.app.subtitle, x + sw + 10, 35, 18.4, C.dim, sOpts);
  return x;
}
