// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
#include "mgvf.h"

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

namespace xop {

MgvfFile::~MgvfFile() { close(false); }

static bool pwrite_all(int fd, const void *buf, size_t n, off_t at)
{
    const uint8_t *p = static_cast<const uint8_t *>(buf);
    while (n) {
        ssize_t r = pwrite(fd, p, n, at);
        if (r < 0) {
            if (errno == EINTR)
                continue;
            return false;
        }
        p += r;
        n -= (size_t)r;
        at += r;
    }
    return true;
}

static void le32(uint8_t *b, uint32_t v)
{
    b[0] = (uint8_t)v;
    b[1] = (uint8_t)(v >> 8);
    b[2] = (uint8_t)(v >> 16);
    b[3] = (uint8_t)(v >> 24);
}

bool MgvfFile::open(const std::string &path, uint32_t w, uint32_t h, uint32_t matrix, uint32_t range, std::string *err)
{
    close(false);
    if (w < 16 || h < 16 || w > 2048 || h > 2048 || (w & 1) || (h & 1) || matrix > 1 || range > 1) {
        *err = "bad video size or colour";
        return false;
    }
    if (kMgvfHeader + (uint64_t)kMgvfSlots * w * h * 3 / 2 > kMgvfMaxFile) {
        *err = "video file over the per-view budget";
        return false;
    }
    struct stat st;
    if (lstat(path.c_str(), &st) == 0 && !S_ISREG(st.st_mode)) {
        *err = path + ": not a regular file";
        return false;
    }
    int fd = ::open(path.c_str(), O_RDWR | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
    if (fd < 0) {
        *err = path + ": " + strerror(errno);
        return false;
    }
    fchmod(fd, 0644);
    const off_t size = kMgvfHeader + (off_t)kMgvfSlots * w * h * 3 / 2;
    if (ftruncate(fd, size) != 0) {
        *err = path + ": " + strerror(errno);
        ::close(fd);
        return false;
    }
    uint8_t head[kMgvfHeader];
    memset(head, 0, sizeof head);
    const uint32_t words[9] = {kMgvfMagic, 1, w, h, 0, 0, kMgvfSlots, matrix, range};
    for (int i = 0; i < 9; i++)
        le32(head + i * 4, words[i]);
    if (!pwrite_all(fd, head, sizeof head, 0)) {
        *err = path + ": " + strerror(errno);
        ::close(fd);
        return false;
    }
    fd_ = fd;
    path_ = path;
    w_ = w;
    h_ = h;
    matrix_ = matrix;
    range_ = range;
    seq_ = 0;
    slot_ = 0;
    return true;
}

bool MgvfFile::put32(uint32_t index, uint32_t v, std::string *err)
{
    uint8_t b[4];
    le32(b, v);
    if (!pwrite_all(fd_, b, 4, (off_t)index * 4)) {
        *err = path_ + ": " + strerror(errno);
        return false;
    }
    return true;
}

bool MgvfFile::write(const uint8_t *i420, std::string *err)
{
    if (fd_ < 0) {
        *err = "not open";
        return false;
    }
    const size_t n = (size_t)w_ * h_ * 3 / 2;
    const uint32_t next = (slot_ + 1) % kMgvfSlots;
    if (!pwrite_all(fd_, i420, n, kMgvfHeader + (off_t)next * n)) {
        *err = path_ + ": " + strerror(errno);
        return false;
    }
    if (!put32(5, next, err))
        return false;
    slot_ = next;
    if (!put32(4, seq_ + 1, err))
        return false;
    seq_++;
    return true;
}

void MgvfFile::close(bool unlink_file)
{
    if (fd_ < 0)
        return;
    /* remove the path only while it is still this file: another writer (a newer helper started while this one was
     * stopping) may have replaced it, and its frames must not disappear */
    struct stat mine, now;
    const bool ours = fstat(fd_, &mine) == 0 && lstat(path_.c_str(), &now) == 0 && mine.st_ino == now.st_ino && mine.st_dev == now.st_dev;
    ::close(fd_);
    fd_ = -1;
    if (unlink_file && ours)
        ::unlink(path_.c_str());
}

}  // namespace xop
