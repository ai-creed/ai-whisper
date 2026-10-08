import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trustWorkspace, trustWorkspaceForClaude, trustWorkspaceForCodex } from "../eval/runner/arms/agent-trust.ts";

describe("agent trust grants", () => {
	let dir: string;
	afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

	it("claude: adds hasTrustDialogAccepted for new paths, restores on release, keeps unrelated projects", () => {
		dir = mkdtempSync(join(tmpdir(), "eval-trust-"));
		const cfg = join(dir, ".claude.json");
		writeFileSync(cfg, JSON.stringify({ hasCompletedOnboarding: true, projects: { "/keep": { hasTrustDialogAccepted: true, allowedTools: [] }, "/was-false": { hasTrustDialogAccepted: false } } }));
		const grant = trustWorkspaceForClaude(["/ws/a", "/ws/a-real", "/was-false"], cfg);
		const mid = JSON.parse(readFileSync(cfg, "utf8")) as { projects: Record<string, { hasTrustDialogAccepted: boolean }> };
		expect(mid.projects["/ws/a"]?.hasTrustDialogAccepted).toBe(true);
		expect(mid.projects["/ws/a-real"]?.hasTrustDialogAccepted).toBe(true);
		expect(mid.projects["/was-false"]?.hasTrustDialogAccepted).toBe(true);
		expect(mid.projects["/keep"]).toEqual({ hasTrustDialogAccepted: true, allowedTools: [] });
		grant.release();
		const after = JSON.parse(readFileSync(cfg, "utf8")) as { hasCompletedOnboarding: boolean; projects: Record<string, { hasTrustDialogAccepted: boolean }> };
		expect(after.projects["/ws/a"]).toBeUndefined();
		expect(after.projects["/ws/a-real"]).toBeUndefined();
		expect(after.projects["/was-false"]?.hasTrustDialogAccepted).toBe(false);
		expect(after.projects["/keep"]?.hasTrustDialogAccepted).toBe(true);
		expect(after.hasCompletedOnboarding).toBe(true);
	});

	it("claude: creates the config when missing", () => {
		dir = mkdtempSync(join(tmpdir(), "eval-trust-"));
		const cfg = join(dir, "nested", ".claude.json");
		trustWorkspaceForClaude(["/ws/b"], cfg);
		expect((JSON.parse(readFileSync(cfg, "utf8")) as { projects: Record<string, unknown> }).projects["/ws/b"]).toEqual({ hasTrustDialogAccepted: true });
	});

	it("codex: appends a trusted project table once and removes exactly it on release", () => {
		dir = mkdtempSync(join(tmpdir(), "eval-trust-"));
		const cfg = join(dir, "config.toml");
		const original = "model = \"gpt-x\"\n\n[projects.\"/already\"]\ntrust_level = \"trusted\"\n\n[tui]\nfoo = 1\n";
		writeFileSync(cfg, original);
		const grant = trustWorkspaceForCodex(["/ws/c", "/already", "/ws/c"], cfg);
		const mid = readFileSync(cfg, "utf8");
		expect(mid).toContain("[projects.\"/ws/c\"]\ntrust_level = \"trusted\"\n");
		expect(mid.split("[projects.\"/ws/c\"]").length).toBe(2); // appended once
		expect(mid.split("[projects.\"/already\"]").length).toBe(2); // existing table untouched
		grant.release();
		expect(readFileSync(cfg, "utf8")).toBe(original);
	});

	it("codex: creates the config when missing", () => {
		dir = mkdtempSync(join(tmpdir(), "eval-trust-"));
		const cfg = join(dir, "config.toml");
		trustWorkspaceForCodex(["/ws/d"], cfg);
		expect(readFileSync(cfg, "utf8")).toBe("\n[projects.\"/ws/d\"]\ntrust_level = \"trusted\"\n");
	});

	it("trustWorkspace grants both and release is best-effort", () => {
		dir = mkdtempSync(join(tmpdir(), "eval-trust-"));
		const config = { claudeJson: join(dir, ".claude.json"), codexToml: join(dir, "config.toml") };
		const grant = trustWorkspace(["/ws/e", "/ws/e"], config);
		expect(readFileSync(config.claudeJson, "utf8")).toContain("/ws/e");
		expect(readFileSync(config.codexToml, "utf8")).toContain("[projects.\"/ws/e\"]");
		rmSync(config.codexToml); // release must not throw when a file vanished
		expect(() => grant.release()).not.toThrow();
		expect(readFileSync(config.claudeJson, "utf8")).not.toContain("/ws/e");
	});
});
