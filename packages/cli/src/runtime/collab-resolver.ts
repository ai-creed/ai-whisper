import type Database from "better-sqlite3";
import {
	getBrokerDaemonByCollab,
	getRecoveryState,
	listSessionAttachmentsByCollab,
	type SessionAttachmentRecord,
} from "@ai-whisper/broker";
import { workspaceIdFromPath } from "./workspace-id.js";

export type ResolverErrorKind =
	| "NoCollabFoundForCwd"
	| "CollabAlreadyStopped"
	| "NoLiveDaemonForCollab"
	| "WorkspaceUnreadable";

export class CollabResolverError extends Error {
	constructor(public readonly kind: ResolverErrorKind, message: string) {
		super(message);
		this.name = "CollabResolverError";
	}
}

export interface ResolvedCollab {
	collabId: string;
	workspaceId: string | null;
	workspaceRoot: string;
	daemon: { host: string; port: number; pid: number } | null;
	launch: { mode: "tmux" | "terminals" | "none"; tmuxSession?: string };
	recovery: {
		state: "normal" | "recovery_required" | "recovered";
		idleAfterRecovery: boolean;
		recoveredAt: string | null;
	};
	status: "active" | "stopped";
	attachments: SessionAttachmentRecord[];
}

interface CollabRow {
	collab_id: string;
	workspace_id: string | null;
	workspace_root: string;
	status: "active" | "stopped";
	launch_mode: "tmux" | "terminals" | "none" | null;
	tmux_session: string | null;
}

export function resolveCollab(opts: {
	db: Database.Database;
	cwd: string;
	collabIdOverride?: string;
	requireActive?: boolean;
	requireDaemon?: boolean;
}): ResolvedCollab {
	const row = opts.collabIdOverride
		? (opts.db
			.prepare(
				"SELECT collab_id, workspace_id, workspace_root, status, launch_mode, tmux_session FROM collab WHERE collab_id = ?",
			)
			.get(opts.collabIdOverride) as CollabRow | undefined)
		: lookupByCwd(opts.db, opts.cwd);

	if (!row) {
		throw new CollabResolverError(
			"NoCollabFoundForCwd",
			opts.collabIdOverride
				? `no collab found for id ${opts.collabIdOverride}`
				: `no active collab found for cwd ${opts.cwd}`,
		);
	}

	if (opts.requireActive && row.status !== "active") {
		throw new CollabResolverError(
			"CollabAlreadyStopped",
			`collab ${row.collab_id} is already stopped`,
		);
	}

	const daemonRow = getBrokerDaemonByCollab(opts.db, row.collab_id);
	const daemon =
		daemonRow && daemonRow.pid !== null
			? { host: daemonRow.host, port: daemonRow.port, pid: daemonRow.pid }
			: null;

	if (opts.requireDaemon && daemon === null) {
		throw new CollabResolverError(
			"NoLiveDaemonForCollab",
			`no live daemon for collab ${row.collab_id}`,
		);
	}

	const recovery = getRecoveryState(opts.db, row.collab_id) ?? {
		collabId: row.collab_id,
		state: "normal" as const,
		idleAfterRecovery: false,
		recoveredAt: null,
	};

	const attachments = listSessionAttachmentsByCollab(opts.db, row.collab_id);

	return {
		collabId: row.collab_id,
		workspaceId: row.workspace_id,
		workspaceRoot: row.workspace_root,
		daemon,
		launch: {
			mode: row.launch_mode ?? "none",
			...(row.tmux_session ? { tmuxSession: row.tmux_session } : {}),
		},
		recovery: {
			state: recovery.state,
			idleAfterRecovery: recovery.idleAfterRecovery,
			recoveredAt: recovery.recoveredAt,
		},
		status: row.status,
		attachments,
	};
}

function lookupByCwd(db: Database.Database, cwd: string): CollabRow | undefined {
	let workspaceId: string;
	try {
		workspaceId = workspaceIdFromPath(cwd);
	} catch (err) {
		throw new CollabResolverError(
			"WorkspaceUnreadable",
			`cannot read workspace path ${cwd}: ${(err as Error).message}`,
		);
	}
	// Live-path cwd resolution must never surface an archived collab (run-ledger):
	// archived collabs are read-only history. `archived_at IS NULL` is belt-and-
	// braces on the active query (archiving also sets status='stopped') and the
	// real exclusion on the status-agnostic fallback, which would otherwise return
	// an archived collab as the most-recent one for the workspace.
	const active = db
		.prepare(
			"SELECT collab_id, workspace_id, workspace_root, status, launch_mode, tmux_session FROM collab WHERE workspace_id = ? AND status = 'active' AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1",
		)
		.get(workspaceId) as CollabRow | undefined;
	if (active) return active;
	return db
		.prepare(
			"SELECT collab_id, workspace_id, workspace_root, status, launch_mode, tmux_session FROM collab WHERE workspace_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1",
		)
		.get(workspaceId) as CollabRow | undefined;
}
