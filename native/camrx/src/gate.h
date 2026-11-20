// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
/* Which access units may be shown, decided in DECODING order as each unit goes to the decoder (decoder-report.md
 * §4.5): a damaged unit is never shown, and nothing decoded after it either (it may refer to the damage) until a
 * clean IDR unit; at the start and after a reset the same wait applies. A unit's camera label is its own (au.h);
 * an IDR without a label still ends the wait (its references are whole) but is not shown itself, nor is a unit
 * whose label names no view this helper makes (perspective 0, rear alone, > 10). A damaged unit left without any
 * slice (its slices lost) is a lost picture: later ones may refer to it, so it starts the same wait. Ids are
 * 64-bit, from 1, never reused while the process runs. */
#ifndef XOP_GATE_H
#define XOP_GATE_H

#include <stdint.h>

#include "au.h"

namespace xop {

enum class Why { Show, Damaged, WaitIdr, Label, NoView };

struct Admission {
    uint64_t id = 0;
    AuLabel label;
    Why why = Why::Label;
    bool show() const { return why == Why::Show; }
};

struct GateStats {
    uint64_t admitted = 0, shown = 0, damaged = 0, wait_idr = 0, unlabelled = 0, no_view = 0, lost = 0;
    uint64_t idr = 0, clean_idr = 0;
};

class AuGate {
public:
    /* A unit with a slice: its id and whether it may be shown. */
    Admission admit(const Au &au);
    /* A unit without a slice (never given to the decoder): a damaged one starts the wait for an IDR. */
    void no_slice(const Au &au);
    /* An output frame turned out concealed/corrupted. A newer IDR already submitted in decode order
     * is independent of that frame, even when display-order output reports the damage later. */
    void damage_seen(uint64_t id) { if (id >= recovery_id_) need_idr_ = true; }
    /* "video off": start over (wait for an IDR); ids keep counting. */
    void reset() { need_idr_ = true; recovery_id_ = 0; }
    bool waiting_idr() const { return need_idr_; }
    uint64_t recovery_id() const { return recovery_id_; }
    const GateStats &stats() const { return st_; }

private:
    uint64_t next_ = 0;
    uint64_t recovery_id_ = 0;
    bool need_idr_ = true;
    GateStats st_;
};

}  // namespace xop

#endif
