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

/**
 * Duo character display label (Task 5): "<characterName> (<agentType>)" when a
 * character is assigned, e.g. "Batman (claude)" — vendor kept lowercase in
 * parens for operational clarity. Without a character (null/undefined/empty),
 * falls back to the RAW agentType string exactly as the dashboard and relay
 * chrome render it today — this fallback must stay byte-identical so an
 * unassigned/opted-out agent's display is unchanged.
 */
export function characterDisplayName(
	agentType: AgentType,
	characterName: string | null | undefined,
): string {
	if (!characterName) return agentType;
	return `${characterName} (${agentType})`;
}
