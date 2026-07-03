import { describe, expect, it } from "vitest";
import { renderDuoBanner, renderVendorBanner } from "../packages/cli/src/duo/banner.ts";
import type { AgentType } from "@ai-whisper/shared";

const RESET = "\x1b[0m";

describe("renderDuoBanner", () => {
	const art = "  .-.\n (o o)\n  |=|";

	it("renders the summon line, art block, indented quoted punchline, and terminal reset", () => {
		const banner = renderDuoBanner({
			summonName: "HEISENBERG",
			role: "brain",
			punchline: "I am the one who knocks.",
			art,
			columns: 80,
		});

		expect(banner).toContain("⚡ Summoning HEISENBERG — the brain of this operation...");
		expect(banner).toContain(art);
		expect(banner).toContain('   "I am the one who knocks."');
		// The child TUI must not inherit a dangling style: always terminate with
		// the reset followed by a final newline.
		expect(banner.endsWith(`${RESET}\n`)).toBe(true);
		// Blank line separating summon line from art and art from punchline.
		expect(banner).toContain(
			`⚡ Summoning HEISENBERG — the brain of this operation...\n\n${art}\n\n   "I am the one who knocks."`,
		);
	});

	it("drops only the art when columns are narrower than the art width, keeping summon + punchline + reset", () => {
		const wideArt = "X".repeat(50);
		const banner = renderDuoBanner({
			summonName: "GROOT",
			role: "body",
			punchline: "I am Groot.",
			art: wideArt,
			columns: 10,
		});

		expect(banner).not.toContain(wideArt);
		expect(banner).toContain("⚡ Summoning GROOT — the body, the face, and the hair...");
		expect(banner).toContain('   "I am Groot."');
		expect(banner.endsWith(`${RESET}\n`)).toBe(true);
	});

	it("keeps the art when columns exactly equal the art width", () => {
		const exactArt = "Y".repeat(20);
		const banner = renderDuoBanner({
			summonName: "R2-D2",
			role: "brain",
			punchline: "Beep boop bee-boop.",
			art: exactArt,
			columns: 20,
		});
		expect(banner).toContain(exactArt);
	});
});

describe("renderVendorBanner", () => {
	const cases: Array<[AgentType, string]> = [
		["claude", "Claude"],
		["codex", "Codex"],
		["ezio", "Ezio"],
		["agy", "Agy"],
	];

	for (const [agentType, display] of cases) {
		it(`renders a plain vendor summon line for ${agentType} with no art or punchline`, () => {
			const banner = renderVendorBanner({ agentType });
			expect(banner).toContain(`⚡ Summoning ${display}...`);
			// Vendor fallback carries no cosmetic role, art, or punchline.
			expect(banner).not.toContain(" as ");
			expect(banner).not.toContain('"');
			expect(banner.endsWith(`${RESET}\n`)).toBe(true);
		});
	}
});
