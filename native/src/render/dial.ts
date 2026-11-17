// Круглый прибор тангажа/крена (как AttitudeDial браузера, «oldv2»): геометрия в единицах SVG
// (ободок 148, циферблат 121, риски до 118, цифры на 135), масштаб DIAL_K → логические px.
//
// Ограничение рантайма: у kit нет поворота картинок (xf — только масштаб/сдвиг), а программный
// drawImage рисует растр непрозрачным. Поэтому циферблат (радиальный градиент + горизонт +
// повёрнутая машина + блик стекла) растеризуется на CPU в одну квадратную текстуру с
// постоянным id. Вне круга циферблата текстура залита цветом панели, а ободок, риски, цифры,
// дуга значения, ось и указатель рисуются векторами поверх. Перерисовка текстуры — только при
// изменении угла ≥ 0,2° и не чаще ~12 раз/с; два чередующихся буфера, без роста памяти.

import type { Surface } from '../platform/kitTypes';
import { DIAL_K } from '../assets/spec';
import type { Rgba } from '../assets/codec';
import { hexRgb } from '../assets/codec';
import { TEX_SCALE } from './layout';
import { C, withA } from './palette';
import { text } from './ui';

export type DialKind = 'pitch' | 'roll';

export const BEZEL = 148;
export const FACE = 121;
const R = 118;
const R_NUM = 135;
export const ARC_SPAN = 45;
const TICK_STEP = 5;
const LABELED = [-40, -20, 0, 20, 40];
/** Размер спрайта в единицах SVG (как SPRITE в AttitudeDial). */
export const SPRITE_UNITS = { pitch: { w: 195, h: 65 }, roll: { w: 164, h: 123 } } as const;

/** Сторона текстуры циферблата, px. */
export const FACE_TEX = Math.round(2 * FACE * DIAL_K * TEX_SCALE);
const MIN_STEP_DEG = 0.2;
const MIN_INTERVAL_MS = 80;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function grad(stops: readonly (readonly [number, readonly number[]])[], t: number): readonly number[] {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const k = (t - a[0]) / (b[0] - a[0]);
      return [lerp(a[1][0], b[1][0], k), lerp(a[1][1], b[1][1], k), lerp(a[1][2], b[1][2], k)];
    }
  }
  return stops[stops.length - 1][1];
}
const FACE_STOPS = [
  [0, hexRgb('#16202c')],
  [0.7, hexRgb('#0a0f15')],
  [1, hexRgb('#040609')],
] as const;

/** Угол поворота машины (градусы, по часовой — как SVG rotate) из значения прибора. */
export function vehicleRotation(kind: DialKind, value: number | null): number {
  const shown = value === null ? 0 : Math.max(-ARC_SPAN, Math.min(ARC_SPAN, value));
  return kind === 'pitch' ? -shown : shown;
}

/**
 * Растеризация циферблата с повёрнутым спрайтом в out (S × S RGBA, непрозрачно).
 * Чистая функция — проверяется тестами без рантайма.
 */
export function rasterFace(out: Uint8Array, S: number, sprite: Rgba, spriteUnits: { w: number; h: number }, rotDeg: number, spriteAlpha: number, bg: readonly number[]): void {
  const th = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const unitPx = (2 * FACE) / S;
  const sx = sprite.w / spriteUnits.w;
  const sy = sprite.h / spriteUnits.h;
  const sd = sprite.data;
  const glassTop = hexRgb('#cfe6ff');
  const horizon = hexRgb('#81c4ff');
  for (let py = 0; py < S; py++) {
    const vy = (py + 0.5) * unitPx - FACE;
    for (let px = 0; px < S; px++) {
      const vx = (px + 0.5) * unitPx - FACE;
      const o = (py * S + px) * 4;
      const rr = Math.sqrt(vx * vx + vy * vy);
      if (rr > FACE + unitPx) {
        out[o] = bg[0];
        out[o + 1] = bg[1];
        out[o + 2] = bg[2];
        out[o + 3] = 255;
        continue;
      }
      // Циферблат: радиальный градиент с центром (0.5, 0.42) и радиусом 0.6 от рамки круга.
      const gy = vy + 0.16 * FACE;
      const f = grad(FACE_STOPS, Math.sqrt(vx * vx + gy * gy) / (1.2 * FACE));
      let r = f[0];
      let g = f[1];
      let b = f[2];
      // Неподвижный горизонт под машиной.
      if (Math.abs(vx) <= FACE - 4) {
        // Линия 0,8 единицы SVG: покрытие пикселя по расстоянию до оси в пикселях.
        const cov = Math.max(0, Math.min(1, (0.4 + 0.5 * unitPx - Math.abs(vy)) / unitPx)) * 0.32;
        if (cov > 0) {
          r = lerp(r, horizon[0], cov);
          g = lerp(g, horizon[1], cov);
          b = lerp(b, horizon[2], cov);
        }
      }
      // Машина: обратный поворот в координаты спрайта, билинейная выборка с альфой.
      const ux = vx * cos + vy * sin + spriteUnits.w / 2;
      const uy = -vx * sin + vy * cos + spriteUnits.h / 2;
      if (ux > -1 && uy > -1 && ux < spriteUnits.w + 1 && uy < spriteUnits.h + 1) {
        const fx = ux * sx - 0.5;
        const fy = uy * sy - 0.5;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const ax = fx - x0;
        const ay = fy - y0;
        let ar = 0;
        let ag = 0;
        let ab = 0;
        let aa = 0;
        for (let k = 0; k < 4; k++) {
          const xx = x0 + (k & 1);
          const yy = y0 + (k >> 1);
          if (xx < 0 || yy < 0 || xx >= sprite.w || yy >= sprite.h) continue;
          const wgt = (k & 1 ? ax : 1 - ax) * (k >> 1 ? ay : 1 - ay);
          const i = (yy * sprite.w + xx) * 4;
          const al = (sd[i + 3] / 255) * wgt;
          ar += sd[i] * al;
          ag += sd[i + 1] * al;
          ab += sd[i + 2] * al;
          aa += al;
        }
        if (aa > 0) {
          const k = aa * spriteAlpha;
          r = lerp(r, ar / aa, k);
          g = lerp(g, ag / aa, k);
          b = lerp(b, ab / aa, k);
        }
      }
      // Блик стекла: сверху 9 %, к середине 0.
      const gt = (vy + FACE) / (2 * FACE);
      if (gt < 0.5) {
        const k = 0.09 * (1 - gt / 0.5);
        r = lerp(r, glassTop[0], k);
        g = lerp(g, glassTop[1], k);
        b = lerp(b, glassTop[2], k);
      }
      // Мягкий край круга (ободок поверх закроет остаток).
      const edge = Math.max(0, Math.min(1, (FACE - rr) / unitPx + 0.5));
      out[o] = Math.round(lerp(bg[0], r, edge));
      out[o + 1] = Math.round(lerp(bg[1], g, edge));
      out[o + 2] = Math.round(lerp(bg[2], b, edge));
      out[o + 3] = 255;
    }
  }
}

export type SetImage = (id: number, w: number, h: number, rgba: Uint8Array) => unknown;

/** Кэш текстуры одного прибора: один id, два буфера, ограниченная частота перерисовки. */
export class DialTexture {
  private readonly bufs: [Uint8Array, Uint8Array];
  private flip = 0;
  private lastRot = Number.NaN;
  private lastAlpha = Number.NaN;
  private lastAt = -Infinity;
  /** Сколько раз текстура реально перерисована (для тестов/логов). */
  renders = 0;

  constructor(
    readonly kind: DialKind,
    readonly id: number,
    private readonly sprite: Rgba,
    private readonly setImage: SetImage,
    private readonly bg: readonly number[] = hexRgb(C.panel),
  ) {
    const n = FACE_TEX * FACE_TEX * 4;
    this.bufs = [new Uint8Array(n), new Uint8Array(n)];
  }

  /** Обновить при необходимости. force — первый кадр/смена данных (без ограничения частоты). */
  update(rotDeg: number, spriteAlpha: number, nowMs: number, force = false): boolean {
    const changed = !(Math.abs(rotDeg - this.lastRot) < MIN_STEP_DEG) || spriteAlpha !== this.lastAlpha;
    if (!changed) return false;
    if (!force && Number.isFinite(this.lastRot) && nowMs - this.lastAt < MIN_INTERVAL_MS) return false;
    this.flip ^= 1;
    const buf = this.bufs[this.flip];
    rasterFace(buf, FACE_TEX, this.sprite, SPRITE_UNITS[this.kind], rotDeg, spriteAlpha, this.bg);
    this.setImage(this.id, FACE_TEX, FACE_TEX, buf);
    this.lastRot = rotDeg;
    this.lastAlpha = spriteAlpha;
    this.lastAt = nowMs;
    this.renders++;
    return true;
  }
}

/* ---------------- векторная часть ---------------- */

/** Точка шкалы (единицы SVG, y вниз). pitch: шкала справа, + вверх; roll: шкала сверху, + вправо. */
function polar(kind: DialKind, a: number, r: number): [number, number] {
  const rad = kind === 'pitch' ? (-a * Math.PI) / 180 : ((a - 90) * Math.PI) / 180;
  return [r * Math.cos(rad), r * Math.sin(rad)];
}
/** Угол kit (по часовой от 12 часов) для угла шкалы a. */
const kitAngle = (kind: DialKind, a: number, mirror = false) => {
  const k = kind === 'pitch' ? 90 - a : a;
  return mirror ? 360 - k : k;
};
const ring = (cv: Surface, cx: number, cy: number, r: number, w: number, c: string) => cv.arc(cx, cy, r - w / 2, r + w / 2, 0, 360, c);

const formatScale = (a: number) => (a === 0 ? '0' : a > 0 ? `+${a}` : `${a}`);

/** Статичная часть (ободок, кольца, риски, цифры), рисуется в слой w × w с центром посередине. */
export function drawDialStatic(cv: Surface, kind: DialKind, size: number): void {
  const k = DIAL_K;
  const c = size / 2;
  const P = (x: number, y: number): [number, number] => [c + x * k, c + y * k];
  // Ободок: вертикальный градиент SVG приближён угловым (сверху светлее, снизу темнее).
  const bez = ['#3a4654', '#18202a', '#090c11'];
  cv.arc(c, c, FACE * k, BEZEL * k, 0, 180, '#18202a', { ramp: bez, rampFrom: 0, rampTo: 180 });
  cv.arc(c, c, FACE * k, BEZEL * k, 180, 360, '#18202a', { ramp: bez.slice().reverse(), rampFrom: 180, rampTo: 360 });
  ring(cv, c, c, BEZEL * k - 0.5, 1, withA('#bedcfa', 0.22));
  ring(cv, c, c, (BEZEL - 4) * k, 1.5 * k, withA('#000000', 0.55));
  ring(cv, c, c, (FACE + 2) * k, 1, withA('#bedcfa', 0.2));
  ring(cv, c, c, FACE * k, 1.5, withA('#000000', 0.8));
  ring(cv, c, c, R * k, 1, withA('#f4f7fb', 0.1));
  const sides = kind === 'pitch' ? [false, true] : [false];
  for (const mirror of sides) {
    for (let a = -ARC_SPAN; a <= ARC_SPAN; a += TICK_STEP) {
      const zero = a === 0;
      const major = a % 20 === 0;
      const r1 = zero ? R - 16 : major ? R - 13 : R - 8;
      const r2 = zero ? FACE + 1 : R;
      const p1 = polar(kind, a, r1);
      const p2 = polar(kind, a, r2);
      const m = mirror ? -1 : 1;
      const A = P(p1[0] * m, p1[1]);
      const B = P(p2[0] * m, p2[1]);
      const col = zero ? C.text : major ? withA('#f4f7fb', 0.7) : withA('#f4f7fb', 0.32);
      cv.line(A[0], A[1], B[0], B[1], zero ? 2 : major ? 1.4 : 1, col);
    }
  }
  for (const a of LABELED) {
    const p = polar(kind, a, R_NUM);
    const q = P(p[0], p[1]);
    text(cv, formatScale(a), q[0], q[1] + 4.5, 13, a === 0 ? C.text : C.dim, { align: 'center', font: 'label' });
  }
}

/** Динамика поверх текстуры: дуга значения, оси и указатель вращаются вместе с машиной. */
export function drawDialLive(cv: Surface, kind: DialKind, cx: number, cy: number, value: number | null): void {
  const k = DIAL_K;
  if (value === null) return;
  const shown = Math.max(-ARC_SPAN, Math.min(ARC_SPAN, value));
  const mag = Math.abs(shown);
  if (mag > 0.05) {
    const a0 = kitAngle(kind, 0);
    const a1 = kitAngle(kind, shown);
    cv.arc(cx, cy, (R - 1.75) * k, (R + 1.75) * k, Math.min(a0, a1), Math.max(a0, a1), C.cold, { round: true });
  }
  const rot = (vehicleRotation(kind, value) * Math.PI) / 180;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const T = (x: number, y: number): [number, number] => [cx + (x * cs - y * sn) * k, cy + (x * sn + y * cs) * k];
  const g = SPRITE_UNITS[kind];
  const tipR = R + 1;
  const baseR = R - 12;
  if (kind === 'pitch') {
    for (const s of [1, -1]) {
      const a = T(s * (g.w / 2 + 2), 0);
      const b = T(s * baseR, 0);
      cv.line(a[0], a[1], b[0], b[1], 1.2, C.ice);
    }
    const tri = [T(tipR, 0), T(baseR, -5.5), T(baseR, 5.5)];
    cv.fill(tri, '#eaf7ff');
    cv.polyline([tri[0], tri[1], tri[2], tri[0]], 1, C.cold);
  } else {
    const a = T(0, -g.h / 2 - 2);
    const b = T(0, -baseR);
    cv.line(a[0], a[1], b[0], b[1], 1.2, C.ice);
    const tri = [T(0, -tipR), T(-5.5, -baseR), T(5.5, -baseR)];
    cv.fill(tri, '#eaf7ff');
    cv.polyline([tri[0], tri[1], tri[2], tri[0]], 1, C.cold);
  }
}
