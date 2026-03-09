"use strict";

/**
 * ack-tracker.cjs — Control message delivery guarantees.
 *
 * Every control message that requires_ack gets tracked.
 * States: pending → acked | expired
 * Expired messages can be retried up to maxRetries.
 *
 * The reactor uses this to know if children actually received instructions.
 */

const { EventEmitter } = require("events");

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

class AckTracker extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    this.maxRetries = opts.maxRetries || DEFAULT_MAX_RETRIES;
    this.pending = new Map();   // msg_id → { message, session, sent_at, retries, timer }
    this.history = [];          // completed ack records for analysis
  }

  /**
   * Track a sent message that requires acknowledgment.
   */
  track(msgId, session, message) {
    if (!message.requires_ack) return;

    const ttl = message.ttl_ms || this.ttlMs;

    const timer = setTimeout(() => {
      this._onExpired(msgId);
    }, ttl);

    this.pending.set(msgId, {
      msg_id: msgId,
      session,
      message,
      sent_at: Date.now(),
      retries: 0,
      timer,
    });

    this.emit("tracked", { msg_id: msgId, session, ttl });
  }

  /**
   * Process an ACK from a child.
   */
  ack(msgId) {
    const entry = this.pending.get(msgId);
    if (!entry) return false; // Unknown or already processed

    clearTimeout(entry.timer);
    this.pending.delete(msgId);

    const record = {
      msg_id: msgId,
      session: entry.session,
      status: "acked",
      sent_at: entry.sent_at,
      acked_at: Date.now(),
      latency_ms: Date.now() - entry.sent_at,
      retries: entry.retries,
    };

    this.history.push(record);
    this.emit("acked", record);
    return true;
  }

  _onExpired(msgId) {
    const entry = this.pending.get(msgId);
    if (!entry) return;

    if (entry.retries < this.maxRetries) {
      // Retry
      entry.retries++;
      const ttl = entry.message.ttl_ms || this.ttlMs;
      entry.timer = setTimeout(() => this._onExpired(msgId), ttl);

      this.emit("retry", {
        msg_id: msgId,
        session: entry.session,
        attempt: entry.retries,
        max: this.maxRetries,
      });
    } else {
      // Exhausted retries
      this.pending.delete(msgId);

      const record = {
        msg_id: msgId,
        session: entry.session,
        status: "expired",
        sent_at: entry.sent_at,
        expired_at: Date.now(),
        retries: entry.retries,
      };

      this.history.push(record);
      this.emit("expired", record);
    }
  }

  /**
   * Get all pending messages for a session.
   */
  getPending(session) {
    const result = [];
    for (const [, entry] of this.pending) {
      if (!session || entry.session === session) {
        result.push({
          msg_id: entry.msg_id,
          session: entry.session,
          type: entry.message.type,
          sent_at: entry.sent_at,
          retries: entry.retries,
          age_ms: Date.now() - entry.sent_at,
        });
      }
    }
    return result;
  }

  /**
   * Get delivery stats for pattern mining.
   */
  getStats() {
    const acked = this.history.filter((r) => r.status === "acked");
    const expired = this.history.filter((r) => r.status === "expired");
    const avgLatency = acked.length > 0
      ? acked.reduce((s, r) => s + r.latency_ms, 0) / acked.length
      : 0;

    return {
      total_sent: this.history.length + this.pending.size,
      acked: acked.length,
      expired: expired.length,
      pending: this.pending.size,
      avg_latency_ms: Math.round(avgLatency),
      retry_rate: this.history.length > 0
        ? this.history.filter((r) => r.retries > 0).length / this.history.length
        : 0,
    };
  }

  /**
   * Get the retry entry for a message (so reactor can re-send).
   */
  getRetryEntry(msgId) {
    return this.pending.get(msgId) || null;
  }

  destroy() {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}

module.exports = { AckTracker };
