// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
/* One access unit as xop-camrx hands it to the decoder: its NAL units behind 00 00 00 01 start codes, where the
 * first VCL NAL unit is, what it holds (SPS, IDR, B slice), whether it is damaged (RTP loss / broken fragment /
 * late packet), and its RTP timestamp when it came from RTP.
 *
 * Camera label of an access unit (decoder-report.md §4.2): exactly one camera tag (sei_tag.h) in the whole unit,
 * placed before its first VCL NAL unit, with application 51; anything else (none, two or more, a tag after a slice)
 * gives the unit no label. A label never carries over to another unit. */
#ifndef XOP_AU_H
#define XOP_AU_H

#include <stddef.h>
#include <stdint.h>
#include <string>
#include <vector>

#include "sei_tag.h"

namespace xop {

struct NalRef {
    size_t off, len;   /* the NAL unit (from its header byte) in Au::bytes */
    uint8_t type;
};

struct Au {
    std::vector<uint8_t> bytes;
    std::vector<NalRef> nals;
    int first_vcl = -1;           /* index into nals; -1: no slice */
    bool sps = false, idr = false, b = false;
    bool damaged = false;
    /* The first unit after a start, reset or sender resync has an unknown reference chain.
     * P/B pictures wait for IDR; a complete progressive all-I picture can stand alone. */
    bool discontinuity = false;
    bool has_rtp_ts = false;
    uint32_t rtp_ts = 0;
    /* Monotonic ms its first packet arrived (PacketQueue); -1: unknown (file replay, tests): not aged. */
    int64_t rx_ms = -1;
    void clear() { *this = Au(); }
};

/* Most bytes one access unit may hold (a 1280x480 picture is far smaller). */
static const size_t kMaxAuBytes = 4u << 20;

/* Appends one NAL unit (from its header byte); false when it would pass kMaxAuBytes (then the unit is damaged). */
bool au_add_nal(Au *au, const uint8_t *nal, size_t len);

/* The access unit in Annex-B bytes (a file replay: no RTP, never damaged by transport). */
Au au_from_annexb(const uint8_t *data, size_t len);

enum class LabelVerdict { Ok, NoTag, TwoOrMore, AfterVcl, OtherApp, NoSlice };
struct AuLabel {
    CameraTag tag;   /* valid only with Ok */
    LabelVerdict verdict = LabelVerdict::NoTag;
    int tags = 0;
};
AuLabel au_label(const Au &au);
/* All ordinary AVC slices are I (2/7), with a readable common header. This does not reset reference pictures. */
bool au_all_intra(const Au &au);
const char *verdict_name(LabelVerdict v);

}  // namespace xop

#endif
