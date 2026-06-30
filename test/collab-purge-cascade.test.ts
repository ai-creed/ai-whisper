import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { listAllCollabs } from "../packages/broker/src/storage/repositories/collab-repository.ts";

function freshDb() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "purge-"));
	const db = openDatabase(path.join(tmp, "state.db"));
	applyMigrations(db);
	return { db, tmp };
}

function seedCollab(
	db: ReturnType<typeof openDatabase>,
	id: string,
	opts: {
		workspaceId?: string;
		workspaceRoot?: string;
		status?: string;
		tmuxSession?: string | null;
	} = {},
) {
	db.prepare(
		`INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, tmux_session, created_at, updated_at)
     VALUES (?, ?, 't', ?, ?, ?, '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z')`,
	).run(
		id,
		opts.workspaceRoot ?? `/ws/${id}`,
		opts.status ?? "active",
		opts.workspaceId ?? `wsid-${id}`,
		opts.tmuxSession ?? null,
	);
}

describe("listAllCollabs", () => {
	it("returns every collab regardless of workspace or status", () => {
		const { db } = freshDb();
		seedCollab(db, "c1", { workspaceId: "wsA", status: "active" });
		seedCollab(db, "c2", {
			workspaceId: "wsB",
			status: "stopped",
			tmuxSession: "aiw-c2",
		});
		const rows = listAllCollabs(db);
		db.close();
		expect(rows.map((r) => r.collabId).sort()).toEqual(["c1", "c2"]);
		const c2 = rows.find((r) => r.collabId === "c2")!;
		expect(c2.status).toBe("stopped");
		expect(c2.workspaceId).toBe("wsB");
		expect(c2.tmuxSession).toBe("aiw-c2");
	});
});
