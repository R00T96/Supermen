"use strict";

/**
 * swarm-reactor.cjs v2 — Event-driven orchestration brain.
 *
 * Composes:
 *   SwarmBus        — reliable transport
 *   ResourceRegistry — typed dependencies
 *   LockManager     — pre-write arbitration
 *   AckTracker      — delivery guarantees
 *
 * Responsibilities:
 *   1. Route child events to the right subsystem
 *   2. Arbitrate file locks (intent_write → grant/deny)
 *   3. Resolve dependencies via resource registry
 *   4. Track control message delivery
 *   5. Extract decisions for intelligence pipeline
 *   6. Detect stalls
 *   7. Emit everything for SSE consumption
 */

const { EventEmitter } = require("events");
const { controlMessage, decisionEvent, ts } = require("./schema.cjs");
const { ResourceRegistry } = require("./resource-registry.cjs");
const { LockManager } = require("./lock-manager.cjs");
const { AckTracker } = require("./ack-tracker.cjs");

const STALL_TIMEOUT_MS = 60_000;

class SwarmReactor extends EventEmitter {
  /**
   * @param {import('./swarm-bus.cjs').SwarmBus} bus
   */
  constructor(bus) {
    super();
    this.bus = bus;
    this.registry = new ResourceRegistry();
    this.locks = new LockManager();
    this.acks = new AckTracker();

    this.eventLog = [];
    this.decisionLog = [];
    this.stallTimers = new Map();
    this.running = false;
  }

  start() {
    this.running = true;
    this._wireEvents();
    this.emit("reactor:started", { run_id: this.bus.runId, ts: ts() });
  }

  stop() {
    this.running = false;
    this.bus.removeAllListeners("event");
    this.bus.removeAllListeners("event:ack");
    this.bus.removeAllListeners("session:registered");
    this.registry.removeAllListeners();
    this.locks.removeAllListeners();
    this.acks.removeAllListeners();

    for (const timer of this.stallTimers.values()) clearTimeout(timer);
    this.stallTimers.clear();

    this.acks.destroy();
    this.locks.destroy();
    this.registry.clear();

    this.emit("reactor:stopped");
  }

  // ─── Event Wiring ───────────────────────────────────────────────────────

  _wireEvents() {
    // All child events
    this.bus.on("event", (e) => this._onEvent(e));

    // ACK events specifically
    this.bus.on("event:ack", (e) => this._onAck(e));

    // Session registration — auto-register resources
    this.bus.on("session:registered", (e) => this._onSessionRegistered(e));

    // Resource ready → unblock subscribers
    this.registry.on("ready_for", (e) => this._onResourceReady(e));

    // ACK retry — re-send control message
    this.acks.on("retry", (e) => this._onAckRetry(e));

    // ACK expired — log failure
    this.acks.on("expired", (e) => this._onAckExpired(e));

    // Lock results — notify children
    this.locks.on("lock_result", (e) => this._onLockResult(e));
    this.locks.on("queued_lock_granted", (e) => this._onQueuedLockGranted(e));
  }

  // ─── Child Event Dispatch ───────────────────────────────────────────────

  _onEvent(event) {
    this.eventLog.push(event);
    this._resetStallTimer(event.session_id);
    this.emit("event", event);

    switch (event.type) {
      case "progress":
        this._onProgress(event);
        break;
      case "intent_write":
        this._onIntentWrite(event);
        break;
      case "file_written":
        this._onFileWritten(event);
        break;
      case "blocked":
        this._onBlocked(event);
        break;
      case "done":
        this._onDone(event);
        break;
      case "error":
        this._onError(event);
        break;
      case "decision_detected":
        this._onDecision(event);
        break;
      case "ack":
        // Handled by specific listener above
        break;
      default:
        break;
    }
  }

  // ─── Event Handlers ─────────────────────────────────────────────────────

  _onProgress(event) {
    this.emit("progress", {
      session: event.session_id,
      pct: event.payload.pct,
      next: event.payload.next,
      aggregate: this._aggregateProgress(),
    });
  }

  _onIntentWrite(event) {
    const files = event.files || event.payload.files || [];
    if (files.length === 0) return;

    const result = this.locks.requestLock(event.session_id, files);

    // Send grant or deny
    if (result.granted.length > 0) {
      this._sendControl(event.session_id, {
        type: "lock_granted",
        requires_ack: false,
        payload: { files: result.granted },
      });
    }
    if (result.denied.length > 0) {
      this._sendControl(event.session_id, {
        type: "lock_denied",
        requires_ack: true,
        payload: {
          denied: result.denied,
          message: `Files locked by other workers: ${result.denied.map((d) => `${d.file} (held by ${d.holder})`).join(", ")}`,
        },
      });

      // Queue for when locks free up
      for (const d of result.denied) {
        this.locks.queueRequest(event.session_id, d.file);
      }

      this._log("warn", event.session_id,
        `Write denied: ${result.denied.map((d) => d.file).join(", ")}`);
    }
  }

  _onFileWritten(event) {
    const files = event.files || [];

    // Release locks
    this.locks.releaseLock(event.session_id, files);

    // Transition resources to ready
    for (const rid of (event.produces || [])) {
      this.registry.transition(rid, "ready", { files });
    }

    // Also check if any file matches a registered resource (by convention)
    // This handles cases where the child didn't explicitly use resource IDs
    this._log("info", event.session_id,
      `Wrote: ${files.join(", ")}${event.payload.summary ? " — " + event.payload.summary : ""}`);
  }

  _onBlocked(event) {
    const { need, from } = event.payload;

    this._log("warn", event.session_id, `Blocked: needs "${need}" from "${from || "?"}"`);

    // Check if needed resource already exists and is ready
    if (need) {
      const entry = this.registry.resources.get(need);
      if (entry && entry.status === "ready") {
        this._sendControl(event.session_id, {
          type: "unblocked",
          requires_ack: true,
          payload: {
            resource_id: need,
            resolved_by: entry.producer,
            message: `Resource "${need}" is already ready (produced by ${entry.producer}).`,
          },
        });
        this._log("info", event.session_id, `Auto-resolved: "${need}" already ready`);
        return;
      }

      // Subscribe so we get notified when it becomes ready
      if (entry) {
        this.registry.subscribe(need, event.session_id);
      }
    }
  }

  _onDone(event) {
    const session = event.session_id;

    // Release all locks
    this.locks.releaseAll(session);

    // Transition all produced resources to ready
    const state = this.bus.getSessionState(session);
    if (state?.produces) {
      for (const rid of state.produces) {
        const entry = this.registry.resources.get(rid);
        if (entry && entry.status !== "ready") {
          this.registry.transition(rid, "ready");
        }
      }
    }

    this._log("info", session,
      `Done: ${event.payload.summary || "no summary"}. Files: ${(event.files || []).join(", ")}`);

    // Check swarm completion
    this._checkSwarmComplete();
  }

  _onError(event) {
    this._log("error", event.session_id, `Error: ${event.payload.message || "unknown"}`);
  }

  _onDecision(event) {
    this.decisionLog.push(event);

    this._log("info", event.session_id,
      `Decision: ${event.payload.chosen || "?"} (confidence: ${event.payload.confidence || "?"})`);

    // Emit for decision intelligence pipeline
    this.emit("decision", event);
  }

  // ─── ACK Handling ───────────────────────────────────────────────────────

  _onAck(event) {
    const msgId = event.payload.msg_id;
    if (msgId) {
      const result = this.acks.ack(msgId);
      if (result) {
        this._log("debug", event.session_id, `ACK received: ${msgId}`);
      }
    }
  }

  _onAckRetry(entry) {
    const retryEntry = this.acks.getRetryEntry(entry.msg_id);
    if (retryEntry) {
      this._log("warn", retryEntry.session,
        `Retrying message ${entry.msg_id} (attempt ${entry.attempt}/${entry.max})`);
      // Re-send the original message
      try {
        this.bus.send(retryEntry.session, retryEntry.message);
      } catch (_) {}
    }
  }

  _onAckExpired(entry) {
    this._log("error", entry.session,
      `Message expired without ACK: ${entry.msg_id} after ${entry.retries} retries`);
    this.emit("delivery_failure", entry);
  }

  // ─── Resource Events ────────────────────────────────────────────────────

  _onSessionRegistered({ session, meta }) {
    // Register declared resources
    if (meta.produces) {
      for (const rid of meta.produces) {
        this.registry.declare(rid, session);
      }
    }
    if (meta.needs) {
      for (const rid of meta.needs) {
        // Ensure resource exists (may have been declared by producer already)
        if (!this.registry.resources.has(rid)) {
          this.registry.declare(rid, null); // Unknown producer
        }
        this.registry.subscribe(rid, session);
      }
    }
  }

  _onResourceReady({ resource_id, subscriber, producer, version }) {
    this._sendControl(subscriber, {
      type: "unblocked",
      requires_ack: true,
      payload: {
        resource_id,
        resolved_by: producer,
        version,
        message: `Resource "${resource_id}" is now ready.`,
      },
    });
    this._log("info", subscriber, `Unblocked: "${resource_id}" ready from ${producer}`);
  }

  // ─── Lock Events ───────────────────────────────────────────────────────

  _onLockResult(result) {
    // Already handled in _onIntentWrite
  }

  _onQueuedLockGranted({ file, session }) {
    this._sendControl(session, {
      type: "lock_granted",
      requires_ack: false,
      payload: { files: [file], message: `Lock on "${file}" now available.` },
    });
    this._log("info", session, `Queued lock granted: ${file}`);
  }

  // ─── Control Message Sending ────────────────────────────────────────────

  _sendControl(session, fields) {
    const msg = controlMessage(fields);
    try {
      this.bus.send(session, msg);
      if (msg.requires_ack) {
        this.acks.track(msg.msg_id, session, msg);
      }
      return msg.msg_id;
    } catch (e) {
      this._log("error", session, `Failed to send: ${e.message}`);
      return null;
    }
  }

  // ─── Stall Detection ───────────────────────────────────────────────────

  _resetStallTimer(session) {
    const existing = this.stallTimers.get(session);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      const state = this.bus.getSessionState(session);
      if (state && state.status !== "done" && state.status !== "error") {
        this._log("warn", session, `Stalled — no events for ${STALL_TIMEOUT_MS / 1000}s`);
        this.emit("stall", { session, state });
      }
    }, STALL_TIMEOUT_MS);

    this.stallTimers.set(session, timer);
  }

  // ─── Completion Check ──────────────────────────────────────────────────

  _checkSwarmComplete() {
    const states = this.bus.getState();
    const all = Object.values(states);
    if (all.length === 0) return;

    const allTerminal = all.every((s) => s.status === "done" || s.status === "error");
    if (allTerminal) {
      const summary = {
        total: all.length,
        done: all.filter((s) => s.status === "done").length,
        errored: all.filter((s) => s.status === "error").length,
        files_written: [...new Set(all.flatMap((s) => s.files_written || []))],
        decisions: this.decisionLog.length,
        ack_stats: this.acks.getStats(),
        locks_snapshot: this.locks.snapshot(),
        resource_snapshot: this.registry.snapshot(),
      };

      this.emit("swarm:complete", summary);
    }
  }

  // ─── Queries ────────────────────────────────────────────────────────────

  _aggregateProgress() {
    const states = this.bus.getState();
    const vals = Object.values(states);
    if (vals.length === 0) return { pct: 0, total: 0, done: 0, blocked: 0, errored: 0 };

    const total = vals.length;
    const done = vals.filter((s) => s.status === "done").length;
    const blocked = vals.filter((s) => s.status === "blocked").length;
    const errored = vals.filter((s) => s.status === "error").length;
    const working = vals.filter((s) => s.status === "working").length;
    const avgPct = vals.reduce((sum, s) => sum + (s.progress_pct || 0), 0) / total;

    return { pct: Math.round(avgPct), total, done, blocked, errored, working };
  }

  getFullState() {
    return {
      sessions: this.bus.getState(),
      progress: this._aggregateProgress(),
      resources: this.registry.snapshot(),
      locks: this.locks.snapshot(),
      acks: this.acks.getStats(),
      decisions: this.decisionLog.length,
      event_count: this.eventLog.length,
    };
  }

  getEventLog(opts = {}) {
    let events = this.eventLog;
    if (opts.session) events = events.filter((e) => e.session_id === opts.session);
    if (opts.type) events = events.filter((e) => e.type === opts.type);
    if (opts.since) events = events.filter((e) => e.ts >= opts.since);
    const limit = opts.limit || 200;
    return events.slice(-limit);
  }

  getDecisionLog() {
    return this.decisionLog;
  }

  // ─── Logging ────────────────────────────────────────────────────────────

  _log(level, session, message) {
    const entry = { level, session, message, ts: ts() };
    this.emit("log", entry);
  }
}

module.exports = { SwarmReactor };
