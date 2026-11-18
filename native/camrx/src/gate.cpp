// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
#include "gate.h"

#include "views.h"

namespace xop {

Admission AuGate::admit(const Au &au)
{
    Admission a;
    a.id = ++next_;
    a.label = au_label(au);
    st_.admitted++;
    if (au.discontinuity)
        need_idr_ = true;
    if (au.damaged) {
        need_idr_ = true;
        a.why = Why::Damaged;
        st_.damaged++;
        return a;
    }
    if (need_idr_) {
        if (!au.idr) {
            a.why = Why::WaitIdr;
            st_.wait_idr++;
            return a;
        }
        need_idr_ = false;   /* a clean IDR: the references are whole again */
    }
    if (a.label.verdict != LabelVerdict::Ok) {
        a.why = Why::Label;
        st_.unlabelled++;
        return a;
    }
    Crop crops[2];
    if (!crops_for(a.label.tag, 1280, 480, crops)) {   /* the perspective names no front / left / right view */
        a.why = Why::NoView;
        st_.no_view++;
        return a;
    }
    a.why = Why::Show;
    st_.shown++;
    return a;
}

void AuGate::no_slice(const Au &au)
{
    if (au.discontinuity)
        need_idr_ = true;
    if (au.damaged) {
        need_idr_ = true;
        st_.lost++;
    }
}

}  // namespace xop
