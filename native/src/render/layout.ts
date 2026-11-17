// Сетка страниц на логическом холсте 1600 × 520 (ctx.canvas). Шапка с вкладками — в заголовке HMI
// (G.frame), содержимое страниц — между Y0 и Y1, ниже — полоса статуса/демо-управления, как в браузере.
// На центральном экране 1920 × 720 kit масштабирует страницу примерно в 1,17 раза.

export const W = 1600;
export const H = 520;
export const M = 12;
export const GAP = 8;
export const Y0 = 50;
export const Y1 = 466;
export const BAR_Y = 472;
export const BAR_H = 38;

/** Запас разрешения растров относительно логических пикселей (≈ масштаб kit на 1920 × 720). */
export const TEX_SCALE = 1.25;

/** Рельеф: колонка приборов, сцена привода, правая колонка, нижняя полоса. */
export const TERRAIN = {
  dials: { x: M, w: 392 },
  stage: { x: M + 392 + GAP, y: Y0, w: 780, h: 322 },
  side: { x: W - M - 392, w: 392 },
  strip: { y: Y0 + 322 + GAP, h: Y1 - (Y0 + 322 + GAP) },
} as const;

/** Прибор тангажа/крена: радиус ободка (логические px) — от него считаются все размеры. */
export const DIAL_R = 92;

/** Сцена привода: высота рендера на «Рельефе» и на «Сцеплении». */
export const XRAY_H_TERRAIN = TERRAIN.stage.h - 4;
export const XRAY_H_TRACTION = 300;

/** Схема сверху: «Подвеска» (крупно) и «Системы» (в панели шин). */
export const TOPDOWN_H_SUSPENSION = 362;
export const TOPDOWN_H_SYSTEMS = 236;

/** Камеры: основной вид и миниатюры, 16:9. */
export const CAMERA_MAIN = { w: 636, h: 358 } as const;
export const CAMERA_THUMB = { w: 267, h: 150 } as const;
