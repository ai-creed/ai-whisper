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
