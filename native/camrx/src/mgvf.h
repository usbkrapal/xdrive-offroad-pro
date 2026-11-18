// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
/* mgu-render's video frame file (mgu-render 0.6.21 PROTOCOL.md "Video"): a 64-byte header (u32 LE: magic
 * 0x4656474d, version 1, w, h, seq, slot, nslot, matrix 0 BT.601 / 1 BT.709, range 0 limited / 1 full, zeros)
 * then nslot I420 frames. Written in the protocol's order: the frame into slot (slot + 1) % nslot, then slot,
 * then seq + 1. The same layout as the app's reader/writer (native/src/camera/mgvf.ts). */
#ifndef XOP_MGVF_H
#define XOP_MGVF_H

#include <stddef.h>
#include <stdint.h>
#include <string>

namespace xop {

static const uint32_t kMgvfMagic = 0x4656474d;
static const uint32_t kMgvfHeader = 64;
static const uint32_t kMgvfSlots = 3;
/* mgu-render maps at most 12 MiB of video files per app; three views each get a third. */
static const uint64_t kMgvfMaxFile = 4u << 20;

class MgvfFile {
public:
    ~MgvfFile();
    /* Creates or replaces path (a regular file, never followed through a link), sized for w x h. */
    bool open(const std::string &path, uint32_t w, uint32_t h, uint32_t matrix, uint32_t range, std::string *err);
    /* One I420 frame of exactly w*h*3/2 bytes. */
    bool write(const uint8_t *i420, std::string *err);
    /* Closes; unlink removes the file (stopping: the renderer then draws nothing, never a frozen frame), but only
     * while the path still names this file (not one a newer writer put there). */
    void close(bool unlink);
    bool is_open() const { return fd_ >= 0; }
    uint32_t w() const { return w_; }
    uint32_t h() const { return h_; }
    uint32_t matrix() const { return matrix_; }
    uint32_t range() const { return range_; }
    uint32_t seq() const { return seq_; }

private:
    bool put32(uint32_t index, uint32_t v, std::string *err);
    int fd_ = -1;
    std::string path_;
    uint32_t w_ = 0, h_ = 0, matrix_ = 0, range_ = 0, seq_ = 0, slot_ = 0;
};

}  // namespace xop

#endif
