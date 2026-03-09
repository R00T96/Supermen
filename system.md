# Nested Claude Code — How It Works

## The Core Idea

A **controller** Claude Code instance acts as a tech lead. It doesn't write code itself — it spawns multiple **child** Claude Code instances in parallel tmux sessions and delegates focused tasks to each one. Each child works independently on its own files while the controller monitors progress and coordinates.

What makes this more than naive terminal multiplexing: a **swarm protocol** layer gives children structured communication channels, the controller gets reliable event-driven feedback instead of screen scraping, and a **decision bridge** extracts learning from each run so future swarms start smarter.

## The Nesting Mechanism

### Problem: Claude Code blocks nesting by default

Claude Code detects if it's running inside another Claude Code session via the `CLAUDECODE` environment variable. If set, it refuses to start with: *"Claude Code cannot be launched inside another Claude Code session."*

### Solution: Unset the env var + use tmux as isolation

1. The controller is spawned with `CLAUDECODE` deleted from its environment
2. Each child runs in its own **tmux session**, which provides process isolation
3. The tmux sessions also unset `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` at three levels:
   - tmux `-e` flag on session creation
   - `tmux set-environment -u` to prevent inheritance on attach
   - `unset` command sent directly into the shell

This triple-unset ensures no child Claude Code instance ever sees the parent's env vars.

## How the Controller Operates

The controller is a Claude Code instance running in **prompt mode** (`claude -p "..."`) — it receives a single system prompt containing:

1. **A role identity** — senior staff engineer who delegates, never codes
2. **A tool reference** — the `tmux-control.cjs` CLI and all its commands
3. **The swarm protocol** — structured event emission and inbox checking instructions to inject into every child's task
4. **Parallelism rules** — split work across 3-6 terminals, each with explicit file ownership
5. **Lessons from previous runs** — orchestration patterns extracted by the decision bridge (if any exist)
6. **The user's goal**

The controller then uses Claude Code's Bash tool to execute `tmux-control.cjs` commands. From its perspective, it's just running shell commands — it doesn't know it's orchestrating other AI instances.

### Controller workflow

```
Controller thinks: "I need to build a web app. I'll split it into 4 areas."

$ node tmux-control.cjs --start ui /path/to/project
$ node tmux-control.cjs --start api /path/to/project
$ node tmux-control.cjs --start db /path/to/project
$ node tmux-control.cjs --start tests /path/to/project

(each --start creates a tmux session + macOS Terminal window)
(the swarm bus auto-registers each session, creating /tmp/swarm/<name>/)

$ node tmux-control.cjs --cmd ui "claude --dangerously-skip-permissions --model sonnet"
$ node tmux-control.cjs --cmd ui ""          ← blank Enter to dismiss prompts
$ node tmux-control.cjs --cmd ui "Build the React components in src/components/. You own this directory only.

## Swarm Communication
export SWARM_SESSION=ui
export SWARM_ROOT=/tmp/swarm
node swarm-cli.cjs event progress --pct 20 --file src/components/App.tsx --next 'header'
node swarm-cli.cjs event file_written --file src/components/App.tsx --summary 'root component'
node swarm-cli.cjs event done --file src/components/App.tsx --summary 'UI complete'
node swarm-cli.cjs inbox read --tail 5
"
$ node tmux-control.cjs --cmd ui ""          ← blank Enter to dismiss ghost text

(repeat for api, db, tests — each gets a focused task WITH swarm protocol)

(monitoring: controller can use structured events OR terminal reads)
$ cat /tmp/swarm/ui/out.jsonl | tail -20     ← typed JSON events
$ node tmux-control.cjs --read ui            ← raw terminal output (fallback)

(when all done)
$ node tmux-control.cjs --cmd ui "/exit"
$ node tmux-control.cjs --stop-all
```

### What `--cmd` actually does

`tmux send-keys` — it types text into the tmux pane and presses Enter. This is how the controller "talks" to each child Claude Code instance. The child sees it as if a human typed a prompt.

### What `--read` actually does

`tmux capture-pane` — it reads the visible terminal output (last N lines). The controller can use this as a fallback, but the swarm bus provides more reliable structured data via `out.jsonl`.

### Why blank Enters matter

Claude Code has ghost text (autocomplete suggestions) that can interfere with the next command. Sending a blank Enter (`--cmd <name> ""`) after every real command clears any pending ghost text or dismisses trust/plan approval prompts.

## The Swarm Protocol

### Filesystem message bus

Each child session gets a directory under `/tmp/swarm/<session>/`:

```
/tmp/swarm/
  ├── ui/
  │   ├── out.jsonl      ← child writes structured events here
  │   ├── in.jsonl       ← controller/reactor writes commands here
  │   └── state.json     ← materialized state, updated after every event
  ├── api/
  │   ├── out.jsonl
  │   ├── in.jsonl
  │   └── state.json
  └── _decisions/
      ├── decisions.jsonl ← extracted decision events
      ├── outcomes.jsonl  ← post-run outcome assessments
      ├── patterns.jsonl  ← compiled orchestration patterns
      └── runs.jsonl      ← historical run reports
```

The bus watches `out.jsonl` files via `fs.watch` (inotify on Linux, kqueue on macOS) for real-time event detection. A 1-second fallback interval handles platforms where `fs.watch` is unreliable. A 3-second interval handles tmux session enumeration. This is hybrid event-driven + fallback-poll — named honestly, not "zero-polling."

### Line buffering (why it matters)

If a child writes half a JSON line and the newline arrives in the next filesystem read, a naive `split("\n")` would parse the partial line as garbage and advance the offset, losing the complete record forever.

The bus maintains a per-session `lineBuffer`. On each read, it prepends any leftover fragment from the previous read, splits on `\n`, and keeps the last element (which may be incomplete) in the buffer. Only complete newline-terminated lines get parsed. Zero data loss.

### Event envelope

Every event flows through one canonical envelope:

```json
{
  "event_id": "uuid",
  "session_id": "api",
  "run_id": "run_42",
  "goal_id": "goal_xyz",
  "type": "progress",
  "ts": "2026-03-09T12:00:00Z",
  "seq": 18,
  "payload": {},
  "produces": ["api:routes:v1"],
  "needs": ["db:schema:v1"],
  "files": ["src/api/routes.ts"],
  "decision_id": null,
  "parent_event_id": null
}
```

This gives causality chains, replay capability, and graphability across runs. The `produces` and `needs` fields use explicit resource IDs (`domain:artifact:version`) — no substring matching.

### Child → controller events

| Type | Purpose |
|---|---|
| `progress` | Status update with percentage, files touched, next step |
| `file_written` | File mutation completed (triggers lock release + dependency resolution) |
| `intent_write` | Request write lock before mutating a file |
| `blocked` | Waiting on a dependency from another worker |
| `done` | Task complete with artifact list and summary |
| `error` | Something went wrong |
| `ack` | Acknowledge receipt of a control message |
| `decision_detected` | Child surfaced an architectural or strategic decision |

### Controller → child messages

| Type | Purpose |
|---|---|
| `lock_granted` | Write lock approved — safe to mutate |
| `lock_denied` | Another worker holds the lock — wait or yield |
| `unblocked` | A dependency is now available |
| `redirect` | Change of plan — new instructions |
| `context` | Sibling produced something relevant to your work |
| `conflict` | Two workers touched the same file |
| `signal` | Generic control (pause, resume, abort) |

### Control message delivery guarantees

Control messages can set `requires_ack: true`. The ACK tracker monitors every such message through `pending → acked | expired`. Expired messages retry up to 2 times. If a child never acknowledges after all retries, the reactor emits a `delivery_failure` event. This means the controller knows what children actually received rather than hoping fire-and-forget worked.

### The swarm-cli helper

Children use `swarm-cli.cjs` instead of raw `echo '{"type":...}' >> out.jsonl` to emit events. This eliminates broken shell quoting, malformed JSON, and missing fields:

```bash
export SWARM_SESSION="api"
export SWARM_ROOT="/tmp/swarm"

# Report progress
node swarm-cli.cjs event progress --pct 40 --file src/api/routes.ts --next "auth middleware"

# Request write lock
node swarm-cli.cjs event intent_write --file src/api/routes.ts

# Report file written
node swarm-cli.cjs event file_written --file src/api/routes.ts --summary "REST endpoints"

# Report a decision
node swarm-cli.cjs event decision --chosen "Express" --options "Express,Fastify" --confidence 0.8

# Check inbox for controller messages
node swarm-cli.cjs inbox read --tail 5

# ACK all pending messages
node swarm-cli.cjs inbox ack-all

# View current state
node swarm-cli.cjs state
```

## Subsystems

### Resource Registry

Typed dependency management. Resources use explicit versioned IDs: `db:schema:v1`, `api:routes:v1`, `ui:components:v1`. Each resource tracks lifecycle: `planned → producing → ready → invalidated`. Workers declare what they `produce` and what they `need` at registration. When a resource transitions to `ready`, all subscribers get notified automatically. No fuzzy string matching anywhere.

### Lock Manager

Pre-write file arbitration. A child emits `intent_write` before mutating a file. The lock manager grants or denies based on current ownership. If denied, the request is queued and auto-granted when the lock frees. Locks have a TTL (30 seconds default) to prevent deadlocks from crashed children. This prevents file conflicts before they happen rather than detecting them after the damage.

### Reactor

The event-driven orchestration brain. Sits between the bus (raw events) and everything else. It routes child events to the right subsystem, arbitrates locks, resolves dependencies via the resource registry, tracks delivery via the ACK tracker, extracts decisions, detects stalled workers (60 seconds without events), and checks for swarm completion.

### Decision Bridge

Connects swarm orchestration to the decision intelligence pipeline. Listens to reactor events and extracts three categories of signal:

1. **Decisions** — explicit choices surfaced by children (`decision_detected` events) plus implicit decisions like dependency ordering revealed by blocker patterns
2. **Outcomes** — after a run completes, assesses each decision and the overall decomposition quality (blockers, conflicts, stalls, error rate)
3. **Patterns** — compiled orchestration motifs capturing what worked and what didn't, with concrete improvement suggestions (e.g., "pre-compute dependency X — it blocked 3 workers")

Everything persists to `/tmp/swarm/_decisions/` as append-only JSONL files that survive across runs.

## The Learning Loop

After each run, the decision bridge compiles an orchestration pattern. When the next swarm starts, the server reads recent patterns and injects them into the controller's system prompt:

```
## Lessons from Previous Runs

- partial: 5 workers, 2 blockers, 1 conflict. Pre-compute db:schema; tighten file ownership.
- success: 4 workers, 0 blockers, 0 conflicts. Clean run.
```

The controller uses these to make better decomposition choices. Over multiple runs, the system compounds: fewer blockers, tighter ownership boundaries, smarter dependency ordering, better prompt clarity.

The full loop:

```
worker events → bus → reactor → decision bridge → pattern files
                                                       ↓
controller prompt ← pattern injection ← pattern files
       ↓
  better next swarm
```

This is where the architecture shifts from "fast coordination" to "learning control system."

## Parallelism & Ownership

The key to avoiding conflicts between children: **each terminal owns specific files**.

The controller's system prompt enforces this pattern:

```
Terminal "ui":    "You own src/components/. Do NOT edit files outside this directory."
Terminal "api":   "You own src/api/. Do NOT edit files outside this directory."
Terminal "db":    "You own src/db/. Do NOT edit files outside this directory."
Terminal "tests": "You only read code and run tests. Do NOT edit source files."
```

Since each child Claude Code instance respects its instructions, there are typically no file conflicts. The lock manager provides a hard enforcement layer on top of this soft convention — if two children attempt to write the same file, the second one gets denied until the first releases.

## Iteration System

After the initial build completes (controller exits with code 0), the system can automatically spawn a new controller round with an improvement-focused prompt:

1. **Code review** — read through what was built, find issues
2. **Fix and improve** — address bugs, refactor, improve quality
3. **Add a feature** — one meaningful addition
4. **Verify** — test everything works

Each iteration spawns fresh child terminals and re-initializes the swarm subsystems. The decision bridge persists across iterations, accumulating patterns. Up to 5 iterations can run sequentially.

## Process Tree

```
server.cjs (or start.cjs)
  ├── SwarmBus          → watches /tmp/swarm/*/out.jsonl (inotify + 1s fallback)
  ├── SwarmReactor      → event routing, locks, deps, ACKs, stall detection
  ├── DecisionBridge    → decisions, outcomes, patterns → /tmp/swarm/_decisions/
  │
  └── claude -p "system prompt + goal + patterns"     ← controller
        ├── [Bash] node tmux-control.cjs ...          ← controller's tool calls
        │
        ├── tmux session "cc-ui"
        │     └── claude --dangerously-skip-permissions   ← child 1
        │           └── swarm-cli.cjs → /tmp/swarm/ui/out.jsonl
        ├── tmux session "cc-api"
        │     └── claude --dangerously-skip-permissions   ← child 2
        │           └── swarm-cli.cjs → /tmp/swarm/api/out.jsonl
        ├── tmux session "cc-db"
        │     └── claude --dangerously-skip-permissions   ← child 3
        │           └── swarm-cli.cjs → /tmp/swarm/db/out.jsonl
        └── tmux session "cc-tests"
              └── claude --dangerously-skip-permissions   ← child 4
                    └── swarm-cli.cjs → /tmp/swarm/tests/out.jsonl
```

## Key Flags

| Flag | Purpose |
|---|---|
| `claude -p "..."` | Prompt mode — controller receives instructions as a single prompt, runs autonomously |
| `--dangerously-skip-permissions` | Both controller and children skip all permission prompts (required for unattended operation) |
| `--model <model>` | Select which Claude model to use (sonnet, opus, haiku) |
| `--output-format stream-json --verbose` | Controller only — enables real-time JSON streaming of output for the dashboard |

## Requirements

- **macOS** — uses Terminal.app + AppleScript for window management
- **tmux** — `brew install tmux`
- **Claude Code CLI** — installed and authenticated
