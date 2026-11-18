#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terrain Monitor contributors
"""Checks xop-camrx's RTP framing and show/drop gate against the decoder fixtures' manifests.

For every <scenario>.rtp + <scenario>.json in FIXTURE_DIR, runs DUMP (build/host/rtp_gate_dump) and checks, per
access unit the gate passed for showing (identified by its first slice's first 24 bytes, matched in order against
the pictures of the fixture's .h264, whose order is the manifest's):
  - its label is the manifest's own tag for that picture (pair9 / pair10), never another;
  - the expectation for its display index is not "drop".
In the scenarios without damage (clean, seq_wrap, and the producer review's x_stapa, x_stapa_sei_slice, x_ts_wrap,
x_duplicate (an exact repeated packet), x_seq_restart (sender restart: new SSRC, lower numbers, then an IDR)) every
access unit must be shown. Units the gate drops beyond what a scenario
requires (it waits for the next IDR after damage) are counted, not failures: the decoder-side rules (Corrupted
frames) can only drop more.

usage: python3 -I check_fixtures.py DUMP FIXTURE_DIR [FIXTURE_DIR ...]
"""
import json
import os
import subprocess
import sys


ALL_SHOWN = {'x_stapa', 'x_stapa_sei_slice', 'x_ts_wrap', 'x_duplicate', 'x_seq_restart'}


def fingerprints(h264):
    """The first 24 bytes of each picture's first slice (first_mb_in_slice 0), in decoding order."""
    data, out = open(h264, 'rb').read(), []
    starts, i = [], 0
    while True:
        j = data.find(b'\x00\x00\x01', i)
        if j < 0:
            break
        starts.append(j + 3)
        i = j + 3
    for k, st in enumerate(starts):
        nal = data[st:(starts[k + 1] - 3 if k + 1 < len(starts) else len(data))].rstrip(b'\x00')
        if len(nal) > 1 and 1 <= (nal[0] & 0x1F) <= 5 and nal[1] & 0x80:
            out.append(nal[:24].hex())
    return out


def check(dump, d, name):
    man = json.load(open(os.path.join(d, name + '.json')))
    fps = fingerprints(os.path.join(d, name + '.h264'))
    last = -1
    out = subprocess.run([dump, os.path.join(d, name + '.rtp')], check=True, stdout=subprocess.PIPE,
                         universal_newlines=True).stdout.splitlines()
    problems, shown, extra_drops = [], 0, 0
    for line in out:
        f = line.split()
        if f[0] != 'au':
            continue
        show, persp, fp = f[2] == '1', f[3], f[7]
        if fp == '-':
            continue   # no slice
        cand = [k for k in range(last + 1, len(fps)) if fps[k] == fp] or [k for k in range(len(fps)) if fps[k] == fp]
        if not cand:
            problems.append(f'unit rtp_ts {f[1]}: no such picture in the fixture')
            continue
        last = max(last, cand[0])
        a = man['access_units'][cand[0]]
        want = man['expect'][str(a['display'])]
        if show:
            shown += 1
            if want == 'drop':
                problems.append(f'display {a["display"]} shown, must be dropped ({a["note"]})')
            elif persp != want[4:]:
                problems.append(f'display {a["display"]} shown as tag {persp}, is {want}')
        elif want != 'drop':
            extra_drops += 1
    whole = name.endswith('_clean') or name.endswith('_seq_wrap') or name in ALL_SHOWN
    if whole and shown != len(man['access_units']):
        problems.append(f'{shown} of {len(man["access_units"])} shown in a scenario without damage')
    return problems, shown, extra_drops, len(man['access_units'])


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    dump = argv[1]
    names = []
    for d in argv[2:]:
        found = sorted(n[:-4] for n in os.listdir(d) if n.endswith('.rtp') and os.path.exists(os.path.join(d, n[:-4] + '.json')))
        if not found:
            print('no fixtures in ' + d, file=sys.stderr)
            return 1
        names += [(d, n) for n in found]
    failed = 0
    for d, name in names:
        problems, shown, extra, total = check(dump, d, name)
        print(f'{"FAIL" if problems else "ok  "} {name}: {shown}/{total} shown, {extra} more dropped than required')
        for p in problems:
            print('     ' + p)
        failed += bool(problems)
    print(f'{len(names)} scenarios, {failed} failed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
