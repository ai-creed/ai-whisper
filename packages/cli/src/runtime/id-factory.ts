import { randomBytes } from "node:crypto";
import type { AgentType } from "@ai-whisper/shared";

function normalizeTimestamp(now: string): string {
	return now.replace(/[^0-9]/g, "");
}

// 8 lowercase-hex chars (32 bits). Keeps collab ids inside the
// `^collab_[a-z0-9_]+$` shape that sessionBindingSchema enforces while making
// same-millisecond starts (which would otherwise collide on the collab PK)
// effectively impossible.
function randomSuffix(): string {
	return randomBytes(4).toString("hex");
}

export function createCliCollabId(now: string): `collab_${string}` {
	return `collab_${normalizeTimestamp(now)}_${randomSuffix()}`;
}

export function createCliSessionId(
	agentType: AgentType,
	now: string,
): `session_${string}` {
	// Defensive: keep the agent segment within the `[a-z0-9_]` shape sessionIdSchema
	// enforces (a hyphen in any future agent name would otherwise fail validation).
	const agentSegment = agentType.replace(/-/g, "_");
	return `session_${agentSegment}_${normalizeTimestamp(now)}`;
}

export function createCliThreadId(now: string): `thread_${string}` {
	return `thread_${normalizeTimestamp(now)}`;
}

export function createCliWorkItemId(now: string): `work_${string}` {
	return `work_${normalizeTimestamp(now)}`;
}
