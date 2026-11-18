// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
/* The camera unit's per-frame camera tag, read from an access unit's SEI.
 *
 * Format (interface facts recorded in work/claude/camera-research-worker/report.md §2 E4 and Addendum A; written
 * here from that description, no code taken from the binaries it describes):
 *   an SEI NAL unit (nal_unit_type 6), after emulation-prevention removal, holds an SEI message with
 *   payloadType 5 (user_data_unregistered) and payloadSize >= 20: the 16-byte UUID
 *   b62c6663-3562-426c-fb62-5ef145d34153, then four bytes b0, application, mode, perspective.
 * Selection uses application 51 (DR_ACTIVE) and perspective only; b0 and mode are kept for the log. */
#ifndef XOP_SEI_TAG_H
#define XOP_SEI_TAG_H

#include <stddef.h>
#include <stdint.h>

namespace xop {

struct CameraTag {
    bool valid = false;
    uint8_t b0 = 0, application = 0, mode = 0, perspective = 0;
};

extern const uint8_t kCameraTagUuid[16];
static const uint8_t kAppDrActive = 51;

/* The first camera tag in an access unit (NAL units behind 00 00 01 / 00 00 00 01 start codes); invalid when
 * there is none. Bounded: never reads past data + size. */
CameraTag parse_camera_tag(const uint8_t *data, size_t size);

/* One SEI NAL unit's RBSP (header byte included, emulation prevention still in): its camera tag, if any. */
CameraTag parse_sei_nal(const uint8_t *nal, size_t len);

/* Every camera tag in one SEI NAL unit (up to max into out); returns how many there are (may exceed max). */
int sei_tags(const uint8_t *nal, size_t len, CameraTag *out, int max);

}  // namespace xop

#endif
