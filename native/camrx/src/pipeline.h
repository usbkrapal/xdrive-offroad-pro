// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
/* Camera stream to per-view frames:
 *   RTP datagrams (AVB bus packets) -> RtpAuAssembler (whole access units with damage, rtp_au.h) -> AuGate
 *   (label + decode-order damage/IDR rule, gate.h) -> MSDK decoder (decoder_msdk.h feed_au: the unit exactly as
 *   framed, its own 64-bit id as the input TimeStamp, display order) -> each decoded frame's id matched EXACTLY
 *   against the pending table -> crops (views.h) -> I420 per view -> sink (the MGVF files).
 * A file replay (--file, Annex-B) frames units with the decoder's NAL rules instead (no transport damage there).
 *
 * Output rules (decoder-report.md §4.4-4.6): a frame is shown only if its id is a pending one (not shown before),
 * its unit was admitted for showing, MSDK did not flag it Corrupted, and it has a picture of its own. The decoder's
 * "same as the last picture" shortcut is turned off (forget_last before every unit): the last picture may be the
 * other pair's. A corrupted output, an unknown or duplicate id are dropped and counted; a corrupted output also
 * withdraws dependent units up to the next clean IDR. A delayed error from an older GOP does not revoke that
 * recovery IDR. Nothing is ever shown under another unit's label.
 * Age: each unit keeps its first packet's arrival time (monotonic); a frame whose unit arrived more than kMaxAgeMs
 * before it comes out (held by the decoder across an input pause, a unit closed only by the next timestamp, a slow
 * decode) is dropped and counted, never written as fresh.
 * Not thread-safe: one thread. */
#ifndef XOP_PIPELINE_H
#define XOP_PIPELINE_H

#include <functional>
#include <string>
#include <vector>

#include "au.h"
#include "decoder_msdk.h"
#include "gate.h"
#include "nal_reader.h"
#include "rtp_au.h"
#include "views.h"

namespace xop {

struct PipelineStats {
    uint64_t units = 0, slice_less = 0, fed = 0;
    uint64_t frames = 0, unmatched = 0, duplicate = 0, corrupted = 0, not_shown = 0, no_picture = 0, bad_size = 0;
    uint64_t view_frames[kViews] = {0, 0, 0};
    uint64_t decode_errors = 0, too_old = 0;
    CameraTag last_tag;
    uint32_t last_w = 0, last_h = 0;
};

class Pipeline {
public:
    static const uint32_t kPending = 64;
    static const int64_t kMaxAgeMs = 750;
    /* One view's I420 frame (w x h), with the colour the stream's SPS states (matrix 0 BT.601 / 1 BT.709, range
     * 0 limited / 1 full; H.264's defaults when the SPS does not say). */
    using Sink = std::function<void(View v, uint32_t w, uint32_t h, uint32_t matrix, uint32_t range, const uint8_t *i420)>;

    /* clock: monotonic ms (the same clock as the packets' arrival times). */
    Pipeline(const Sink &sink, const bool enabled[kViews], std::function<int64_t()> clock = [] { return (int64_t)0; });

    /* dev: the render node. Stream size output, exact levels, no GPU copy, display order. */
    bool init(const char *dev, std::string *err);
    void push_rtp(const uint8_t *pkt, size_t len, int64_t rx_ms = -1);
    void push_annexb(const uint8_t *data, size_t len, bool end_of_au);
    /* One access unit as framed by the caller (tests, replay). */
    void push_au(const Au &au);
    void flush();
    /* "video off": transport, framing, decoder and pending ids start over; the next unit shown is after a clean
     * IDR. Ids keep counting (never reused). */
    void reset();
    void shutdown();

    const PipelineStats &stats() const { return st_; }
    const GateStats &gate_stats() const { return gate_.stats(); }
    const RtpAuStats &rtp_stats() const { return rtp_.stats(); }
    bool waiting_idr() const { return gate_.waiting_idr(); }
    std::string last_error() const { return err_; }

private:
    struct Pending {
        uint64_t id = 0;
        uint64_t recovery_id = 0;
        bool show = false, output = false;
        CameraTag tag;
        int64_t rx_ms = -1;
    };
    void on_au(const Au &au);
    void on_frame(const woc::VideoFrame &f);
    void on_sps(const uint8_t *nal, size_t len);

    Sink sink_;
    std::function<int64_t()> clock_;
    bool enabled_[kViews];
    woc::Decoder dec_;
    woc::NalReader nal_;
    RtpAuAssembler rtp_;
    AuGate gate_;
    Pending pending_[kPending];
    std::vector<uint8_t> params_;   /* SPS/PPS of a unit without a slice, put before the next unit's */
    std::vector<uint8_t> feed_;
    uint32_t matrix_ = 0, range_ = 0;
    std::vector<uint8_t> buf_;
    PipelineStats st_;
    std::string err_;
};

}  // namespace xop

#endif
