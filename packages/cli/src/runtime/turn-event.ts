import type { AgentType } from "@ai-whisper/shared";

// cursor is excluded alongside ezio: Cursor's CLI has no per-turn completion
// hook (its `stop`/`afterAgentResponse` hooks do not fire in headless mode, and
// `sessionEnd` is session-scoped, not per-turn), so cursor never drives the
// push-based turn-event path — it uses the clipboard `/copy` capture instead.
export type TurnEventProvider = Exclude<AgentType, "ezio" | "cursor">;

export type TurnEvent = {
	provider: TurnEventProvider;
	workspaceId: string;
	cwd: string;
	sessionOrThreadId: string;
	turnId: string | null;
	message: string;
	inputMessages: string[];
	receivedAt: string;
};
