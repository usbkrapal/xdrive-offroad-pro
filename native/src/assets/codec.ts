// Растровые ресурсы без сторонних зависимостей: только zlib из Node (есть и в Node 8 на MGU).
// Сборка: исходный PNG проекта → RGBA → уменьшение → (заливка фона) → строки с PNG-фильтрами → deflate.
// Рантайм: inflate → снятие фильтров → RGBA для record.setImage. Генеративных изменений нет:
// только масштабирование (усреднение по площади) и заливка известным фоном.

import * as zlib from 'zlib';

export interface Rgba {
  readonly w: number;
  readonly h: number;
  /** w × h × 4 байт, без премультипликации. */
  readonly data: Uint8Array;
}

/** Сжатый ресурс внутри assets.js. ch = 3 (непрозрачный, альфа восстанавливается 255) или 4. */
export interface EmbeddedImage {
  readonly w: number;
  readonly h: number;
  readonly ch: 3 | 4;
  /** base64(deflate(строки с байтом фильтра PNG)). */
  readonly z: string;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
/** Защита от «PNG-бомб» и опечаток в спецификации ресурсов. */
export const MAX_SIDE = 8192;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Снять PNG-фильтры (0…4) со строк: raw — [f, ...stride] × h. */
export function unfilter(raw: Uint8Array, w: number, h: number, bpp: number): Uint8Array {
  const stride = w * bpp;
  if (raw.length !== h * (stride + 1)) throw new Error(`image data: expected ${h * (stride + 1)} bytes, got ${raw.length}`);
  const out = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y > 0 ? out[up + i] : 0;
      const c = y > 0 && i >= bpp ? out[up + i - bpp] : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`image data: bad filter type ${f} in row ${y}`);
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}

/** Наложить фильтры: для каждой строки выбирается тип с минимальной суммой |байт| (эвристика PNG). */
export function filterRows(px: Uint8Array, w: number, h: number, bpp: number): Uint8Array {
  const stride = w * bpp;
  const out = new Uint8Array(h * (stride + 1));
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    const up = row - stride;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = px[row + i];
        const a = i >= bpp ? px[row + i - bpp] : 0;
        const b = y > 0 ? px[up + i] : 0;
        const cc = y > 0 && i >= bpp ? px[up + i - bpp] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, cc);
        const v = (x - pred) & 255;
        c[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    out.set(cand[best], y * (stride + 1) + 1);
  }
  return out;
}

/** PNG 8 бит RGB (тип 2) или RGBA (тип 6), без чересстрочности → RGBA. Всё остальное — ошибка. */
export function decodePng(buf: Uint8Array): Rgba {
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) throw new Error('png: bad signature');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8;
  let w = 0;
  let h = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  let seenEnd = false;
  while (p + 8 <= buf.length) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (body.length !== len) throw new Error(`png: truncated ${type} chunk`);
    if (type === 'IHDR') {
      w = view.getUint32(p + 8);
      h = view.getUint32(p + 12);
      const depth = buf[p + 16];
      colorType = buf[p + 17];
      const compression = buf[p + 18];
      const filter = buf[p + 19];
      const interlace = buf[p + 20];
      if (!(w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE)) throw new Error(`png: unsupported size ${w}x${h}`);
      if (depth !== 8) throw new Error(`png: bit depth ${depth} is not supported (8 only)`);
      if (colorType !== 2 && colorType !== 6) throw new Error(`png: colour type ${colorType} is not supported (RGB/RGBA only)`);
      if (compression !== 0 || filter !== 0) throw new Error('png: unknown compression/filter method');
      if (interlace !== 0) throw new Error('png: interlaced images are not supported');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      seenEnd = true;
      break;
    }
    p += 12 + len;
  }
  if (!w || !seenEnd || !idat.length) throw new Error('png: missing IHDR/IDAT/IEND');
  const bpp = colorType === 6 ? 4 : 3;
  const raw = new Uint8Array(zlib.inflateSync(Buffer.concat(idat.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength)))));
  const px = unfilter(raw, w, h, bpp);
  return { w, h, data: bpp === 4 ? px : expandRgb(px, w * h) };
}

function expandRgb(px: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    out[i * 4] = px[j];
    out[i * 4 + 1] = px[j + 1];
    out[i * 4 + 2] = px[j + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Уменьшение усреднением по площади (с премультипликацией: без светлой каймы у прозрачных краёв). */
export function resizeArea(src: Rgba, w: number, h: number): Rgba {
  if (!(w > 0 && h > 0) || w > src.w || h > src.h) throw new Error(`resize: ${src.w}x${src.h} -> ${w}x${h} is not a downscale`);
  const out = new Uint8Array(w * h * 4);
  const sx = src.w / w;
  const sy = src.h / h;
  const d = src.data;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let yy = Math.floor(y0); yy < Math.min(src.h, Math.ceil(y1)); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.min(src.w, Math.ceil(x1)); xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (wx <= 0) continue;
          const k = wx * wy;
          const i = (yy * src.w + xx) * 4;
          const al = d[i + 3] / 255;
          r += d[i] * al * k;
          g += d[i + 1] * al * k;
          b += d[i + 2] * al * k;
          a += al * k;
          area += k;
        }
      }
      const o = (y * w + x) * 4;
      const alpha = area > 0 ? a / area : 0;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return { w, h, data: out };
}

/** Залить известным фоном (непрозрачный результат): программный drawImage kit рисует картинку как непрозрачную. */
export function flatten(src: Rgba, bg: readonly [number, number, number]): Rgba {
  const out = new Uint8Array(src.data.length);
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = Math.round(d[i] * a + bg[0] * (1 - a));
    out[i + 1] = Math.round(d[i + 1] * a + bg[1] * (1 - a));
    out[i + 2] = Math.round(d[i + 2] * a + bg[2] * (1 - a));
    out[i + 3] = 255;
  }
  return { w: src.w, h: src.h, data: out };
}

export function encodeEmbedded(img: Rgba, ch: 3 | 4): EmbeddedImage {
  const n = img.w * img.h;
  let px = img.data;
  if (ch === 3) {
    px = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      px[i * 3] = img.data[i * 4];
      px[i * 3 + 1] = img.data[i * 4 + 1];
      px[i * 3 + 2] = img.data[i * 4 + 2];
    }
  }
  const z = zlib.deflateSync(Buffer.from(filterRows(px, img.w, img.h, ch)), { level: 9 });
  return { w: img.w, h: img.h, ch, z: z.toString('base64') };
}

export function decodeEmbedded(e: EmbeddedImage): Rgba {
  if (!(e.w > 0 && e.h > 0 && e.w <= MAX_SIDE && e.h <= MAX_SIDE) || (e.ch !== 3 && e.ch !== 4)) throw new Error('asset: bad header');
  const raw = new Uint8Array(zlib.inflateSync(Buffer.from(e.z, 'base64')));
  const px = unfilter(raw, e.w, e.h, e.ch);
  return { w: e.w, h: e.h, data: e.ch === 4 ? px : expandRgb(px, e.w * e.h) };
}

export function hexRgb(hex: string): [number, number, number] {
  const s = hex.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
