import type Database from "better-sqlite3";
import {
	getBrokerDaemonByCollab,
	listSessionAttachmentsByCollab,
	findNonTerminalWorkflow,
	countCollabRows,
	type CollabListRow,
	type WorkflowStatus,
} from "@ai-whisper/broker";

export type PurgeBucket = "live" | "protected" | "stale";

export interface CollabClassification {
	collabId: string;
	workspaceRoot: string;
	workspaceId: string | null;
	status: "active" | "stopped";
	bucket: PurgeBucket;
	reason: string;
	workflowId?: string;
	workflowStatus?: WorkflowStatus;
	rowCount: number;
	tmuxSession: string | null;
}

/** A collab is live when its daemon pid is alive OR any mounted agent pid is. */
export function isCollabLive(
	db: Database.Database,
	collabId: string,
	isAlive: (pid: number) => boolean,
): boolean {
	const daemon = getBrokerDaemonByCollab(db, collabId);
	if (daemon?.pid != null && isAlive(daemon.pid)) return true;
	return listSessionAttachmentsByCollab(db, collabId).some(
		(a) => a.pid != null && isAlive(a.pid),
	);
}

export function classifyCollab(
	db: Database.Database,
	collab: CollabListRow,
	isAlive: (pid: number) => boolean,
): CollabClassification {
	const base = {
		collabId: collab.collabId,
		workspaceRoot: collab.workspaceRoot,
		workspaceId: collab.workspaceId,
		status: collab.status,
		tmuxSession: collab.tmuxSession,
		rowCount: countCollabRows(db, collab.collabId),
	};

	const daemon = getBrokerDaemonByCollab(db, collab.collabId);
	const daemonAlive = daemon?.pid != null && isAlive(daemon.pid);
	const mountAlive = listSessionAttachmentsByCollab(db, collab.collabId).some(
		(a) => a.pid != null && isAlive(a.pid),
	);
	if (daemonAlive || mountAlive) {
		return {
			...base,
			bucket: "live",
			reason: daemonAlive ? "live-daemon" : "live-mount",
		};
	}

	const wf = findNonTerminalWorkflow(db, collab.collabId);
	if (wf) {
		return {
			...base,
			bucket: "protected",
			reason: `workflow ${wf.status}`,
			workflowId: wf.workflowId,
			workflowStatus: wf.status,
		};
	}

	const reason =
		collab.status === "stopped"
			? "stopped"
			: daemon
				? "dead-daemon"
				: "dead-mounts";
	return { ...base, bucket: "stale", reason };
}

export function classifyAllCollabs(
	db: Database.Database,
	collabs: CollabListRow[],
	isAlive: (pid: number) => boolean,
): CollabClassification[] {
	return collabs.map((c) => classifyCollab(db, c, isAlive));
}

import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
	applyMigrations,
	openDatabase,
	listAllCollabs,
	archiveCollabRuntime,
	isPidAlive,
} from "@ai-whisper/broker";
import { getSharedSqlitePath } from "../../runtime/state-root.js";
import { workspaceIdFromPath } from "../../runtime/workspace-id.js";

export interface CollabPurgeOpts {
	cwd: string;
	dryRun?: boolean;
	yes?: boolean;
	force?: boolean;
	json?: boolean;
	collabId?: string;
	workspace?: string;
	isAlive?: (pid: number) => boolean;
	isTTY?: boolean;
	confirm?: (promptText: string) => Promise<boolean>;
	log?: (line: string) => void;
	killTmuxSession?: (session: string) => void;
	deleteCascade?: (db: Database.Database, collabId: string) => void;
}

export interface PurgeResult {
	classifications: CollabClassification[];
	purged: string[];
	skippedWentLive: string[];
	skippedError: { collabId: string; error: string }[];
	protectedSkipped: string[];
	aborted: boolean;
	exitCode: number;
}

function defaultConfirm(promptText: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return rl
		.question(`${promptText} [y/N] `)
		.then((answer) => /^y(es)?$/i.test(answer.trim()))
		.finally(() => rl.close());
}

function defaultKillTmuxSession(session: string): void {
	try {
		const escaped = session.replace(/'/g, "'\\''");
		execSync(`tmux kill-session -t '${escaped}'`, { stdio: "ignore" });
	} catch {
		// session may already be gone — cleanup is best-effort
	}
}

function buildJsonPayload(
	classifications: CollabClassification[],
	purged: string[],
	skippedWentLive: string[],
	skippedError: { collabId: string; error: string }[],
	protectedSkipped: string[],
	aborted: boolean,
) {
	return {
		classifications,
		purged,
		skipped: { wentLive: skippedWentLive, error: skippedError },
		protected: protectedSkipped,
		aborted,
	};
}

function renderTable(
	classifications: CollabClassification[],
	log: (line: string) => void,
): void {
	if (classifications.length === 0) {
		log("No collabs found.");
		return;
	}
	log(
		"COLLAB                          BUCKET     REASON           ROWS  WORKSPACE",
	);
	for (const c of classifications) {
		const wf = c.workflowId ? ` [${c.workflowId} ${c.workflowStatus}]` : "";
		log(
			`${c.collabId.padEnd(31)} ${c.bucket.padEnd(10)} ${c.reason.padEnd(16)} ${String(c.rowCount).padStart(4)}  ${c.workspaceRoot}${wf}`,
		);
	}
}

export async function runCollabPurge(
	opts: CollabPurgeOpts,
): Promise<PurgeResult> {
	if (opts.collabId && opts.workspace) {
		throw new Error("--collab and --workspace are mutually exclusive");
	}
	const isAlive = opts.isAlive ?? isPidAlive;
	const log = opts.log ?? ((line: string) => console.log(line));
	const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
	const confirm = opts.confirm ?? defaultConfirm;
	const killTmux = opts.killTmuxSession ?? defaultKillTmuxSession;

	const empty = (
		exitCode: number,
		classifications: CollabClassification[] = [],
		protectedSkipped: string[] = [],
		aborted = false,
	): PurgeResult => ({
		classifications,
		purged: [],
		skippedWentLive: [],
		skippedError: [],
		protectedSkipped,
		aborted,
		exitCode,
	});

	let workspaceFilter: string | null = null;
	if (opts.workspace) {
		try {
			workspaceFilter = workspaceIdFromPath(opts.workspace);
		} catch {
			log(`Cannot resolve --workspace path: ${opts.workspace}`);
			return empty(1);
		}
	}

	const db = openDatabase(getSharedSqlitePath());
	applyMigrations(db);
	try {
		let collabs = listAllCollabs(db).filter((c) => c.archivedAt == null);
		if (opts.collabId)
			collabs = collabs.filter((c) => c.collabId === opts.collabId);
		if (workspaceFilter)
			collabs = collabs.filter((c) => c.workspaceId === workspaceFilter);

		const classifications = classifyAllCollabs(db, collabs, isAlive);
		const protectedSkipped = classifications
			.filter((c) => c.bucket === "protected")
			.map((c) => c.collabId);
		const candidates = classifications.filter(
			(c) =>
				c.bucket === "stale" ||
				(opts.force === true && c.bucket === "protected"),
		);

		if (!opts.json) {
			renderTable(classifications, log);
		}

		if (candidates.length === 0) {
			if (opts.json) {
				log(
					JSON.stringify(
						buildJsonPayload(
							classifications,
							[],
							[],
							[],
							protectedSkipped,
							false,
						),
						null,
						2,
					),
				);
			} else {
				log("Nothing to purge.");
			}
			return empty(0, classifications, protectedSkipped);
		}

		const previewOnly =
			opts.dryRun === true || (opts.json === true && opts.yes !== true);
		if (previewOnly) {
			if (opts.json) {
				log(
					JSON.stringify(
						buildJsonPayload(
							classifications,
							[],
							[],
							[],
							protectedSkipped,
							false,
						),
						null,
						2,
					),
				);
			} else {
				log(
					`Dry run — ${candidates.length} collab(s) would be purged. Nothing archived.`,
				);
			}
			return empty(0, classifications, protectedSkipped);
		}

		if (opts.yes !== true) {
			if (!isTTY) {
				log(
					`Refusing to archive ${candidates.length} collab(s) without confirmation. Re-run with --yes.`,
				);
				return empty(1, classifications, protectedSkipped, true);
			}
			const ok = await confirm(
				`Archive these ${candidates.length} collab(s)? (runtime state removed, history kept)`,
			);
			if (!ok) {
				log("Aborted. Nothing deleted.");
				return empty(0, classifications, protectedSkipped, true);
			}
		}

		const purged: string[] = [];
		const skippedWentLive: string[] = [];
		const skippedError: { collabId: string; error: string }[] = [];

		// Per-collab IMMEDIATE transaction with an in-transaction synchronous
		// liveness re-check (TOCTOU guard). Defined once; invoked per candidate.
		// deleteCascade is injectable so tests can simulate a per-collab failure;
		// a throw rolls back that one transaction and is caught below — the sweep
		// continues to the next candidate. The default action archives — it
		// removes the collab's RUNTIME rows and stamps archived_at, but keeps the
		// ledger rows (collab/workflows/etc.) forever (run-ledger spec §3).
		const archive =
			opts.deleteCascade ??
			((d: Database.Database, collabId: string) =>
				archiveCollabRuntime(d, collabId, new Date().toISOString()));
		const purgeOne = db.transaction((collabId: string): boolean => {
			if (isCollabLive(db, collabId, isAlive)) return false;
			archive(db, collabId);
			return true;
		});

		for (const cand of candidates) {
			try {
				const deleted = purgeOne.immediate(cand.collabId);
				if (deleted) {
					purged.push(cand.collabId);
					if (cand.tmuxSession) killTmux(cand.tmuxSession); // best-effort, post-commit
				} else {
					skippedWentLive.push(cand.collabId);
				}
			} catch (err) {
				skippedError.push({
					collabId: cand.collabId,
					error: (err as Error).message,
				});
			}
		}

		if (opts.json) {
			log(
				JSON.stringify(
					buildJsonPayload(
						classifications,
						purged,
						skippedWentLive,
						skippedError,
						protectedSkipped,
						false,
					),
					null,
					2,
				),
			);
		} else {
			log(
				`Archived ${purged.length} collab(s) (runtime state removed, history kept), skipped (went live) ${skippedWentLive.length}, errors ${skippedError.length}, protected ${protectedSkipped.length}.`,
			);
		}

		return {
			classifications,
			purged,
			skippedWentLive,
			skippedError,
			protectedSkipped,
			aborted: false,
			exitCode: skippedError.length > 0 ? 1 : 0,
		};
	} finally {
		db.close();
	}
}
