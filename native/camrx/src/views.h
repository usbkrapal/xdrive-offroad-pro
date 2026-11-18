// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
/* Which camera views a tagged decoded frame holds, and where (interface facts: report.md §2 E3/E5 and Addendum A;
 * no code from the binaries described there):
 *   application must be 51 (DR_ACTIVE); perspective
 *     1 or 5 -> front, the whole frame        2 or 6 -> rear (not used here)
 *     3 or 7 -> left, the whole frame         4 or 8 -> right, the whole frame
 *     9      -> front | rear side by side: front is the left half
 *     10     -> left | right side by side: left is the left half, right the right half
 *   A half is ((W/2) & ~1) x (H & ~1) at x 0 or x (W/2)&~1, taken from the decoded frame's own size (no fixed
 *   dimension). No mirroring or rotation: the pixels as the camera unit sends them.
 * Anything else (another application, perspective 0 or > 10, an odd or out-of-bounds size) yields no view: the
 * view stays unavailable and is never relabelled. */
#ifndef XOP_VIEWS_H
#define XOP_VIEWS_H

#include <stddef.h>
#include <stdint.h>

#include "sei_tag.h"

namespace xop {

enum View { kFront = 0, kLeft = 1, kRight = 2, kViews = 3 };
extern const char *const kViewNames[kViews];

struct Crop {
    View view;
    uint32_t x, w, h;   /* in the decoded frame: columns x .. x+w-1, rows 0 .. h-1 */
};

/* Decoded frames this helper takes: both sides even and within these bounds. */
static const uint32_t kMinSide = 32, kMaxW = 4096, kMaxH = 2048;
/* Per-view output bounds (mgu-render's video file: 16..2048 a side, even). */
static const uint32_t kOutMin = 16, kOutMax = 2048;

/* The crops for a tagged W x H frame; returns how many (0..2) were written to out. */
int crops_for(const CameraTag &tag, uint32_t W, uint32_t H, Crop out[2]);

/* One crop of a W x atlas_height(H) atlas (Y rows, then rows holding U | V side by side, cluster-render
 * yuv_atlas.h) into planar I420 (Y w*h, U, V (w/2)*(h/2) each) at dst. x, w, h even; the crop inside the frame. */
void crop_atlas_i420(const uint8_t *atlas, uint32_t W, uint32_t H, const Crop &c, uint8_t *dst);

inline size_t i420_bytes(uint32_t w, uint32_t h) { return (size_t)w * h * 3 / 2; }

}  // namespace xop

#endif
