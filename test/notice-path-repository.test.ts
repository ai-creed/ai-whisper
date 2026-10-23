import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { handoffBackRelayTxn } from "../packages/broker/src/storage/repositories/relay-handoff-repository.ts";
import {
	findFetchedUnrepliedHandoff,
	getNoticePathFields,
	getSessionBindingTurnDone,
	markHandoffReplied,
	markSessionBindingTurnDone,
	recordHandoffFetch,
} from "../packages/broker/src/storage/repositories/notice-path-repository.ts";
import {
	DIAGNOSTICS_TABLES,
	LEDGER_TABLES,
	RUNTIME_TABLES,
	assertCollabTablesClassified,
	listCollabIdTables,
} from "../packages/broker/src/storage/repositories/collab-repository.ts";

// RUNTIME_TABLES as shipped in 0.16.0 (master before the notice path). Installed
// 0.16.0's `whisper collab purge` refuses any DB carrying a collab_id table it
// does not classify, so this branch must not add one.
const RUNTIME_TABLES_0_16_0 = [
	"artifact_attachment",
	"artifact_manifest",
	"attach_claim",
	"broker_daemon",
	"companion_session",
	"duo_assignment",
	"duo_roll",
	"event_log",
	"recovery_state",
	"relay_event",
	"relay_monitor",
	"relay_turn_state",
	"reply",
	"session",
	"session_attachment",
	"session_binding",
	"thread",
	"work_item",
	"workflow_event_outbox",
];

const NEW_HANDOFF_COLUMNS = [
	"delivery_path",
	"notice_sent_at",
	"reminder_sent_at",
	"nudge_sent_at",
	"fetched_at",
	"fetch_count",
	"capture_path",
	"replied_at",
	"reply_refused_at",
];

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "np-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run("c1", "/tmp/r", "test", "active", "2026-05-15T00:00:00Z", "2026-05-15T00:00:00Z");
	return db;
}

function seedBinding(db: Database.Database, collabId: string, agent: string) {
	db.prepare(
		"INSERT INTO session_binding (collab_id, agent_type, binding_state, updated_at) VALUES (?, ?, 'bound', '2026-05-15T00:00:00Z')",
	).run(collabId, agent);
}

function columnNames(db: Database.Database, table: string): string[] {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
		(c) => c.name,
	);
}

function tableExists(db: Database.Database, table: string): boolean {
	return !!db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table);
}

function seedHandoff(
	db: Database.Database,
	id: string,
	o: {
		target?: string;
		status?: string;
		workflowId?: string | null;
		acceptedAt?: string;
		fetchedAt?: string | null;
		repliedAt?: string | null;
		handbackText?: string | null;
		orchestratorStatus?: string | null;
	} = {},
) {
	db.prepare(
		`INSERT INTO relay_handoff
		   (handoff_id, collab_id, sender_agent, target_agent, request_text, status,
		    created_at, accepted_at, last_activity_at, workflow_id, fetched_at, replied_at,
		    handback_text, orchestrator_status)
		 VALUES (?, 'c1', 'claude', ?, 'req', ?, '2026-05-15T00:00:00Z', ?, '2026-05-15T00:00:00Z', ?, ?, ?, ?, ?)`,
	).run(
		id,
		o.target ?? "codex",
		o.status ?? "accepted",
		o.acceptedAt ?? "2026-05-15T00:01:00Z",
		o.workflowId === undefined ? "w1" : o.workflowId,
		o.fetchedAt ?? null,
		o.repliedAt ?? null,
		o.handbackText ?? null,
		o.orchestratorStatus ?? null,
	);
}

describe("notice-path schema", () => {
	it("applyMigrations is idempotent for notice-path schema", () => {
		const db = freshDb();
		applyMigrations(db);
		applyMigrations(db);
		const cols = columnNames(db, "relay_handoff");
		for (const c of NEW_HANDOFF_COLUMNS) expect(cols).toContain(c);
		expect(columnNames(db, "broker_daemon")).toContain("cli_version");
		expect(columnNames(db, "session_binding")).toContain("turn_done_at");
		expect(tableExists(db, "seat_turn_done")).toBe(false);
		expect(db.pragma("user_version", { simple: true })).toBe(8);
	});

	it("adds no collab_id table that installed 0.16.0 would not classify", () => {
		const db = freshDb();
		expect([...RUNTIME_TABLES]).toEqual(RUNTIME_TABLES_0_16_0);
		const classified0160 = new Set([...LEDGER_TABLES, ...DIAGNOSTICS_TABLES, ...RUNTIME_TABLES_0_16_0]);
		const unclassified = listCollabIdTables(db).filter((t) => !classified0160.has(t));
		expect(unclassified).toEqual([]);
		expect(() => assertCollabTablesClassified(db)).not.toThrow();
	});

	it("adds columns to a DB already at user_version 8", () => {
		const db = freshDb();
		for (const c of NEW_HANDOFF_COLUMNS) db.exec(`ALTER TABLE relay_handoff DROP COLUMN ${c}`);
		db.exec("ALTER TABLE broker_daemon DROP COLUMN cli_version");
		db.exec("ALTER TABLE session_binding DROP COLUMN turn_done_at");
		expect(db.pragma("user_version", { simple: true })).toBe(8);

		applyMigrations(db);

		const cols = columnNames(db, "relay_handoff");
		for (const c of NEW_HANDOFF_COLUMNS) expect(cols).toContain(c);
		expect(columnNames(db, "broker_daemon")).toContain("cli_version");
		expect(columnNames(db, "session_binding")).toContain("turn_done_at");
		expect(db.pragma("user_version", { simple: true })).toBe(8);
	});
});

describe("handoffBackRelayTxn reply guard", () => {
	it("is a no-op once replied_at is set", () => {
		const db = freshDb();
		db.prepare("UPDATE collab SET orchestrator_enabled = 1 WHERE collab_id = 'c1'").run();
		seedHandoff(db, "h1", { repliedAt: "2026-05-15T00:02:00Z", handbackText: "R" });
		const before = db.prepare("SELECT * FROM relay_handoff WHERE handoff_id = 'h1'").get();

		const record = handoffBackRelayTxn(db, {
			handoffId: "h1",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "CAPTURED",
			now: "2026-05-15T00:03:00Z",
		});

		const after = db.prepare("SELECT * FROM relay_handoff WHERE handoff_id = 'h1'").get();
		expect(after).toEqual(before);
		expect(record.handbackText).toBe("R");
		expect(record.status).toBe("accepted");
		expect(record.orchestratorStatus).toBeNull();
		expect(record.resolvedAt).toBeNull();
	});
});

describe("notice-path repository", () => {
	it("recordHandoffFetch sets fetched_at once and counts", () => {
		const db = freshDb();
		seedHandoff(db, "h1");
		recordHandoffFetch(db, { handoffId: "h1", now: "T1" });
		recordHandoffFetch(db, { handoffId: "h1", now: "T2" });
		const f = getNoticePathFields(db, "h1");
		expect(f?.fetchedAt).toBe("T1");
		expect(f?.fetchCount).toBe(2);
		expect(getNoticePathFields(db, "nope")).toBeNull();
	});

	it("markHandoffReplied sets capture_path reply", () => {
		const db = freshDb();
		seedHandoff(db, "h1");
		markHandoffReplied(db, { handoffId: "h1", now: "T1" });
		const f = getNoticePathFields(db, "h1");
		expect(f?.capturePath).toBe("reply");
		expect(f?.repliedAt).toBe("T1");
	});

	it("markSessionBindingTurnDone overwrites per seat", () => {
		const db = freshDb();
		seedBinding(db, "c1", "codex");
		seedBinding(db, "c1", "claude");
		expect(markSessionBindingTurnDone(db, { collabId: "c1", agent: "codex", now: "T1" })).toBe(true);
		expect(markSessionBindingTurnDone(db, { collabId: "c1", agent: "claude", now: "T5" })).toBe(true);
		expect(markSessionBindingTurnDone(db, { collabId: "c1", agent: "codex", now: "T2" })).toBe(true);
		expect(getSessionBindingTurnDone(db, { collabId: "c1", agent: "codex" })).toBe("T2");
		expect(getSessionBindingTurnDone(db, { collabId: "c1", agent: "claude" })).toBe("T5");
		expect(getSessionBindingTurnDone(db, { collabId: "other", agent: "codex" })).toBeNull();
	});

	it("markSessionBindingTurnDone records nothing without a binding row", () => {
		const db = freshDb();
		expect(markSessionBindingTurnDone(db, { collabId: "c1", agent: "codex", now: "T1" })).toBe(false);
		expect(getSessionBindingTurnDone(db, { collabId: "c1", agent: "codex" })).toBeNull();
		const n = (db.prepare("SELECT COUNT(*) AS n FROM session_binding").get() as { n: number }).n;
		expect(n).toBe(0);
	});

	it("findFetchedUnrepliedHandoff ignores unfetched, replied, non-workflow and other-agent rows", () => {
		const db = freshDb();
		seedHandoff(db, "unfetched");
		seedHandoff(db, "replied", { fetchedAt: "F", repliedAt: "R" });
		seedHandoff(db, "nonwf", { fetchedAt: "F", workflowId: null });
		seedHandoff(db, "other", { fetchedAt: "F", target: "claude" });
		seedHandoff(db, "pending", { fetchedAt: "F", status: "pending" });
		seedHandoff(db, "old", { fetchedAt: "F", acceptedAt: "2026-05-15T00:01:00Z" });
		seedHandoff(db, "match", { fetchedAt: "F", acceptedAt: "2026-05-15T00:05:00Z" });
		expect(findFetchedUnrepliedHandoff(db, { collabId: "c1", agent: "codex" })).toBe("match");
		expect(findFetchedUnrepliedHandoff(db, { collabId: "c2", agent: "codex" })).toBeNull();
	});
});

describe("notice-path reads on an unmigrated DB", () => {
	it("getNoticePathFields and findFetchedUnrepliedHandoff do not throw without the new columns", () => {
		const db = freshDb();
		seedHandoff(db, "h1");
		for (const c of NEW_HANDOFF_COLUMNS) db.exec(`ALTER TABLE relay_handoff DROP COLUMN ${c}`);
		expect(getNoticePathFields(db, "h1")).toEqual({
			deliveryPath: null,
			fetchedAt: null,
			fetchCount: 0,
			capturePath: null,
			repliedAt: null,
			replyRefusedAt: null,
		});
		expect(getNoticePathFields(db, "nope")).toBeNull();
		expect(findFetchedUnrepliedHandoff(db, { collabId: "c1", agent: "codex" })).toBeNull();
	});

	it("session-binding turn-done read and write do not throw without turn_done_at", () => {
		const db = freshDb();
		seedBinding(db, "c1", "codex");
		db.exec("ALTER TABLE session_binding DROP COLUMN turn_done_at");
		expect(markSessionBindingTurnDone(db, { collabId: "c1", agent: "codex", now: "T1" })).toBe(false);
		expect(getSessionBindingTurnDone(db, { collabId: "c1", agent: "codex" })).toBeNull();
	});
});
