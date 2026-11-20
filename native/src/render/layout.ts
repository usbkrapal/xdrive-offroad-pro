// Сетка страниц на логическом холсте 1600 × 520 (ctx.canvas). Шапка с вкладками — в заголовке HMI
// (G.frame), содержимое страниц — между Y0 и Y1 до низа холста (нижней строки статуса нет).
// На центральном экране 1920 × 720 kit масштабирует страницу примерно в 1,17 раза.

export const W = 1600;
export const H = 520;
export const M = 12;
export const GAP = 8;
export const Y0 = 50;
export const Y1 = H - 6;

/** Запас разрешения растров относительно логических пикселей (≈ масштаб kit на 1920 × 720). */
export const TEX_SCALE = 1.25;

/** Рельеф: колонка приборов, сцена привода, правая колонка — на всю высоту (нижней полосы нет). */
const STAGE_H = Y1 - Y0;
export const TERRAIN = {
  dials: { x: M, w: 392 },
  stage: { x: M + 392 + GAP, y: Y0, w: 780, h: STAGE_H },
  side: { x: W - M - 392, w: 392 },
} as const;

/** Прибор тангажа/крена: радиус ободка (логические px) — от него считаются все размеры. */
export const DIAL_R = 92;

/** Сцена привода: высота рендера на «Рельефе» и на «Сцеплении». */
export const XRAY_H_TERRAIN = TERRAIN.stage.h - 30;
export const XRAY_H_TRACTION = 300;

/** Схема сверху: «Подвеска» (крупно) и «Системы» (в панели шин). */
export const TOPDOWN_H_SUSPENSION = 362;
export const TOPDOWN_H_SYSTEMS = 236;

/**
 * Камеры в ряд, как стоят на машине: левая — передняя (крупно, по центру) — правая, 16:9. Подпись над кадром.
 * Ширины: 2 × (боковая + 32) + (передняя + 32) + 2 × GAP = W − 2M.
 */
export const CAMERA_LABEL_H = 34;
export const CAMERA_MAIN = { w: 722, h: 406 } as const;
export const CAMERA_THUMB = { w: 371, h: 209 } as const;
