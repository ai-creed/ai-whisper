import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../packages/cli/scripts/stamp-ezio-provenance.mjs";

describe("provenance build output (real whisper bundle)", () => {
	it("bundle.mjs inlines non-empty ezioCliVersion AND ezioGitSha into dist/bin/whisper.js", () => {
		// Stamp first to learn the expected real values (bundle.mjs re-stamps identically).
		const p = generate(); // fails loudly if the sibling ai-ezio checkout is absent
		expect(p.ezioCliVersion).not.toBe("0.0.0-dev");
		expect(p.ezioCliVersion).toBeTruthy();
		expect(p.ezioGitSha).toBeTruthy();
		expect(p.ezioGitSha).not.toBe("dev");

		const cliRoot = join(process.cwd(), "packages", "cli");
		// Run the REAL bundler: it stamps, then esbuilds the actual bin entry points.
		execFileSync("node", ["scripts/bundle.mjs"], { cwd: cliRoot, stdio: "pipe" });

		// The actual published bin must carry the FULL populated provenance, INLINED:
		// if the module were runtime-imported instead of inlined, these literal values
		// would live only in the separate generated file, not in whisper.js.
		const whisperJs = readFileSync(join(cliRoot, "dist", "bin", "whisper.js"), "utf8");
		expect(whisperJs).toContain(p.ezioCliVersion); // non-empty ezioCliVersion in the bundle
		expect(whisperJs).toContain(p.ezioGitSha); // non-empty ezioGitSha in the bundle
		// And no real runtime import/require statement for the generated module remains.
		expect(whisperJs).not.toMatch(/(?:from|require\()\s*["'][^"']*generated\/ezio-provenance/);
	});
});
