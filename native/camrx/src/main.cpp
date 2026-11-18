// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
/* xop-camrx: live front / left / right camera views for Terrain Monitor.
 *
 * Joins the camera unit's AVB stream as one more receiver (the IAS AVB bridge's receiver API, as idrive-apps'
 * waze-on-cluster joins a stream; avb_source.cpp), depacketises RTP H.264, reads each access unit's camera tag,
 * decodes with the head unit's MSDK (decoder_msdk.cpp) and writes each view's I420 frames to an mgu-render video
 * file (<out-prefix><view>). It never asks the camera unit for anything: which view the unit sends is the app's
 * request (or another app's), and frames that do not carry a wanted view leave that view's file untouched (stale).
 *
 *   xop-camrx --stream ROLE --out-prefix /dev/shm/mgu-video-xop- --views front,left,right [--dri DEVICE]
 *             [--control stdin]
 *   xop-camrx --file capture.h264 --out-prefix DIR/prefix- --views ... [--keep]     (Annex-B replay, for tests)
 *   xop-camrx --rtp-file capture.rtp --out-prefix DIR/prefix- --views ... [--keep]  (RTP replay: u32-LE length +
 *             datagram, repeated; the live path from depacketising on)
 *   xop-camrx --check-args ...                       parses and validates the arguments only, prints "ok", exits 0
 *
 * stdout: one {"ev":"caps",...} line at start, then {"ev":"stats",...} every 5 s; the log goes to stderr.
 * stdin (--control stdin): "video on" / "video off" (receiver off, files removed, framing/decoder/ids start over:
 * the next frame shown follows a clean IDR), end of input: exit. Read with poll() in the main loop (no thread).
 * SIGTERM: exit.
 * On exit the receiver is stopped and the view files removed (no frozen picture is left for the renderer). */
#include <ctype.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <fstream>
#include <mutex>
#include <string>
#include <vector>

#include "log.h"
#include "mgvf.h"
#include "packet_queue.h"
#include "pipeline.h"
#ifndef XOP_NO_AVB
#include "avb_source.h"
#endif

using namespace xop;

namespace {

const char *const kDefaultPrefix = "/dev/shm/mgu-video-xop-";

std::atomic<bool> g_quit{false};
void on_signal(int) { g_quit = true; }

bool valid_role(const std::string &s)
{
    if (s.empty() || s.size() > 64)
        return false;
    for (char c : s)
        if (!(isalnum((unsigned char)c) || c == '.' || c == '_' || c == '-'))
            return false;
    return true;
}

/* "/dev/dri/renderD" and 3 digits ("/dev/dri/renderD128", 19 characters) */
bool valid_dri(const std::string &s)
{
    static const char kPre[] = "/dev/dri/renderD";
    const size_t n = sizeof kPre - 1;
    if (s.size() != n + 3 || s.compare(0, n, kPre) != 0)
        return false;
    for (size_t i = n; i < s.size(); i++)
        if (!isdigit((unsigned char)s[i]))
            return false;
    return true;
}

/* Control lines from stdin, read without blocking (the fd is polled by the main loop). */
class Control {
public:
    enum Ev { None, On, Off, Eof };
    /* Waits up to wait_ms for input; returns the newest command in what arrived (or Eof). */
    Ev poll_once(int wait_ms)
    {
        struct pollfd p = {0, POLLIN, 0};
        if (::poll(&p, 1, wait_ms) <= 0)
            return None;
        char b[256];
        const ssize_t n = ::read(0, b, sizeof b);
        if (n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN))
            return Eof;
        Ev ev = None;
        for (ssize_t i = 0; i < n; i++) {
            if (b[i] != '\n') {
                if (line_.size() < 64)
                    line_ += b[i];
                continue;
            }
            if (line_ == "video on")
                ev = On;
            else if (line_ == "video off")
                ev = Off;
            line_.clear();
        }
        return ev;
    }

private:
    std::string line_;
};

struct Outputs {
    std::string prefix;
    bool enabled[kViews] = {false, false, false};
    MgvfFile files[kViews];

    void write(View v, uint32_t w, uint32_t h, uint32_t matrix, uint32_t range, const uint8_t *i420)
    {
        MgvfFile &f = files[v];
        std::string err;
        if (!f.is_open() || f.w() != w || f.h() != h || f.matrix() != matrix || f.range() != range) {
            if (!f.open(prefix + kViewNames[v], w, h, matrix, range, &err)) {
                log_warn("%s: %s", kViewNames[v], err.c_str());
                return;
            }
            log_info("%s: %ux%u %s %s range", kViewNames[v], w, h, matrix ? "BT.709" : "BT.601", range ? "full" : "limited");
        }
        if (!f.write(i420, &err))
            log_warn("%s: %s", kViewNames[v], err.c_str());
    }
    void close_all(bool unlink)
    {
        for (int v = 0; v < kViews; v++)
            files[v].close(unlink);
    }
};

void print_caps(const Outputs &o)
{
    std::string views;
    for (int v = 0; v < kViews; v++)
        if (o.enabled[v])
            views += std::string(views.empty() ? "" : ",") + "\"" + kViewNames[v] + "\"";
    /* currentState perspectives whose frames carry a view this helper makes (report.md E5, Addendum A):
     * view 1 -> 1, 3 -> 3, 4 -> 4, 5 -> 5/6 (front in 5), 6 -> 7/8, 7 -> 7/9/10; rear alone (2) gives nothing.
     * The view to ask for when the cameras are free: 7, all cameras (front from 9, left/right from 10). */
    printf("{\"ev\":\"caps\",\"views\":[%s],\"accept\":[1,3,4,5,6,7,8,9,10],\"request\":7}\n", views.c_str());
    fflush(stdout);
}

void print_stats(const Pipeline &p, uint64_t queue_drops, uint64_t packets, bool active, uint64_t stale = 0, uint64_t overloads = 0)
{
    const PipelineStats &s = p.stats();
    const GateStats &g = p.gate_stats();
    const RtpAuStats &r = p.rtp_stats();
    typedef unsigned long long ull;
    printf("{\"ev\":\"stats\",\"active\":%d,\"packets\":%llu,\"queue_drops\":%llu,\"queue_stale\":%llu,\"overloads\":%llu,\"rtp_bad\":%llu,\"rtp_lost\":%llu,"
           "\"rtp_late\":%llu,\"rtp_dup\":%llu,\"rtp_restarts\":%llu,\"units\":%llu,\"damaged\":%llu,\"wait_idr\":%llu,\"unlabelled\":%llu,\"slice_less\":%llu,"
           "\"frames\":%llu,\"front\":%llu,\"left\":%llu,\"right\":%llu,\"unmatched\":%llu,\"duplicate\":%llu,"
           "\"corrupted\":%llu,\"not_shown\":%llu,\"no_picture\":%llu,\"too_old\":%llu,\"bad_size\":%llu,\"decode_errors\":%llu,"
           "\"tag\":\"%u/%u/%u/%u\",\"size\":\"%ux%u\"}\n",
           active ? 1 : 0, (ull)packets, (ull)queue_drops, (ull)stale, (ull)overloads, (ull)r.bad, (ull)r.lost, (ull)r.late, (ull)r.duplicates, (ull)r.restarts, (ull)s.units,
           (ull)g.damaged, (ull)g.wait_idr, (ull)g.unlabelled, (ull)s.slice_less, (ull)s.frames,
           (ull)s.view_frames[kFront], (ull)s.view_frames[kLeft], (ull)s.view_frames[kRight], (ull)s.unmatched,
           (ull)s.duplicate, (ull)s.corrupted, (ull)s.not_shown, (ull)s.no_picture, (ull)s.too_old, (ull)s.bad_size,
           (ull)s.decode_errors, s.last_tag.b0, s.last_tag.application, s.last_tag.mode, s.last_tag.perspective,
           s.last_w, s.last_h);
    fflush(stdout);
}

int usage(const char *why)
{
    fprintf(stderr, "xop-camrx: %s\nusage: xop-camrx --stream ROLE --out-prefix /dev/shm/mgu-video-xop- --views front,left,right "
                    "[--dri /dev/dri/renderD128] [--control stdin]\n       xop-camrx --file capture.h264 | --rtp-file capture.rtp --out-prefix PREFIX --views ... [--keep]\n       "
                    "(--check-args first: validate only)\n",
            why);
    return 2;
}

}  // namespace

int main(int argc, char **argv)
{
    std::string stream, file, rtp_file, dri = "/dev/dri/renderD128", views_arg;
    Outputs out;
    out.prefix = kDefaultPrefix;
    bool control = false, keep = false, check_only = false;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        auto val = [&](std::string *dst) {
            if (i + 1 >= argc)
                return false;
            *dst = argv[++i];
            return true;
        };
        if (a == "--stream") { if (!val(&stream)) return usage("--stream needs a value"); }
        else if (a == "--file") { if (!val(&file)) return usage("--file needs a value"); }
        else if (a == "--rtp-file") { if (!val(&rtp_file)) return usage("--rtp-file needs a value"); }
        else if (a == "--check-args") check_only = true;
        else if (a == "--out-prefix") { if (!val(&out.prefix)) return usage("--out-prefix needs a value"); }
        else if (a == "--views") { if (!val(&views_arg)) return usage("--views needs a value"); }
        else if (a == "--dri") { if (!val(&dri)) return usage("--dri needs a value"); }
        else if (a == "--control") {
            std::string c;
            if (!val(&c) || c != "stdin")
                return usage("--control takes stdin");
            control = true;
        } else if (a == "--keep") keep = true;
        else return usage(("unknown argument " + a).c_str());
    }
    const bool replay = !file.empty() || !rtp_file.empty();
    if ((int)!stream.empty() + (int)!file.empty() + (int)!rtp_file.empty() != 1)
        return usage("one of --stream, --file or --rtp-file");
    if (replay && control)
        return usage("--control is for --stream");
    if (!stream.empty() && !valid_role(stream))
        return usage("bad --stream");
    /* replay (tests with the host stand-in decoder) may name /dev/null; live only a render node */
    if (!valid_dri(dri) && !(replay && dri == "/dev/null"))
        return usage("bad --dri");
    /* live: only the app's fixed prefix; replay (tests): an absolute prefix without ".." */
    if (!replay ? out.prefix != kDefaultPrefix : (out.prefix.empty() || out.prefix[0] != '/' || out.prefix.find("..") != std::string::npos || out.prefix.size() > 200))
        return usage("bad --out-prefix");
    size_t pos = 0;
    while (pos <= views_arg.size() && !views_arg.empty()) {
        size_t c = views_arg.find(',', pos);
        const std::string v = views_arg.substr(pos, c == std::string::npos ? std::string::npos : c - pos);
        int k = -1;
        for (int j = 0; j < kViews; j++)
            if (v == kViewNames[j])
                k = j;
        if (k < 0 || out.enabled[k])
            return usage("--views: front, left, right, each once");
        out.enabled[k] = true;
        if (c == std::string::npos)
            break;
        pos = c + 1;
    }
    if (!out.enabled[kFront] && !out.enabled[kLeft] && !out.enabled[kRight])
        return usage("--views is empty");
    if (check_only) {
        printf("ok\n");
        return 0;
    }

    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    signal(SIGPIPE, SIG_IGN);

    Pipeline pipe([&](View v, uint32_t w, uint32_t h, uint32_t m, uint32_t r, const uint8_t *i420) { out.write(v, w, h, m, r, i420); },
                  out.enabled, [] { return cld::now_ms(); });
    std::string err;
    if (!pipe.init(dri.c_str(), &err)) {
        log_error("decoder: %s", err.c_str());
        return 1;
    }
    print_caps(out);

    if (!file.empty()) {
        std::ifstream in(file, std::ios::binary);
        if (!in) {
            log_error("%s: cannot open", file.c_str());
            return 1;
        }
        std::vector<char> b(64 << 10);
        while (in && !g_quit) {
            in.read(b.data(), (std::streamsize)b.size());
            if (in.gcount() > 0)
                pipe.push_annexb(reinterpret_cast<const uint8_t *>(b.data()), (size_t)in.gcount(), false);
        }
        pipe.flush();
        print_stats(pipe, 0, 0, true);
        pipe.shutdown();
        out.close_all(!keep);
        return 0;
    }
    if (!rtp_file.empty()) {
        std::ifstream in(rtp_file, std::ios::binary);
        if (!in) {
            log_error("%s: cannot open", rtp_file.c_str());
            return 1;
        }
        std::vector<uint8_t> pkt;
        uint64_t packets = 0;
        uint8_t len[4];
        while (!g_quit && in.read(reinterpret_cast<char *>(len), 4)) {
            const uint32_t n = len[0] | (uint32_t)len[1] << 8 | (uint32_t)len[2] << 16 | (uint32_t)len[3] << 24;
            if (n > 65536) {
                log_error("%s: bad record length %u", rtp_file.c_str(), n);
                break;
            }
            pkt.resize(n);
            if (!in.read(reinterpret_cast<char *>(pkt.data()), (std::streamsize)n))
                break;
            packets++;
            pipe.push_rtp(pkt.data(), pkt.size());
        }
        pipe.flush();
        print_stats(pipe, 0, packets, true);
        pipe.shutdown();
        out.close_all(!keep);
        return 0;
    }

#ifdef XOP_NO_AVB
    log_error("this build has no AVB receiver (host test build)");
    return 1;
#else
    PacketQueue queue([] { return cld::now_ms(); });
    Control ctl;
    bool want = !control;
    woc::AvbSource avb;
    bool receiving = false;
    int64_t last_stats = cld::now_ms(), retry_at = 0;
    std::vector<uint8_t> pkt;
    uint64_t overloads = 0;
    while (!g_quit) {
        if (control) {
            /* stdin is checked every turn; packets are waited for below while receiving */
            const Control::Ev ev = ctl.poll_once(receiving ? 0 : 100);
            if (ev == Control::Eof) {
                log_info("control: stdin closed: stopping");
                break;
            }
            if (ev == Control::On)
                want = true;
            else if (ev == Control::Off)
                want = false;
        }
        if (want && !receiving && cld::now_ms() >= retry_at) {
            std::string e;
            /* the callback runs on the IAS bridge's thread, inside its (libstdc++) frames: no exception may leave it */
            if (avb.start(stream, [&](const uint8_t *p, size_t n) noexcept {
                    try {
                        queue.push(p, n);
                    } catch (...) {
                        queue.note_drop();
                    }
                }, &e))
                receiving = true;
            else {
                log_warn("avb: %s (again in 5000 ms)", e.c_str());
                retry_at = cld::now_ms() + 5000;
            }
        } else if (!want && receiving) {
            avb.stop();
            receiving = false;
            queue.clear();
            /* the next "video on" starts from nothing: no unit, id or decoded picture from before is shown */
            pipe.reset();
            out.close_all(true);
        }
        if (receiving) {
            int64_t rx = -1;
            const PacketQueue::Pop got = queue.pop(&pkt, 100, &rx);
            if (got == PacketQueue::Packet) {
                pipe.push_rtp(pkt.data(), pkt.size(), rx);
            } else if (got == PacketQueue::Overload) {
                /* decoding fell behind: what was queued is late, and later units may refer to what was dropped */
                overloads++;
                pipe.reset();
            }
        } else if (!control) {
            usleep(100 * 1000);   /* waiting to retry the receiver */
        }
        if (cld::now_ms() - last_stats >= 5000) {
            last_stats = cld::now_ms();
            print_stats(pipe, queue.drops(), avb.packets(), receiving, queue.stale(), overloads);
        }
    }
    avb.stop();
    pipe.shutdown();
    out.close_all(true);
    return 0;
#endif
}
