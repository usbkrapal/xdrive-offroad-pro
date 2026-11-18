// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
#include "sei_tag.h"

#include <string.h>
#include <vector>

namespace xop {

const uint8_t kCameraTagUuid[16] = {0xb6, 0x2c, 0x66, 0x63, 0x35, 0x62, 0x42, 0x6c,
                                    0xfb, 0x62, 0x5e, 0xf1, 0x45, 0xd3, 0x41, 0x53};

CameraTag parse_sei_nal(const uint8_t *nal, size_t len)
{
    CameraTag t;
    return sei_tags(nal, len, &t, 1) > 0 ? t : CameraTag();
}

int sei_tags(const uint8_t *nal, size_t len, CameraTag *out, int max)
{
    int found = 0;
    if (len < 2 || (nal[0] & 0x1f) != 6)
        return 0;
    /* RBSP: the payload without emulation prevention bytes (00 00 03 -> 00 00) */
    std::vector<uint8_t> r;
    r.reserve(len);
    int zeros = 0;
    for (size_t i = 1; i < len; i++) {
        uint8_t b = nal[i];
        if (zeros >= 2 && b == 3) {
            zeros = 0;
            continue;
        }
        r.push_back(b);
        zeros = b == 0 ? zeros + 1 : 0;
    }
    size_t i = 0, n = r.size();
    /* sei_message()s until the rbsp trailing bits (0x80) */
    while (i < n && !(r[i] == 0x80 && i + 1 == n)) {
        uint32_t type = 0, size = 0;
        while (i < n && r[i] == 0xff) {
            type += 255;
            i++;
        }
        if (i >= n)
            return found;
        type += r[i++];
        while (i < n && r[i] == 0xff) {
            size += 255;
            i++;
        }
        if (i >= n)
            return found;
        size += r[i++];
        if (size > n - i)
            return found;
        if (type == 5 && size >= 20 && memcmp(&r[i], kCameraTagUuid, 16) == 0) {
            if (found < max) {
                CameraTag &tag = out[found];
                tag.valid = true;
                tag.b0 = r[i + 16];
                tag.application = r[i + 17];
                tag.mode = r[i + 18];
                tag.perspective = r[i + 19];
            }
            found++;
        }
        i += size;
    }
    return found;
}

CameraTag parse_camera_tag(const uint8_t *data, size_t size)
{
    size_t i = 0;
    /* start of each NAL unit: after 00 00 01 */
    while (i + 3 <= size) {
        if (!(data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1)) {
            i++;
            continue;
        }
        size_t start = i + 3, end = start;
        while (end + 3 <= size && !(data[end] == 0 && data[end + 1] == 0 && (data[end + 2] == 1 || (data[end + 2] == 0 && end + 4 <= size && data[end + 3] == 1))))
            end++;
        if (end + 3 > size)
            end = size;
        if (start < end && (data[start] & 0x1f) == 6) {
            CameraTag t = parse_sei_nal(data + start, end - start);
            if (t.valid)
                return t;
        }
        i = end;
    }
    return CameraTag();
}

}  // namespace xop
