// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terrain Monitor contributors
#ifndef XOP_PACKET_QUEUE_H
#define XOP_PACKET_QUEUE_H

#include <stddef.h>
#include <stdint.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <vector>

namespace xop {

/* Bounded queue of RTP datagrams from the AVB bridge's thread to the decode thread (the bridge's thread never
 * blocks on decoding). Each packet keeps its arrival time. A full queue drops the arrival and marks an overflow;
 * the decode side then discards the backlog (Pop::Overload) and the pipeline restarts at a clean IDR. */
class PacketQueue {
public:
    static const size_t kPackets = 1024, kBytes = 8u << 20;
    /* Oldest packet the decode thread still takes (ms since it arrived). Anything older means decoding fell behind:
     * the backlog is discarded and the pipeline restarts at the next clean IDR, so a frame written as fresh never
     * waited longer than this in the queue. */
    static const int64_t kMaxAgeMs = 250;
    explicit PacketQueue(std::function<int64_t()> clock) : clock_(std::move(clock)) {}
    enum Pop { None, Packet, Overload };
    void push(const uint8_t *p, size_t n)
    {
        const int64_t now = clock_();
        std::lock_guard<std::mutex> l(m_);
        if (q_.size() >= kPackets || bytes_ + n > kBytes) {
            drops_++;
            overflow_ = true;
            return;
        }
        q_.push_back(Item{std::vector<uint8_t>(p, p + n), now});
        bytes_ += n;
        cv_.notify_one();
    }
    /* at: the packet's arrival time (the clock's ms), kept so a unit's age counts from its first packet. */
    Pop pop(std::vector<uint8_t> *out, int wait_ms, int64_t *at = nullptr)
    {
        std::unique_lock<std::mutex> l(m_);
        if (q_.empty() && !overflow_)
            cv_.wait_for(l, std::chrono::milliseconds(wait_ms));
        if (overflow_flag_.exchange(false))
            overflow_ = true;
        if (overflow_ || (!q_.empty() && clock_() - q_.front().at > kMaxAgeMs)) {
            overflow_ = false;
            stale_ += q_.size();
            q_.clear();
            bytes_ = 0;
            return Overload;
        }
        if (q_.empty())
            return None;
        out->swap(q_.front().b);
        if (at)
            *at = q_.front().at;
        q_.pop_front();
        bytes_ -= out->size();
        return Packet;
    }
    void clear()
    {
        std::lock_guard<std::mutex> l(m_);
        q_.clear();
        bytes_ = 0;
        overflow_ = false;
    }
    /* a packet lost outside push's own checks (an allocation failure): counted, and the backlog is discarded */
    void note_drop() noexcept
    {
        drops_++;
        overflow_flag_ = true;
    }
    uint64_t drops() const { return drops_.load(); }
    uint64_t stale() const
    {
        std::lock_guard<std::mutex> l(m_);
        return stale_;
    }

private:
    struct Item {
        std::vector<uint8_t> b;
        int64_t at;
    };
    std::function<int64_t()> clock_;
    mutable std::mutex m_;
    std::condition_variable cv_;
    std::deque<Item> q_;
    size_t bytes_ = 0;
    bool overflow_ = false;
    uint64_t stale_ = 0;
    std::atomic<uint64_t> drops_{0};
    std::atomic<bool> overflow_flag_{false};
};

}  // namespace xop

#endif
