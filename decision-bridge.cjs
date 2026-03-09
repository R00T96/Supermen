"use strict";

/**
 * decision-bridge.cjs — Connects swarm orchestration to decision intelligence.
 *
 * Listens to reactor events, extracts decision-relevant signals,
 * publishes to the DI pipeline (via filesystem or future MCP bridge).
 *
 * This is Layer 2-4 of the exponential stack:
 *   Layer 2: Decision extraction from worker events
 *   Layer 3: Goal binding on every event
 *   Layer 4: Outcome capture via delayed checks
 *
 * Outputs go to /tmp/swarm/_decisions/ for downstream consumption:
 *   decisions.jsonl    — all detected decisions
 *   outcomes.jsonl     — outcome assessments
 *   patterns.jsonl     — extracted patterns (populated by external agent)
 *   playbooks.jsonl    — compiled playbooks (populated by external agent)
 */

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { uuid, ts, outcomeEvent } = require("./schema.cjs");

class DecisionBridge extends EventEmitter {
  /**
   * @param {import('./swarm-reactor.cjs').SwarmReactor} reactor
   * @param {string} rootDir
   */
  constructor(reactor, rootDir = "/tmp/swarm") {
    super();
    this.reactor = reactor;
    this.dir = path.join(rootDir, "_decisions");
    this.outcomeTimers = [];
    this.runMetrics = {
      run_id: reactor.bus.runId,
      started_at: ts(),
      decisions: [],
      blockers: [],
      conflicts: [],
      stalls: [],
      completion: null,
    };

    fs.mkdirSync(this.dir, { recursive: true });
  }

  start() {
    // Decision events from children
    this.reactor.on("decision", (e) => this._onDecision(e));

    // Structural events worth mining
    this.reactor.on("event", (e) => {
      if (e.type === "blocked") this._onBlocker(e);
    });

    this.reactor.on("stall", (e) => this._onStall(e));

    this.reactor.on("swarm:complete", (summary) => this._onSwarmComplete(summary));

    // Lock conflicts from the reactor's log
    this.reactor.on("log", (entry) => {
      if (entry.level === "error" && entry.message.includes("CONFLICT")) {
        this._onConflict(entry);
      }
    });

    this.reactor.on("delivery_failure", (e) => this._onDeliveryFailure(e));
  }

  stop() {
    for (const timer of this.outcomeTimers) clearTimeout(timer);
    this.outcomeTimers = [];
  }

  // ─── Event Handlers ─────────────────────────────────────────────────────

  _onDecision(event) {
    this.runMetrics.decisions.push({
      decision_id: event.payload.decision_id,
      session: event.session_id,
      chosen: event.payload.chosen,
      confidence: event.payload.confidence,
      ts: event.ts,
    });

    this._append("decisions.jsonl", event);
    this.emit("decision:captured", event);
  }

  _onBlocker(event) {
    this.runMetrics.blockers.push({
      session: event.session_id,
      need: event.payload.need,
      from: event.payload.from,
      ts: event.ts,
    });

    // Blockers are implicit decisions about dependency ordering
    this._append("decisions.jsonl", {
      type: "implicit_decision",
      domain: "dependency",
      context: `${event.session_id} blocked on "${event.payload.need}" from ${event.payload.from}`,
      decision_id: uuid(),
      session_id: event.session_id,
      run_id: event.run_id,
      goal_id: event.goal_id,
      ts: event.ts,
      payload: {
        pattern: "blocker",
        need: event.payload.need,
        from: event.payload.from,
      },
    });
  }

  _onStall(data) {
    this.runMetrics.stalls.push({
      session: data.session,
      ts: ts(),
    });
  }

  _onConflict(entry) {
    this.runMetrics.conflicts.push({
      session: entry.session,
      message: entry.message,
      ts: entry.ts,
    });
  }

  _onDeliveryFailure(entry) {
    // Track unreliable communication as a pattern
    this._append("patterns.jsonl", {
      type: "pattern_detected",
      pattern: "delivery_failure",
      session: entry.session,
      msg_id: entry.msg_id,
      retries: entry.retries,
      ts: ts(),
    });
  }

  _onSwarmComplete(summary) {
    this.runMetrics.completed_at = ts();
    this.runMetrics.completion = summary;

    // Write run report
    this._append("runs.jsonl", this.runMetrics);

    // Schedule delayed outcome checks
    this._scheduleOutcomeChecks(summary);

    this.emit("run:complete", this.runMetrics);
  }

  // ─── Outcome Capture ────────────────────────────────────────────────────

  /**
   * Schedule outcome verification after swarm completes.
   * Each decision gets a deferred outcome check.
   */
  _scheduleOutcomeChecks(summary) {
    for (const dec of this.runMetrics.decisions) {
      // Immediate outcome: did the swarm complete successfully?
      const outcome = outcomeEvent({
        decision_id: dec.decision_id,
        session_id: dec.session,
        run_id: this.reactor.bus.runId,
        goal_id: null,
        outcome: summary.errored > 0 ? "partial" : "success",
        metrics: {
          total_workers: summary.total,
          completed: summary.done,
          errored: summary.errored,
          files_written: summary.files_written?.length || 0,
        },
        rework_caused: summary.errored > 0,
        notes: `Swarm completed: ${summary.done}/${summary.total} workers succeeded`,
      });

      this._append("outcomes.jsonl", outcome);
    }

    // Structural outcome: was the task decomposition good?
    const decompositionOutcome = outcomeEvent({
      decision_id: uuid(),
      run_id: this.reactor.bus.runId,
      outcome: this._assessDecomposition(summary),
      metrics: {
        total_workers: summary.total,
        blockers: this.runMetrics.blockers.length,
        conflicts: this.runMetrics.conflicts.length,
        stalls: this.runMetrics.stalls.length,
        delivery_stats: summary.ack_stats,
      },
      rework_caused: this.runMetrics.conflicts.length > 0,
      notes: this._decompositionNotes(),
    });

    this._append("outcomes.jsonl", decompositionOutcome);

    // Compile orchestration pattern for this run
    this._compileRunPattern();
  }

  _assessDecomposition(summary) {
    const blockers = this.runMetrics.blockers.length;
    const conflicts = this.runMetrics.conflicts.length;
    const stalls = this.runMetrics.stalls.length;
    const errored = summary.errored || 0;

    if (conflicts === 0 && blockers === 0 && stalls === 0 && errored === 0) return "success";
    if (conflicts > 0 || errored > 1) return "failure";
    if (blockers > 2 || stalls > 0) return "partial";
    return "success";
  }

  _decompositionNotes() {
    const parts = [];
    if (this.runMetrics.blockers.length > 0) {
      parts.push(`${this.runMetrics.blockers.length} blockers — consider pre-computing dependencies`);
    }
    if (this.runMetrics.conflicts.length > 0) {
      parts.push(`${this.runMetrics.conflicts.length} file conflicts — tighten ownership boundaries`);
    }
    if (this.runMetrics.stalls.length > 0) {
      parts.push(`${this.runMetrics.stalls.length} stalls — check prompt clarity`);
    }
    return parts.join("; ") || "Clean run";
  }

  // ─── Pattern Compilation ────────────────────────────────────────────────

  /**
   * After a run, compile an orchestration pattern that captures
   * what worked and what didn't. This feeds Layer 5-6.
   */
  _compileRunPattern() {
    const states = this.reactor.bus.getState();
    const workers = Object.entries(states).map(([name, s]) => ({
      name,
      status: s.status,
      files_owned: s.files_owned || [],
      files_written: s.files_written || [],
      produces: s.produces || [],
      needs: s.needs || [],
    }));

    const pattern = {
      type: "orchestration_pattern",
      run_id: this.reactor.bus.runId,
      ts: ts(),
      worker_count: workers.length,
      workers,
      blockers: this.runMetrics.blockers,
      conflicts: this.runMetrics.conflicts,
      stalls: this.runMetrics.stalls,
      decisions: this.runMetrics.decisions.length,
      outcome: this._assessDecomposition(this.runMetrics.completion || {}),
      // For playbook compilation
      recommended_improvements: this._suggestImprovements(),
    };

    this._append("patterns.jsonl", pattern);
    this.emit("pattern:compiled", pattern);
  }

  _suggestImprovements() {
    const suggestions = [];

    // Blocker pattern: same dependency blocked multiple workers
    const blockerSources = {};
    for (const b of this.runMetrics.blockers) {
      const key = b.from || b.need;
      blockerSources[key] = (blockerSources[key] || 0) + 1;
    }
    for (const [src, count] of Object.entries(blockerSources)) {
      if (count > 1) {
        suggestions.push({
          type: "precompute_dependency",
          target: src,
          reason: `Blocked ${count} workers. Pre-compute or start earlier.`,
        });
      }
    }

    // Conflict pattern
    if (this.runMetrics.conflicts.length > 0) {
      suggestions.push({
        type: "tighten_ownership",
        reason: `${this.runMetrics.conflicts.length} file conflicts detected.`,
      });
    }

    // Stall pattern
    if (this.runMetrics.stalls.length > 0) {
      suggestions.push({
        type: "improve_prompts",
        targets: this.runMetrics.stalls.map((s) => s.session),
        reason: "Workers stalled — likely unclear instructions.",
      });
    }

    return suggestions;
  }

  // ─── File I/O ───────────────────────────────────────────────────────────

  _append(filename, data) {
    const filepath = path.join(this.dir, filename);
    fs.appendFileSync(filepath, JSON.stringify(data) + "\n");
  }

  /**
   * Read a decisions file for external consumption.
   */
  readFile(filename, limit = 100) {
    const filepath = path.join(this.dir, filename);
    try {
      const content = fs.readFileSync(filepath, "utf-8").trim();
      if (!content) return [];
      return content.split("\n").slice(-limit).map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);
    } catch (_) {
      return [];
    }
  }
}

module.exports = { DecisionBridge };
