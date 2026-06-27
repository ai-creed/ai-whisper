import type { AgentType } from "@ai-whisper/shared";

const DISPLAY_NAMES: Record<AgentType, string> = {
	claude: "Claude",
	codex: "Codex",
	ezio: "Ezio",
	agy: "Agy",
};

export function agentDisplayName(agentType: AgentType): string {
	return DISPLAY_NAMES[agentType];
}
