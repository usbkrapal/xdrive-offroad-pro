// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
/* Runs an RTP fixture (u32-LE length + datagram, repeated) through xop-camrx's own RtpAuAssembler and AuGate and
 * prints one line per access unit, in decoding order:
 *   au <rtp_ts> <shown 0|1> <perspective or -> <damaged 0|1> <idr 0|1> <why> <fp>
 * fp: the first 24 bytes (hex) of the unit's first slice, which identifies the picture in the fixture's .h264.
 * test/check_fixtures.py compares the lines with the fixture manifest's expectations. */
#include <stdio.h>

#include <fstream>
#include <string>
#include <vector>

#include "gate.h"
#include "rtp_au.h"

using namespace xop;

static const char *why_name(Why w)
{
    switch (w) {
    case Why::Show: return "show";
    case Why::Damaged: return "damaged";
    case Why::WaitIdr: return "wait-idr";
    case Why::Label: return "label";
    case Why::NoView: return "no-view";
    }
    return "?";
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: rtp_gate_dump FIXTURE.rtp\n");
        return 2;
    }
    std::ifstream in(argv[1], std::ios::binary);
    if (!in) {
        fprintf(stderr, "%s: cannot open\n", argv[1]);
        return 1;
    }
    RtpAuAssembler rtp;
    AuGate gate;
    auto sink = [&](const Au &au) {
        if (au.first_vcl < 0) {
            gate.no_slice(au);
            printf("au %u 0 - %d %d no-slice -\n", au.rtp_ts, au.damaged ? 1 : 0, 0);
            return;
        }
        const Admission a = gate.admit(au);
        char persp[8] = "-";
        if (a.label.verdict == LabelVerdict::Ok)
            snprintf(persp, sizeof persp, "%u", a.label.tag.perspective);
        const NalRef &v = au.nals[(size_t)au.first_vcl];
        std::string fp;
        char hex[3];
        for (size_t k = 0; k < v.len && k < 24; k++) {
            snprintf(hex, sizeof hex, "%02x", au.bytes[v.off + k]);
            fp += hex;
        }
        printf("au %u %d %s %d %d %s %s\n", au.rtp_ts, a.show() ? 1 : 0, persp, au.damaged ? 1 : 0, au.idr ? 1 : 0,
               why_name(a.why), fp.c_str());
    };
    std::vector<uint8_t> pkt;
    uint8_t len[4];
    while (in.read(reinterpret_cast<char *>(len), 4)) {
        const uint32_t n = len[0] | (uint32_t)len[1] << 8 | (uint32_t)len[2] << 16 | (uint32_t)len[3] << 24;
        if (n > 65536)
            return 1;
        pkt.resize(n);
        if (!in.read(reinterpret_cast<char *>(pkt.data()), (std::streamsize)n))
            return 1;
        rtp.push(pkt.data(), pkt.size(), sink);
    }
    rtp.flush(sink);
    const RtpAuStats &s = rtp.stats();
    printf("stats packets %llu bad %llu gaps %llu lost %llu late %llu units %llu damaged %llu broken_fu %llu\n",
           (unsigned long long)s.packets, (unsigned long long)s.bad, (unsigned long long)s.gaps,
           (unsigned long long)s.lost, (unsigned long long)s.late, (unsigned long long)s.units,
           (unsigned long long)s.damaged_units, (unsigned long long)s.broken_fu);
    return 0;
}
