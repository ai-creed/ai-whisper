import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SOCKET_PATH, turnEventSocketPathLength } from "../eval/runner/arms/pair.ts";
import { DRY_RUN_WORKSPACE_ROOT } from "../eval/runner/dry-run.ts";

const fakes = join(import.meta.dirname, "../eval/runner/fakes");

describe("dry-run fakes", () => {
	let ws: string;
	afterEach(() => rmSync(ws, { recursive: true, force: true }));

	it("fake-claude-headless emits stream-json, touches the workspace and commits", () => {
		ws = mkdtempSync(join(tmpdir(), "eval-fake-"));
		execFileSync("git", ["init", "-q"], { cwd: ws });
		const out = execFileSync(process.execPath, [join(fakes, "fake-claude-headless.mjs"), "-p", "--output-format", "stream-json"], { cwd: ws, input: "hello prompt", encoding: "utf8" });
		const lines = out.trim().split("\n").map((l) => JSON.parse(l) as { type: string; subtype?: string });
		expect(lines.map((l) => l.type)).toEqual(["assistant", "result"]);
		expect(lines[1]?.subtype).toBe("success");
		expect(existsSync(join(ws, "DRY_RUN_TOUCHED"))).toBe(true);
		expect(execFileSync("git", ["log", "--oneline"], { cwd: ws, encoding: "utf8" })).toContain("dry-run");
	});

	it("fake-pair-agent stays alive until SIGTERM", async () => {
		ws = mkdtempSync(join(tmpdir(), "eval-fake-"));
		const child = spawn(process.execPath, [join(fakes, "fake-pair-agent.mjs")], { cwd: ws, stdio: ["pipe", "pipe", "pipe"] });
		const first = await new Promise<string>((r) => child.stdout.once("data", (d: Buffer) => r(d.toString())));
		expect(first).toMatch(/ready/);
		await new Promise((r) => setTimeout(r, 300));
		expect(child.exitCode).toBeNull();
		child.kill("SIGTERM");
		const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
		expect(code).toBe(0);
	});
});

describe("dry-run roots", () => {
	it("derives an Arm C state root whose socket path fits the macOS limit", () => {
		// run-one puts the state root at <workspaceRoot>/../state/<12 hex>
		const stateRoot = join(DRY_RUN_WORKSPACE_ROOT, "..", "state", "0123456789ab");
		expect(turnEventSocketPathLength(stateRoot)).toBeLessThanOrEqual(MAX_SOCKET_PATH);
	});
});
