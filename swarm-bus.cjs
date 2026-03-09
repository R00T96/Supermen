"use strict";

/**
 * swarm-bus.cjs v2 — Reliable filesystem-backed duplex message bus.
 *
 * Fixes from v1:
 *   1. Per-session lineBuffer — no partial line loss
 *   2. Sequence numbers on all events
 *   3. state.json materialized after every accepted event
 *   4. All events wrapped in canonical envelope
 *   5. Explicit resource_id in registration
 *
 * Architecture:
 *   fs.watch (inotify/kqueue) for real-time event detection
 *   1s fallback interval for platforms where fs.watch is unreliable
 *   (This is hybrid event + fallback-poll. Named honestly.)
 */

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { envelope, ts, uuid } = require("./schema.cjs");

const SWARM_ROOT = process.env.SWARM_ROOT || "/tmp/swarm";

class SwarmBus extends EventEmitter {
  constructor(runId, rootDir = SWARM_ROOT) {
    super();
    this.runId = runId || uuid();
    this.rootDir = rootDir;
    this.watchers = new Map();       // session → FSWatcher
    this.offsets = new Map();        // session → byte offset
    this.lineBuffers = new Map();    // session → incomplete line fragment
    this.sequences = new Map();      // session → next seq number
    this.sessions = new Map();       // session → { dir, paths, meta, state }
    fs.mkdirSync(rootDir, { recursive: true });
  }

  /**
   * Register a child session.
   * @param {string} name — session identifier
   * @param {object} meta — { goalId, produces: [resourceId], needs: [resourceId], filesOwned: [] }
   * @returns {{ out, in, state }} paths for prompt injection
   */
  register(name, meta = {}) {
    const dir = path.join(this.rootDir, name);
    fs.mkdirSync(dir, { recursive: true });

    const paths = {
      out: path.join(dir, "out.jsonl"),
      in: path.join(dir, "in.jsonl"),
      state: path.join(dir, "state.json"),
    };

    // Init files
    for (const f of [paths.out, paths.in]) {
      if (!fs.existsSync(f)) fs.writeFileSync(f, "");
    }

    const initialState = {
      session: name,
      run_id: this.runId,
      status: "initializing",
      goal_id: meta.goalId || null,
      produces: meta.produces || [],
      needs: meta.needs || [],
      files_owned: meta.filesOwned || [],
      files_written: [],
      progress_pct: 0,
      last_event_at: null,
      error: null,
      created_at: ts(),
      updated_at: ts(),
    };

    fs.writeFileSync(paths.state, JSON.stringify(initialState, null, 2));

    this.sessions.set(name, { dir, paths, meta, state: initialState });
    this.offsets.set(name, 0);
    this.lineBuffers.set(name, "");
    this.sequences.set(name, 0);

    this._watch(name, paths.out);

    this.emit("session:registered", { session: name, paths, meta });
    return paths;
  }

  /**
   * Watch a child's out.jsonl via inotify + fallback interval.
   */
  _watch(name, outPath) {
    if (this.watchers.has(name)) return;

    let watcher = null;
    try {
      watcher = fs.watch(outPath, { persistent: false }, (eventType) => {
        if (eventType === "change") this._drain(name, outPath);
      });
    } catch (_) {
      // fs.watch can fail on some filesystems; fallback-only mode
    }

    const fallback = setInterval(() => this._drain(name, outPath), 1000);

    this.watchers.set(name, { watcher, fallback });
  }

  /**
   * Read new bytes from out.jsonl. Only parse complete newline-terminated lines.
   * Partial lines stay in lineBuffer until next read completes them.
   */
  _drain(name, outPath) {
    let stat;
    try {
      stat = fs.statSync(outPath);
    } catch (_) {
      return;
    }

    const offset = this.offsets.get(name) || 0;
    if (stat.size <= offset) return;

    const fd = fs.openSync(outPath, "r");
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    this.offsets.set(name, stat.size);

    // Prepend any leftover fragment from previous read
    const raw = (this.lineBuffers.get(name) || "") + buf.toString("utf-8");

    const lines = raw.split("\n");
    // Last element is either "" (if raw ended with \n) or incomplete fragment
    const fragment = lines.pop();
    this.lineBuffers.set(name, fragment);

    for (const line of lines) {
      if (!line.trim()) continue;
      this._processLine(name, line);
    }
  }

  /**
   * Parse a complete line. Wrap in envelope. Emit typed events.
   */
  _processLine(name, line) {
    const seq = this.sequences.get(name) || 0;
    this.sequences.set(name, seq + 1);

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      // Unparseable — wrap as raw
      parsed = { type: "raw", text: line };
    }

    const session = this.sessions.get(name);
    const goalId = session?.state?.goal_id || null;

    const event = envelope({
      session_id: name,
      run_id: this.runId,
      goal_id: parsed.goal_id || goalId,
      type: parsed.type || "raw",
      seq,
      payload: parsed,
      produces: parsed.produces || [],
      needs: parsed.needs || [],
      files: parsed.files || parsed.artifacts || [],
      decision_id: parsed.decision_id || null,
      parent_event_id: parsed.parent_event_id || null,
    });

    // Materialize state.json
    if (session) {
      this._updateState(name, event);
    }

    // Emit
    this.emit("event", event);
    this.emit(`event:${event.type}`, event);
  }

  /**
   * Update materialized state.json after every accepted event.
   * state.json is the authoritative snapshot of this worker's status.
   */
  _updateState(name, event) {
    const session = this.sessions.get(name);
    if (!session) return;

    const s = session.state;
    const p = event.payload;

    s.updated_at = ts();
    s.last_event_at = event.ts;

    switch (event.type) {
      case "progress":
        s.status = "working";
        if (p.pct !== undefined) s.progress_pct = p.pct;
        if (p.next) s.next_step = p.next;
        break;
      case "file_written":
        s.status = "working";
        if (event.files.length) {
          s.files_written.push(...event.files.filter((f) => !s.files_written.includes(f)));
        }
        break;
      case "intent_write":
        // Don't change status — waiting for lock
        s.pending_writes = event.files;
        break;
      case "blocked":
        s.status = "blocked";
        s.blocker = { need: p.need, from: p.from };
        break;
      case "done":
        s.status = "done";
        s.progress_pct = 100;
        if (event.files.length) {
          s.files_written.push(...event.files.filter((f) => !s.files_written.includes(f)));
        }
        s.summary = p.summary || null;
        break;
      case "error":
        s.status = "error";
        s.error = p.message || p.text || null;
        break;
      case "ack":
        // ACK doesn't change worker status
        break;
      case "decision_detected":
        // Track decisions made by this worker
        if (!s.decisions) s.decisions = [];
        s.decisions.push(p.decision_id || event.decision_id);
        break;
      default:
        break;
    }

    // Write atomically (write tmp + rename)
    const tmpPath = session.paths.state + ".tmp";
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(s, null, 2));
      fs.renameSync(tmpPath, session.paths.state);
    } catch (_) {
      // Non-fatal — state is still in memory
    }
  }

  /**
   * Send a control message to a child's in.jsonl.
   */
  send(name, message) {
    const session = this.sessions.get(name);
    if (!session) throw new Error(`Unknown session: ${name}`);
    const line = JSON.stringify(message) + "\n";
    fs.appendFileSync(session.paths.in, line);
    this.emit("sent", { session: name, message });
    return message.msg_id || null;
  }

  /**
   * Broadcast to all active (non-done, non-error) sessions.
   */
  broadcast(message) {
    for (const [name, session] of this.sessions) {
      if (session.state.status === "done" || session.state.status === "error") continue;
      this.send(name, message);
    }
  }

  /**
   * Get the materialized state of all sessions.
   */
  getState() {
    const result = {};
    for (const [name, session] of this.sessions) {
      result[name] = { ...session.state };
    }
    return result;
  }

  /**
   * Read a session's current materialized state.
   */
  getSessionState(name) {
    const session = this.sessions.get(name);
    return session ? { ...session.state } : null;
  }

  /**
   * Cleanup a single session.
   */
  unregister(name) {
    const w = this.watchers.get(name);
    if (w) {
      if (w.watcher) w.watcher.close();
      clearInterval(w.fallback);
      this.watchers.delete(name);
    }
    this.sessions.delete(name);
    this.offsets.delete(name);
    this.lineBuffers.delete(name);
    this.sequences.delete(name);
  }

  /**
   * Destroy everything.
   */
  destroy() {
    for (const [name] of this.watchers) {
      this.unregister(name);
    }
    try {
      fs.rmSync(this.rootDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

module.exports = { SwarmBus, SWARM_ROOT };
