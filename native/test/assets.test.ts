import assert from 'node:assert/strict';
import { openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as zlib from 'node:zlib';
import { decodeEmbedded, decodePng, encodeEmbedded, filterRows, flatten, resizeArea, unfilter, type Rgba } from '../src/assets/codec';
import { ImageRegistry } from '../src/assets/registry';
import { ASSETS, IMAGE_ID } from '../src/assets/spec';
import { DialTexture, FACE_TEX, rasterFace, SPRITE_UNITS } from '../src/render/dial';
import { ASSET_DIR, buildImage } from '../scripts/assets';
import { syntheticAssets } from './helpers';

/** Минимальный PNG (CRC не проверяется декодером, но заполняем нулями честно как «любые»). */
function png(w: number, h: number, colorType: number, rows: Uint8Array, opts: { depth?: number; interlace?: number } = {}): Uint8Array {
  const chunk = (type: string, body: Uint8Array) => {
    const b = Buffer.alloc(12 + body.length);
    b.writeUInt32BE(body.length, 0);
    b.write(type, 4, 'ascii');
    Buffer.from(body).copy(b, 8);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = opts.depth ?? 8;
  ihdr[9] = colorType;
  ihdr[12] = opts.interlace ?? 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', new Uint8Array(0))]);
}

function gradient(w: number, h: number, alpha = true): Rgba {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = (x * 7) & 255;
      d[i + 1] = (y * 5) & 255;
      d[i + 2] = (x * y) & 255;
      d[i + 3] = alpha ? (x + y) & 255 : 255;
    }
  return { w, h, data: d };
}

function readIhdr(file: string): { w: number; h: number; depth: number; type: number; interlace: number } {
  const fd = openSync(join(ASSET_DIR, file), 'r');
  const b = Buffer.alloc(33);
  readSync(fd, b, 0, 33, 0);
  closeSync(fd);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), depth: b[24], type: b[25], interlace: b[28] };
}

describe('кодек растров', () => {
  it('фильтры PNG: filterRows → unfilter без потерь (RGB и RGBA)', () => {
    for (const bpp of [3, 4]) {
      const px = new Uint8Array(37 * 23 * bpp).map((_, i) => (i * 31 + (i >> 5)) & 255);
      assert.deepEqual(unfilter(filterRows(px, 37, 23, bpp), 37, 23, bpp), px);
    }
  });

  it('встроенный формат: RGBA и RGB (альфа 255) без потерь', () => {
    const img = gradient(41, 17);
    assert.deepEqual(decodeEmbedded(encodeEmbedded(img, 4)).data, img.data);
    const rgb = decodeEmbedded(encodeEmbedded(gradient(41, 17, false), 3));
    assert.deepEqual(rgb.data, gradient(41, 17, false).data);
  });

  it('PNG: RGB и RGBA 8 бит без чересстрочности; остальное — понятная ошибка', () => {
    const rgba = gradient(9, 5);
    const rows = filterRows(rgba.data, 9, 5, 4);
    assert.deepEqual(decodePng(png(9, 5, 6, rows)).data, rgba.data);
    const rgbPx = new Uint8Array(9 * 5 * 3).fill(77);
    const rgb = decodePng(png(9, 5, 2, filterRows(rgbPx, 9, 5, 3)));
    assert.equal(rgb.data[3], 255);
    assert.equal(rgb.data[0], 77);
    assert.throws(() => decodePng(png(9, 5, 6, rows, { interlace: 1 })), /interlaced/);
    assert.throws(() => decodePng(png(9, 5, 6, rows, { depth: 16 })), /bit depth/);
    assert.throws(() => decodePng(png(9, 5, 3, rows)), /colour type/);
    assert.throws(() => decodePng(new Uint8Array(20)), /signature/);
    assert.throws(() => decodePng(png(9, 6, 6, rows)), /expected/);
  });

  it('уменьшение по площади и заливка: размеры, непрозрачность, без светлой каймы', () => {
    const img = gradient(100, 60);
    const small = resizeArea(img, 33, 20);
    assert.equal(small.w, 33);
    assert.equal(small.data.length, 33 * 20 * 4);
    assert.throws(() => resizeArea(img, 200, 60), /not a downscale/);
    const flat = flatten(small, [4, 6, 10]);
    for (let i = 3; i < flat.data.length; i += 4) assert.equal(flat.data[i], 255);
    // Полностью прозрачный белый над тёмным фоном остаётся фоном.
    const clear: Rgba = { w: 2, h: 2, data: new Uint8Array([255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0]) };
    assert.deepEqual(Array.from(flatten(resizeArea(clear, 1, 1), [4, 6, 10]).data), [4, 6, 10, 255]);
  });
});

describe('ресурсы проекта', () => {
  it('исходные PNG совпадают со спецификацией: размер, 8 бит, RGB/RGBA, без чересстрочности', () => {
    for (const s of ASSETS) {
      const h = readIhdr(s.file);
      assert.equal(h.w, s.srcW, s.file);
      assert.equal(h.h, s.srcH, s.file);
      assert.equal(h.depth, 8, s.file);
      assert.ok(h.type === 2 || h.type === 6, `${s.file}: colour type ${h.type}`);
      assert.equal(h.interlace, 0, s.file);
      assert.ok(s.w <= s.srcW && s.h <= s.srcH, `${s.key}: только уменьшение`);
      assert.ok(Math.abs(s.w / s.h - s.srcW / s.srcH) < 0.02, `${s.key}: пропорции сохранены`);
    }
  });

  it('настоящий спрайт тангажа проходит конвейер: размер спецификации, альфа сохранена', () => {
    const spec = ASSETS.find((a) => a.key === 'pitchSprite')!;
    const e = buildImage(spec);
    assert.equal(e.ch, 4);
    const img = decodeEmbedded(e);
    assert.equal(img.w, spec.w);
    assert.equal(img.h, spec.h);
    // Усреднение по площади смягчает края: 255 может не уцелеть, но фон прозрачен, а машина почти непрозрачна.
    let transparent = 0;
    let solid = 0;
    let maxA = 0;
    for (let i = 3; i < img.data.length; i += 4) {
      const a = img.data[i];
      if (a === 0) transparent++;
      if (a >= 192) solid++;
      if (a > maxA) maxA = a;
    }
    assert.ok(transparent > img.w * img.h * 0.1, `прозрачный фон сохранён: ${transparent}`);
    assert.ok(solid > 50 && maxA >= 240, `машина плотная: ${solid} px ≥192, max ${maxA}`);
  });

  it('реестр: распаковка и загрузка один раз; камеры не трогаются, пока не запрошены', () => {
    const calls: number[] = [];
    const reg = new ImageRegistry(syntheticAssets(), (id) => calls.push(id));
    assert.deepEqual(reg.stats(), { decoded: 0, uploaded: 0 });
    const a = reg.image('xray');
    const b = reg.image('xray');
    assert.equal(a, b);
    assert.deepEqual(calls, [IMAGE_ID.xray]);
    reg.thumb('cameraLeft');
    reg.thumb('cameraLeft');
    assert.deepEqual(calls, [IMAGE_ID.xray, IMAGE_ID.thumbLeft]);
    assert.deepEqual(reg.stats(), { decoded: 2, uploaded: 2 });
    assert.equal(new ImageRegistry(null, () => undefined).image('xray'), null, 'без assets.js — заглушка, не исключение');
    assert.throws(() => new ImageRegistry({ format: 'other' } as never, () => undefined), /unknown format/);
  });
});

describe('текстура прибора (CPU-поворот)', () => {
  const sprite = decodeEmbedded(syntheticAssets().images.pitchSprite);

  it('вне круга — цвет панели; машина меняет пиксели при повороте', () => {
    const S = 64;
    const a = new Uint8Array(S * S * 4);
    const b = new Uint8Array(S * S * 4);
    rasterFace(a, S, sprite, SPRITE_UNITS.pitch, 0, 1, [16, 18, 23]);
    rasterFace(b, S, sprite, SPRITE_UNITS.pitch, 30, 1, [16, 18, 23]);
    assert.deepEqual(Array.from(a.slice(0, 4)), [16, 18, 23, 255], 'угол квадрата — фон панели');
    assert.notDeepEqual(a, b);
    for (let i = 3; i < a.length; i += 4) assert.equal(a[i], 255, 'текстура непрозрачна');
  });

  it('один id, два буфера, перерисовка только при изменении и не чаще ~12/с', () => {
    const calls: { id: number; buf: Uint8Array }[] = [];
    const tex = new DialTexture('pitch', IMAGE_ID.dialPitch, sprite, (id, w, h, d) => {
      assert.equal(w, FACE_TEX);
      assert.equal(h, FACE_TEX);
      calls.push({ id, buf: d });
    });
    assert.equal(tex.update(0, 1, 0), true);
    assert.equal(tex.update(0.1, 1, 500), false, 'изменение меньше шага');
    assert.equal(tex.update(5, 1, 520), true);
    assert.equal(tex.update(6, 1, 540), false, 'слишком часто');
    assert.equal(tex.update(6, 1, 700), true);
    assert.equal(tex.update(6, 0.25, 701, true), true, 'нет данных → приглушённый спрайт сразу');
    assert.ok(calls.every((c) => c.id === IMAGE_ID.dialPitch));
    assert.equal(new Set(calls.map((c) => c.buf)).size, 2, 'ровно два буфера');
    assert.equal(tex.renders, 4);
  });
});
