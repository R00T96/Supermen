# Changelog

## [Unreleased]

### Added

- **SwarmBus** (`swarm-bus.cjs`) — Filesystem-backed duplex message bus with inotify/kqueue + 1s fallback polling. Per-session line buffers prevent partial-line data loss. Sequence numbers on all events. Materializes `state.json` as authoritative per-worker snapshot.
- **SwarmReactor** (`swarm-reactor.cjs`) — Event-driven orchestration brain. Routes child events to subsystems, arbitrates file locks, resolves resource dependencies, tracks control message delivery, extracts decisions, and detects stalled workers.
- **ResourceRegistry** (`resource-registry.cjs`) — Typed versioned dependency management with explicit `domain:artifact:version` IDs. Resources track lifecycle: `planned → producing → ready → invalidated`. Push-notifies subscribers on state transitions.
- **LockManager** (`lock-manager.cjs`) — Pre-write file lock arbitration. TTL-based expiry prevents deadlocks. Queued requests auto-resolve when locks free.
- **AckTracker** (`ack-tracker.cjs`) — Control message delivery guarantees. Tracks messages through `pending → acked | expired` with up to 2 retries on expiry.
- **DecisionBridge** (`decision-bridge.cjs`) — Extracts decisions from worker events, schedules outcome assessments, compiles orchestration patterns to `/tmp/swarm/_decisions/patterns.jsonl`.
- **Schema** (`schema.cjs`) — Canonical event envelope with `event_id`, `session_id`, `run_id`, `goal_id`, `type`, `ts`, `seq`, `payload`, `produces`, `needs`, `files`, `decision_id`, `parent_event_id`.
- **SwarmCLI** (`swarm-cli.cjs`) — Worker-side CLI for safe structured event emission, eliminating broken quoting and malformed JSON from child sessions.
- **Learning loop** — After each run, DecisionBridge compiles an orchestration pattern. New swarms inject recent patterns into the controller's system prompt as "Lessons from Previous Runs."
- **New API endpoints** — `/api/swarm/state`, `/api/swarm/events`, `/api/swarm/resources`, `/api/swarm/locks`, `/api/swarm/acks`, `/api/swarm/decisions`, `/api/swarm/outcomes`, `/api/swarm/patterns`, `/api/swarm/runs`, `/api/swarm/send`, `/api/swarm/broadcast`.
- **SSE event types** — `swarm:event`, `swarm:log`, `swarm:progress`, `swarm:complete`, `swarm:stall`, `swarm:delivery_failure`, `swarm:decision`, `swarm:pattern`, `swarm:run_complete`.
- `PORT` environment variable support for the HTTP server.

### Changed

- **server.cjs** — Upgraded from v1 (simple tmux poller) to v2 (full swarm intelligence substrate). Composes all six new modules. HTTP API remains backward-compatible.
- **README.md** — Expanded with full architecture documentation, swarm protocol details, subsystem descriptions, learning loop explanation, and complete API reference.
- **system.md** — Updated to reflect v2 swarm protocol and new controller capabilities.

---

## [1.0.0] — Initial release

- Nested Claude Code orchestration: controller instance delegates parallel sub-tasks to child Claude Code terminals via tmux.
- Web dashboard at `http://localhost:3456` with SSE streaming.
- CLI launcher (`start.cjs`) as a terminal-only alternative.
- `tmux-control.cjs` for tmux session management (start, stop, send, read).
- Terminal layout: 53×22 grid (2×3).
