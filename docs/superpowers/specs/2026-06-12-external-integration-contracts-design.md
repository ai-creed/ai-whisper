# External Integration Contracts — `env --json`, Event Socket, Read Contract

**Date:** 2026-06-12
**Status:** Design approved (mirrors contracts pinned and already implemented consumer-side in ai-14all); implementation plan not yet written.
**Companions:**
- ai-14all spec: `docs/superpowers/specs/2026-06-12-ecosystem-plugin-framework-whisper-driver-design.md` (in the ai-14all repo)
- ai-14all consumer implementations (the binding compatibility targets, landed on ai-14all master `ccec3f3..21f1f58`):
  `services/plugins/whisper/whisper-env-probe.ts`, `whisper-store-reader.ts`,
  `whisper-event-socket.ts`, `whisper-collab-watcher.ts`

## 1. Context

ai-14all now ships an opt-in ecosystem plug-in framework whose first driver targets
ai-whisper. The driver detects whisper, reads workflow/collab state, subscribes to
live events, and routes operator actions through whisper's own CLI. It was built
against **provisional contracts** that this spec now makes real on the whisper side.

Design constraint carried over from the ecosystem principle: nothing in these
deliverables is ai-14all-specific. They are sanctioned integration surfaces any
external supervisor (ai-samantha later) can consume. Whisper remains the sole owner
of its state and its schema migrations.

Because the consumer already exists, **the contracts below are fixed, not
negotiable defaults**: field names, frame shapes, socket path, and version values
must match exactly or ai-14all degrades (by design, gracefully — but pointlessly).

## 2. Deliverable 1: `whisper env --json`

A new top-level CLI command (registered in `packages/cli/src/create-cli.ts`,
following the existing commander patterns; `--json` flag precedent:
`collab status --json`, create-cli.ts:161-172).

Behavior:

- `whisper env --json` prints **exactly one JSON object and nothing else** on
  stdout, then exits 0. No banner, no log lines, no trailing prose — the consumer
  does `JSON.parse(stdout)` and treats any parse failure as `not-installed`.
- Works in any cwd, with or without a collab, with or without a daemon running.
  It must not touch the network and must not require the DB to exist (the schema
  version is a compile-time constant, not a DB read).
- Shape (consumer validates with zod; extra fields are tolerated but these five
  are required, with these exact names and types):

```json
{
	"engineVersion": "0.5.8",
	"installPath": "/opt/homebrew/lib/node_modules/ai-whisper",
	"stateRoot": "/Users/x/.ai-whisper",
	"dbSchemaVersion": 6,
	"protocolVersion": "1"
}
```

- `engineVersion`: `resolveCliVersion()` (create-cli.ts:64-77).
- `installPath`: the package install root the CLI is running from (derive from the
  same package.json resolution `resolveCliVersion` uses).
- `stateRoot`: `getStateRoot()` (packages/cli/src/runtime/state-root.ts:4-6),
  i.e. it honors `AI_WHISPER_STATE_ROOT`.
- `dbSchemaVersion`: `CURRENT_SCHEMA_VERSION` imported from
  `packages/broker/src/storage/apply-migrations.ts:10` (currently 6) — never a
  hand-maintained literal.
- `protocolVersion`: the event-socket protocol version, `"1"` (a string), from one
  shared constant also used by the socket fanout (§3).
- `whisper env` without `--json` may print a human-readable rendering; only the
  `--json` form is contractual.

Consumer behavior for context: a whisper without this command probes as
`incompatible — upgrade whisper`; `dbSchemaVersion` outside the consumer's
supported range produces "update ai-14all" / "upgrade whisper" chips. The command
is the single sanctioned machine-readable answer to "are you there and can we
talk?".

## 3. Deliverable 2: broker daemon event-socket fanout

Each per-collab broker daemon serves a Unix domain socket that fans out its
in-process `BrokerEventBus` events as newline-delimited JSON.

**Path (fixed):** `<stateRoot>/sockets/events-<collabId>.sock` — built from the
existing `getStateSocketsDir()` (state-root.ts:12-14). The consumer computes this
path deterministically; it is not stored in the DB (no schema change, no read-
contract bump).

**Protocol (version "1"):**

- Framing: one JSON object per `\n`-terminated line. Frames must never be split
  or interleaved mid-line across writes (the consumer disconnects and falls back
  to DB polling on any unparseable line).
- On client connect, the server immediately writes the hello frame:

```json
{ "type": "hello", "engineVersion": "0.5.8", "protocolVersion": "1" }
```

- Thereafter, one frame per `BrokerEventBus` emission, for **all** event names in
  `BrokerEventMap` (broker-event-bus.ts:4-41): `chain.resolved`,
  `chain.escalated`, `workflow.created`, `workflow.phase-started`,
  `workflow.round-started`, `workflow.phase-done`, `workflow.halted`,
  `workflow.canceled`, `workflow.done`, `workflow.resumed`, `workflow.paused`:

```json
{ "type": "event", "name": "workflow.halted", "payload": { "workflowId": "wf_x", "reason": "…" }, "ts": "2026-06-12T10:00:00.000Z" }
```

  `payload` is the bus payload verbatim; `ts` is an ISO-8601 timestamp stamped at
  fanout time. The bus has no wildcard subscription (`on` is per-event-name,
  broker-event-bus.ts:45-51), so the fanout either subscribes to every name
  explicitly or the bus gains an internal emit tap — implementation's choice, but
  the event-name list must not silently drift from `BrokerEventMap` (a
  type-level exhaustiveness guard is required).
- Multi-client: any number of concurrent clients, each getting every frame. A
  slow/dead client must never block the daemon or the other clients (drop the
  client on write error).
- Consumers treat frames as **wake-up signals only** ("re-read the DB now"); the
  DB remains the source of truth. Payload richness is therefore not contractual
  beyond the shapes above.

**Lifecycle:**

- Socket created when the daemon runtime starts (it knows `collabId` via
  `AI_WHISPER_COLLAB_ID`, broker-daemon.ts:25). A stale socket file from a
  crashed predecessor is unlinked before binding.
- Socket closed and the file unlinked in the daemon `shutdown()` path
  (packages/cli/src/bin/broker-daemon.ts:113-120, SIGTERM/SIGINT).
- Fanout failures must never affect broker operation: if the socket cannot be
  created, the daemon logs and continues (consumers silently poll instead).

**Heartbeat cadence guarantee (documented, already true):** the daemon updates
`broker_daemon.last_heartbeat_at` every 10 s by default
(`AI_WHISPER_HEARTBEAT_MS`, create-broker-runtime.ts:68). External readers treat
a heartbeat older than 30 s as daemon-dead; the default cadence must stay
comfortably under that. This guarantee belongs in the read-contract doc (§4).

**Protocol versioning:** breaking changes to framing, the hello shape, or frame
shapes bump `protocolVersion`. Consumers refuse a mismatched hello and fall back
to polling. Adding new event names is non-breaking.

## 4. Deliverable 3: `state-db-read-contract.md`

A committed contract doc — `docs/state-db-read-contract.md` — modeled on
ai-cortex's `cortex-index-contract.md` playbook: the explicit, versioned list of
what external read-only consumers may rely on. Everything not listed is
implementation detail and may change without notice.

Contents:

1. **Access rules:** consumers open `<stateRoot>/state.db` read-only
   (`busy_timeout` recommended; WAL makes concurrent readers safe), never write,
   never migrate. Whisper is the sole migrator.
2. **Version gate:** `PRAGMA user_version` is the contract version (currently 6,
   `CURRENT_SCHEMA_VERSION`). Readers declare a supported range and refuse reads
   outside it. **Any breaking change to a contract table/column bumps
   `CURRENT_SCHEMA_VERSION` and this doc in the same change.** Additive columns
   are non-breaking.
3. **The contract surface** (exact subset ai-14all reads today):

| table | columns external readers may rely on |
|---|---|
| `collab` | `collab_id`, `workspace_root`, `display_name`, `status` |
| `broker_daemon` | `collab_id`, `host`, `port`, `pid`, `last_heartbeat_at` |
| `session_binding` | `collab_id`, `agent_type`, `binding_state` (`unbound \| pending_attach \| bound`) |
| `workflows` | `workflow_id`, `collab_id`, `workflow_type`, `status`, `current_phase_index`, `halt_reason`, `updated_at` |
| `workflow_phases` | `phase_run_id`, `workflow_id`, `phase_index`, `phase_name`, `chain_id`, `started_at`, `ended_at`, `outcome` |
| `relay_chains` | `chain_id`, `collab_id`, `status` (`active \| done \| escalated \| abandoned`), `current_round`, `max_rounds`, `terminal_reason`, `updated_at` |
| `relay_handoff` | `handoff_id`, `chain_id`, `sender_agent`, `target_agent`, `request_text`, `handback_text`, `orchestrator_verdict`, `round_number`, `created_at` |

4. **Semantics notes:** timestamps are UTC ISO-8601 strings (lexicographically
   sortable — readers order by them); at most one `running|paused` workflow per
   collab (unique index `workflows_one_running_per_collab`); the heartbeat
   cadence guarantee from §3; `relay_chains.status` value set pinned to
   `RelayChainStatus` (relay-chain-repository.ts:3).
5. The socket path convention and protocol version from §3 (so one doc carries
   the whole external surface).

## 5. Deliverable 4: CI contract test

A vitest suite (existing framework; `test/**/*.test.ts`, helpers like
`test/helpers/start-collab-for-test.ts` show the temp-state-root pattern) that:

1. Runs the real migrations into a fresh temp `state.db`.
2. Asserts `PRAGMA user_version` equals the version stated in
   `docs/state-db-read-contract.md` (parse the doc or pin via a shared constant —
   the test must fail if code and doc diverge).
3. Asserts every contract table/column from §4 exists, by querying
   `pragma table_info(...)` — the column list lives in the test as a literal
   mirror of the doc, deliberately not derived from repository code, so schema
   drift without a contract bump fails CI.
4. Asserts the `protocolVersion` constant matches the doc.

Runs in the existing `pnpm test` CI job (.github/workflows/ci.yml) — no new
workflow needed.

## 6. Out of scope / deferred

- **Daemon HTTP control endpoints** — v2, only if CLI shell-out proves limiting
  for supervisors (ai-14all currently invokes `whisper workflow pause/resume/
  cancel` and `collab tell/recover` as argv-array child processes; that works).
- **Pushing lens state through the socket** — frames stay wake-up signals; the
  DB read contract carries the data.
- Anything ai-14all-specific (naming, payload tailoring) — these surfaces are
  consumer-agnostic by design.

## 7. Acceptance criteria

1. `whisper env --json` from any cwd prints the §2 object, parseable by
   ai-14all's `WhisperEnvReportSchema`, exit 0; pure-stdout discipline holds.
2. With a collab daemon running, connecting to
   `<stateRoot>/sockets/events-<collabId>.sock` yields the hello frame first;
   pausing/resuming a workflow produces matching `workflow.paused` /
   `workflow.resumed` frames; killing the daemon removes the socket file.
3. ai-14all integration smoke (manual, dev checkout): with the driver's
   `install_path` pointed at this working tree, the Plugins panel chip reads
   `on` (not `limited`) and a live `workflow.halted` flips the sidebar lens
   without waiting for a poll.
4. The contract test fails if any §4 table/column is renamed/dropped without a
   `CURRENT_SCHEMA_VERSION` + doc bump, or if `protocolVersion` drifts.
5. Repo gates green: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.
