import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	loadCharacterArt,
	maxDisplayWidth,
} from "../packages/cli/src/duo/art-assets.ts";
import { DUOS } from "../packages/cli/src/duo/duo-table.ts";

const ASSET_DIR = new URL("../packages/cli/assets/duos/", import.meta.url);
const ALL_CHARACTERS = DUOS.flatMap((duo) => duo.characters);

describe("duo art assets", () => {
	it("has 14 distinct artFile values — one file per character, no sharing", () => {
		const artFiles = ALL_CHARACTERS.map((c) => c.artFile);
		expect(artFiles).toHaveLength(14);
		expect(new Set(artFiles).size).toBe(14);
	});

	it("has every artFile present on disk under packages/cli/assets/duos/ and loadable", () => {
		for (const character of ALL_CHARACTERS) {
			const onDisk = new URL(character.artFile, ASSET_DIR);
			expect(
				existsSync(onDisk),
				`${character.artFile} should exist on disk`,
			).toBe(true);

			const art = loadCharacterArt(character.artFile);
			expect(
				art.length,
				`${character.artFile} should load non-empty art`,
			).toBeGreaterThan(0);
		}
	});

	it("keeps quixote.txt and sancho.txt byte-identical (shared windmill scene, drift guard)", () => {
		const quixote = readFileSync(new URL("quixote.txt", ASSET_DIR));
		const sancho = readFileSync(new URL("sancho.txt", ASSET_DIR));
		expect(quixote.equals(sancho)).toBe(true);
	});

	it("keeps every art asset within an 80-column display width, with no trailing braille-blank padding", () => {
		for (const character of ALL_CHARACTERS) {
			const art = loadCharacterArt(character.artFile);
			expect(
				maxDisplayWidth(art),
				`${character.artFile} exceeds the 80-column display width`,
			).toBeLessThanOrEqual(80);

			for (const line of art.split("\n")) {
				expect(
					line.endsWith("⠀"),
					`${character.artFile} has a line with trailing U+2800 braille-blank padding`,
				).toBe(false);
			}
		}
	});
});
