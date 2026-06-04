import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { getBrokerDaemonByCollab } from "@ai-whisper/broker";
import {
	resolveCollab,
	CollabResolverError,
} from "../../runtime/collab-resolver.js";
import { getSharedSqlitePath } from "../../runtime/state-root.js";
import { isEvaluatorReady, type EvaluatorStatus } from "../../runtime/evaluator-config.js";
import { agentTypes } from "@ai-whisper/shared";

export function runCollabStatus(input: {
	cwd: string;
	collabIdOverride?: string;
	json?: boolean;
}): string {
	const sqlitePath = getSharedSqlitePath();
	if (!existsSync(sqlitePath)) {
		return input.json
			? JSON.stringify({ error: "no_collab_for_cwd", cwd: input.cwd })
			: `no active collab for ${input.cwd}`;
	}
	const db = new Database(sqlitePath, { readonly: true });
	try {
		const r = resolveCollab({
			db,
			cwd: input.cwd,
			...(input.collabIdOverride ? { collabIdOverride: input.collabIdOverride } : {}),
		});

		if (input.json) {
			const bindings = db
				.prepare(
					"SELECT agent_type, binding_state FROM session_binding WHERE collab_id = ?",
				)
				.all(r.collabId) as Array<{ agent_type: string; binding_state: string }>;
			const agents = agentTypes.map((agentType) => {
				const b = bindings.find((x) => x.agent_type === agentType);
				return {
					agentType,
					bindingState: b?.binding_state ?? null,
				};
			});
			const daemonRow = getBrokerDaemonByCollab(db, r.collabId);
			const evaluatorStatus = (daemonRow?.evaluatorStatus ?? "unknown") as EvaluatorStatus;
			return JSON.stringify({
				collabId: r.collabId,
				workspaceRoot: r.workspaceRoot,
				status: r.status,
				daemon: r.daemon ?? null,
				agents,
				recovery: { state: r.recovery.state },
				evaluator: { ready: isEvaluatorReady(evaluatorStatus), status: evaluatorStatus },
			});
		}

		const daemonStr = r.daemon
			? `daemon: ${r.daemon.host}:${r.daemon.port} pid=${r.daemon.pid}`
			: "daemon: not running";
		return [
			`collabId: ${r.collabId}`,
			`workspace: ${r.workspaceRoot}`,
			`status: ${r.status}`,
			`launch: ${r.launch.mode}${r.launch.tmuxSession ? ` (tmux=${r.launch.tmuxSession})` : ""}`,
			daemonStr,
			`recovery: ${r.recovery.state}`,
		].join("\n");
	} catch (err) {
		if (err instanceof CollabResolverError && err.kind === "NoCollabFoundForCwd") {
			return input.json
				? JSON.stringify({ error: "no_collab_for_cwd", cwd: input.cwd })
				: `no active collab for ${input.cwd}`;
		}
		throw err;
	} finally {
		db.close();
	}
}
