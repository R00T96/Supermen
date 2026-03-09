#!/usr/bin/env node
"use strict";

/**
 * swarm-cli.cjs — Worker-side helper for reliable event emission.
 *
 * Replaces fragile `echo '{"type":...}' >> out.jsonl` with:
 *   swarm-cli event progress --pct 40 --file src/api/routes.ts --next "auth middleware"
 *   swarm-cli event file_written --file src/api/routes.ts --summary "REST endpoints"
 *   swarm-cli event blocked --need "db:schema:v1" --from db
 *   swarm-cli event done --file src/api/routes.ts --summary "API complete"
 *   swarm-cli event intent_write --file src/api/routes.ts
 *   swarm-cli event decision --chosen "Express" --options "Express,Fastify" --confidence 0.8
 *   swarm-cli event ack --msg-id msg_91
 *   swarm-cli inbox read [--tail 5]
 *   swarm-cli inbox ack-all
 *   swarm-cli state
 *
 * Session name comes from SWARM_SESSION env var.
 * Swarm root from SWARM_ROOT env var (default /tmp/swarm).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SESSION = process.env.SWARM_SESSION;
const ROOT = process.env.SWARM_ROOT || "/tmp/swarm";

if (!SESSION) {
  console.error("SWARM_SESSION env var not set");
  process.exit(1);
}

const DIR = path.join(ROOT, SESSION);
const OUT = path.join(DIR, "out.jsonl");
const IN = path.join(DIR, "in.jsonl");
const STATE = path.join(DIR, "state.json");

function emit(obj) {
  const line = JSON.stringify({ ...obj, ts: new Date().toISOString() }) + "\n";
  fs.appendFileSync(OUT, line);
}

const args = process.argv.slice(2);
const cmd = args[0];
const sub = args[1];

function parseFlags(from) {
  const flags = {};
  for (let i = from; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
      // Accumulate --file flags into array
      if (key === "file") {
        if (!flags.files) flags.files = [];
        flags.files.push(val);
      } else if (key === "options") {
        flags.options = String(val).split(",");
      } else {
        flags[key] = val;
      }
    }
  }
  return flags;
}

if (cmd === "event") {
  const type = sub;
  const flags = parseFlags(2);

  switch (type) {
    case "progress":
      emit({
        type: "progress",
        pct: parseInt(flags.pct) || 0,
        status: "working",
        files: flags.files || [],
        next: flags.next || "",
      });
      break;

    case "file_written":
      emit({
        type: "file_written",
        files: flags.files || [],
        summary: flags.summary || "",
      });
      break;

    case "intent_write":
      emit({
        type: "intent_write",
        files: flags.files || [],
      });
      break;

    case "blocked":
      emit({
        type: "blocked",
        need: flags.need || "",
        from: flags.from || "",
      });
      break;

    case "done":
      emit({
        type: "done",
        artifacts: flags.files || [],
        summary: flags.summary || "",
      });
      break;

    case "error":
      emit({
        type: "error",
        message: flags.message || flags.msg || "",
      });
      break;

    case "decision":
      emit({
        type: "decision_detected",
        decision_id: crypto.randomUUID(),
        chosen: flags.chosen || "",
        options: flags.options || [],
        confidence: parseFloat(flags.confidence) || 0,
        reasoning_summary: flags.reason || flags.reasoning || "",
        constraints: flags.constraints ? String(flags.constraints).split(",") : [],
      });
      break;

    case "ack":
      emit({
        type: "ack",
        msg_id: flags["msg-id"] || flags.msg_id || "",
      });
      break;

    default:
      // Generic event
      emit({ type, ...flags });
  }

  console.log(`✓ ${type}`);
} else if (cmd === "inbox") {
  if (sub === "read") {
    const tail = parseInt(parseFlags(2).tail) || 10;
    try {
      const content = fs.readFileSync(IN, "utf-8").trim();
      if (!content) {
        console.log("(empty inbox)");
      } else {
        const lines = content.split("\n").slice(-tail);
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            console.log(`[${msg.type}] ${msg.payload?.message || JSON.stringify(msg.payload)}`);
            // Auto-ack if requires_ack
            if (msg.requires_ack && msg.msg_id) {
              emit({ type: "ack", msg_id: msg.msg_id });
            }
          } catch (_) {
            console.log(line);
          }
        }
      }
    } catch (_) {
      console.log("(no inbox file)");
    }
  } else if (sub === "ack-all") {
    try {
      const content = fs.readFileSync(IN, "utf-8").trim();
      if (content) {
        for (const line of content.split("\n")) {
          try {
            const msg = JSON.parse(line);
            if (msg.requires_ack && msg.msg_id) {
              emit({ type: "ack", msg_id: msg.msg_id });
              console.log(`ACK: ${msg.msg_id}`);
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
} else if (cmd === "state") {
  try {
    const state = JSON.parse(fs.readFileSync(STATE, "utf-8"));
    console.log(JSON.stringify(state, null, 2));
  } catch (_) {
    console.log("(no state file)");
  }
} else {
  console.log(`Usage:
  swarm-cli event <type> [--flags]
  swarm-cli inbox read [--tail N]
  swarm-cli inbox ack-all
  swarm-cli state`);
}
