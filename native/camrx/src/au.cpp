// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
#include "au.h"

namespace xop {

namespace {

/* Exp-Golomb ue(v) over the RBSP of a slice header (emulation prevention skipped), for slice_type. */
class Bits {
public:
    Bits(const uint8_t *d, size_t n) : d_(d), n_(n) {}
    bool bit(uint32_t *out)
    {
        if (byte_ >= n_)
            return false;
        if (bitpos_ == 0 && byte_ >= 2 && d_[byte_] == 3 && d_[byte_ - 1] == 0 && d_[byte_ - 2] == 0) {
            if (++byte_ >= n_)
                return false;
        }
        *out = (d_[byte_] >> (7 - bitpos_)) & 1;
        if (++bitpos_ == 8) {
            bitpos_ = 0;
            byte_++;
        }
        return true;
    }
    bool ue(uint32_t *out)
    {
        int zeros = 0;
        uint32_t b = 0;
        while (true) {
            if (!bit(&b))
                return false;
            if (b)
                break;
            if (++zeros > 31)
                return false;
        }
        uint32_t v = 0;
        for (int i = 0; i < zeros; i++) {
            if (!bit(&b))
                return false;
            v = (v << 1) | b;
        }
        *out = (1u << zeros) - 1 + v;
        return true;
    }

private:
    const uint8_t *d_;
    size_t n_, byte_ = 0;
    int bitpos_ = 0;
};

}  // namespace

bool au_add_nal(Au *au, const uint8_t *nal, size_t len)
{
    if (!len)
        return true;
    if (au->bytes.size() + len + 4 > kMaxAuBytes) {
        au->damaged = true;
        return false;
    }
    const uint8_t start[4] = {0, 0, 0, 1};
    au->bytes.insert(au->bytes.end(), start, start + 4);
    const size_t off = au->bytes.size();
    au->bytes.insert(au->bytes.end(), nal, nal + len);
    const uint8_t type = nal[0] & 0x1f;
    au->nals.push_back(NalRef{off, len, type});
    if (type >= 1 && type <= 5) {
        if (au->first_vcl < 0)
            au->first_vcl = (int)au->nals.size() - 1;
        if (type == 5)
            au->idr = true;
        /* slice_header: first_mb_in_slice ue(v), slice_type ue(v); B is 1 or 6 */
        Bits b(nal + 1, len - 1);
        uint32_t first_mb = 0, slice_type = 0;
        if (b.ue(&first_mb) && b.ue(&slice_type) && (slice_type == 1 || slice_type == 6))
            au->b = true;
    } else if (type == 7) {
        au->sps = true;
    }
    return true;
}

Au au_from_annexb(const uint8_t *data, size_t size)
{
    Au au;
    size_t i = 0;
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
        size_t e = end;
        while (e > start && data[e - 1] == 0)   /* trailing zero bytes are not part of the NAL unit */
            e--;
        if (start < e)
            au_add_nal(&au, data + start, e - start);
        i = end;
    }
    return au;
}

AuLabel au_label(const Au &au)
{
    AuLabel out;
    if (au.first_vcl < 0) {
        out.verdict = LabelVerdict::NoSlice;
        return out;
    }
    CameraTag first;
    int first_at = -1;
    for (size_t k = 0; k < au.nals.size(); k++) {
        const NalRef &n = au.nals[k];
        if (n.type != 6)
            continue;
        CameraTag tags[4];
        const int c = sei_tags(&au.bytes[n.off], n.len, tags, 4);
        for (int j = 0; j < c; j++) {
            if (out.tags == 0) {
                first = tags[j];
                first_at = (int)k;
            }
            out.tags++;
        }
    }
    if (out.tags == 0)
        out.verdict = LabelVerdict::NoTag;
    else if (out.tags > 1)
        out.verdict = LabelVerdict::TwoOrMore;
    else if (first_at > au.first_vcl)
        out.verdict = LabelVerdict::AfterVcl;
    else if (first.application != kAppDrActive)
        out.verdict = LabelVerdict::OtherApp;
    else {
        out.verdict = LabelVerdict::Ok;
        out.tag = first;
    }
    return out;
}

bool au_all_intra(const Au &au)
{
    bool found = false;
    for (const NalRef &n : au.nals) {
        if (n.type == 19 || n.type == 20 || n.type == 21)
            return false;
        if (n.type < 1 || n.type > 5)
            continue;
        if ((n.type != 1 && n.type != 5) || n.len < 2 || (au.bytes[n.off] & 0x80))
            return false;
        Bits bits(&au.bytes[n.off + 1], n.len - 1);
        uint32_t first_mb = 0, slice_type = 0, pps = 0;
        if (!bits.ue(&first_mb) || !bits.ue(&slice_type) || !bits.ue(&pps) || pps > 255 ||
            (slice_type != 2 && slice_type != 7) || (!found && first_mb != 0))
            return false;
        found = true;
    }
    return found;
}

const char *verdict_name(LabelVerdict v)
{
    switch (v) {
    case LabelVerdict::Ok: return "ok";
    case LabelVerdict::NoTag: return "no tag";
    case LabelVerdict::TwoOrMore: return "two or more tags";
    case LabelVerdict::AfterVcl: return "tag after a slice";
    case LabelVerdict::OtherApp: return "another application";
    case LabelVerdict::NoSlice: return "no slice";
    }
    return "?";
}

}  // namespace xop
