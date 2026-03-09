"use strict";

/**
 * lock-manager.cjs — Pre-write lock arbitration.
 *
 * Flow:
 *   1. Child emits intent_write { files: [...] }
 *   2. LockManager checks for conflicts
 *   3. Responds lock_granted or lock_denied
 *   4. Child writes only after grant
 *   5. Child emits file_written → lock auto-released
 *
 * Locks expire after TTL to prevent deadlocks from crashed children.
 */

const { EventEmitter } = require("events");
const { ts } = require("./schema.cjs");

const DEFAULT_LOCK_TTL_MS = 30_000;

class LockManager extends EventEmitter {
  constructor(ttlMs = DEFAULT_LOCK_TTL_MS) {
    super();
    this.locks = new Map();    // filePath → { session, acquired_at, expires_at, timer }
    this.ttlMs = ttlMs;
    this.pendingQueue = [];    // { session, file, resolve } — queued requests
  }

  /**
   * Request lock on a set of files.
   * Returns { granted: string[], denied: { file, holder }[] }
   */
  requestLock(sessionId, files) {
    const granted = [];
    const denied = [];

    for (const file of files) {
      const existing = this.locks.get(file);

      if (existing && existing.session !== sessionId) {
        // Check expiry
        if (Date.now() > existing.expires_at) {
          this._releaseLock(file, "expired");
          // Fall through to acquire
        } else {
          denied.push({ file, holder: existing.session });
          continue;
        }
      }

      // Acquire or re-acquire
      this._acquireLock(file, sessionId);
      granted.push(file);
    }

    const result = { granted, denied };

    this.emit("lock_result", {
      session: sessionId,
      ...result,
      ts: ts(),
    });

    return result;
  }

  _acquireLock(file, sessionId) {
    // Clear any existing timer
    const existing = this.locks.get(file);
    if (existing?.timer) clearTimeout(existing.timer);

    const expiresAt = Date.now() + this.ttlMs;
    const timer = setTimeout(() => {
      this._releaseLock(file, "expired");
      this._processQueue(file);
    }, this.ttlMs);

    this.locks.set(file, {
      session: sessionId,
      acquired_at: Date.now(),
      expires_at: expiresAt,
      timer,
    });

    this.emit("lock_acquired", { file, session: sessionId, expires_at: expiresAt });
  }

  /**
   * Release locks on files. Called after file_written event.
   */
  releaseLock(sessionId, files) {
    for (const file of files) {
      const lock = this.locks.get(file);
      if (lock && lock.session === sessionId) {
        this._releaseLock(file, "released");
        this._processQueue(file);
      }
    }
  }

  _releaseLock(file, reason) {
    const lock = this.locks.get(file);
    if (!lock) return;
    if (lock.timer) clearTimeout(lock.timer);
    this.locks.delete(file);
    this.emit("lock_released", { file, session: lock.session, reason });
  }

  /**
   * Release all locks held by a session (cleanup on disconnect/done).
   */
  releaseAll(sessionId) {
    for (const [file, lock] of this.locks) {
      if (lock.session === sessionId) {
        this._releaseLock(file, "session_ended");
        this._processQueue(file);
      }
    }
  }

  /**
   * Queue a lock request for when the file becomes available.
   */
  queueRequest(sessionId, file) {
    this.pendingQueue.push({ session: sessionId, file, queued_at: Date.now() });
    this.emit("lock_queued", { file, session: sessionId });
  }

  _processQueue(file) {
    const idx = this.pendingQueue.findIndex((r) => r.file === file);
    if (idx === -1) return;
    const req = this.pendingQueue.splice(idx, 1)[0];
    const result = this.requestLock(req.session, [file]);
    if (result.granted.length > 0) {
      this.emit("queued_lock_granted", { file, session: req.session });
    }
  }

  /**
   * Check if a session holds a lock on a file.
   */
  holdsLock(sessionId, file) {
    const lock = this.locks.get(file);
    return lock && lock.session === sessionId && Date.now() <= lock.expires_at;
  }

  /**
   * Snapshot for serialization.
   */
  snapshot() {
    const result = {};
    for (const [file, lock] of this.locks) {
      result[file] = {
        session: lock.session,
        acquired_at: lock.acquired_at,
        expires_at: lock.expires_at,
        remaining_ms: Math.max(0, lock.expires_at - Date.now()),
      };
    }
    return result;
  }

  destroy() {
    for (const [, lock] of this.locks) {
      if (lock.timer) clearTimeout(lock.timer);
    }
    this.locks.clear();
    this.pendingQueue = [];
  }
}

module.exports = { LockManager };
