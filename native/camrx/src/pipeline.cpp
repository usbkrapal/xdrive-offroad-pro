// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
#include "pipeline.h"

#include <string.h>

#include "sps_info.h"
#include "yuv_atlas.h"

namespace xop {

Pipeline::Pipeline(const Sink &sink, const bool enabled[kViews], std::function<int64_t()> clock) : sink_(sink), clock_(std::move(clock))
{
    for (int i = 0; i < kViews; i++)
        enabled_[i] = enabled[i];
    dec_.on_sps([this](const uint8_t *nal, size_t len) { on_sps(nal, len); });
    dec_.set_display_order(true);
}

bool Pipeline::init(const char *dev, std::string *err) { return dec_.init(dev, 0, 0, 0, false, err); }

void Pipeline::on_sps(const uint8_t *nal, size_t len)
{
    woc::SpsInfo s;
    if (!woc::parse_sps(nal, len, &s))
        return;
    /* H.264 E.2.1: absent video_signal_type means video_full_range_flag 0; matrix 1 is BT.709, 5/6 BT.601, and
     * an unspecified matrix (2, or none) is taken as BT.601 (the SD-size camera picture). */
    range_ = s.full_range == 1 ? 1 : 0;
    matrix_ = s.matrix == 1 ? 1 : 0;
}

void Pipeline::push_rtp(const uint8_t *pkt, size_t len, int64_t rx_ms)
{
    rtp_.push(pkt, len, [this](const Au &au) { on_au(au); }, rx_ms);
}

void Pipeline::push_annexb(const uint8_t *data, size_t len, bool end_of_au)
{
    nal_.push(data, len, end_of_au, [this](const woc::AccessUnit &a) { on_au(au_from_annexb(a.data, a.size)); });
}

void Pipeline::push_au(const Au &au) { on_au(au); }

void Pipeline::on_au(const Au &au)
{
    st_.units++;
    if (au.first_vcl < 0) {
        /* no slice: never joins the next unit, except its parameter sets (they carry no camera label) */
        st_.slice_less++;
        gate_.no_slice(au);
        if (!au.damaged) {
            for (const NalRef &n : au.nals) {
                if ((n.type == 7 || n.type == 8) && params_.size() + n.len + 4 <= 4096) {
                    const uint8_t sc[4] = {0, 0, 0, 1};
                    params_.insert(params_.end(), sc, sc + 4);
                    params_.insert(params_.end(), au.bytes.begin() + (long)n.off, au.bytes.begin() + (long)(n.off + n.len));
                }
            }
        }
        return;
    }
    const Admission a = gate_.admit(au);
    if (a.label.verdict == LabelVerdict::Ok)
        st_.last_tag = a.label.tag;
    Pending &p = pending_[a.id % kPending];
    p = Pending{a.id, a.show(), false, a.label.tag, au.rx_ms};
    feed_ = params_;
    const bool params_sps = !params_.empty();
    params_.clear();
    feed_.insert(feed_.end(), au.bytes.begin(), au.bytes.end());
    woc::AccessUnit wa{feed_.data(), feed_.size(), au.sps || params_sps, au.idr, au.b};
    std::string err;
    dec_.forget_last();
    st_.fed++;
    if (!dec_.feed_au(wa, a.id, [this](const woc::VideoFrame &f) { on_frame(f); }, &err)) {
        st_.decode_errors++;
        err_ = err;
    }
}

void Pipeline::on_frame(const woc::VideoFrame &f)
{
    st_.frames++;
    // Record decoder output even if it never reaches the crop or video file.
    st_.last_w = f.w;
    st_.last_h = f.h;
    Pending &p = pending_[f.id % kPending];
    if (f.id == 0 || p.id != f.id) {
        st_.unmatched++;   /* not an id given (or no longer pending): never guessed */
        return;
    }
    if (p.output) {
        st_.duplicate++;
        return;
    }
    p.output = true;
    if (f.corrupted) {
        st_.corrupted++;
        gate_.damage_seen();
        /* everything given after this frame's unit may refer to it */
        for (Pending &q : pending_)
            if (q.id > f.id && !q.output)
                q.show = false;
        return;
    }
    if (!p.show) {
        st_.not_shown++;
        return;
    }
    if (p.rx_ms >= 0 && clock_() - p.rx_ms > kMaxAgeMs) {
        st_.too_old++;   /* late: never written as a fresh frame */
        return;
    }
    if (f.same || !f.atlas || f.atlas->size() < (size_t)f.w * crk::atlas_height(f.h)) {
        st_.no_picture++;
        return;
    }
    Crop crops[2];
    const int n = crops_for(p.tag, f.w, f.h, crops);
    if (!n) {
        st_.bad_size++;
        return;
    }
    for (int i = 0; i < n; i++) {
        const Crop &c = crops[i];
        if (!enabled_[c.view])
            continue;
        buf_.resize(i420_bytes(c.w, c.h));
        crop_atlas_i420(f.atlas->data(), f.w, f.h, c, buf_.data());
        sink_(c.view, c.w, c.h, matrix_, range_, buf_.data());
        st_.view_frames[c.view]++;
    }
}

void Pipeline::flush()
{
    rtp_.flush([this](const Au &au) { on_au(au); });
    nal_.flush([this](const woc::AccessUnit &a) { on_au(au_from_annexb(a.data, a.size)); });
    dec_.flush([this](const woc::VideoFrame &f) { on_frame(f); });
}

void Pipeline::reset()
{
    rtp_.reset();
    nal_.reset();
    /* frames still in the decoder belong to before the pause: delivered nowhere */
    dec_.flush([](const woc::VideoFrame &) {});
    for (Pending &p : pending_)
        p = Pending();
    params_.clear();
    gate_.reset();
}

void Pipeline::shutdown() { dec_.shutdown(); }

}  // namespace xop
