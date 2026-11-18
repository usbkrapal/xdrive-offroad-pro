// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
#include "views.h"

#include <string.h>

namespace xop {

const char *const kViewNames[kViews] = {"front", "left", "right"};

int crops_for(const CameraTag &tag, uint32_t W, uint32_t H, Crop out[2])
{
    if (!tag.valid || tag.application != kAppDrActive)
        return 0;
    if (W < kMinSide || H < kMinSide || W > kMaxW || H > kMaxH || (W & 1) || (H & 1))
        return 0;
    const uint32_t h = H & ~1u;
    const uint32_t half = (W / 2) & ~1u;
    int n = 0;
    switch (tag.perspective) {
    case 1: case 5: out[n++] = Crop{kFront, 0, W, h}; break;
    case 3: case 7: out[n++] = Crop{kLeft, 0, W, h}; break;
    case 4: case 8: out[n++] = Crop{kRight, 0, W, h}; break;
    case 9: out[n++] = Crop{kFront, 0, half, h}; break;
    case 10:
        out[n++] = Crop{kLeft, 0, half, h};
        out[n++] = Crop{kRight, half, half, h};
        break;
    default: return 0;
    }
    /* every crop must fit the output bounds; one that does not drops the frame for all its views */
    for (int i = 0; i < n; i++) {
        if (out[i].w < kOutMin || out[i].h < kOutMin || out[i].w > kOutMax || out[i].h > kOutMax || out[i].x + out[i].w > W)
            return 0;
    }
    return n;
}

void crop_atlas_i420(const uint8_t *atlas, uint32_t W, uint32_t H, const Crop &c, uint8_t *dst)
{
    const uint32_t cw = c.w / 2, ch = c.h / 2;
    uint8_t *y = dst, *u = dst + (size_t)c.w * c.h, *v = u + (size_t)cw * ch;
    for (uint32_t r = 0; r < c.h; r++)
        memcpy(y + (size_t)r * c.w, atlas + (size_t)r * W + c.x, c.w);
    const uint8_t *chroma = atlas + (size_t)W * H;   /* rows of U (W/2) | V (W/2) */
    for (uint32_t r = 0; r < ch; r++) {
        const uint8_t *row = chroma + (size_t)r * W;
        memcpy(u + (size_t)r * cw, row + c.x / 2, cw);
        memcpy(v + (size_t)r * cw, row + W / 2 + c.x / 2, cw);
    }
}

}  // namespace xop
