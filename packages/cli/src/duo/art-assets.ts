import { readFileSync } from "node:fs";

// The published `ai-whisper` package ships a top-level `assets/` directory
// (see the "files" allowlist in packages/cli/package.json, mirroring how
// `skills/` ships today). From this module's own location, `../../assets/`
// is the package root's assets dir in BOTH layouts we ship: the from-source
// runtime (src/duo/ → ../../assets/) and the esbuild-bundled binary (this
// module is inlined into dist/bin/<entry>.js → ../../assets/). `../assets/`
// is a defensive fallback for any alternate emit layout, mirroring the
// PKG_CANDIDATES pattern in runtime/cli-package-info.ts.
const ASSET_DIR_CANDIDATES = ["../../assets/duos/", "../assets/duos/"] as const;

function readArtFile(artFile: string): string {
	for (const candidate of ASSET_DIR_CANDIDATES) {
		try {
			const url = new URL(`${candidate}${artFile}`, import.meta.url);
			return readFileSync(url, "utf8");
		} catch {
			// try the next candidate
		}
	}
	throw new Error(
		`loadCharacterArt: could not resolve "${artFile}" under assets/duos/ ` +
			`(tried ${ASSET_DIR_CANDIDATES.join(", ")} relative to ${import.meta.url})`,
	);
}

/**
 * Load a bundled character art file by name (e.g. "batman.txt"). Resolves
 * `assets/duos/<artFile>` relative to the package root; see
 * {@link ASSET_DIR_CANDIDATES} for the layouts tried. Trailing
 * whitespace-only lines are trimmed; the art block is otherwise returned
 * verbatim, including embedded artist signatures.
 */
export function loadCharacterArt(artFile: string): string {
	const lines = readArtFile(artFile).split("\n");
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
		lines.pop();
	}
	return lines.join("\n");
}

/**
 * The widest line in an art block, measured in display code points (not
 * UTF-16 units and not UTF-8 bytes — e.g. braille characters are 3 bytes
 * each in UTF-8 but a single display column).
 */
export function maxDisplayWidth(art: string): number {
	let max = 0;
	for (const line of art.split("\n")) {
		const width = [...line].length;
		if (width > max) max = width;
	}
	return max;
}
