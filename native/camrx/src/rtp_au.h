// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
/* RTP H.264 (RFC 3550 / RFC 6184, non-interleaved mode) to whole access units, keeping per unit what the decoder's
 * own re-framing would lose (decoder-report.md §3.1-3.2, §4.1):
 *   - a unit is the packets of one RTP timestamp (RFC 6184: all packets of an access unit share it); it ends when
 *     the timestamp changes, or at the marker bit on a packet that completes a slice;
 *   - single NAL units (1-23), STAP-A (24) and FU-A (28); STAP-B, MTAP and FU-B (interleaved mode) are damage;
 *   - damage, marked on the unit (never silently repaired): a sequence-number gap while it is open or just before
 *     its first packet (the lost packets may be its head), an FU-A that is cut (start missing, end missing, or
 *     interrupted by another NAL unit), a late / reordered packet (sequence number behind the last one), a packet
 *     that does not parse, a unit over kMaxAuBytes;
 *   - a lost packet between two units (a gap where the timestamp changes) damages BOTH: it may have been the old
 *     unit's tail or the new one's head;
 *   - an exact repeat of the last packet (same sequence number and bytes) is ignored;
 *   - a sender restart resynchronises (the next unit is damaged, so the gate waits for an IDR): a new SSRC, or
 *     kRestartRun packets in a row that are "behind" the last sequence number with timestamps of no open unit;
 *   - a unit is delivered as it is (the caller decides: a damaged one is decoded for its references but never
 *     shown; one without a slice never joins the next unit).
 * Not thread-safe. */
#ifndef XOP_RTP_AU_H
#define XOP_RTP_AU_H

#include <functional>
#include <vector>

#include "au.h"

namespace xop {

struct RtpAuStats {
    uint64_t packets = 0, bad = 0, gaps = 0, lost = 0, late = 0, units = 0, damaged_units = 0, broken_fu = 0, duplicates = 0,
             restarts = 0;
};

class RtpAuAssembler {
public:
    static const int kRestartRun = 8;
    using Sink = std::function<void(const Au &)>;
    /* rx_ms: monotonic arrival time of the packet (-1 unknown); a unit keeps its first packet's. */
    void push(const uint8_t *pkt, size_t len, const Sink &sink, int64_t rx_ms = -1);
    /* End of stream / stop: delivers the open unit. */
    void flush(const Sink &sink);
    /* Forgets everything (a restart after "video off"): the next packet starts afresh, its unit marked damaged
     * (what came before it is unknown). */
    void reset();
    const RtpAuStats &stats() const { return st_; }

private:
    void emit(const Sink &sink);
    void nal(const uint8_t *d, size_t n);
    void damage() { cur_.damaged = true; }
    void resync(const Sink &sink);

    Au cur_;
    bool open_ = false;
    bool have_seq_ = false, fresh_ = true;
    /* the unit opened first after a start/reset: whole only if its first slice starts the picture
     * (first_mb_in_slice 0) and no fragment was cut; which NAL type comes first is not judged (SEI may lead) */
    bool fresh_unit_ = false;
    uint16_t last_seq_ = 0;
    uint32_t ssrc_ = 0;
    int late_run_ = 0;
    std::vector<uint8_t> last_pkt_;
    std::vector<uint8_t> fu_;
    bool fu_active_ = false;
    RtpAuStats st_;
};

}  // namespace xop

#endif
