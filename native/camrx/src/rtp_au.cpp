// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
#include "rtp_au.h"

#include <algorithm>

namespace xop {

/* A new sender stream: the open unit ends damaged (its rest will never come), framing starts afresh. */
void RtpAuAssembler::resync(const Sink &sink)
{
    st_.restarts++;
    if (open_)
        damage();
    emit(sink);
    reset();
}

void RtpAuAssembler::reset()
{
    late_run_ = 0;
    last_pkt_.clear();
    cur_.clear();
    open_ = false;
    have_seq_ = false;
    fresh_ = true;
    fresh_unit_ = false;
    fu_.clear();
    fu_active_ = false;
}

void RtpAuAssembler::emit(const Sink &sink)
{
    if (!open_)
        return;
    if (fu_active_) {   /* a fragmented NAL unit never ended */
        st_.broken_fu++;
        damage();
        fu_active_ = false;
        fu_.clear();
    }
    if (fresh_unit_ && cur_.first_vcl >= 0) {
        /* joined mid-unit? Its first slice must start the picture: first_mb_in_slice ue(v) 0 is the bit '1' */
        const NalRef &v = cur_.nals[(size_t)cur_.first_vcl];
        if (v.len < 2 || !(cur_.bytes[v.off + 1] & 0x80))
            damage();
    }
    st_.units++;
    if (cur_.damaged)
        st_.damaged_units++;
    sink(cur_);
    cur_.clear();
    open_ = false;
    fresh_unit_ = false;
}

void RtpAuAssembler::nal(const uint8_t *d, size_t n)
{
    if (!n)
        return;
    au_add_nal(&cur_, d, n);
}

void RtpAuAssembler::push(const uint8_t *p, size_t len, const Sink &sink, int64_t rx_ms)
{
    st_.packets++;
    if (len < 12 || (p[0] >> 6) != 2) {
        st_.bad++;
        if (open_)
            damage();
        return;
    }
    const bool padding = p[0] & 0x20, ext = p[0] & 0x10;
    const unsigned cc = p[0] & 0x0f;
    const bool marker = p[1] & 0x80;
    const uint16_t seq = (uint16_t)(p[2] << 8 | p[3]);
    const uint32_t ts = (uint32_t)p[4] << 24 | (uint32_t)p[5] << 16 | (uint32_t)p[6] << 8 | p[7];
    size_t off = 12 + 4 * (size_t)cc, end = len;
    if (ext) {
        if (off + 4 > end) {
            st_.bad++;
            if (open_)
                damage();
            return;
        }
        off += 4 + 4 * (size_t)(p[off + 2] << 8 | p[off + 3]);
    }
    if (padding) {
        const size_t pad = p[len - 1];
        if (pad == 0 || pad > end - off) {
            st_.bad++;
            if (open_)
                damage();
            return;
        }
        end -= pad;
    }
    if (off >= end) {
        st_.bad++;
        if (open_)
            damage();
        return;
    }

    const uint32_t ssrc = (uint32_t)p[8] << 24 | (uint32_t)p[9] << 16 | (uint32_t)p[10] << 8 | p[11];
    if (have_seq_ && ssrc != ssrc_)
        resync(sink);   /* another sender stream */

    /* sequence numbers */
    bool gap = false;
    if (have_seq_) {
        const uint16_t expected = (uint16_t)(last_seq_ + 1);
        const uint16_t d = (uint16_t)(seq - expected);
        if (d == 0xffff && last_pkt_.size() == len && std::equal(p, p + len, last_pkt_.begin())) {
            st_.duplicates++;   /* the same packet again */
            return;
        }
        if (d >= 0x8000) {
            /* behind the last packet: late, reordered or repeated. Its unit (if still open) is damaged; a packet
             * of an already delivered unit cannot be repaired. A run of them with timestamps of no open unit is a
             * sender that started its numbering again. */
            st_.late++;
            if (open_ && ts == cur_.rtp_ts) {
                damage();
                late_run_ = 0;
                return;
            }
            if (++late_run_ < kRestartRun)
                return;
            resync(sink);
        } else {
            late_run_ = 0;
        }
    }
    if (have_seq_) {
        const uint16_t d = (uint16_t)(seq - (uint16_t)(last_seq_ + 1));
        if (d) {
            gap = true;
            st_.gaps++;
            st_.lost += d;
        }
    }
    have_seq_ = true;
    last_seq_ = seq;
    ssrc_ = ssrc;
    last_pkt_.assign(p, p + len);

    if (open_ && ts != cur_.rtp_ts) {
        if (gap)
            damage();   /* the lost packets may have been this unit's tail */
        emit(sink);   /* a new timestamp: the previous unit ended */
    }
    if (gap && open_)
        damage();   /* lost packets within this unit */
    if (!open_) {
        open_ = true;
        cur_.has_rtp_ts = true;
        cur_.rtp_ts = ts;
        cur_.rx_ms = rx_ms;
        /* lost packets just before this one may have been this unit's head */
        if (gap)
            damage();
        fresh_unit_ = fresh_;
        cur_.discontinuity = fresh_;
        fresh_ = false;
    }

    const uint8_t *pl = p + off;
    const size_t n = end - off;
    const uint8_t type = pl[0] & 0x1f;
    bool completes_slice = false;
    if (type >= 1 && type <= 23) {
        if (fu_active_) {   /* a fragmented NAL unit interrupted */
            st_.broken_fu++;
            damage();
            fu_active_ = false;
            fu_.clear();
        }
        nal(pl, n);
        completes_slice = type >= 1 && type <= 5;
    } else if (type == 24) {   /* STAP-A: 16-bit size + NAL unit, repeated */
        if (fu_active_) {
            st_.broken_fu++;
            damage();
            fu_active_ = false;
            fu_.clear();
        }
        size_t i = 1;
        while (i + 2 <= n) {
            const size_t sz = (size_t)pl[i] << 8 | pl[i + 1];
            i += 2;
            if (!sz || i + sz > n) {
                damage();
                break;
            }
            nal(pl + i, sz);
            if ((pl[i] & 0x1f) >= 1 && (pl[i] & 0x1f) <= 5)
                completes_slice = true;
            i += sz;
        }
        if (i != n)
            damage();
    } else if (type == 28) {   /* FU-A */
        if (n < 2) {
            damage();
            return;
        }
        const bool s = pl[1] & 0x80, e = pl[1] & 0x40;
        const uint8_t header = (uint8_t)((pl[0] & 0xe0) | (pl[1] & 0x1f));
        if (s) {
            if (fu_active_) {
                st_.broken_fu++;
                damage();
            }
            fu_.assign(1, header);
            fu_active_ = true;
        } else if (!fu_active_ || gap) {
            /* a middle or end without its start (or after lost packets): the NAL unit is lost */
            st_.broken_fu++;
            damage();
            fu_active_ = false;
            fu_.clear();
            return;
        }
        if (fu_.size() + n - 2 > kMaxAuBytes) {
            damage();
            fu_active_ = false;
            fu_.clear();
            return;
        }
        fu_.insert(fu_.end(), pl + 2, pl + n);
        if (e) {
            nal(fu_.data(), fu_.size());
            completes_slice = (header & 0x1f) >= 1 && (header & 0x1f) <= 5;
            fu_active_ = false;
            fu_.clear();
        }
    } else {
        /* STAP-B, MTAP16/24, FU-B (interleaved mode) or reserved: not taken */
        damage();
    }
    if (marker && completes_slice)
        emit(sink);
}

void RtpAuAssembler::flush(const Sink &sink) { emit(sink); }

}  // namespace xop
