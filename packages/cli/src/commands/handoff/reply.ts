import type Database from "better-sqlite3";
import { createBrokerEventBus, createControlService } from "@ai-whisper/broker";
import type { ControlService } from "@ai-whisper/broker";
import type { AgentType } from "@ai-whisper/shared";
import type { AgentCommandConnection } from "../../runtime/broker-connect.js";

export interface HandoffReplyDeps {
	control: Pick<ControlService, "replyWorkflowHandoff">;
	collabId: string;
	handoffId: string;
	callerAgent: AgentType | null;
	filePath: string;
	readFile: (path: string) => string;
	now: string;
}

export interface HandoffReplyResult {
	exitCode: 0 | 1;
	stdout: string;
}

type ReplyOutcome = ReturnType<ControlService["replyWorkflowHandoff"]>;
type ReplyRefusal = Extract<ReplyOutcome, { ok: false }>;

const NOT_RECORDED = "your reply was not recorded.";
const DO_NOT_RETRY = `${NOT_RECORDED} Do not retry; end your turn.`;

function nullAgentRefusal(): HandoffReplyResult {
	return {
		exitCode: 1,
		stdout: `whisper handoff reply must be run by a mounted agent (AI_WHISPER_AGENT is not set); ${NOT_RECORDED}`,
	};
}

/**
 * Full reply command flow. The caller-identity check runs before connecting so
 * an unidentified caller can never touch the DB, including the mismatch path.
 */
export function resolveReplyResult(input: {
	callerAgent: AgentType | null;
	connect: () => AgentCommandConnection;
	handoffId: string;
	filePath: string;
	readFile: (path: string) => string;
	now: string;
}): HandoffReplyResult {
	if (input.callerAgent === null) return nullAgentRefusal();
	const conn = input.connect();
	try {
		if (conn.ok) {
			return runHandoffReply({
				control: conn.control,
				collabId: conn.collabId,
				handoffId: input.handoffId,
				callerAgent: input.callerAgent,
				filePath: input.filePath,
				readFile: input.readFile,
				now: input.now,
			});
		}
		if (conn.db !== null && conn.collabId !== null) {
			return handleReplyVersionMismatch({
				db: conn.db,
				collabId: conn.collabId,
				handoffId: input.handoffId,
				message: conn.message,
				now: input.now,
			});
		}
		return { exitCode: 1, stdout: conn.message };
	} finally {
		conn.close();
	}
}

export function runHandoffReply(deps: HandoffReplyDeps): HandoffReplyResult {
	const { handoffId, callerAgent } = deps;
	if (callerAgent === null) return nullAgentRefusal();

	let body: string | null;
	try {
		body = deps.readFile(deps.filePath);
	} catch {
		body = null;
	}
	if (body === null || body.trim() === "") {
		return {
			exitCode: 1,
			stdout: `reply file ${deps.filePath} is missing or empty; write your complete handback to it and run the command again.`,
		};
	}

	const result = deps.control.replyWorkflowHandoff({
		handoffId,
		collabId: deps.collabId,
		callerAgent,
		body,
		now: deps.now,
	});
	if (!result.ok) {
		return { exitCode: 1, stdout: refusalCopy(result, handoffId, callerAgent) };
	}
	return { exitCode: 0, stdout: `reply recorded for handoff ${handoffId}` };
}

function refusalCopy(refusal: ReplyRefusal, id: string, callerAgent: AgentType): string {
	switch (refusal.reason) {
		case "wrong_agent":
			return `handoff ${id} is assigned to ${refusal.targetAgent ?? "another agent"}, not ${callerAgent}; ${NOT_RECORDED}`;
		case "other_collab":
			return `handoff ${id} belongs to another collaboration; ${DO_NOT_RETRY}`;
		case "superseded":
			return `handoff ${id} is no longer the current handoff for its workflow; ${DO_NOT_RETRY}`;
		case "not_workflow":
			return `handoff ${id} is not a workflow handoff; ${DO_NOT_RETRY}`;
		case "not_accepted":
			return `handoff ${id} is ${refusal.status ?? "unknown"}; ${DO_NOT_RETRY}`;
		case "unknown":
			return `handoff ${id} is unknown; ${DO_NOT_RETRY}`;
		default: {
			const unhandled: never = refusal.reason;
			throw new Error(`unhandled reply refusal: ${String(unhandled)}`);
		}
	}
}

/**
 * Version-mismatch branch of `handoff reply`: record the refusal on the handoff
 * (column-tolerant, no migration) so the reply-side ladder skips the nudge,
 * then surface the spec's mismatch copy.
 */
export function handleReplyVersionMismatch(input: {
	db: Database.Database;
	collabId: string;
	handoffId: string;
	message: string;
	now: string;
}): HandoffReplyResult {
	createControlService(input.db, createBrokerEventBus()).recordWorkflowReplyRefused({
		handoffId: input.handoffId,
		collabId: input.collabId,
		now: input.now,
	});
	return { exitCode: 1, stdout: input.message };
}
