#!/usr/bin/env node
"use strict";

/**
 * server.cjs v2 — Learning swarm orchestrator.
 *
 * Composes: SwarmBus, SwarmReactor, ResourceRegistry, LockManager,
 *           AckTracker, DecisionBridge
 *
 * Architecture:
 *   worker events → bus → reactor → decision bridge → pattern files
 *   pattern files → (external agent) → playbooks → controller policy
 *
 * HTTP API is backward-compatible with v1.
 * New endpoints expose the full intelligence substrate.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const { SwarmBus, SWARM_ROOT } = require("./swarm-bus.cjs");
const { SwarmReactor } = require("./swarm-reactor.cjs");
const { DecisionBridge } = require("./decision-bridge.cjs");
const { TmuxBridge } = require("./tmux-bridge.cjs");
const { uuid } = require("./schema.cjs");

const PORT = parseInt(process.env.PORT, 10) || 3456;
const TMUX_CONTROL = path.join(__dirname, "tmux-control.cjs");
const PUBLIC_DIR = path.join(__dirname, "public");
const CLI_PATH = path.join(__dirname, "swarm-cli.cjs");
const MAX_BUFFER_LINES = 500;

// ─── System Prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are a senior staff software engineer and expert technical lead. Your role is to decompose complex projects into parallel workstreams and delegate them across multiple Claude Code terminals.

You have the following tools available:

## tmux-control.cjs commands

node ${TMUX_CONTROL} --start <name> <working-dir>
node ${TMUX_CONTROL} --cmd <name> "instruction"
node ${TMUX_CONTROL} --cmd <name> ""
node ${TMUX_CONTROL} --read <name>
node ${TMUX_CONTROL} --read <name> 100
node ${TMUX_CONTROL} --stop <name>
node ${TMUX_CONTROL} --stop-all
node ${TMUX_CONTROL} --list

## Swarm Protocol — MANDATORY for every child

When sending a task to a child terminal named "<NAME>", you MUST append these instructions after your task:

\`\`\`
## Swarm Communication

You have a helper CLI for reporting status. Use it instead of raw echo:

# Set env (do this once after Claude Code starts):
export SWARM_SESSION="<NAME>"
export SWARM_ROOT="/tmp/swarm"

# Report progress:
node ${CLI_PATH} event progress --pct <0-100> --file <path> --next "<next step>"

# Before writing a file, request lock:
node ${CLI_PATH} event intent_write --file <path>

# After writing a file:
node ${CLI_PATH} event file_written --file <path> --summary "<what>"

# If blocked on another worker:
node ${CLI_PATH} event blocked --need "<resource_id>" --from "<worker>"

# When done:
node ${CLI_PATH} event done --file <path1> --file <path2> --summary "<what you built>"

# If you made an architectural decision:
node ${CLI_PATH} event decision --chosen "<choice>" --options "<a>,<b>" --confidence <0-1>

# Check coordinator messages:
node ${CLI_PATH} inbox read --tail 5

# Read your current state:
node ${CLI_PATH} state

Do these after EVERY significant action. The swarm coordinator depends on your reports.
\`\`\`

Replace <NAME> with the actual terminal session name.

## Reading child status

Prefer structured events over terminal scraping:
  cat /tmp/swarm/<name>/out.jsonl | tail -20

To send messages to a child:
  echo '{"msg_id":"x","type":"redirect","ts":"...","requires_ack":true,"payload":{"message":"..."}}' >> /tmp/swarm/<name>/in.jsonl

## Workflow

1. Break goal into focused sub-tasks — one per terminal
2. Start ALL terminals at once with descriptive names
3. Launch Claude Code in each: --cmd <name> "claude --dangerously-skip-permissions --model <MODEL>"
4. Wait a few seconds, then blank Enter: --cmd <name> ""
5. Send task with FULL swarm protocol instructions above
6. ALWAYS follow --cmd with blank Enter after ~1 second
7. Monitor via swarm bus AND terminal reads
8. When done: --cmd <name> "/exit" then --stop-all

## Parallel Execution — MANDATORY

Minimum 3 terminals, aim for 4-6. Each terminal gets ONE file or ONE responsibility.
Be explicit about file ownership in every prompt.

## Verification — MANDATORY before completion

Test everything: run servers, hit endpoints, check UI, run test suites. Loop until clean.

## Important Rules

- ALWAYS blank Enter after every command
- ALWAYS include full swarm protocol in every child task
- Include export SWARM_SESSION=<name> in each child's setup
- Use descriptive session names
- DEFAULT to parallel execution`;
}

// ─── State ──────────────────────────────────────────────────────────────────

const state = {
  running: false,
  controllerProcess: null,
  controllerOutput: [],
  goal: "",
  terminalCount: "auto",
  model: "sonnet",
  iterations: 0,
  currentIteration: 0,
  stopped: false,
  sessions: [],
  sseClients: [],
  // Subsystems
  bus: null,
  reactor: null,
  bridge: null,
  tmuxBridge: null,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function pushLine(line) {
  state.controllerOutput.push(line);
  if (state.controllerOutput.length > MAX_BUFFER_LINES) state.controllerOutput.shift();
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = state.sseClients.length - 1; i >= 0; i--) {
    try { state.sseClients[i].write(msg); }
    catch (_) { state.sseClients.splice(i, 1); }
  }
}

function runTmux(...args) {
  try {
    return execSync(`node ${TMUX_CONTROL} ${args.join(" ")}`, {
      encoding: "utf-8", timeout: 15000,
    }).trimEnd();
  } catch (e) {
    return e.stdout ? e.stdout.trimEnd() : "";
  }
}

// ─── Subsystem Lifecycle ────────────────────────────────────────────────────

function initSubsystems() {
  destroySubsystems();

  const runId = uuid();
  state.bus = new SwarmBus(runId);
  state.reactor = new SwarmReactor(state.bus);
  state.bridge = new DecisionBridge(state.reactor);

  // Wire reactor → SSE
  state.reactor.on("event", (e) => broadcast("swarm:event", e));
  state.reactor.on("log", (e) => {
    pushLine(`[${e.level}] ${e.session}: ${e.message}`);
    broadcast("swarm:log", e);
  });
  state.reactor.on("progress", (e) => broadcast("swarm:progress", e));
  state.reactor.on("swarm:complete", (e) => broadcast("swarm:complete", e));
  state.reactor.on("stall", (e) => broadcast("swarm:stall", e));
  state.reactor.on("delivery_failure", (e) => broadcast("swarm:delivery_failure", e));

  // Wire bridge → SSE
  state.bridge.on("decision:captured", (e) => broadcast("swarm:decision", e));
  state.bridge.on("pattern:compiled", (e) => broadcast("swarm:pattern", e));
  state.bridge.on("run:complete", (e) => broadcast("swarm:run_complete", e));

  state.tmuxBridge = new TmuxBridge(state.bus, TMUX_CONTROL, SWARM_ROOT);
  state.tmuxBridge.on("synthetic_event", (e) =>
    broadcast("swarm:log", { level: "debug", session: e.session, message: `[tmux-bridge] ${e.type}` })
  );

  state.reactor.start();
  state.bridge.start();
  state.tmuxBridge.start();
}

function destroySubsystems() {
  if (state.tmuxBridge) { state.tmuxBridge.stop(); state.tmuxBridge = null; }
  if (state.bridge) { state.bridge.stop(); state.bridge = null; }
  if (state.reactor) { state.reactor.stop(); state.reactor = null; }
  if (state.bus) { state.bus.destroy(); state.bus = null; }
}

// ─── Tmux Session Enumeration ───────────────────────────────────────────────
// Hybrid: bus handles real-time data, this handles session discovery.

let pollInterval = null;

function pollTerminals() {
  try {
    const out = runTmux("--list");
    const sessions = [];
    if (out && !out.includes("No active sessions")) {
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (t && t !== "Active sessions:") {
          sessions.push(t);
          if (state.bus && !state.bus.sessions.has(t)) {
            state.bus.register(t);
          }
        }
      }
    }
    state.sessions = sessions;
    broadcast("terminals", { sessions });
  } catch (_) {}
}

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollTerminals, 3000);
  pollTerminals();
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// ─── Controller Process ─────────────────────────────────────────────────────

function buildPrompt(goal, terminalCount, model, iteration) {
  const tc = terminalCount === "auto"
    ? "Decide how many terminals to use. Prefer parallel."
    : `Use exactly ${terminalCount} terminal(s).`;

  const mi = `When launching Claude Code: claude --dangerously-skip-permissions --model ${model || "sonnet"}`;

  const gs = iteration === 0
    ? `## Your Goal\n\n${goal}`
    : `## Iteration ${iteration} — Improvement\n\n1. Code review\n2. Fix issues\n3. Add 1 feature\n4. Verify\n\nOriginal: ${goal}`;

  // Check for existing playbooks
  let playbookSection = "";
  try {
    const playbooks = fs.readFileSync(path.join(SWARM_ROOT, "_decisions", "patterns.jsonl"), "utf-8").trim();
    if (playbooks) {
      const recent = playbooks.split("\n").slice(-3).map((l) => {
        try { return JSON.parse(l); } catch (_) { return null; }
      }).filter(Boolean);

      if (recent.length > 0) {
        playbookSection = `\n## Lessons from Previous Runs\n\n${recent.map((p) =>
          `- ${p.outcome}: ${p.worker_count} workers, ${p.blockers?.length || 0} blockers, ${p.conflicts?.length || 0} conflicts. ${(p.recommended_improvements || []).map((i) => i.reason).join("; ")}`
        ).join("\n")}\n\nApply these lessons to your decomposition.`;
      }
    }
  } catch (_) {}

  return `${buildSystemPrompt()}\n\n## Terminal count\n\n${tc}\n\n## Model\n\n${mi}\n\n${gs}${playbookSection}`;
}

function spawnController(goal, terminalCount, model, iteration) {
  const prompt = buildPrompt(goal, terminalCount, model, iteration || 0);
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const child = spawn("claude", [
    "--dangerously-skip-permissions",
    "-p", prompt,
    "--model", model || "sonnet",
    "--output-format", "stream-json",
    "--verbose",
  ], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  state.controllerProcess = child;
  state.running = true;
  state.goal = goal;
  state.terminalCount = terminalCount;
  state.model = model || "sonnet";
  state.controllerOutput = [];
  state.sessions = [];

  broadcast("status", { running: true, goal, terminalCount, iteration });

  let lineBuf = "";

  const processJson = (raw) => {
    if (!raw.trim()) return;
    try {
      const msg = JSON.parse(raw);
      let line = null;

      if (msg.type === "assistant" && msg.message) {
        for (const block of msg.message.content || []) {
          if (block.type === "text" && block.text) line = block.text;
          else if (block.type === "tool_use") {
            const inp = block.input || {};
            line = inp.command ? "$ " + inp.command : "[tool: " + block.name + "]";

            // Auto-register sessions
            if (inp.command && state.bus) {
              const m = inp.command.match(/--start\s+(\S+)/);
              if (m && !state.bus.sessions.has(m[1])) {
                state.bus.register(m[1]);
              }
            }
          }
          if (line) {
            for (const l of line.split("\n")) { pushLine(l); broadcast("controller", { line: l }); }
            line = null;
          }
        }
      } else if (msg.type === "result" && msg.result) {
        const t = typeof msg.result === "string" ? msg.result : (msg.result.text || "");
        for (const l of t.split("\n")) { pushLine(l); broadcast("controller", { line: l }); }
      } else if (msg.type === "content_block_delta" && msg.delta?.text) {
        for (const l of msg.delta.text.split("\n")) {
          if (l) { pushLine(l); broadcast("controller", { line: l }); }
        }
      }
    } catch (_) {
      pushLine(raw);
      broadcast("controller", { line: raw });
    }
  };

  child.stdout.on("data", (chunk) => {
    lineBuf += chunk.toString();
    const parts = lineBuf.split("\n");
    lineBuf = parts.pop();
    for (const p of parts) processJson(p);
  });

  child.stderr.on("data", (chunk) => {
    for (const l of stripAnsi(chunk.toString()).split("\n")) {
      if (l.trim()) { pushLine(l); broadcast("controller", { line: l }); }
    }
  });

  child.on("exit", (code) => {
    if (lineBuf) { processJson(lineBuf); lineBuf = ""; }
    state.controllerProcess = null;
    stopPolling();
    try { runTmux("--stop-all"); } catch (_) {}
    state.sessions = [];
    broadcast("terminals", { sessions: [] });

    if (code === 0 && state.currentIteration < state.iterations && !state.stopped) {
      state.currentIteration++;
      pushLine(`\n--- Iteration ${state.currentIteration} of ${state.iterations} ---`);
      broadcast("controller", { line: `--- Iteration ${state.currentIteration} ---` });
      broadcast("status", { running: true, currentIteration: state.currentIteration });

      // Re-init for fresh iteration (decision bridge persists across iterations)
      destroySubsystems();
      initSubsystems();

      setTimeout(() => spawnController(state.goal, state.terminalCount, state.model, state.currentIteration), 2000);
    } else {
      state.running = false;
      const reason = state.stopped ? "Stopped" : `Exit ${code}`;
      pushLine(`\n[${reason}]`);
      broadcast("controller", { line: `[${reason}]` });
      broadcast("status", { running: false });
      // Don't destroy subsystems immediately — let bridge finalize
      setTimeout(() => destroySubsystems(), 5000);
      state.stopped = false;
    }
  });

  startPolling();
}

function stopController() {
  state.stopped = true;
  if (state.controllerProcess) {
    state.controllerProcess.kill("SIGTERM");
    setTimeout(() => {
      if (state.controllerProcess) try { state.controllerProcess.kill("SIGKILL"); } catch (_) {}
    }, 3000);
  }
  try { runTmux("--stop-all"); } catch (_) {}
  stopPolling();
  destroySubsystems();
  state.running = false;
  state.sessions = [];
  broadcast("status", { running: false });
  broadcast("terminals", { sessions: [] });
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch (_) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // ── Core API (backward compat) ──

  if (p === "/api/start" && req.method === "POST") {
    if (state.running) return json(res, 400, { error: "Already running" });
    const body = await parseBody(req);
    const goal = (body.goal || "").trim();
    if (!goal) return json(res, 400, { error: "Goal required" });
    const tc = body.terminalCount === "auto" || !body.terminalCount ? "auto" : parseInt(body.terminalCount, 10);
    const model = body.model || "sonnet";
    const iterations = Math.min(Math.max(parseInt(body.iterations) || 0, 0), 5);
    state.iterations = iterations;
    state.currentIteration = 0;
    state.stopped = false;
    initSubsystems();
    spawnController(goal, tc, model, 0);
    return json(res, 200, { ok: true });
  }

  if (p === "/api/stop" && req.method === "POST") {
    stopController();
    return json(res, 200, { ok: true });
  }

  if (p === "/api/status" && req.method === "GET") {
    return json(res, 200, {
      running: state.running, goal: state.goal, terminalCount: state.terminalCount,
      model: state.model, iterations: state.iterations, currentIteration: state.currentIteration,
      sessions: state.sessions,
    });
  }

  if (p === "/api/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      Connection: "keep-alive", "Access-Control-Allow-Origin": "*",
    });
    state.sseClients.push(res);
    res.write(`event: init\ndata: ${JSON.stringify({
      running: state.running, goal: state.goal, terminalCount: state.terminalCount,
      model: state.model, iterations: state.iterations, currentIteration: state.currentIteration,
      controllerOutput: state.controllerOutput, sessions: state.sessions,
    })}\n\n`);
    req.on("close", () => {
      const i = state.sseClients.indexOf(res);
      if (i !== -1) state.sseClients.splice(i, 1);
    });
    return;
  }

  // ── Swarm Intelligence API ──

  if (p === "/api/swarm/state" && req.method === "GET") {
    if (!state.reactor) return json(res, 200, { sessions: {}, progress: null });
    return json(res, 200, state.reactor.getFullState());
  }

  if (p === "/api/swarm/events" && req.method === "GET") {
    if (!state.reactor) return json(res, 200, { events: [] });
    return json(res, 200, {
      events: state.reactor.getEventLog({
        session: url.searchParams.get("session"),
        type: url.searchParams.get("type"),
        limit: parseInt(url.searchParams.get("limit")) || 200,
      }),
    });
  }

  if (p === "/api/swarm/resources" && req.method === "GET") {
    if (!state.reactor) return json(res, 200, { resources: {} });
    return json(res, 200, { resources: state.reactor.registry.snapshot() });
  }

  if (p === "/api/swarm/locks" && req.method === "GET") {
    if (!state.reactor) return json(res, 200, { locks: {} });
    return json(res, 200, { locks: state.reactor.locks.snapshot() });
  }

  if (p === "/api/swarm/acks" && req.method === "GET") {
    if (!state.reactor) return json(res, 200, { stats: {}, pending: [] });
    return json(res, 200, {
      stats: state.reactor.acks.getStats(),
      pending: state.reactor.acks.getPending(),
    });
  }

  if (p === "/api/swarm/decisions" && req.method === "GET") {
    if (!state.bridge) return json(res, 200, { decisions: [] });
    return json(res, 200, { decisions: state.bridge.readFile("decisions.jsonl") });
  }

  if (p === "/api/swarm/outcomes" && req.method === "GET") {
    if (!state.bridge) return json(res, 200, { outcomes: [] });
    return json(res, 200, { outcomes: state.bridge.readFile("outcomes.jsonl") });
  }

  if (p === "/api/swarm/patterns" && req.method === "GET") {
    if (!state.bridge) return json(res, 200, { patterns: [] });
    return json(res, 200, { patterns: state.bridge.readFile("patterns.jsonl") });
  }

  if (p === "/api/swarm/runs" && req.method === "GET") {
    // Historical run data — persists across server restarts
    try {
      const runsPath = path.join(SWARM_ROOT, "_decisions", "runs.jsonl");
      const content = fs.readFileSync(runsPath, "utf-8").trim();
      const runs = content ? content.split("\n").map((l) => {
        try { return JSON.parse(l); } catch (_) { return null; }
      }).filter(Boolean) : [];
      return json(res, 200, { runs });
    } catch (_) {
      return json(res, 200, { runs: [] });
    }
  }

  if (p === "/api/swarm/send" && req.method === "POST") {
    if (!state.bus) return json(res, 400, { error: "No active swarm" });
    const body = await parseBody(req);
    if (!body.session || !body.message) return json(res, 400, { error: "session and message required" });
    try { state.bus.send(body.session, body.message); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (p === "/api/swarm/broadcast" && req.method === "POST") {
    if (!state.bus) return json(res, 400, { error: "No active swarm" });
    const body = await parseBody(req);
    state.bus.broadcast(body.message || body);
    return json(res, 200, { ok: true });
  }

  // ── Static ──

  let fp = p === "/" ? "/index.html" : p;
  fp = path.join(PUBLIC_DIR, fp);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  try {
    if (!fs.statSync(fp).isFile()) throw 0;
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(fs.readFileSync(fp));
  } catch (_) { res.writeHead(404); res.end("Not Found"); }
});

server.listen(PORT, () => {
  console.log(`Swarm Dashboard:    http://localhost:${PORT}`);
  console.log(`Swarm bus root:     ${SWARM_ROOT}`);
  console.log(`Decision store:     ${SWARM_ROOT}/_decisions/`);
  console.log(`CLI helper:         ${CLI_PATH}`);
});
