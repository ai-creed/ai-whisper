// Borrowed from ~/Dev/ai-cortex/src/tui/theme.ts so both TUIs share the
// terracotta palette. Hex values match upstream exactly.
export const THEME = {
	accent: "#D97757", // Claude terracotta — Inspector active-tab marker / brand
	select: "#7FB069", // ai-cortex palette green — card-selection chevron + border
	ok: "green",
	warn: "yellow",
	err: "red",
	muted: "gray",
} as const;

export const AGENT_COLOR = {
	claude: "#D97757", // signature terracotta
	codex: "#5FB3C9", // palette teal
	cursor: "#7AA2F7", // palette blue
	ezio: "#A78BFA", // palette violet
	agy: "#E8B339", // antigravity amber
} as const;

export type ThemeToken = keyof typeof THEME;
export type AgentName = keyof typeof AGENT_COLOR;
