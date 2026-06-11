import type Database from "better-sqlite3";
import { enforceOneActiveCollabPerWorkspace } from "./enforce-one-active-collab.js";
import { sweepStaleCaptureLease } from "./clipboard-capture-lease.js";

// Bump this whenever runMigrationBody gains new schema (tables/columns/indexes).
// The body is fully idempotent (CREATE ... IF NOT EXISTS + PRAGMA-guarded
// ALTERs), so a persisted DB at an older user_version safely re-runs it and
// picks up the additions. Forgetting to bump means a persisted DB never gets
// the new schema (it only worked for freshly-created DBs).
export const CURRENT_SCHEMA_VERSION = 6;

const initMigrationSql = `
CREATE TABLE IF NOT EXISTS broker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  migrated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collab (
  collab_id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  orchestrator_enabled INTEGER NOT NULL DEFAULT 0,
  orchestrator_max_rounds INTEGER NOT NULL DEFAULT 3
);

CREATE TABLE IF NOT EXISTS session (
  session_id TEXT PRIMARY KEY,
  collab_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  registration_state TEXT NOT NULL,
  health_state TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread (
  thread_id TEXT PRIMARY KEY,
  collab_id TEXT NOT NULL,
  title TEXT NOT NULL,
  thread_state TEXT NOT NULL,
  base_context_ref TEXT,
  current_turn_index INTEGER NOT NULL,
  active INTEGER NOT NULL,
  created_by_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_item (
  work_item_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  collab_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  sender_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  instruction TEXT NOT NULL,
  context_packet_json TEXT NOT NULL,
  delivery_state TEXT NOT NULL,
  artifact_manifest_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS reply (
  reply_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  collab_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  transition_intent TEXT,
  artifact_manifest_ids_json TEXT NOT NULL,
  consumed_by_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_manifest (
  artifact_manifest_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  collab_id TEXT NOT NULL,
  produced_by_session_id TEXT NOT NULL,
  artifact_category TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_attachment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collab_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  artifact_manifest_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  attached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companion_session (
  collab_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  session_secret TEXT NOT NULL,
  health_state TEXT NOT NULL DEFAULT 'healthy',
  registered_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (collab_id, session_id)
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  collab_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attach_claim (
  claim_id TEXT PRIMARY KEY,
  collab_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  mode TEXT NOT NULL,
  secret TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS session_binding (
  collab_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  binding_state TEXT NOT NULL,
  active_session_id TEXT,
  binding_source TEXT,
  pending_claim_id TEXT,
  pending_claim_expires_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collab_id, agent_type)
);

CREATE TABLE IF NOT EXISTS relay_monitor (
  collab_id TEXT NOT NULL,
  monitor_id TEXT PRIMARY KEY,
  registered_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collab_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  sender_agent TEXT,
  receiver_agent TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_item_cancellation (
  work_item_id TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_turn_state (
  collab_id TEXT PRIMARY KEY,
  turn_owner TEXT NOT NULL,
  waiting_agent TEXT,
  unresolved_handoff_id TEXT,
  handoff_state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  orchestrator_enabled INTEGER NOT NULL DEFAULT 0,
  current_round INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 3,
  chain_status TEXT NOT NULL DEFAULT 'done'
);

CREATE TABLE IF NOT EXISTS relay_handoff (
  handoff_id TEXT PRIMARY KEY,
  collab_id TEXT NOT NULL,
  sender_agent TEXT NOT NULL,
  target_agent TEXT NOT NULL,
  request_text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  deferred_at TEXT,
  resolved_at TEXT,
  last_activity_at TEXT NOT NULL,
  capture_status TEXT,
  chain_id TEXT,
  parent_handoff_id TEXT,
  round_number INTEGER,
  root_request_text TEXT,
  handback_text TEXT,
  orchestrator_status TEXT,
  orchestrator_verdict TEXT,
  orchestrator_reason TEXT,
  orchestrator_claimed_at TEXT,
  orchestrator_evaluated_at TEXT
);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  collab_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  name TEXT,
  spec_path TEXT NOT NULL,
  role_bindings TEXT NOT NULL,
  status TEXT NOT NULL,
  current_phase_index INTEGER NOT NULL,
  halt_reason TEXT,
  workflow_context TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

DROP INDEX IF EXISTS workflows_one_running_per_collab;
CREATE UNIQUE INDEX IF NOT EXISTS workflows_one_running_per_collab
  ON workflows(collab_id) WHERE status IN ('running', 'paused');

CREATE TABLE IF NOT EXISTS workflow_phases (
  phase_run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  phase_index INTEGER NOT NULL,
  phase_name TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT
);

CREATE INDEX IF NOT EXISTS workflow_phases_by_workflow
  ON workflow_phases(workflow_id, phase_index);

CREATE TABLE IF NOT EXISTS relay_chains (
  chain_id TEXT PRIMARY KEY,
  collab_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_round INTEGER NOT NULL,
  max_rounds INTEGER NOT NULL,
  terminal_handoff_id TEXT,
  terminal_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace (
  id              TEXT PRIMARY KEY,
  workspace_root  TEXT NOT NULL UNIQUE,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_attachment (
  collab_id        TEXT NOT NULL REFERENCES collab(collab_id) ON DELETE CASCADE,
  agent_type       TEXT NOT NULL,
  attachment_kind  TEXT NOT NULL,
  session_id       TEXT,
  provider_id      TEXT,
  launch_mode      TEXT,
  tty_path         TEXT,
  pid              INTEGER,
  window_label     TEXT,
  attached_at      TEXT NOT NULL,
  PRIMARY KEY (collab_id, agent_type, attachment_kind)
);

CREATE TABLE IF NOT EXISTS broker_daemon (
  collab_id          TEXT PRIMARY KEY REFERENCES collab(collab_id) ON DELETE CASCADE,
  host               TEXT NOT NULL,
  port               INTEGER NOT NULL,
  pid                INTEGER,
  pid_start_time     TEXT,
  started_at         TEXT NOT NULL,
  last_heartbeat_at  TEXT NOT NULL,
  evaluator_status   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS broker_daemon_port ON broker_daemon(port);

CREATE TABLE IF NOT EXISTS recovery_state (
  collab_id            TEXT PRIMARY KEY REFERENCES collab(collab_id) ON DELETE CASCADE,
  state                TEXT NOT NULL,
  idle_after_recovery  INTEGER NOT NULL,
  recovered_at         TEXT
);

CREATE TABLE IF NOT EXISTS clipboard_capture_lease (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  holder_collab_id  TEXT,
  holder_pid        INTEGER,
  acquired_at       TEXT
);

`;

function ensureBrokerStateRow(db: Database.Database): void {
	db.prepare(
		`INSERT INTO broker_state (id, schema_version, migrated)
		VALUES (1, ?, 1)
		ON CONFLICT(id) DO UPDATE SET
		  schema_version = excluded.schema_version,
		  migrated = 1`,
	).run(CURRENT_SCHEMA_VERSION);
}

export function applyMigrations(db: Database.Database): void {
	const current = db.pragma("user_version", { simple: true }) as number;
	if (current < CURRENT_SCHEMA_VERSION) {
		db.exec("BEGIN EXCLUSIVE");
		try {
			runMigrationBody(db);
			db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}
	ensureBrokerStateRow(db);
	// Runs on EVERY call (not behind the user_version gate) and is idempotent:
	// a clean DB is a no-op, and the index is created on a later startup once a
	// residual duplicate is resolved. Kept out of runMigrationBody because the
	// unique index can fail on pre-existing duplicate rows.
	enforceOneActiveCollabPerWorkspace(db);
	// Idempotent startup sweep: clears a lease left held by a crashed mount
	// (dead holder pid or TTL-exceeded). A clean/free row is a no-op.
	sweepStaleCaptureLease(db);
}

function runMigrationBody(db: Database.Database): void {
	db.exec(initMigrationSql);

	const attachClaimColumns = db
		.prepare("PRAGMA table_info(attach_claim)")
		.all() as Array<{ name: string }>;
	if (!attachClaimColumns.some((column) => column.name === "target_mode")) {
		db.exec("ALTER TABLE attach_claim ADD COLUMN target_mode TEXT");
	}
	if (!attachClaimColumns.some((column) => column.name === "target_tty_path")) {
		db.exec("ALTER TABLE attach_claim ADD COLUMN target_tty_path TEXT");
	}

	const bindingColumns = db
		.prepare("PRAGMA table_info(session_binding)")
		.all() as Array<{ name: string }>;
	if (!bindingColumns.some((column) => column.name === "target_tty_path")) {
		db.exec("ALTER TABLE session_binding ADD COLUMN target_tty_path TEXT");
	}

	const replyColumns = db
		.prepare("PRAGMA table_info(reply)")
		.all() as Array<{ name: string }>;
	if (!replyColumns.some((column) => column.name === "consumed_by_json")) {
		db.exec(
			"ALTER TABLE reply ADD COLUMN consumed_by_json TEXT NOT NULL DEFAULT '[]'",
		);
	}

	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_item_cancellation'",
		)
		.all() as Array<{ name: string }>;
	if (tables.length === 0) {
		db.exec(
			`CREATE TABLE work_item_cancellation (
				work_item_id TEXT PRIMARY KEY,
				requested_at TEXT NOT NULL
			)`,
		);
	}

	const relayHandoffColumns = db
		.prepare("PRAGMA table_info(relay_handoff)")
		.all() as Array<{ name: string }>;
	if (!relayHandoffColumns.some((col) => col.name === "capture_status")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN capture_status TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "chain_id")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN chain_id TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "parent_handoff_id")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN parent_handoff_id TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "round_number")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN round_number INTEGER");
	}
	if (!relayHandoffColumns.some((column) => column.name === "root_request_text")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN root_request_text TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "handback_text")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN handback_text TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "orchestrator_status")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN orchestrator_status TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "orchestrator_verdict")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN orchestrator_verdict TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "orchestrator_reason")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN orchestrator_reason TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "orchestrator_claimed_at")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN orchestrator_claimed_at TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "orchestrator_evaluated_at")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN orchestrator_evaluated_at TEXT");
	}
	if (!relayHandoffColumns.some((c) => c.name === "handoff_step")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN handoff_step TEXT");
	}
	if (!relayHandoffColumns.some((c) => c.name === "workflow_id")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN workflow_id TEXT");
	}
	if (!relayHandoffColumns.some((c) => c.name === "phase_run_id")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN phase_run_id TEXT");
	}
	if (!relayHandoffColumns.some((c) => c.name === "evaluator_verdict")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN evaluator_verdict TEXT");
	}
	if (!relayHandoffColumns.some((c) => c.name === "evaluator_confidence")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN evaluator_confidence REAL");
	}
	if (!relayHandoffColumns.some((c) => c.name === "evaluator_reason")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN evaluator_reason TEXT");
	}
	if (!relayHandoffColumns.some((c) => c.name === "evaluator_evaluated_at")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN evaluator_evaluated_at TEXT");
	}

	const collabColumns = db.prepare("PRAGMA table_info(collab)").all() as Array<{ name: string }>;
	if (!collabColumns.some((column) => column.name === "orchestrator_enabled")) {
		db.exec("ALTER TABLE collab ADD COLUMN orchestrator_enabled INTEGER NOT NULL DEFAULT 0");
	}
	if (!collabColumns.some((column) => column.name === "orchestrator_max_rounds")) {
		db.exec("ALTER TABLE collab ADD COLUMN orchestrator_max_rounds INTEGER NOT NULL DEFAULT 3");
	}
	if (!collabColumns.some((column) => column.name === "workspace_id")) {
		db.exec("ALTER TABLE collab ADD COLUMN workspace_id TEXT");
	}
	if (!collabColumns.some((column) => column.name === "stopped_at")) {
		db.exec("ALTER TABLE collab ADD COLUMN stopped_at TEXT");
	}
	if (!collabColumns.some((column) => column.name === "launch_mode")) {
		db.exec("ALTER TABLE collab ADD COLUMN launch_mode TEXT");
	}
	if (!collabColumns.some((column) => column.name === "tmux_session")) {
		db.exec("ALTER TABLE collab ADD COLUMN tmux_session TEXT");
	}
	if (!collabColumns.some((column) => column.name === "relay_monitor_window_label")) {
		db.exec("ALTER TABLE collab ADD COLUMN relay_monitor_window_label TEXT");
	}
	if (!collabColumns.some((column) => column.name === "relay_monitor_pid")) {
		db.exec("ALTER TABLE collab ADD COLUMN relay_monitor_pid INTEGER");
	}
	db.exec("CREATE INDEX IF NOT EXISTS collab_by_workspace ON collab(workspace_id, status)");

	const relayTurnStateColumns = db.prepare("PRAGMA table_info(relay_turn_state)").all() as Array<{ name: string }>;
	if (!relayTurnStateColumns.some((column) => column.name === "orchestrator_enabled")) {
		db.exec("ALTER TABLE relay_turn_state ADD COLUMN orchestrator_enabled INTEGER NOT NULL DEFAULT 0");
	}
	if (!relayTurnStateColumns.some((column) => column.name === "current_round")) {
		db.exec("ALTER TABLE relay_turn_state ADD COLUMN current_round INTEGER NOT NULL DEFAULT 0");
	}
	if (!relayTurnStateColumns.some((column) => column.name === "max_rounds")) {
		db.exec("ALTER TABLE relay_turn_state ADD COLUMN max_rounds INTEGER NOT NULL DEFAULT 3");
	}
	if (!relayTurnStateColumns.some((column) => column.name === "chain_status")) {
		db.exec("ALTER TABLE relay_turn_state ADD COLUMN chain_status TEXT NOT NULL DEFAULT 'done'");
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS relay_capture_diagnostics (
			capture_id TEXT PRIMARY KEY,
			handoff_id TEXT NOT NULL,
			collab_id TEXT NOT NULL,
			chain_id TEXT,
			workflow_id TEXT,
			target_provider TEXT NOT NULL,
			capture_status TEXT NOT NULL,
			clip_len INTEGER NOT NULL,
			turn_len INTEGER NOT NULL,
			turn_confidence TEXT NOT NULL,
			jaccard_score REAL,
			containment_score REAL,
			clip_sample TEXT,
			turn_sample TEXT,
			aborted_by_race_guard INTEGER NOT NULL DEFAULT 0,
			interference_detected INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_relay_capture_diagnostics_collab_created
			ON relay_capture_diagnostics (collab_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_relay_capture_diagnostics_handoff
			ON relay_capture_diagnostics (handoff_id);
		CREATE INDEX IF NOT EXISTS idx_relay_capture_diagnostics_chain_created
			ON relay_capture_diagnostics (chain_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_relay_capture_diagnostics_status
			ON relay_capture_diagnostics (capture_status);
	`);

	// CREATE TABLE IF NOT EXISTS above does not alter a persisted DB, so add the
	// interference_detected column for DBs created before schema v5. Placed after
	// the relay_capture_diagnostics CREATE so the table is guaranteed to exist.
	const captureDiagColumns = db
		.prepare("PRAGMA table_info(relay_capture_diagnostics)")
		.all() as Array<{ name: string }>;
	if (!captureDiagColumns.some((column) => column.name === "interference_detected")) {
		db.exec(
			"ALTER TABLE relay_capture_diagnostics ADD COLUMN interference_detected INTEGER NOT NULL DEFAULT 0",
		);
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS relay_evaluator_diagnostics (
			evaluator_id TEXT PRIMARY KEY,
			handoff_id TEXT NOT NULL,
			collab_id TEXT NOT NULL,
			chain_id TEXT,
			workflow_id TEXT,
			phase_run_id TEXT,
			evaluator_branch TEXT NOT NULL,
			evaluator_prompt_key TEXT,
			handoff_step TEXT,
			attempt_kind TEXT NOT NULL,
			call_group_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			outcome TEXT NOT NULL,
			verdict TEXT,
			confidence REAL,
			reason TEXT,
			follow_up_message_len INTEGER,
			latency_ms INTEGER NOT NULL,
			error_message TEXT,
			input_tokens INTEGER,
			output_tokens INTEGER,
			prompt_sample TEXT,
			response_sample TEXT,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_relay_evaluator_diagnostics_collab_created
			ON relay_evaluator_diagnostics (collab_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_relay_evaluator_diagnostics_handoff
			ON relay_evaluator_diagnostics (handoff_id);
		CREATE INDEX IF NOT EXISTS idx_relay_evaluator_diagnostics_chain_created
			ON relay_evaluator_diagnostics (chain_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_relay_evaluator_diagnostics_workflow
			ON relay_evaluator_diagnostics (workflow_id);
		CREATE INDEX IF NOT EXISTS idx_relay_evaluator_diagnostics_call_group
			ON relay_evaluator_diagnostics (call_group_id);
		CREATE INDEX IF NOT EXISTS idx_relay_evaluator_diagnostics_outcome
			ON relay_evaluator_diagnostics (outcome);
	`);

	const brokerDaemonColumns = db
		.prepare("PRAGMA table_info(broker_daemon)")
		.all() as Array<{ name: string }>;
	if (!brokerDaemonColumns.some((column) => column.name === "evaluator_status")) {
		db.exec("ALTER TABLE broker_daemon ADD COLUMN evaluator_status TEXT");
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS relay_turn_event_diagnostics (
			event_id TEXT PRIMARY KEY,
			received_at TEXT NOT NULL,
			provider TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			session_or_thread_id TEXT,
			turn_id TEXT,
			workflow_active INTEGER NOT NULL DEFAULT 0,
			collab_id TEXT,
			workflow_id TEXT,
			chain_id TEXT,
			handoff_id TEXT,
			input_correlated INTEGER,
			containment_score REAL,
			fidelity_verdict TEXT NOT NULL DEFAULT 'n/a',
			defer_count INTEGER NOT NULL DEFAULT 0,
			action TEXT NOT NULL,
			message_len INTEGER NOT NULL DEFAULT 0,
			message_sample TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_relay_turn_event_diag_collab_received
			ON relay_turn_event_diagnostics (collab_id, received_at DESC);
		CREATE INDEX IF NOT EXISTS idx_relay_turn_event_diag_handoff
			ON relay_turn_event_diagnostics (handoff_id);
		CREATE INDEX IF NOT EXISTS idx_relay_turn_event_diag_action
			ON relay_turn_event_diagnostics (action);
		CREATE INDEX IF NOT EXISTS idx_relay_turn_event_diag_received
			ON relay_turn_event_diagnostics (received_at);
	`);
}
