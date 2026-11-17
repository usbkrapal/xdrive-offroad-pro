// icon.png приложения (плитка HMI 140 × 140; build.py берёт apps/<id>/icon.png вместо make_icon.js).
// Выбранный пользователем знак (горы + компас) — src/assets/app-icon-terrain.png, без правок и кадрирования:
// decodePng → resizeArea (усреднение по площади) до 140 × 140 → пиксели в Canvas вендорного MIT kit/runtime
// и его png(). Строится один раз при сборке; в рантайме и в assets.js исходник не участвует.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { decodePng, resizeArea, type Rgba } from '../src/assets/codec';
import { ROOT } from './bundle';

export const ICON_FILE = 'icon.png';
export const ICON_SIZE = 140;
export const ICON_SOURCE = join(ROOT, 'src', 'assets', 'app-icon-terrain.png');
const RUNTIME = join(ROOT, 'vendor', 'idrive7-apps', 'kit', 'runtime');

interface KitCanvas {
  readonly w: number;
  readonly h: number;
  readonly d: Uint8Array;
  png(level?: number): Buffer;
}

/** Исходник иконки → RGBA 140 × 140. Нет файла / не PNG / битый / не квадрат — понятная ошибка. */
export function iconPixels(source: string = ICON_SOURCE): Rgba {
  let buf: Buffer;
  try {
    buf = readFileSync(source);
  } catch (e) {
    throw new Error(`icon: source ${source} is unavailable: ${(e as Error).message}`);
  }
  let img: Rgba;
  try {
    img = decodePng(buf);
  } catch (e) {
    throw new Error(`icon: source ${source} is not a usable PNG: ${(e as Error).message}`);
  }
  if (img.w !== img.h || img.w < ICON_SIZE) throw new Error(`icon: source ${source} is ${img.w}x${img.h}; need a square ≥ ${ICON_SIZE}`);
  return resizeArea(img, ICON_SIZE, ICON_SIZE);
}

export function renderIcon(source: string = ICON_SOURCE, runtime: string = RUNTIME): Buffer {
  const px = iconPixels(source);
  const req = createRequire(join(runtime, 'canvas.js'));
  const { Canvas } = req('./canvas.js') as { Canvas: new (w: number, h: number) => KitCanvas };
  const cv = new Canvas(ICON_SIZE, ICON_SIZE);
  if (cv.w !== px.w || cv.h !== px.h || !(cv.d instanceof Uint8Array) || cv.d.length !== px.data.length) {
    throw new Error('icon: kit Canvas pixel buffer is not w × h × 4 RGBA');
  }
  cv.d.set(px.data);
  return cv.png(9);
}
