# Nested Claude Code

Run multiple Claude Code instances in parallel, orchestrated by a controller Claude Code instance that acts as a tech lead — decomposing your goal into focused sub-tasks and delegating each to its own terminal.

```
You → Dashboard → Controller Claude Code
                        ├── Terminal 1: Claude Code (ui)
                        ├── Terminal 2: Claude Code (api)
                        ├── Terminal 3: Claude Code (db)
                        └── Terminal 4: Claude Code (tests)
```

## Requirements

- **macOS** (uses Terminal.app for window management)
- **Node.js** (no dependencies to install)
- **tmux** — `brew install tmux`
- **Claude Code CLI** — installed and authenticated ([docs](https://docs.anthropic.com/en/docs/claude-code))

## Quick Start

```bash
git clone <repo-url>
cd nestedcc
node server.cjs
```

Open **http://localhost:3456** in your browser.

1. Type a goal (e.g. "Build a todo app with React and Express")
2. Pick terminal count (Auto lets the controller decide, or choose 1-6)
3. Pick a model (Sonnet, Opus, Haiku) — used for both the controller and child terminals
4. Set iterations (0 = one-shot, 1-5 = automatic improvement rounds after the initial build)
5. Click **Start**

Terminal windows will pop up on your screen — one per sub-task. The dashboard shows what the controller is doing in real-time.

## CLI Alternative

If you prefer a terminal-only experience:

```bash
node start.cjs
```

## Architecture

### How It Works

The controller is a Claude Code instance running in prompt mode. It receives a system prompt that tells it to act as a senior engineer who delegates work across parallel terminals. Children are fully independent Claude Code instances — they don't know about each other or the controller.

What makes this different from naive terminal multiplexing is the **swarm protocol**: a structured communication layer between controller and children that replaces terminal scraping with reliable, typed event passing.

### The Swarm Protocol

Every child session gets a directory under `/tmp/swarm/<session>/` containing three files:

- **out.jsonl** — child writes structured events here (progress, file writes, blockers, completion)
- **in.jsonl** — controller writes commands here (redirects, unblocks, lock grants)
- **state.json** — materialized snapshot updated after every accepted event

Children emit events using the `swarm-cli.cjs` helper instead of raw shell echo, which eliminates broken quoting and malformed JSON. The bus watches these files via `fs.watch` (inotify/kqueue) with a 1-second fallback interval for unreliable filesystems. A 3-second interval handles tmux session enumeration. This is hybrid event-driven + fallback-poll, named honestly.

### Event Envelope

Every event in the system flows through one canonical envelope:

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
  "produces": [],
  "needs": [],
  "files": [],
  "decision_id": null,
  "parent_event_id": null
}
```

This gives causality chains, replay capability, and full graphability across runs.

### Subsystems

The server composes six modules:

**SwarmBus** — Reliable filesystem-backed duplex transport. Per-session line buffers prevent partial-line data loss. Sequence numbers on all events. Materialized `state.json` is the authoritative snapshot per worker.

**SwarmReactor** — Event-driven orchestration brain. Routes child events to the right subsystem, arbitrates file locks, resolves resource dependencies, tracks control message delivery, extracts decisions, and detects stalled workers.

**ResourceRegistry** — Typed dependency management with explicit versioned resource IDs (`domain:artifact:version`). Resources track lifecycle: `planned → producing → ready → invalidated`. Subscribers get push-notified on state transitions. No substring matching.

**LockManager** — Pre-write lock arbitration. Children emit `intent_write` before mutating files. The manager grants or denies based on current ownership. TTL-based expiry prevents deadlocks. Queued requests auto-resolve when locks free.

**AckTracker** — Control message delivery guarantees. Every `requires_ack` message is tracked through `pending → acked | expired`. Expired messages retry up to 2x. The controller knows what children actually received.

**DecisionBridge** — Connects swarm orchestration to the decision intelligence pipeline. Extracts decisions from worker events, schedules outcome assessments after completion, compiles orchestration patterns, and writes everything to `/tmp/swarm/_decisions/` for downstream consumption.

### The Learning Loop

After each run completes, the decision bridge compiles an orchestration pattern capturing worker count, dependency structure, blockers encountered, file conflicts, stalls, and a decomposition quality assessment. These patterns persist across runs in `/tmp/swarm/_decisions/patterns.jsonl`.

When a new swarm starts, the server reads recent patterns and injects them into the controller's system prompt as "Lessons from Previous Runs." The controller uses these to make better decomposition choices — fewer blockers, tighter ownership boundaries, smarter dependency ordering.

The full loop: `worker events → bus → reactor → decision bridge → pattern files → controller prompt → better next swarm`.

## What Happens On Screen

When you click Start, you'll see:

- **Dashboard** (left panel): Activity log showing every action the controller takes — starting terminals, sending prompts, reading output, plus structured swarm events
- **Dashboard** (right panel): List of active terminals with click-to-expand prompts
- **Terminal windows**: macOS Terminal windows arranged side-by-side, one per child Claude Code instance

## Iterations

Setting iterations > 0 triggers automatic improvement rounds after the initial build. Each round spawns a fresh controller that reviews the codebase, fixes issues, adds a feature, and verifies everything works.

## API

### Core Endpoints (backward compatible)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/start` | Start a swarm run |
| POST | `/api/stop` | Stop the running swarm |
| GET | `/api/status` | Current run status |
| GET | `/api/stream` | SSE stream of all events |

### Swarm Intelligence Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/swarm/state` | Full state: sessions, progress, resources, locks, ACK stats |
| GET | `/api/swarm/events` | Event log with `?session=`, `?type=`, `?limit=` filters |
| GET | `/api/swarm/resources` | Resource registry snapshot |
| GET | `/api/swarm/locks` | Active file locks |
| GET | `/api/swarm/acks` | Delivery stats and pending messages |
| GET | `/api/swarm/decisions` | Extracted decision events |
| GET | `/api/swarm/outcomes` | Outcome assessments |
| GET | `/api/swarm/patterns` | Compiled orchestration patterns |
| GET | `/api/swarm/runs` | Historical run reports |
| POST | `/api/swarm/send` | Send message to a specific child |
| POST | `/api/swarm/broadcast` | Broadcast message to all active children |

### SSE Event Types

The `/api/stream` endpoint emits these event types: `init`, `status`, `controller`, `terminals`, `swarm:event`, `swarm:log`, `swarm:progress`, `swarm:complete`, `swarm:stall`, `swarm:delivery_failure`, `swarm:decision`, `swarm:pattern`, `swarm:run_complete`.

## Project Structure

```
server.cjs              — HTTP server, SSE streaming, subsystem lifecycle
swarm-bus.cjs           — Filesystem-backed duplex message bus (inotify + fallback)
swarm-reactor.cjs       — Event-driven orchestration brain
resource-registry.cjs   — Typed versioned dependency management
lock-manager.cjs        — Pre-write file lock arbitration
ack-tracker.cjs         — Control message delivery guarantees
decision-bridge.cjs     — Decision extraction, outcomes, pattern compilation
schema.cjs              — Canonical event envelope and type definitions
swarm-cli.cjs           — Worker-side CLI for safe structured event emission
tmux-control.cjs        — tmux session manager (start, stop, send, read)
public/index.html       — Web dashboard
start.cjs               — CLI launcher (alternative to dashboard)
```

## Limitations

- **macOS only** — relies on Terminal.app and AppleScript for window management
- **No Linux/Windows support** — would need a different terminal management approach
- **Controller quality varies** — sometimes it under-parallelizes or sends overly broad prompts. The system prompt is tuned but not perfect.
- **Soft protocol compliance** — children are instructed to use the swarm CLI via prompt engineering. A misbehaving child can skip events or ignore inbox messages. The ACK tracker detects delivery failures but can't force compliance.
- **Single-machine only** — the filesystem bus assumes all processes share `/tmp/swarm`. Distributed execution would need a network transport layer.

## License

MIT
