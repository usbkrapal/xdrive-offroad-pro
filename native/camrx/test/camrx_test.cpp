// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
/* Host tests for xop-camrx: camera-tag parsing, view crops, the mgu-render video file, access-unit labels, RTP
 * framing with damage, the show/drop gate, and the whole pipeline (units -> gate -> decoder with ids -> exact
 * association -> crops) on idrive-apps' stand-in MSDK (test/fake_msdk, whose pictures are uniform: every byte of a
 * picture is its "content" value), including reordering, swallowed / corrupted / stale-stamped / unstamped frames,
 * restarts and "video off". Built and run by build.sh host-test. */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <initializer_list>
#include <string>
#include <vector>

#include "fake_msdk.h"
#include "mgvf.h"
#include "packet_queue.h"
#include "au.h"
#include "gate.h"
#include "pipeline.h"
#include "rtp_au.h"
#include "sei_tag.h"
#include "views.h"
#include "yuv_atlas.h"

using namespace xop;

static int failures = 0, checks = 0;
#define CHECK(c)                                                              \
    do {                                                                      \
        checks++;                                                             \
        if (!(c)) {                                                           \
            failures++;                                                       \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c);      \
        }                                                                     \
    } while (0)

/* An SEI NAL unit (with its 4-byte start code) holding the camera tag, emulation prevention applied. */
static std::string sei(uint8_t b0, uint8_t app, uint8_t mode, uint8_t persp, bool extra_message = false)
{
    std::vector<uint8_t> rbsp;
    if (extra_message) {   /* an unrelated message first: payloadType 1 (pic_timing-like), 3 bytes */
        rbsp.push_back(1);
        rbsp.push_back(3);
        rbsp.insert(rbsp.end(), {0, 0, 0});
    }
    rbsp.push_back(5);
    rbsp.push_back(20);
    rbsp.insert(rbsp.end(), kCameraTagUuid, kCameraTagUuid + 16);
    rbsp.insert(rbsp.end(), {b0, app, mode, persp});
    rbsp.push_back(0x80);
    std::string s("\0\0\0\1\x06", 5);
    int zeros = 0;
    for (uint8_t b : rbsp) {
        if (zeros >= 2 && b <= 3) {
            s += '\x03';
            zeros = 0;
        }
        s += (char)b;
        zeros = b == 0 ? zeros + 1 : 0;
    }
    return s;
}

static void test_tags()
{
    std::string au = sei(0, 51, 50, 9) + fake_msdk::access_unit("1280x480", true, 9);
    CameraTag t = parse_camera_tag((const uint8_t *)au.data(), au.size());
    CHECK(t.valid && t.application == 51 && t.mode == 50 && t.perspective == 9 && t.b0 == 0);
    /* emulation prevention inside the payload: b0 = 0, mode = 0 -> 00 00 03 sequences */
    au = sei(0, 51, 0, 1, true) + fake_msdk::access_unit(nullptr, false, 1);
    t = parse_camera_tag((const uint8_t *)au.data(), au.size());
    CHECK(t.valid && t.perspective == 1 && t.mode == 0);
    /* no tag; another UUID; truncated */
    au = fake_msdk::access_unit("1280x480", true, 3);
    CHECK(!parse_camera_tag((const uint8_t *)au.data(), au.size()).valid);
    std::string other = sei(0, 51, 50, 10);
    other[8] ^= 0x55;
    CHECK(!parse_camera_tag((const uint8_t *)other.data(), other.size()).valid);
    std::string cut = sei(0, 51, 50, 10).substr(0, 20);
    CHECK(!parse_camera_tag((const uint8_t *)cut.data(), cut.size()).valid);
}

static void test_crops()
{
    Crop c[2];
    CameraTag t;
    t.valid = true;
    t.application = 51;
    struct {
        uint8_t p;
        int n;
        View v0;
        uint32_t w0;
    } cases[] = {{1, 1, kFront, 1280}, {5, 1, kFront, 1280}, {3, 1, kLeft, 1280}, {7, 1, kLeft, 1280},
                 {4, 1, kRight, 1280}, {8, 1, kRight, 1280}, {9, 1, kFront, 640}, {10, 2, kLeft, 640}};
    for (auto &k : cases) {
        t.perspective = k.p;
        const int n = crops_for(t, 1280, 480, c);
        CHECK(n == k.n);
        if (n) {
            CHECK(c[0].view == k.v0 && c[0].w == k.w0 && c[0].h == 480 && c[0].x == 0);
        }
    }
    t.perspective = 10;
    CHECK(crops_for(t, 1280, 480, c) == 2 && c[1].view == kRight && c[1].x == 640 && c[1].w == 640);
    /* half widths are taken from the frame and kept even: 1284 -> 642, 1300 -> 650 at x 650 */
    CHECK(crops_for(t, 1300, 480, c) == 2 && c[0].w == 650 && c[1].x == 650);
    for (uint8_t p : {0, 2, 6, 11, 255}) {
        t.perspective = p;
        CHECK(crops_for(t, 1280, 480, c) == 0);
    }
    t.perspective = 9;
    t.application = 1;   /* a parking application: not ours */
    CHECK(crops_for(t, 1280, 480, c) == 0);
    t.application = 51;
    CHECK(crops_for(t, 1281, 480, c) == 0);    /* odd */
    CHECK(crops_for(t, 8192, 480, c) == 0);    /* too wide */
    CHECK(crops_for(t, 1280, 4000, c) == 0);   /* too high */
}

static void test_crop_pixels()
{
    /* a 64x32 atlas: Y = column (left half 0..31, right 32..63), U = 100 + column, V = 200 + column */
    const uint32_t W = 64, H = 32;
    std::vector<uint8_t> atlas(W * crk::atlas_height(H));
    for (uint32_t r = 0; r < H; r++)
        for (uint32_t x = 0; x < W; x++)
            atlas[r * W + x] = (uint8_t)x;
    for (uint32_t r = 0; r < H / 2; r++)
        for (uint32_t x = 0; x < W / 2; x++) {
            atlas[(H + r) * W + x] = (uint8_t)(100 + x);
            atlas[(H + r) * W + W / 2 + x] = (uint8_t)(200 + x);
        }
    CameraTag t;
    t.valid = true;
    t.application = 51;
    t.perspective = 10;
    Crop c[2];
    CHECK(crops_for(t, W, H, c) == 2);
    std::vector<uint8_t> left(i420_bytes(32, 32)), right(i420_bytes(32, 32));
    crop_atlas_i420(atlas.data(), W, H, c[0], left.data());
    crop_atlas_i420(atlas.data(), W, H, c[1], right.data());
    /* Y: left half columns 0..31, right half 32..63; U/V: their own halves of each chroma row; no flip */
    CHECK(left[0] == 0 && left[31] == 31 && left[32 * 31 + 31] == 31);
    CHECK(right[0] == 32 && right[31] == 63);
    const size_t u = 32 * 32, v = u + 16 * 16;
    CHECK(left[u] == 100 && left[u + 15] == 115 && left[v] == 200 && left[v + 15] == 215);
    CHECK(right[u] == 116 && right[u + 15] == 131 && right[v] == 216 && right[v + 15] == 231);
}

static std::vector<uint8_t> read_file(const std::string &p)
{
    std::vector<uint8_t> d;
    FILE *f = fopen(p.c_str(), "rb");
    if (!f)
        return d;
    uint8_t b[65536];
    size_t n;
    while ((n = fread(b, 1, sizeof b, f)) > 0)
        d.insert(d.end(), b, b + n);
    fclose(f);
    return d;
}
static uint32_t le32(const std::vector<uint8_t> &d, size_t i) { return d[i] | d[i + 1] << 8 | d[i + 2] << 16 | (uint32_t)d[i + 3] << 24; }

static void test_mgvf(const std::string &dir)
{
    const std::string p = dir + "/mgvf-test";
    MgvfFile f;
    std::string err;
    CHECK(f.open(p, 32, 16, 0, 1, &err));
    std::vector<uint8_t> fr(i420_bytes(32, 16));
    for (int k = 1; k <= 4; k++) {
        memset(fr.data(), k, fr.size());
        CHECK(f.write(fr.data(), &err));
    }
    std::vector<uint8_t> d = read_file(p);
    CHECK(d.size() == 64 + 3 * fr.size());
    CHECK(le32(d, 0) == kMgvfMagic && le32(d, 4) == 1 && le32(d, 8) == 32 && le32(d, 12) == 16);
    CHECK(le32(d, 16) == 4);   /* seq */
    const uint32_t slot = le32(d, 20);
    CHECK(slot == 1);          /* 0 -> 1 -> 2 -> 0 -> 1 */
    CHECK(le32(d, 24) == 3 && le32(d, 28) == 0 && le32(d, 32) == 1);
    CHECK(d[64 + slot * fr.size()] == 4);
    f.close(true);
    struct stat st;
    CHECK(stat(p.c_str(), &st) != 0);   /* removed */
    CHECK(!f.open(p, 31, 16, 0, 0, &err));   /* odd width refused */
    CHECK(!f.open(p, 2048, 1024, 0, 0, &err));   /* over the per-view third of mgu-render's 12 MiB */
    CHECK(f.open(p, 1280, 480, 0, 0, &err));     /* a whole single-camera frame fits */
    f.close(true);
    /* a newer writer replaced the path: closing the old one leaves the new file alone */
    {
        MgvfFile old, newer;
        CHECK(old.open(p, 32, 16, 0, 0, &err));
        unlink(p.c_str());
        CHECK(newer.open(p, 32, 16, 0, 0, &err));
        old.close(true);
        struct stat s2;
        CHECK(stat(p.c_str(), &s2) == 0);
        newer.close(true);
        CHECK(stat(p.c_str(), &s2) != 0);
    }
}

struct Got {
    View v;
    uint32_t w, h;
    uint8_t y, u;
};

/* A tagged fake access unit: the camera tag SEI before its slice (after SPS/PPS when the unit has them). */
static std::string unit(const char *sps, bool idr, uint8_t content, int persp, uint8_t app = 51, uint8_t b0 = 0)
{
    const std::string body = fake_msdk::access_unit(sps, idr, content);
    if (persp < 0)
        return body;
    /* the slice is the last NAL unit: its start code is the last 00 00 00 01 */
    const size_t at = body.rfind(std::string("\0\0\0\1", 4));
    return body.substr(0, at) + sei(b0, app, 50, (uint8_t)persp) + body.substr(at);
}

static Au au_of(const std::string &s) { return au_from_annexb((const uint8_t *)s.data(), s.size()); }

struct Run {
    std::vector<Got> got;
    PipelineStats st;
    GateStats gate;
};

/* Each string one access unit (push_au); "\x01reset" calls reset(). */
static Run run(const std::vector<std::string> &aus, bool damaged_at_3 = false)
{
    Run r;
    bool en[kViews] = {true, true, true};
    Pipeline p([&](View v, uint32_t w, uint32_t h, uint32_t, uint32_t, const uint8_t *i420) {
        r.got.push_back(Got{v, w, h, i420[0], i420[(size_t)w * h]});
    }, en);
    std::string err;
    CHECK(p.init("/dev/null", &err));
    int k = 0;
    for (const std::string &a : aus) {
        if (a == "\x01reset") {
            p.reset();
            continue;
        }
        Au au = au_of(a);
        if (damaged_at_3 && k == 3)
            au.damaged = true;
        p.push_au(au);
        k++;
    }
    /* the stand-in decoder keeps its last `delay` pictures at the end of a stream: untagged fillers push them out */
    for (int i = 0; i < fake_msdk::delay; i++)
        p.push_au(au_of(unit(nullptr, false, 1, -1)));
    p.flush();
    r.st = p.stats();
    r.gate = p.gate_stats();
    p.shutdown();
    return r;
}

static int count(const Run &r, View v, int y = -1)
{
    int n = 0;
    for (const Got &g : r.got)
        if (g.v == v && (y < 0 || g.y == y))
            n++;
    return n;
}

/* Contents of the fake pictures: unit i of the tag-9 pair is 20 + i, of the tag-10 pair 60 + i (i < 40). */
static uint8_t c9(int i) { return (uint8_t)(20 + i); }
static uint8_t c10(int i) { return (uint8_t)(60 + i); }
static int index_of(uint8_t y) { return y < 60 ? y - 20 : y - 60; }
/* n units alternating tag 9 / tag 10 (unit 0 an IDR with its SPS; also the units in idrs) */
static std::vector<std::string> alternating(int n, std::initializer_list<int> idrs = {})
{
    std::vector<std::string> aus;
    for (int i = 0; i < n; i++) {
        bool idr = i == 0;
        for (int k : idrs)
            idr = idr || k == i;
        aus.push_back(unit(idr ? "1280x480" : nullptr, idr, i % 2 ? c10(i) : c9(i), i % 2 ? 10 : 9));
    }
    return aus;
}

/* every shown view came from its own tag's picture: tag 9 -> front, tag 10 -> left/right */
static void check_pairs(const Run &r)
{
    for (const Got &g : r.got) {
        const bool pair9 = g.y >= 20 && g.y < 60, pair10 = g.y >= 60 && g.y < 100;
        CHECK(g.v == kFront ? pair9 : pair10);
        CHECK(g.y == g.u);
    }
}

static void test_labels()
{
    /* exactly one tag before the first slice, application 51 */
    CHECK(au_label(au_of(unit("1280x480", true, 9, 9))).verdict == LabelVerdict::Ok);
    CHECK(au_label(au_of(unit(nullptr, false, 9, -1))).verdict == LabelVerdict::NoTag);
    CHECK(au_label(au_of(unit(nullptr, false, 9, 9, 3))).verdict == LabelVerdict::OtherApp);
    const std::string two = sei(0, 51, 50, 9) + unit(nullptr, false, 9, 10);
    CHECK(au_label(au_of(two)).verdict == LabelVerdict::TwoOrMore);
    const std::string after = fake_msdk::access_unit(nullptr, false, 9) + sei(0, 51, 50, 9);
    CHECK(au_label(au_of(after)).verdict == LabelVerdict::AfterVcl);
    CHECK(au_label(au_of(sei(0, 51, 50, 9))).verdict == LabelVerdict::NoSlice);
    /* two tags inside ONE SEI NAL unit count as two */
    std::string one = sei(0, 51, 50, 9);
    const std::string second = sei(0, 51, 50, 10);
    one.pop_back();                                        /* rbsp trailing bits of the first */
    one += second.substr(5, second.size() - 5);            /* the second message (and its trailing bits) */
    CHECK(au_label(au_of(one + fake_msdk::access_unit(nullptr, false, 9))).verdict == LabelVerdict::TwoOrMore);
    const Au a = au_of(unit("1280x480", true, 9, 9));
    CHECK(a.sps && a.idr && a.first_vcl == 3 && !a.damaged);
}

static void test_gate()
{
    AuGate g;
    Au p = au_of(unit(nullptr, false, 9, 9)), i = au_of(unit("1280x480", true, 9, 9));
    CHECK(g.admit(p).why == Why::WaitIdr);   /* start: wait for an IDR */
    CHECK(g.admit(i).show());
    CHECK(g.admit(p).show());
    Au d = p;
    d.damaged = true;
    CHECK(g.admit(d).why == Why::Damaged);
    CHECK(g.admit(p).why == Why::WaitIdr);   /* after damage, in decoding order, until a clean IDR */
    Au di = i;
    di.damaged = true;
    CHECK(g.admit(di).why == Why::Damaged);  /* a damaged IDR does not end the wait */
    CHECK(g.admit(p).why == Why::WaitIdr);
    Au ui = au_of(unit("1280x480", true, 9, -1));
    const Admission u = g.admit(ui);
    CHECK(u.why == Why::Label && !g.waiting_idr());   /* an unlabelled clean IDR ends the wait, not shown */
    CHECK(g.admit(p).show());
    g.damage_seen(u.id);
    CHECK(g.admit(p).why == Why::WaitIdr);
    CHECK(g.admit(i).show());
    g.reset();
    CHECK(g.admit(p).why == Why::WaitIdr);
    CHECK(g.admit(i).show());
    Au gone = au_of(sei(0, 51, 50, 10));   /* a picture whose slices were all lost */
    gone.damaged = true;
    g.no_slice(gone);
    CHECK(g.admit(p).why == Why::WaitIdr);
    CHECK(g.admit(i).show());
    g.no_slice(au_of(sei(0, 51, 50, 10)));   /* a whole slice-less unit (parameter sets, SEI) changes nothing */
    CHECK(g.admit(p).show());
    CHECK(g.admit(au_of(unit(nullptr, false, 9, 0))).why == Why::NoView);
    /* a sender resync (packets dropped as late may have been references): wait for a clean IDR */
    CHECK(g.admit(i).show());
    Au after = p;
    after.discontinuity = true;
    CHECK(g.admit(after).why == Why::WaitIdr);
    Au after_idr = i;
    after_idr.discontinuity = true;
    CHECK(g.admit(after_idr).show());
    CHECK(g.admit(au_of(unit(nullptr, false, 9, 2))).why == Why::NoView);
    uint64_t last = 0;
    for (int k = 0; k < 5; k++) {
        const uint64_t id = g.admit(i).id;
        CHECK(id > last);   /* ids only grow, also across a reset */
        last = id;
    }
}

/* RTP packets for fake access units: one packet per NAL unit, or FU-A in pieces of `mtu` bytes; marker on the
 * unit's last packet. */
struct Pkt {
    std::vector<uint8_t> b;
    int au;
};
static void rtp_header(std::vector<uint8_t> *b, bool marker, uint16_t seq, uint32_t ts)
{
    const uint8_t h[12] = {0x80, (uint8_t)((marker ? 0x80 : 0) | 96), (uint8_t)(seq >> 8), (uint8_t)seq,
                           (uint8_t)(ts >> 24), (uint8_t)(ts >> 16), (uint8_t)(ts >> 8), (uint8_t)ts, 0, 0, 0, 1};
    b->insert(b->end(), h, h + 12);
}
static std::vector<Pkt> packetize(const std::vector<std::string> &aus, uint16_t seq0, size_t mtu = 1000)
{
    std::vector<Pkt> out;
    uint16_t seq = seq0;
    for (size_t i = 0; i < aus.size(); i++) {
        const Au a = au_of(aus[i]);
        const uint32_t ts = 1000 + (uint32_t)i * 3000;
        std::vector<std::vector<uint8_t>> pl;
        for (const NalRef &n : a.nals) {
            const uint8_t *d = &a.bytes[n.off];
            if (n.len <= mtu) {
                pl.emplace_back(d, d + n.len);
                continue;
            }
            for (size_t o = 1; o < n.len; o += mtu) {
                const size_t c = std::min(mtu, n.len - o);
                std::vector<uint8_t> f = {(uint8_t)((d[0] & 0xe0) | 28),
                                          (uint8_t)((o == 1 ? 0x80 : 0) | (o + c >= n.len ? 0x40 : 0) | (d[0] & 0x1f))};
                f.insert(f.end(), d + o, d + o + c);
                pl.push_back(f);
            }
        }
        for (size_t k = 0; k < pl.size(); k++) {
            Pkt p;
            p.au = (int)i;
            rtp_header(&p.b, k + 1 == pl.size(), seq++, ts);
            p.b.insert(p.b.end(), pl[k].begin(), pl[k].end());
            out.push_back(p);
        }
    }
    return out;
}

struct Unit {
    uint32_t ts;
    bool damaged;
    int nals;
    LabelVerdict verdict;
};
static std::vector<Unit> assemble(const std::vector<Pkt> &pk, RtpAuStats *st = nullptr)
{
    std::vector<Unit> out;
    RtpAuAssembler r;
    auto sink = [&](const Au &a) { out.push_back(Unit{a.rtp_ts, a.damaged, (int)a.nals.size(), au_label(a).verdict}); };
    for (const Pkt &p : pk)
        r.push(p.b.data(), p.b.size(), sink);
    r.flush(sink);
    if (st)
        *st = r.stats();
    return out;
}

static std::string big_unit(const char *sps, bool idr, uint8_t content, int persp)
{
    /* a slice of ~2500 bytes (fragmented): the fake decoder reads only its first payload byte */
    std::string u = unit(sps, idr, content, persp);
    u += std::string(2500, '\x55');
    return u;
}

static void test_rtp()
{
    std::vector<std::string> aus;
    for (int i = 0; i < 6; i++)
        aus.push_back(big_unit(i == 0 ? "1280x480" : nullptr, i == 0, i % 2 ? c10(i) : c9(i), i % 2 ? 10 : 9));
    /* clean, with a sequence-number wrap inside */
    std::vector<Pkt> pk = packetize(aus, 65530);
    std::vector<Unit> u = assemble(pk);
    CHECK(u.size() == 6);
    for (const Unit &x : u)
        CHECK(!x.damaged && x.verdict == LabelVerdict::Ok);
    /* the round trip keeps the bytes: same NAL units as the Annex-B unit */
    CHECK(u.size() == 6 && u[0].nals == 4);

    /* a middle FU-A fragment lost: that unit damaged, the others whole */
    std::vector<Pkt> lost;
    int mid = -1;
    for (size_t k = 0; k < pk.size(); k++)
        if (pk[k].au == 2 && pk[k].b[12] == ((pk[k].b[12] & 0xe0) | 28) && !(pk[k].b[13] & 0xc0))
            mid = (int)k;
    CHECK(mid >= 0);
    for (size_t k = 0; k < pk.size(); k++)
        if ((int)k != mid)
            lost.push_back(pk[k]);
    u = assemble(lost);
    CHECK(u.size() == 6);
    for (size_t k = 0; k < u.size(); k++)
        CHECK(u[k].damaged == (k == 2));

    /* every slice packet of unit 2 lost, its SEI kept: a slice-less unit (never joins unit 3), unit 3 damaged by
     * the gap just before it is not needed: the loss is inside unit 2's timestamp */
    std::vector<Pkt> slices;
    for (const Pkt &p : pk) {
        const uint8_t t = p.b[12] & 0x1f, inner = p.b[13] & 0x1f;
        const bool slice = (t >= 1 && t <= 5) || (t == 28 && inner >= 1 && inner <= 5);
        if (!(p.au == 2 && slice))
            slices.push_back(p);
    }
    u = assemble(slices);
    CHECK(u.size() == 6 && u[2].verdict == LabelVerdict::NoSlice && u[3].verdict == LabelVerdict::Ok);
    CHECK(u.size() == 6 && u[3].damaged);   /* lost packets just before its first: could have been its head */

    /* a whole unit lost: the next is damaged (gap before its first packet) */
    std::vector<Pkt> gone;
    for (const Pkt &p : pk)
        if (p.au != 3)
            gone.push_back(p);
    u = assemble(gone);
    CHECK(u.size() == 5 && !u[2].damaged && u[3].damaged && !u[4].damaged);

    /* two packets swapped: late packet damages its unit */
    std::vector<Pkt> swapped = pk;
    for (size_t k = 0; k + 1 < swapped.size(); k++)
        if (swapped[k].au == 4 && swapped[k + 1].au == 4) {
            std::swap(swapped[k], swapped[k + 1]);
            break;
        }
    RtpAuStats st;
    u = assemble(swapped, &st);
    CHECK(st.late == 1);
    bool any4 = false;
    for (const Unit &x : u)
        if (x.ts == 1000 + 4 * 3000 && x.damaged)
            any4 = true;
    CHECK(any4);
    for (const Unit &x : u)
        if (x.ts < 1000 + 4 * 3000)
            CHECK(!x.damaged);

    /* joining mid-stream: the first packet is a fragment end / a P unit's SEI: damaged, never shown */
    std::vector<Pkt> join(pk.begin() + 4, pk.end());
    u = assemble(join);
    CHECK(!u.empty() && u[0].damaged);
    std::vector<Pkt> join2;
    for (const Pkt &p : pk)
        if (p.au >= 1)
            join2.push_back(p);
    u = assemble(join2);
    CHECK(u.size() == 5 && !u[0].damaged);   /* starts at a whole unit (SEI first, then a whole slice): not damaged */
    CHECK(u.size() == 5 && !u[1].damaged);

    /* R1: an IDR unit ordered SEI, SPS, PPS, slice right after start is whole (H.264 does not put SPS first) */
    {
        std::vector<std::string> sf;
        sf.push_back(sei(0, 51, 50, 9) + fake_msdk::access_unit("1280x480", true, c9(0)) + std::string(2500, '\x55'));
        sf.push_back(big_unit(nullptr, false, c10(1), 10));
        const std::vector<Unit> v = assemble(packetize(sf, 7));
        CHECK(v.size() == 2 && !v[0].damaged && v[0].verdict == LabelVerdict::Ok && !v[1].damaged);
    }
    /* joining at the second slice of a two-slice picture (first_mb_in_slice != 0): damaged */
    {
        const std::string two = unit("1280x480", true, c9(0), 9) + std::string("\0\0\0\1\x65\x08\x14\x80", 8);
        std::vector<Pkt> v = packetize({two, big_unit(nullptr, false, c10(1), 10)}, 50);
        v.erase(v.begin(), v.begin() + 4);   /* SPS, PPS, SEI and the first slice lost before the start */
        const std::vector<Unit> w = assemble(v);
        CHECK(!w.empty() && w[0].damaged);
    }

    /* a bad packet (not RTP v2) in an open unit damages it; STAP-A is taken */
    std::vector<Pkt> bad = pk;
    Pkt junk;
    junk.au = 1;
    junk.b.assign(20, 0);
    for (size_t k = 0; k < bad.size(); k++)
        if (bad[k].au == 1) {
            bad.insert(bad.begin() + (long)k + 1, junk);
            break;
        }
    u = assemble(bad);
    CHECK(u.size() == 6 && u[1].damaged && !u[0].damaged);
    {
        const Au a = au_of(unit("1280x480", true, c9(0), 9));
        std::vector<uint8_t> stap;
        rtp_header(&stap, true, 7, 5000);
        stap.push_back(24);
        for (const NalRef &n : a.nals) {
            stap.push_back((uint8_t)(n.len >> 8));
            stap.push_back((uint8_t)n.len);
            stap.insert(stap.end(), a.bytes.begin() + (long)n.off, a.bytes.begin() + (long)(n.off + n.len));
        }
        std::vector<Pkt> one(1);
        one[0].b = stap;
        u = assemble(one);
        CHECK(u.size() == 1 && !u[0].damaged && u[0].verdict == LabelVerdict::Ok && u[0].nals == 4);
    }
}

static void test_rtp_restart()
{
    std::vector<std::string> aus;
    for (int i = 0; i < 6; i++)
        aus.push_back(big_unit(i == 0 || i == 3 ? "1280x480" : nullptr, i == 0 || i == 3, i % 2 ? c10(i) : c9(i), i % 2 ? 10 : 9));
    const std::vector<Pkt> pk = packetize(aus, 1000);

    /* F2: the last packet of unit 2 (a whole NAL unit) lost: unit 2 AND unit 3 damaged (either may own it) */
    {
        std::vector<Pkt> v;
        int last2 = -1;
        for (size_t k = 0; k < pk.size(); k++)
            if (pk[k].au == 2)
                last2 = (int)k;
        for (size_t k = 0; k < pk.size(); k++)
            if ((int)k != last2)
                v.push_back(pk[k]);
        const std::vector<Unit> u = assemble(v);
        CHECK(u.size() == 6 && !u[1].damaged && u[2].damaged && u[3].damaged && !u[4].damaged);
    }
    /* F4: an exact repeat of a packet is ignored; a different packet under the same number is not */
    {
        std::vector<Pkt> v = pk;
        v.insert(v.begin() + 5, v[4]);
        RtpAuStats st;
        std::vector<Unit> u = assemble(v, &st);
        CHECK(st.duplicates == 1 && u.size() == 6);
        for (const Unit &x : u)
            CHECK(!x.damaged);
        v = pk;
        Pkt changed = v[4];
        changed.b.back() ^= 1;
        v.insert(v.begin() + 5, changed);
        u = assemble(v, &st);
        CHECK(st.duplicates == 0 && st.late == 1);
    }
    /* F3: the sender restarts after unit 2 with a new SSRC and lower numbers; resync at once, the new stream's
     * first unit (an IDR with its SPS) whole */
    {
        std::vector<Pkt> v;
        for (const Pkt &p : pk)
            if (p.au <= 2)
                v.push_back(p);
        std::vector<Pkt> again = packetize(std::vector<std::string>(aus.begin() + 3, aus.end()), 10);
        for (Pkt &p : again) {
            p.b[11] = 2;   /* SSRC 2 */
            p.b[4] = 0x40;  /* other timestamps */
            v.push_back(p);
        }
        RtpAuStats st;
        const std::vector<Unit> u = assemble(v, &st);
        CHECK(st.restarts == 1 && st.late == 0 && u.size() == 6);
        for (const Unit &x : u)
            CHECK(!x.damaged);
    }
    /* F3: same SSRC, numbering starts lower: after kRestartRun "late" packets the assembler resyncs; the unit it
     * resyncs into is damaged (its head was dropped as late), the next IDR whole */
    {
        std::vector<std::string> more = aus;
        for (int i = 6; i < 12; i++)
            more.push_back(big_unit(i == 9 ? "1280x480" : nullptr, i == 9, i % 2 ? c10(i) : c9(i), i % 2 ? 10 : 9));
        std::vector<Pkt> v;
        for (const Pkt &p : pk)
            if (p.au <= 2)
                v.push_back(p);
        std::vector<Pkt> again = packetize(std::vector<std::string>(more.begin() + 3, more.end()), 10);
        for (Pkt &p : again) {
            p.b[4] = 0x40;
            v.push_back(p);
        }
        RtpAuStats st;
        const std::vector<Unit> u = assemble(v, &st);
        CHECK(st.restarts == 1 && st.late == (uint64_t)RtpAuAssembler::kRestartRun);
        bool idr_whole = false;
        for (const Unit &x : u)
            if (x.ts == (0x40000000u | (1000 + 6 * 3000)) && !x.damaged)
                idr_whole = true;
        CHECK(idr_whole);
    }
}

static void test_queue()
{
    int64_t now = 0;
    PacketQueue q([&] { return now; });
    std::vector<uint8_t> out;
    const uint8_t pkt[100] = {0x80};
    q.push(pkt, sizeof pkt);
    now = 100;
    CHECK(q.pop(&out, 0) == PacketQueue::Packet && out.size() == 100);
    CHECK(q.pop(&out, 0) == PacketQueue::None);
    /* decoding fell behind: a packet older than kMaxAgeMs discards the whole backlog */
    for (int i = 0; i < 10; i++) {
        q.push(pkt, sizeof pkt);
        now += 30;
    }
    CHECK(q.pop(&out, 0) == PacketQueue::Overload && q.stale() == 10);
    CHECK(q.pop(&out, 0) == PacketQueue::None);
    /* a full queue: the arrival is dropped and the backlog discarded at the next pop, even if young */
    for (size_t i = 0; i <= PacketQueue::kPackets; i++)
        q.push(pkt, sizeof pkt);
    CHECK(q.drops() == 1 && q.pop(&out, 0) == PacketQueue::Overload);
    q.push(pkt, sizeof pkt);
    CHECK(q.pop(&out, 0) == PacketQueue::Packet);
}

static void test_pipeline()
{
    /* all cameras: tag 9 (front|rear) and tag 10 (left|right) alternating, in decoding order; display-order delay */
    for (int delay : {0, 2}) {
        fake_msdk::delay = delay;
        const Run r = run(alternating(12));
        check_pairs(r);
        for (const Got &g : r.got)
            CHECK(g.w == 640 && g.h == 480);
        CHECK(count(r, kFront) == 6 && count(r, kLeft) == 6 && count(r, kRight) == 6);
        CHECK(r.st.unmatched == 0 && r.st.duplicate == 0);
        fprintf(stderr, "pipeline delay %d: front %d left %d right %d, frames %llu\n", delay, count(r, kFront),
                count(r, kLeft), count(r, kRight), (unsigned long long)r.st.frames);
    }
    fake_msdk::delay = 0;

    /* untagged, rear alone, another application, a tag after the slice, two tags: no view; left alone: full width */
    {
        std::vector<std::string> aus;
        aus.push_back(unit("1280x480", true, 1, -1));
        aus.push_back(unit(nullptr, false, 2, 2));
        aus.push_back(unit(nullptr, false, 3, 9, 3));
        aus.push_back(fake_msdk::access_unit(nullptr, false, 5) + sei(0, 51, 50, 9));
        aus.push_back(sei(0, 51, 50, 9) + unit(nullptr, false, 6, 10));
        aus.push_back(unit(nullptr, false, 64, 3));
        const Run r = run(aus);
        CHECK(r.got.size() == 1 && r.got[0].v == kLeft && r.got[0].w == 1280 && r.got[0].y == 64);
        CHECK(r.gate.unlabelled == 4 && r.gate.no_view == 1 && r.gate.shown == 1);
    }

    /* a tag-only unit (its slices lost) never labels the next one */
    {
        const Run r = run({unit("1280x480", true, c9(0), 9), sei(0, 51, 50, 10), unit(nullptr, false, c9(1), -1),
                           unit(nullptr, false, c9(2), 9)});
        CHECK(r.st.slice_less == 1);
        CHECK(count(r, kLeft) == 0 && count(r, kRight) == 0 && count(r, kFront) == 2 && count(r, kFront, c9(1)) == 0);
        check_pairs(r);
    }

    /* a frame the decoder never outputs (swallowed) does not shift the others' labels */
    {
        fake_msdk::swallow = c10(3);
        fake_msdk::delay = 1;
        const Run r = run(alternating(8));
        check_pairs(r);
        CHECK(count(r, kLeft, c10(3)) == 0 && count(r, kFront) == 4 && count(r, kLeft) == 3);
        fake_msdk::swallow = 0;
        fake_msdk::delay = 0;
    }

    /* a new sequence (SPS of another size): labels still match their frames */
    {
        const Run r = run({unit("1280x480", true, c9(0), 9), unit(nullptr, false, c10(1), 10),
                           unit("1920x720", true, c10(2), 10), unit(nullptr, false, c9(3), 9)});
        check_pairs(r);
        CHECK(r.st.unmatched == 0 && count(r, kFront) == 2 && count(r, kLeft) == 2);
    }

    /* MSDK flags a frame Corrupted: dropped, and everything decoded after it waits for a clean IDR */
    for (int delay : {0, 2}) {
        fake_msdk::corrupt = c10(3);
        fake_msdk::delay = delay;
        const Run r = run(alternating(10, {7}));
        check_pairs(r);
        CHECK(r.st.corrupted == 1 && count(r, kLeft, c10(3)) == 0);
        for (const Got &g : r.got) {
            const int i = index_of(g.y);
            CHECK(i < 3 || i >= 7);   /* units 3..6 never shown; 7 (IDR) on */
        }
        CHECK(count(r, kFront, c9(2)) == 1 && count(r, kFront, c9(8)) == 1 && count(r, kLeft, c10(9)) == 1);
        fake_msdk::corrupt = 0;
    }
    fake_msdk::delay = 0;

    /* A delayed error in the old GOP must not revoke an already submitted recovery IDR or its pictures. */
    for (int delay : {1, 2, 4}) {
        fake_msdk::corrupt = c10(3);
        fake_msdk::delay = delay;
        const Run r = run(alternating(12, {4}));
        check_pairs(r);
        CHECK(r.st.corrupted == 1);
        for (const Got &g : r.got)
            CHECK(index_of(g.y) < 3 || index_of(g.y) >= 4);
        for (int i = 4; i < 12; i++)
            CHECK(count(r, i % 2 ? kLeft : kFront, i % 2 ? c10(i) : c9(i)) == 1);
        fake_msdk::corrupt = 0;
    }
    fake_msdk::delay = 0;

    /* The recovery IDR itself can be corrupt. Its GOP stays hidden until a subsequent clean IDR. */
    for (int delay : {0, 2, 4}) {
        fake_msdk::corrupt = c9(4);
        fake_msdk::delay = delay;
        const Run r = run(alternating(14, {4, 8}));
        check_pairs(r);
        CHECK(r.st.corrupted == 1);
        for (const Got &g : r.got)
            CHECK(index_of(g.y) < 4 || index_of(g.y) >= 8);
        CHECK(count(r, kFront, c9(8)) == 1 && count(r, kLeft, c10(9)) == 1);
        fake_msdk::corrupt = 0;
    }
    fake_msdk::delay = 0;

    /* a damaged unit (transport) and the units after it until the next IDR are never shown */
    {
        const Run r = run(alternating(8, {6}), true);
        check_pairs(r);
        for (const Got &g : r.got)
            CHECK(index_of(g.y) < 3 || index_of(g.y) >= 6);
        CHECK(r.gate.damaged == 1 && r.gate.wait_idr == 2 && count(r, kFront, c9(6)) == 1);
    }

    /* a frame carrying a stale id (the unit before's): never shown under that unit's label, and never twice */
    {
        fake_msdk::stale_stamp = c10(3);
        const Run r = run(alternating(6));
        check_pairs(r);
        CHECK(r.st.duplicate == 1);
        CHECK(count(r, kLeft, c10(3)) == 0 && count(r, kFront, c9(2)) == 1 && count(r, kFront, c9(4)) == 1);
        fake_msdk::stale_stamp = 0;
    }

    /* frames without a TimeStamp (id 0): nothing is guessed, nothing shown */
    {
        const auto side_pair = unit("1280x480", true, c10(0), 10, 51, 1);
        const Run good = run({side_pair});
        CHECK(count(good, kLeft) == 1 && count(good, kRight) == 1 && count(good, kFront) == 0);
        fake_msdk::timestamps = false;
        const Run r = run({side_pair});
        CHECK(r.got.empty() && r.st.unmatched == 1);
        CHECK(r.st.last_w == 1280 && r.st.last_h == 480 && r.st.last_tag.b0 == 1 && r.st.last_tag.perspective == 10);
        fake_msdk::timestamps = true;
    }

    /* "same as the last picture" across pairs: front 30 -> side 30 -> front 30; the last front frame is shown with
     * its own picture (the decoder's shortcut would have left it without one) */
    {
        const Run r = run({unit("1280x480", true, 30, 9), unit(nullptr, false, 70, 10), unit(nullptr, false, 70, 9)});
        CHECK(r.st.no_picture == 0);
        CHECK(count(r, kFront) == 2 && count(r, kLeft) == 1);
    }
    {
        /* identical pictures in both pairs: each pair's frame still comes with a picture */
        const Run r = run({unit("1280x480", true, 70, 10), unit(nullptr, false, 70, 10), unit(nullptr, false, 70, 10)});
        CHECK(r.st.no_picture == 0 && count(r, kLeft) == 3);
    }

    /* video off / on: nothing from before shown after; the first unit after must be a clean IDR */
    {
        const Run r = run({unit("1280x480", true, c9(0), 9), unit(nullptr, false, c10(1), 10), "\x01reset",
                           unit(nullptr, false, c9(2), 9), unit("1280x480", true, c9(3), 9), unit(nullptr, false, c10(4), 10)});
        check_pairs(r);
        CHECK(count(r, kFront, c9(2)) == 0 && count(r, kFront, c9(3)) == 1 && count(r, kLeft, c10(4)) == 1);
        CHECK(r.st.unmatched == 0);
    }
}

/* R2: a frame is never written as fresh when its unit arrived more than kMaxAgeMs before it came out */
static void test_age()
{
    struct Feed {
        std::vector<Got> got;
        PipelineStats st;
    };
    auto feed = [](const std::vector<std::string> &aus, int pause_at, bool markers) {
        Feed f;
        int64_t now = 0;
        bool en[kViews] = {true, true, true};
        Pipeline p([&](View v, uint32_t w, uint32_t h, uint32_t, uint32_t, const uint8_t *i420) {
            f.got.push_back(Got{v, w, h, i420[0], i420[(size_t)w * h]});
        }, en, [&] { return now; });
        std::string err;
        CHECK(p.init("/dev/null", &err));
        std::vector<Pkt> pk = packetize(aus, 100);
        for (Pkt &k : pk) {
            if (!markers)
                k.b[1] &= 0x7f;
            now = (int64_t)k.au * 33 + (k.au >= pause_at ? 3000 : 0);
            p.push_rtp(k.b.data(), k.b.size(), now);
        }
        p.flush();
        f.st = p.stats();
        p.shutdown();
        return f;
    };
    /* A: the decoder holds 2 pictures (display order) across a 3 s input pause: those come out ~3 s late: dropped;
     * the pictures after the pause are shown */
    fake_msdk::delay = 2;
    Feed a = feed(alternating(14), 10, true);
    CHECK(a.st.too_old == 2);
    CHECK(count(Run{a.got, a.st, GateStats()}, kFront, c9(8)) == 0 && count(Run{a.got, a.st, GateStats()}, kLeft, c10(9)) == 0);
    CHECK(count(Run{a.got, a.st, GateStats()}, kFront, c9(10)) == 1 && count(Run{a.got, a.st, GateStats()}, kLeft, c10(11)) == 1);
    CHECK(count(Run{a.got, a.st, GateStats()}, kFront, c9(6)) == 1);
    fake_msdk::delay = 0;
    /* B: no marker bits: the last unit before a 3 s pause closes only when the next timestamp arrives: dropped */
    Feed b = feed(alternating(8), 6, false);
    CHECK(b.st.too_old == 1 && count(Run{b.got, b.st, GateStats()}, kLeft, c10(5)) == 0);
    CHECK(count(Run{b.got, b.st, GateStats()}, kFront, c9(6)) == 1 && count(Run{b.got, b.st, GateStats()}, kFront, c9(4)) == 1);
    /* with markers every unit closes at once: nothing is old */
    Feed c = feed(alternating(8), 6, true);
    CHECK(c.st.too_old == 0 && c.got.size() == 12);
}

int main(int argc, char **argv)
{
    const std::string dir = argc > 1 ? argv[1] : "/tmp";
    test_tags();
    test_crops();
    test_crop_pixels();
    test_mgvf(dir);
    test_labels();
    test_gate();
    test_rtp();
    test_rtp_restart();
    test_queue();
    test_pipeline();
    test_age();
    fprintf(stderr, "%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
