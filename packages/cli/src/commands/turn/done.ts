import type { ControlService } from "@ai-whisper/broker";
import type { AgentType } from "@ai-whisper/shared";
import type { AgentCommandConnection } from "../../runtime/broker-connect.js";

export interface TurnDoneDeps {
	control: Pick<ControlService, "recordSeatTurnDone">;
	collabId: string;
	callerAgent: AgentType | null;
	now: string;
}

export interface TurnDoneResult {
	exitCode: 0 | 1;
	stdout: string;
}

const NULL_AGENT_COPY =
	"whisper turn done must be run by a mounted agent (AI_WHISPER_AGENT is not set).";

export function runTurnDone(deps: TurnDoneDeps): TurnDoneResult {
	if (deps.callerAgent === null) return { exitCode: 1, stdout: NULL_AGENT_COPY };
	const { fetchedUnrepliedHandoffId: id } = deps.control.recordSeatTurnDone({
		collabId: deps.collabId,
		agent: deps.callerAgent,
		now: deps.now,
	});
	if (id !== null) {
		return {
			exitCode: 0,
			stdout: `note: handoff ${id} is fetched but has no reply — if your work for it is complete, run whisper handoff reply ${id} --file <path>`,
		};
	}
	return { exitCode: 0, stdout: "ok" };
}

/**
 * Full `turn done` flow. The caller-identity check runs before connecting so an
 * unidentified caller never touches the DB; a version mismatch records nothing.
 */
export function resolveTurnDoneResult(input: {
	callerAgent: AgentType | null;
	connect: () => AgentCommandConnection;
	now: string;
}): TurnDoneResult {
	if (input.callerAgent === null) return { exitCode: 1, stdout: NULL_AGENT_COPY };
	const conn = input.connect();
	try {
		if (!conn.ok) return { exitCode: 1, stdout: conn.message };
		return runTurnDone({
			control: conn.control,
			collabId: conn.collabId,
			callerAgent: input.callerAgent,
			now: input.now,
		});
	} finally {
		conn.close();
	}
}
