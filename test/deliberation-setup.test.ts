import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeliberationWorkspace } from "../packages/broker/src/runtime/deliberation-setup.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "delib-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("ensureDeliberationWorkspace", () => {
	it("creates the run dir and self-contained gitignores", () => {
		const dir = ensureDeliberationWorkspace(root, "wf_x");
		expect(dir).toBe(join(root, ".ai-whisper", "deliberation", "wf_x"));
		expect(existsSync(dir)).toBe(true);
		expect(readFileSync(join(root, ".ai-whisper", ".gitignore"), "utf8")).toContain(
			"*",
		);
		expect(
			readFileSync(join(root, ".ai-whisper", "deliberation", ".gitignore"), "utf8"),
		).toContain("*");
	});
	it("is idempotent and does not clobber an existing gitignore", () => {
		ensureDeliberationWorkspace(root, "wf_x");
		expect(() => ensureDeliberationWorkspace(root, "wf_x")).not.toThrow();
	});
});
