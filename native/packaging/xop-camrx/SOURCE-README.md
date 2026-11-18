# xop-camrx: corresponding source

This archive is the complete corresponding source of the `xop-camrx` program in the Store component
`xop-camrx@<version>.tgz` (GNU GPL version 3 or later, `native/camrx/LICENSE`).

## Contents

- `native/camrx/src/`: the program (Terrain Monitor contributors).
- `native/camrx/third_party/idrive-apps/`: code copied from
  [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps) (GPL-3.0-or-later; Intel's MSDK
  headers in `waze-on-cluster/abi/include/mfx` under their own MIT licence). `PROVENANCE.txt` names the upstream
  commit and lists every copied file as identical to it or modified. Each modified file says what changed at its top.
- `native/camrx/build.sh`, `native/camrx/tools/elfabi.py`: the build, and the link-only stubs and import checks it
  uses. The stubs are generated from `third_party/idrive-apps/waze-on-cluster/abi/*.symbols` at build time; they are
  needed only to link and are **not** installed.
- `native/camrx/test/`: the host tests.
- `native/packaging/xop-camrx/`: the component manifest and the NOTICE template that install the program
  (`/var/opt/xop-camrx/versions/<version>/xop-camrx`, run by the separate `xop-camera-bridge` service).
- `BUILD-INFO.txt`: the toolchain and the command that produced the shipped binary, and its sha256.

## Building

Zig 0.14.1 (the official `zig-aarch64-macos-0.14.1` or another host's build of the same version) as the C/C++
cross compiler:

```
ZIG=/path/to/zig sh native/camrx/build.sh target
```

The result is `native/camrx/build/target/xop-camrx`: x86-64 Linux, glibc 2.27, interpreter
`/lib/ld-linux-x86-64.so.2`, stripped. `build.sh host-test` builds and runs the host tests (macOS x86-64).
