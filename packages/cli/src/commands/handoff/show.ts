import type { ControlService } from "@ai-whisper/broker";
import type { AgentType } from "@ai-whisper/shared";
import type { AgentCommandConnection } from "../../runtime/broker-connect.js";
import { runAgentCommand } from "../agent-command.js";

export interface HandoffShowDeps {
	control: Pick<ControlService, "fetchWorkflowHandoff">;
	collabId: string;
	handoffId: string;
	callerAgent: AgentType | null;
	now: string;
}

export interface HandoffShowResult {
	exitCode: 0 | 1;
	stdout: string;
}

const DO_NOT_ACT = "Do not act on it; end your turn.";

/**
 * Full `handoff show` flow. A null caller is allowed (it peeks: the handoff is
 * printed but the fetch is not recorded), so there is no pre-connect refusal.
 */
export function resolveShowResult(input: {
	callerAgent: AgentType | null;
	connect: () => AgentCommandConnection;
	handoffId: string;
	now: string;
}): HandoffShowResult {
	return runAgentCommand({
		context: "show",
		refuseBeforeConnect: null,
		connect: input.connect,
		run: (conn) =>
			runHandoffShow({
				control: conn.control,
				collabId: conn.collabId,
				handoffId: input.handoffId,
				callerAgent: input.callerAgent,
				now: input.now,
			}),
	});
}

export function runHandoffShow(deps: HandoffShowDeps): HandoffShowResult {
	const { handoffId } = deps;
	const result = deps.control.fetchWorkflowHandoff({
		handoffId,
		collabId: deps.collabId,
		callerAgent: deps.callerAgent,
		now: deps.now,
		// An unidentified caller cannot be the seat the fetch would be credited to.
		record: deps.callerAgent !== null,
	});

	if (!result.ok) {
		return { exitCode: 1, stdout: refusalCopy(result, handoffId, deps.callerAgent) };
	}

	const h = result.handoff;
	const orDash = (v: string | number | null): string => (v === null ? "-" : String(v));
	return {
		exitCode: 0,
		stdout: [
			`=== ai-whisper handoff ${handoffId} — operator request, delivered by ai-whisper on the operator's behalf ===`,
			`workflow ${h.workflowId} · phase ${orDash(h.phaseName)} · step ${orDash(h.handoffStep)} · round ${orDash(h.roundNumber)} · from: ${h.senderAgent} · to: ${h.targetAgent}`,
			"",
			h.requestText,
			"",
			`=== end of handoff ${handoffId} ===`,
		].join("\n"),
	};
}

function refusalCopy(
	refusal: { reason: string; status?: string; targetAgent?: AgentType },
	id: string,
	callerAgent: AgentType | null,
): string {
	switch (refusal.reason) {
		case "unknown":
			return `unknown handoff ${id}. ${DO_NOT_ACT}`;
		case "other_collab":
			return `handoff ${id} belongs to another collaboration. ${DO_NOT_ACT}`;
		case "not_workflow":
			return `handoff ${id} is not a workflow handoff. ${DO_NOT_ACT}`;
		case "not_accepted":
			return `handoff ${id} is ${refusal.status ?? "not accepted"}, not awaiting your work. ${DO_NOT_ACT}`;
		case "superseded":
			return `handoff ${id} is no longer the current handoff for its workflow. ${DO_NOT_ACT}`;
		case "wrong_agent":
			return `handoff ${id} is assigned to ${refusal.targetAgent ?? "another agent"}, not ${callerAgent ?? "you"}. ${DO_NOT_ACT}`;
		default:
			return `handoff ${id} cannot be shown (${refusal.reason}). ${DO_NOT_ACT}`;
	}
}
