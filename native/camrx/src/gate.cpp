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
    a.intra = au_all_intra(au);
    st_.admitted++;
    if (a.intra) st_.intra++;
    if (au.idr) {
        st_.idr++;
        if (!au.damaged) st_.clean_idr++;
    }
    if (au.discontinuity)
        need_idr_ = true;
    if (au.damaged) {
        need_idr_ = true;
        a.why = Why::Damaged;
        st_.damaged++;
        return a;
    }
    if (au.idr)
        recovery_id_ = a.id;
    if (need_idr_) {
        if (!au.idr && !a.intra) {
            a.why = Why::WaitIdr;
            st_.wait_idr++;
            return a;
        }
        if (au.idr) need_idr_ = false;   /* only IDR restores the chain for following P/B pictures */
    }
    a.chain_ok = !need_idr_;
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
