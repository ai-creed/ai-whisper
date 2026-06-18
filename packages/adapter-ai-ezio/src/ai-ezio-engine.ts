import { Session } from "@ai-ezio/harness";
import type { DelegatedToolDef, ProtocolEvent } from "@ai-ezio/protocol";

/** The subset of the harness Session the adapter drives. */
export interface AiEzioEngineSession {
	start(opts?: { transcriptPath?: string }): Promise<unknown>;
	/** The HAX_TRANSCRIPT mirror path, populated by start({ transcriptPath }).
	 *  The mounted /transcript view reads this (the harness-owned seam). */
	transcriptPath: string | undefined;
	/** Reset the conversation (protocol newConversation control). */
	newConversation(): Promise<void>;
	/** Current provider/model/effort (protocol status control). */
	status(): Promise<{ provider: string; model: string; effort?: string }>;
	submit(text: string): void;
	/** Cancel the in-flight turn (protocol `interrupt`; the engine ignores it
	 *  between turns). */
	interrupt(): void;
	submitAndWait(text: string): Promise<{ turnId: string; content: string }>;
	/** M9: advertise host-delegated (MCP) tools before the first submit. */
	registerDelegatedTools(tools: DelegatedToolDef[]): void;
	/** M9: reply to a `tool_call_requested` (correlated by callId). */
	sendToolResult(callId: string, output: string, status: "ok" | "error"): void;
	/** Switch to a past session in place (engine respawn). See Session.resume. */
	resume(sessionId: string, options?: { transcriptPath?: string }): Promise<unknown>;
	onExit(
		handler: (info: {
			code: number | null;
			signal: NodeJS.Signals | null;
		}) => void,
	): void;
	close(): void;
}

export type CreateEngineSession = (opts: {
	onEvent: (event: ProtocolEvent) => void;
}) => AiEzioEngineSession;

/** Default factory: a real hax-backed harness Session in mounted posture. */
export const defaultCreateEngineSession: CreateEngineSession = ({ onEvent }) =>
	new Session({ onEvent }) as unknown as AiEzioEngineSession;

export type { ProtocolEvent };
