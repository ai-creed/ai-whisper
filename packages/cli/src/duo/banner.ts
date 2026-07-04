import type { AgentType } from "@ai-whisper/shared";
import { agentDisplayName } from "../runtime/agent-display.js";
import { maxDisplayWidth } from "./art-assets.js";
import { duoRoleFlavor, type DuoRole } from "./duo-table.js";

/** ANSI reset: the banner always terminates with this so the child TUI never
 * inherits a dangling style from the summon art. */
const RESET = "\x1b[0m";

const PUNCHLINE_INDENT = "   ";

/**
 * Render the pre-spawn duo summon banner. Pure — no I/O, no timers; the caller
 * supplies the already-loaded `art` string.
 *
 * Layout:
 *
 * ```
 * ⚡ Summoning <SUMMONNAME> — <role flavor>...
 *
 * <art>
 *
 *    "<punchline>"
 * ```
 *
 * The returned string ALWAYS ends with the ANSI reset followed by a final
 * newline. When `columns` is narrower than the widest art line the art block
 * (and its surrounding blank lines) is dropped entirely — summon line,
 * punchline, and reset only — so a small terminal never wraps the art into
 * garbage.
 */
export function renderDuoBanner(input: {
	summonName: string;
	role: DuoRole;
	punchline: string;
	art: string;
	columns: number;
}): string {
	const summonLine = `⚡ Summoning ${input.summonName} — ${duoRoleFlavor(input.role)}...`;
	const punchlineLine = `${PUNCHLINE_INDENT}"${input.punchline}"`;
	const showArt = input.columns >= maxDisplayWidth(input.art);
	const parts = showArt
		? [summonLine, "", input.art, "", punchlineLine, RESET]
		: [summonLine, punchlineLine, RESET];
	return `${parts.join("\n")}\n`;
}

/**
 * Render the plain vendor fallback banner used for `outcome: "fallback"`
 * mounts (both duo slots already held by live owners — no character to claim).
 * A single summon line naming the agent vendor, no art and no punchline, with
 * the same reset + newline termination as {@link renderDuoBanner}.
 */
export function renderVendorBanner(input: { agentType: AgentType }): string {
	const summonLine = `⚡ Summoning ${agentDisplayName(input.agentType)}...`;
	return `${summonLine}\n${RESET}\n`;
}
