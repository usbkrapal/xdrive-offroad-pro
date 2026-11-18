// Какие растры собираются в assets.js и в каком размере. Размеры выводятся из сетки страниц
// (render/layout.ts) × TEX_SCALE, чтобы текстура совпадала с размером на экране 1920 × 720.

import { C } from '../render/palette';
import { CAMERA_MAIN, DIAL_R, TEX_SCALE, TOPDOWN_H_SUSPENSION, TOPDOWN_H_SYSTEMS, XRAY_H_TERRAIN } from '../render/layout';

export type AssetKey = 'xray' | 'topdownLarge' | 'topdownSmall' | 'pitchSprite' | 'rollSprite' | 'cameraFront' | 'cameraLeft' | 'cameraRight';

export interface AssetSpec {
  readonly key: AssetKey;
  /** Файл в src/assets (тот же, что использует браузер). */
  readonly file: string;
  /** Ожидаемый размер исходника: сборка падает, если PNG заменили другим. */
  readonly srcW: number;
  readonly srcH: number;
  readonly w: number;
  readonly h: number;
  /** null — сохраняется альфа (спрайты прибора компонуются на CPU); иначе заливка этим цветом. */
  readonly flattenOn: string | null;
}

/** Масштаб прибора: единицы SVG AttitudeDial (ободок 148) → логические px. */
export const DIAL_K = DIAL_R / 148;

const fit = (srcW: number, srcH: number, h: number) => ({ w: Math.round((h * srcW) / srcH), h });
const xray = fit(1122, 1402, Math.round(XRAY_H_TERRAIN * TEX_SCALE));
const topL = fit(887, 1774, Math.round(TOPDOWN_H_SUSPENSION * TEX_SCALE));
const topS = fit(887, 1774, Math.round(TOPDOWN_H_SYSTEMS * TEX_SCALE));
// Спрайты в пропорциях PNG, ширина как в AttitudeDial (195 и 164 единиц из 148).
const pitchW = Math.round(195 * DIAL_K * TEX_SCALE);
const rollW = Math.round(164 * DIAL_K * TEX_SCALE);
// Демо-снимки камер — только для демо разработчика (XOP_DEV=demo): ширина текстуры прежняя (0.1.1, 792), а не по
// выросшему кадру передней камеры — пакет не растёт ради демо; на экране кадр слегка растягивается.
const camW = Math.min(792, Math.round((CAMERA_MAIN.w * TEX_SCALE) / 8) * 8);
const cam = { w: camW, h: Math.round((camW * 941) / 1672) };

export const ASSETS: readonly AssetSpec[] = [
  { key: 'xray', file: 'xray-drivetrain.png', srcW: 1122, srcH: 1402, ...xray, flattenOn: C.bg },
  { key: 'topdownLarge', file: 'topdown-schematic-v2.png', srcW: 887, srcH: 1774, ...topL, flattenOn: C.bg },
  { key: 'topdownSmall', file: 'topdown-schematic-v2.png', srcW: 887, srcH: 1774, ...topS, flattenOn: C.panel },
  { key: 'pitchSprite', file: 'pitch-side-v2.png', srcW: 2172, srcH: 724, w: pitchW, h: Math.round((pitchW * 724) / 2172), flattenOn: null },
  { key: 'rollSprite', file: 'roll-rear-v2.png', srcW: 1448, srcH: 1086, w: rollW, h: Math.round((rollW * 1086) / 1448), flattenOn: null },
  { key: 'cameraFront', file: 'camera-front-demo.png', srcW: 1672, srcH: 941, ...cam, flattenOn: C.bg },
  { key: 'cameraLeft', file: 'camera-left-demo.png', srcW: 1672, srcH: 941, ...cam, flattenOn: C.bg },
  { key: 'cameraRight', file: 'camera-right-demo.png', srcW: 1672, srcH: 941, ...cam, flattenOn: C.bg },
];

/** Формат модуля assets.js (CommonJS, генерируется native/scripts/build.ts). */
export interface AssetsModule {
  readonly format: 'xop-assets/1';
  readonly images: Readonly<Record<AssetKey, import('./codec').EmbeddedImage>>;
}

/**
 * Постоянные id картинок record.setImage (uint32; общий реестр процесса). Один id на ресурс,
 * никаких новых id на кадр: повёрнутые циферблаты перезаписывают свой id.
 */
export const IMAGE_ID = {
  xray: 0x584f5001,
  topdownLarge: 0x584f5002,
  topdownSmall: 0x584f5003,
  dialPitch: 0x584f5010,
  dialRoll: 0x584f5011,
  cameraFront: 0x584f5020,
  cameraLeft: 0x584f5021,
  cameraRight: 0x584f5022,
  thumbFront: 0x584f5030,
  thumbLeft: 0x584f5031,
  thumbRight: 0x584f5032,
} as const;
