"use strict";

/**
 * tmux-bridge.cjs — Synthesizes swarm events from tmux pane output.
 *
 * Children are Claude Code instances that may not voluntarily emit swarm
 * events. This bridge scrapes each child's tmux pane, detects Claude Code
 * output patterns, and writes synthetic events to the session's out.jsonl
 * so the SwarmBus picks them up normally.
 *
 * Pattern detection is based on Claude Code's interactive terminal output:
 *   ● Write(path)          → file_written
 *   ● Edit(path)           → file_written
 *   ● MultiEdit(...)       → file_written (multiple)
 *   ⎿ Created / Wrote      → file_written (confirmation)
 *   ● Bash(cmd)            → progress
 *   ● Read(path)           → progress
 *   ● TodoWrite(...)       → progress
 *   summary paragraph      → done (heuristic: last non-empty line before idle)
 *   >  (idle prompt)       → idle / potentially done
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { EventEmitter } = require("events");

const POLL_MS = 2500;
const PANE_LINES = 120;

// Regex patterns for Claude Code interactive terminal output
const RE_WRITE  = /[●✓]\s*Write\(([^)]+)\)/;
const RE_EDIT   = /[●✓]\s*(?:Edit|MultiEdit)\(([^)]+)\)/;
const RE_CREATED = /⎿\s*(?:Created file|Wrote \d+|Updated \d+)/i;
const RE_BASH   = /[●✓]\s*Bash\(/;
const RE_READ   = /[●✓]\s*Read\(/;
const RE_TODO   = /[●✓]\s*TodoWrite\(/;
const RE_TOOL   = /[●✓]\s*\w+\(/;
const RE_IDLE   = /^\s*>\s*$/;
const RE_ERROR  = /(?:Error:|error:|ENOENT|EACCES|SyntaxError|TypeError|Cannot find module)/;
const RE_PCT    = /(\d{1,3})%/;

// Heuristic: lines that look like a completion summary
const RE_DONE_HINT = /(?:completed?|finished?|done|built|created|implemented|set up|working)/i;

class TmuxBridge extends EventEmitter {
  /**
   * @param {import('./swarm-bus.cjs').SwarmBus} bus
   * @param {string} tmuxControlPath  path to tmux-control.cjs
   * @param {string} swarmRoot        /tmp/swarm
   */
  constructor(bus, tmuxControlPath, swarmRoot) {
    super();
    this.bus = bus;
    this.tmuxControl = tmuxControlPath;
    this.swarmRoot = swarmRoot;

    // Per-session scrape state
    this._seen = new Map();      // session → Set of line fingerprints already processed
    this._status = new Map();    // session → last emitted status string
    this._filesWritten = new Map(); // session → Set of files already reported
    this._idleCount = new Map(); // session → consecutive idle-prompt hits

    this._interval = null;
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this._poll(), POLL_MS);
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  // ── polling ───────────────────────────────────────────────────────────────

  _poll() {
    if (!this.bus) return;
    for (const [name] of this.bus.sessions) {
      try { this._scrape(name); } catch (_) {}
    }
  }

  _scrape(name) {
    const sessionState = this.bus.getSessionState(name);
    // Don't scrape sessions that already finished via the real protocol
    if (sessionState && (sessionState.status === "done" || sessionState.status === "error")) return;

    const raw = this._readPane(name, PANE_LINES);
    if (!raw) return;

    const lines = raw.split("\n");
    const seen = this._seen.get(name) || new Set();
    const filesWritten = this._filesWritten.get(name) || new Set();
    let idleCount = this._idleCount.get(name) || 0;

    const newLines = [];
    for (const line of lines) {
      const key = line.trim();
      if (!key) continue;
      if (!seen.has(key)) {
        seen.add(key);
        newLines.push(line);
      }
    }

    this._seen.set(name, seen);

    if (newLines.length === 0) return;

    // ── Classify new lines ────────────────────────────────────────────────

    let progressPct = null;
    const writtenFiles = [];
    let hasToolActivity = false;
    let hasError = false;
    let idleHit = false;
    let doneHint = false;

    for (const line of newLines) {
      const t = line.trim();

      // Idle prompt
      if (RE_IDLE.test(t)) {
        idleHit = true;
        idleCount++;
        continue;
      }
      idleCount = 0;

      // Error
      if (RE_ERROR.test(t)) hasError = true;

      // File writes
      const mWrite = RE_WRITE.exec(t) || RE_EDIT.exec(t);
      if (mWrite) {
        const filePath = mWrite[1].trim();
        if (!filesWritten.has(filePath)) {
          writtenFiles.push(filePath);
          filesWritten.add(filePath);
        }
        hasToolActivity = true;
      }

      // Confirmation lines (⎿ Created file, etc)
      if (RE_CREATED.test(t)) hasToolActivity = true;

      // Other tool activity
      if (RE_BASH.test(t) || RE_READ.test(t) || RE_TODO.test(t)) hasToolActivity = true;
      else if (RE_TOOL.test(t)) hasToolActivity = true;

      // Percentage in output
      const mPct = RE_PCT.exec(t);
      if (mPct) progressPct = parseInt(mPct[1], 10);

      // Done hint in a substantive line (>10 chars, not a file path)
      if (t.length > 10 && !t.startsWith("●") && !t.startsWith("⎿") && RE_DONE_HINT.test(t)) {
        doneHint = true;
      }
    }

    this._idleCount.set(name, idleCount);
    this._filesWritten.set(name, filesWritten);

    // ── Emit events ──────────────────────────────────────────────────────

    // File written events
    for (const f of writtenFiles) {
      this._emit(name, {
        type: "file_written",
        files: [f],
        summary: `Wrote ${path.basename(f)}`,
        _source: "tmux-bridge",
      });
    }

    // Error event
    if (hasError && this._status.get(name) !== "error") {
      const errLine = newLines.find((l) => RE_ERROR.test(l)) || "";
      this._emit(name, {
        type: "error",
        message: errLine.trim().slice(0, 200),
        _source: "tmux-bridge",
      });
      this._status.set(name, "error");
    }

    // Progress event (working)
    if (hasToolActivity && !hasError) {
      const pct = progressPct || undefined;
      this._emit(name, {
        type: "progress",
        pct,
        next: "working",
        _source: "tmux-bridge",
      });
      this._status.set(name, "working");
    }

    // Done heuristic: idle prompt seen 2+ times after tool activity, or done hint text
    const sessionAlreadyDone = sessionState && sessionState.status === "done";
    if (!sessionAlreadyDone && this._status.get(name) !== "done") {
      if (idleCount >= 2 && doneHint) {
        // Summarize
        const summary = newLines
          .filter((l) => l.trim().length > 20 && !RE_TOOL.test(l.trim()) && !RE_IDLE.test(l.trim()))
          .slice(-3)
          .join(" ")
          .slice(0, 300);

        this._emit(name, {
          type: "done",
          files: Array.from(filesWritten),
          summary: summary || `Session ${name} completed`,
          pct: 100,
          _source: "tmux-bridge",
        });
        this._status.set(name, "done");
      }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  _readPane(name, lines) {
    try {
      return execSync(
        `node ${this.tmuxControl} --read ${name} ${lines}`,
        { encoding: "utf-8", timeout: 5000 }
      );
    } catch (_) {
      return null;
    }
  }

  _emit(name, payload) {
    const outPath = path.join(this.swarmRoot, name, "out.jsonl");
    try {
      fs.appendFileSync(outPath, JSON.stringify(payload) + "\n");
      this.emit("synthetic_event", { session: name, type: payload.type });
    } catch (_) {}
  }
}

module.exports = { TmuxBridge };
