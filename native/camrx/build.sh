#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terrain Monitor contributors
#
# xop-camrx build (Zig as the C/C++ cross compiler; no other toolchain needed):
#   ./build.sh host-test   x86-64 macOS build of the tests on idrive-apps' stand-in MSDK (runs under Rosetta on
#                          Apple silicon) and a replay binary (--file) for the app-side end-to-end test
#   ./build.sh target      the head unit's binary: x86-64 Linux, glibc 2.27, interpreter /lib/ld-linux-x86-64.so.2,
#                          linked against link-only stubs of the unit's libmfxhw64 / libva / libva-drm / IAS AVB
#                          bridge (from abi/*.symbols); then every import checked (tools/elfabi.py check)
# ZIG (default: the workspace's work/toolchains/zig-aarch64-macos-0.14.1/zig) and its caches can be overridden.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=${XOP_ROOT:-$(cd "$HERE/../../../.." && pwd)}
ZIG=${ZIG:-$ROOT/work/toolchains/zig-aarch64-macos-0.14.1/zig}
export ZIG_GLOBAL_CACHE_DIR=${ZIG_GLOBAL_CACHE_DIR:-$ROOT/work/toolchains/cache}
export ZIG_LOCAL_CACHE_DIR=${ZIG_LOCAL_CACHE_DIR:-$ROOT/work/toolchains/local-cache}
OUT=${XOP_CAMRX_OUT:-$HERE/build}
TP=$HERE/third_party/idrive-apps
WOC=$TP/waze-on-cluster
CR=$TP/cluster-render
INC="-I$HERE/src -I$WOC/src -I$CR/kit -I$CR/src -I$WOC/abi/include -I$WOC/test"
SRC="$HERE/src/sei_tag.cpp $HERE/src/views.cpp $HERE/src/mgvf.cpp $HERE/src/au.cpp $HERE/src/rtp_au.cpp $HERE/src/gate.cpp \
$HERE/src/pipeline.cpp $WOC/src/decoder_msdk.cpp $WOC/src/nal_reader.cpp $WOC/src/sps_info.cpp $CR/kit/yuv_atlas.cpp $CR/src/log.cpp"
# the decoder fixtures (original test material of the camera research, RTP + manifest per scenario)
FIXTURES=${XOP_FIXTURES:-$ROOT/work/claude/camera-research-worker/decoder-fixtures/generated}
EXTRA_FIXTURES=${XOP_EXTRA_FIXTURES:-$ROOT/work/claude/camera-research-worker/producer-tests/extra-fixtures}
CXXFLAGS="-std=c++14 -O2 -g -Wall -Wextra"
TFLAGS="-std=c++14 -O2 -Wall -Wextra -ffile-prefix-map=$HERE=. -fPIE -pie -s -Wl,-z,noexecstack -Wl,-z,relro -Wl,-z,now"
INTERP=/lib/ld-linux-x86-64.so.2
# ld-linux-x86-64.so.2: the dynamic loader itself (already mapped as the interpreter); only __tls_get_addr@GLIBC_2.3
# (TLS of the static libc++), pinned by elfabi.py check --ldso-versions
NEEDED=libmfxhw64.so,libva.so.1,libva-drm.so.1,libias-media_transport-avb_ufipc_bridge.so.1,libc.so.6,libm.so.6,libpthread.so.0,libdl.so.2,librt.so.1,ld-linux-x86-64.so.2

host_test() {
    mkdir -p "$OUT/host"
    # shellcheck disable=SC2086
    "$ZIG" c++ -target x86_64-macos $CXXFLAGS -DXOP_NO_AVB $INC $SRC "$WOC/test/fake_msdk.cpp" "$HERE/test/camrx_test.cpp" \
        -o "$OUT/host/camrx_test"
    # shellcheck disable=SC2086
    "$ZIG" c++ -target x86_64-macos $CXXFLAGS -DXOP_NO_AVB $INC $SRC "$WOC/test/fake_msdk.cpp" "$HERE/src/main.cpp" \
        -o "$OUT/host/xop-camrx-replay"
    # shellcheck disable=SC2086
    "$ZIG" c++ -target x86_64-macos $CXXFLAGS $INC "$HERE/src/sei_tag.cpp" "$HERE/src/au.cpp" "$HERE/src/rtp_au.cpp" \
        "$HERE/src/gate.cpp" "$HERE/src/views.cpp" "$CR/kit/yuv_atlas.cpp" "$HERE/test/rtp_gate_dump.cpp" -o "$OUT/host/rtp_gate_dump"
    tmp=$(mktemp -d)
    "$OUT/host/camrx_test" "$tmp"
    rm -rf "$tmp"
    "$OUT/host/xop-camrx-replay" --check-args --stream media_transport.avb_streaming.1 --out-prefix /dev/shm/mgu-video-xop- \
        --views front,left,right --control stdin --dri /dev/dri/renderD128
    if [ -d "$FIXTURES" ]; then
        # shellcheck disable=SC2046
        python3 -I "$HERE/test/check_fixtures.py" "$OUT/host/rtp_gate_dump" "$FIXTURES" $([ -d "$EXTRA_FIXTURES" ] && echo "$EXTRA_FIXTURES")
    else
        echo "decoder fixtures not found ($FIXTURES): fixture check skipped" >&2
    fi
}

target() {
    mkdir -p "$OUT/target/stub"
    for pair in "libmfx:libmfxhw64.so" "libva:libva.so.1" "libva-drm:libva-drm.so.1" \
                "libias_avb:libias-media_transport-avb_ufipc_bridge.so.1"; do
        list=${pair%%:*}
        soname=${pair#*:}
        python3 -I "$HERE/tools/elfabi.py" stub-source "$WOC/abi/$list.symbols" > "$OUT/target/stub/$list.c"
        "$ZIG" cc -target x86_64-linux-gnu.2.27 -shared -Wl,-soname,"$soname" -o "$OUT/target/stub/$soname" "$OUT/target/stub/$list.c"
    done
    # shellcheck disable=SC2086
    # release: no debug info / build paths (-ffile-prefix-map), stripped, PIE, non-executable stack
    "$ZIG" c++ -target x86_64-linux-gnu.2.27 $TFLAGS -pthread $INC $SRC "$WOC/src/avb_source.cpp" "$HERE/src/main.cpp" \
        "$OUT/target/stub/libmfxhw64.so" "$OUT/target/stub/libva.so.1" "$OUT/target/stub/libva-drm.so.1" \
        "$OUT/target/stub/libias-media_transport-avb_ufipc_bridge.so.1" -o "$OUT/target/xop-camrx"
    python3 -I "$HERE/tools/elfabi.py" set-interp "$OUT/target/xop-camrx" "$INTERP"
    python3 -I "$HERE/tools/elfabi.py" check "$OUT/target/xop-camrx" --ldso-versions GLIBC_2.3 --stripped --interp "$INTERP" --glibc 2.27 --needed "$NEEDED" \
        "$WOC/abi/libmfx.symbols" "$WOC/abi/libva.symbols" "$WOC/abi/libva-drm.symbols" "$WOC/abi/libias_avb.symbols"
}

case "${1:-}" in
host-test) host_test ;;
target) target ;;
all) host_test; target ;;
*) echo "usage: $0 host-test | target | all" >&2; exit 2 ;;
esac
