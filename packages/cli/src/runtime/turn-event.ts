import type { AgentType } from "@ai-whisper/shared";

export type TurnEventProvider = Exclude<AgentType, "ezio">;

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
