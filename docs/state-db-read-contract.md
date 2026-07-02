# ai-whisper state-db read contract

<!-- contract-version: 7 -->
<!-- protocol-version: 1 -->

**Status:** Stable, versioned. This document is the explicit, versioned list of
what external **read-only** consumers (e.g. ai-14all, ai-samantha) may rely on
when reading ai-whisper's SQLite state. Everything not listed here is
implementation detail and may change without notice. ai-whisper is the sole
owner of this state and the sole migrator.

This contract is consumer-agnostic by design: nothing here is specific to any
one supervisor.

## 1. Access rules

- Consumers open `<stateRoot>/state.db` **read-only**. `stateRoot` is
  `$AI_WHISPER_STATE_ROOT` if set, else `~/.ai-whisper` — discover it from
  `whisper env --json` (`stateRoot` field), never hard-code it.
- A `busy_timeout` is recommended. The database runs in WAL mode, so concurrent
  readers are safe alongside the writer.
- Consumers **never** write and **never** migrate. Only ai-whisper migrates.

## 2. Version gate

- `PRAGMA user_version` is the contract version. It currently reads **6**
  (`CURRENT_SCHEMA_VERSION`).
- Readers declare a supported version range and refuse to read a database whose
  `user_version` is outside that range.
- **Any breaking change to a contract table or column below — a rename, a drop,
  a type/meaning change — bumps `CURRENT_SCHEMA_VERSION` and this document in the
  same change.** Adding a new column to a contract table is non-breaking and does
  not require a bump.

## 3. Contract surface

The exact subset of tables and columns external readers may rely on:

| table | columns external readers may rely on |
|---|---|
| `collab` | `collab_id`, `workspace_root`, `display_name`, `status` |
| `broker_daemon` | `collab_id`, `host`, `port`, `pid`, `last_heartbeat_at` |
| `session_binding` | `collab_id`, `agent_type`, `binding_state` (`unbound` \| `pending_attach` \| `bound`) |
| `workflows` | `workflow_id`, `collab_id`, `workflow_type`, `status`, `current_phase_index`, `halt_reason`, `updated_at` |
| `workflow_phases` | `phase_run_id`, `workflow_id`, `phase_index`, `phase_name`, `chain_id`, `started_at`, `ended_at`, `outcome` |
| `relay_chains` | `chain_id`, `collab_id`, `status` (`active` \| `done` \| `escalated` \| `abandoned`), `current_round`, `max_rounds`, `terminal_reason`, `updated_at` |
| `relay_handoff` | `handoff_id`, `chain_id`, `sender_agent`, `target_agent`, `request_text`, `handback_text`, `orchestrator_verdict`, `round_number`, `created_at` |

## 4. Semantics notes

- **Timestamps** are UTC ISO-8601 strings and are lexicographically sortable;
  order by them directly (e.g. `ORDER BY updated_at`).
- **At most one active workflow per collab:** a unique index
  (`workflows_one_running_per_collab`) guarantees at most one workflow with
  `status IN ('running','paused')` per `collab_id`.
- **`relay_chains.status`** is one of `active`, `done`, `escalated`, `abandoned`
  (pinned to the `RelayChainStatus` type).
- **Heartbeat cadence guarantee:** the daemon updates
  `broker_daemon.last_heartbeat_at` every 10 s by default (`AI_WHISPER_HEARTBEAT_MS`).
  External readers should treat a heartbeat older than 30 s as daemon-dead; the
  default cadence stays comfortably under that threshold.

## 5. Event socket (companion surface)

A live wake-up signal complements the read contract. Each per-collab broker
daemon serves a Unix domain socket:

- **Path:** `<stateRoot>/sockets/events-<collabId>.sock`, computed deterministically
  by the consumer (not stored in the DB).
- **Protocol version:** `"1"` — also reported as `protocolVersion` by
  `whisper env --json`. Breaking changes to framing or frame shape bump this
  version; consumers refuse a mismatched hello frame and fall back to DB polling.
  Adding new event names is non-breaking.
- **Framing:** one JSON object per `\n`-terminated line. On connect the server
  writes a `hello` frame (`{ "type": "hello", "engineVersion": "...", "protocolVersion": "1" }`),
  then one `event` frame per broker event
  (`{ "type": "event", "name": "...", "payload": {...}, "ts": "<ISO-8601>" }`).
- Frames are **wake-up signals only** ("re-read the DB now"); the database
  remains the source of truth. Payload richness beyond these shapes is not
  contractual.
