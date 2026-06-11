export type TurnEventProvider = "claude" | "codex";

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
