// Растры во время работы: распаковка по первому требованию, один постоянный id record.setImage
// на картинку, без кэша «на кадр». Миниатюры камер считаются один раз из основного кадра.
// Демо-снимки камер распаковываются только когда их реально показывают (демо + экран «Камеры»).

import type { Rgba } from './codec';
import { decodeEmbedded, resizeArea } from './codec';
import { IMAGE_ID, type AssetKey, type AssetsModule } from './spec';
import { CAMERA_THUMB, TEX_SCALE } from '../render/layout';

export type CameraKey = 'cameraFront' | 'cameraLeft' | 'cameraRight';
const THUMB_ID: Record<CameraKey, number> = { cameraFront: IMAGE_ID.thumbFront, cameraLeft: IMAGE_ID.thumbLeft, cameraRight: IMAGE_ID.thumbRight };
type Uploadable = 'xray' | 'topdownLarge' | 'topdownSmall' | CameraKey;

export interface Uploaded {
  readonly id: number;
  readonly w: number;
  readonly h: number;
}

export class ImageRegistry {
  private readonly decoded = new Map<AssetKey, Rgba>();
  private readonly uploaded = new Map<number, Uploaded>();
  private readonly failed = new Set<string>();

  constructor(
    private readonly assets: AssetsModule | null,
    private readonly setImage: (id: number, w: number, h: number, rgba: Uint8Array) => unknown,
    private readonly log?: { warn(...a: unknown[]): void },
  ) {
    if (assets && assets.format !== 'xop-assets/1') throw new Error(`assets.js: unknown format ${String(assets.format)}`);
  }

  /** Распакованный растр (спрайты прибора компонуются на CPU и не загружаются как есть). */
  raw(key: AssetKey): Rgba | null {
    const hit = this.decoded.get(key);
    if (hit) return hit;
    if (this.failed.has(key)) return null;
    const e = this.assets && this.assets.images[key];
    if (!e) {
      this.fail(key, 'missing in assets.js');
      return null;
    }
    try {
      const img = decodeEmbedded(e);
      this.decoded.set(key, img);
      return img;
    } catch (err) {
      this.fail(key, String(err));
      return null;
    }
  }

  /** Загрузить картинку под её постоянным id (один раз). null — ресурса нет (рисуется заглушка). */
  image(key: Uploadable): Uploaded | null {
    const id = IMAGE_ID[key];
    const up = this.uploaded.get(id);
    if (up) return up;
    const img = this.raw(key);
    if (!img) return null;
    this.setImage(id, img.w, img.h, img.data);
    const u = { id, w: img.w, h: img.h };
    this.uploaded.set(id, u);
    return u;
  }

  /** Миниатюра камеры: усреднение основного кадра до размера миниатюры, один раз. */
  thumb(key: CameraKey): Uploaded | null {
    const id = THUMB_ID[key];
    const up = this.uploaded.get(id);
    if (up) return up;
    const img = this.raw(key);
    if (!img) return null;
    const tw = Math.min(img.w, Math.round(CAMERA_THUMB.w * TEX_SCALE));
    const th = Math.min(img.h, Math.round((tw * img.h) / img.w));
    const small = tw === img.w ? img : resizeArea(img, tw, th);
    this.setImage(id, small.w, small.h, small.data);
    const u = { id, w: small.w, h: small.h };
    this.uploaded.set(id, u);
    return u;
  }

  /** Сколько растров распаковано и сколько id загружено (для тестов ограниченности памяти). */
  stats(): { decoded: number; uploaded: number } {
    return { decoded: this.decoded.size, uploaded: this.uploaded.size };
  }

  private fail(key: string, why: string): void {
    this.failed.add(key);
    if (this.log) this.log.warn(`asset ${key}: ${why}`);
  }
}
