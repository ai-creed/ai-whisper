import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { workspaceIdFromPath } from "./workspace-id.js";
import type { TurnEvent } from "./turn-event.js";

export type AgyAdoptionMode = "pinned" | "workspace" | "global";

export type AgyObservation =
	| { kind: "turn-end"; event: TurnEvent }
	| { kind: "heartbeat"; toolInFlight: boolean }
	| { kind: "ignored"; reason: string };

type AgyPayload = {
	conversationId?: unknown;
	fullyIdle?: unknown;
	stepIdx?: unknown;
	workspacePaths?: unknown;
};

/**
 * Stateful per-mount tracker for agy lifecycle-hook events. It adopts the parent
 * conversationId ONLY when positively identified as the launched session
 * (spec §4.2), then:
 *  - emits a turn-end for the parent's Stop with fullyIdle:true (gate H1),
 *  - emits heartbeat + tool-in-flight state for every other parent event,
 *  - ignores everything it cannot attribute to its own session (degrade to idle).
 */
export class AgyEventReceiver {
	private readonly mode: AgyAdoptionMode;
	private readonly mountCwd: string;
	private readonly canonicalCwd: string;
	private adoptedConversationId: string | null;
	private readonly toolsInFlight = new Set<number>();

	constructor(opts: { mode: AgyAdoptionMode; mountCwd: string; pinnedConversationId?: string }) {
		this.mode = opts.mode;
		this.mountCwd = opts.mountCwd;
		this.canonicalCwd = canonicalize(opts.mountCwd);
		// Pinned mode knows the id up front; the others discover it on a positively
		// identified event.
		this.adoptedConversationId =
			opts.mode === "pinned" ? (opts.pinnedConversationId ?? null) : null;
	}

	observe(raw: string, receivedAt: string, event: string): AgyObservation {
		let payload: AgyPayload;
		try {
			payload = JSON.parse(raw) as AgyPayload;
		} catch {
			return { kind: "ignored", reason: "malformed-json" };
		}
		const conversationId =
			typeof payload.conversationId === "string" ? payload.conversationId : "";
		if (!conversationId) return { kind: "ignored", reason: "no-conversation-id" };

		// Adoption / attribution.
		if (this.adoptedConversationId === null) {
			if (!this.canAdopt(payload)) {
				return { kind: "ignored", reason: "unattributed" };
			}
			this.adoptedConversationId = conversationId;
		}
		if (conversationId !== this.adoptedConversationId) {
			return { kind: "ignored", reason: "foreign-conversation" };
		}

		// Attributed to our session — classify by the tagged event.
		if (event === "Stop") {
			if (payload.fullyIdle === true) {
				return { kind: "turn-end", event: this.toTurnEvent(conversationId, receivedAt) };
			}
			// Parent mid-turn pause: a heartbeat, not a turn boundary.
			return { kind: "heartbeat", toolInFlight: this.toolsInFlight.size > 0 };
		}
		if (event === "PreToolUse") {
			if (typeof payload.stepIdx === "number") this.toolsInFlight.add(payload.stepIdx);
			return { kind: "heartbeat", toolInFlight: this.toolsInFlight.size > 0 };
		}
		if (event === "PostToolUse") {
			if (typeof payload.stepIdx === "number") this.toolsInFlight.delete(payload.stepIdx);
			return { kind: "heartbeat", toolInFlight: this.toolsInFlight.size > 0 };
		}
		// PreInvocation / PostInvocation (and any other observational event).
		return { kind: "heartbeat", toolInFlight: this.toolsInFlight.size > 0 };
	}

	// Positive-identification gate for the FIRST event (spec §4.2).
	private canAdopt(payload: AgyPayload): boolean {
		if (this.mode === "workspace") return true; // only our session loads workspace hooks
		// "global": adopt only when workspacePaths positively names our cwd.
		const paths = Array.isArray(payload.workspacePaths)
			? payload.workspacePaths.filter((p): p is string => typeof p === "string")
			: [];
		return paths.some((p) => canonicalize(p) === this.canonicalCwd);
	}

	private toTurnEvent(conversationId: string, receivedAt: string): TurnEvent {
		return {
			provider: "agy",
			workspaceId: safeWorkspaceId(this.mountCwd),
			cwd: this.mountCwd,
			sessionOrThreadId: conversationId,
			turnId: null,
			// v1: capture content comes from the shared /copy path (spec §4.5); the
			// transcriptPath structured read is a deferred enhancement.
			message: "",
			// No structured input in the Stop payload → the relay's sequence backstop
			// handles correlation (mirrors claude with an unreadable transcript).
			inputMessages: [],
			receivedAt,
		};
	}
}

function canonicalize(p: string): string {
	try {
		return realpathSync(resolvePath(p));
	} catch {
		return resolvePath(p);
	}
}

function safeWorkspaceId(cwd: string): string {
	try {
		return workspaceIdFromPath(cwd);
	} catch {
		return workspaceIdFromPath(".");
	}
}
