import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGY_HOOKS_GROUP,
	agyHooksFilePath,
	buildAgyHooksGroup,
	removeAgyHooksGroup,
	writeAgyHooksFile,
} from "../packages/cli/src/runtime/turn-events-config.ts";

describe("agy hooks file", () => {
	let dir: string | undefined;
	afterEach(() => (dir = undefined));

	it("resolves the workspace and global paths", () => {
		expect(agyHooksFilePath({ scope: "workspace", workspaceRoot: "/ws" })).toBe(
			"/ws/.agents/hooks.json",
		);
		expect(
			agyHooksFilePath({ scope: "global", workspaceRoot: "/ws", home: "/home/u" }),
		).toBe("/home/u/.gemini/config/hooks.json");
	});

	it("builds a group with the shim command (incl. --workspace-id and --event) for all five events", () => {
		type AgyCmd = { type: string; command: string; timeout: number };
		type AgyMatcherEntry = { matcher: string; hooks: AgyCmd[] };
		type AgyGroup = {
			Stop: AgyCmd[];
			PreInvocation: AgyCmd[];
			PostInvocation: AgyCmd[];
			// Tool-scoped events: agy only fires these in the matcher form.
			PostToolUse: AgyMatcherEntry[];
			PreToolUse: AgyMatcherEntry[];
		};
		const group = buildAgyHooksGroup({
			shimPath: "/shim.js",
			socketsDir: "/s",
			logsDir: "/l",
			workspaceId: "wid1",
		}) as unknown as AgyGroup;
		expect(Object.keys(group).sort()).toEqual(
			["PostInvocation", "PostToolUse", "PreInvocation", "PreToolUse", "Stop"].sort(),
		);
		expect(group.Stop[0]!.command).toBe(
			"/shim.js --provider agy --socket-dir /s --log-dir /l --workspace-id wid1 --event Stop",
		);
		expect(group.Stop[0]!.timeout).toBe(5);
		// Both tool-scoped events use the matcher + nested-hooks form. agy fires
		// PreToolUse/PostToolUse ONLY in this form; the shorthand { type, command }
		// silently never fires (verified against agy v1.0.13), which would leave the
		// tool-in-flight bracket open forever and disable the idle fallback.
		expect(group.PreToolUse[0]!.matcher).toBe("*");
		expect(group.PreToolUse[0]!.hooks[0]!.command).toContain("--event PreToolUse");
		expect(group.PostToolUse[0]!.matcher).toBe("*");
		expect(group.PostToolUse[0]!.hooks[0]!.command).toContain("--event PostToolUse");
		expect(group.PostToolUse[0]!.hooks[0]!.timeout).toBe(5);
	});

	it("merges our group into an existing file without clobbering user groups", () => {
		dir = mkdtempSync(join(tmpdir(), "aiw-agyhooks-"));
		const filePath = join(dir, "hooks.json");
		writeFileSync(filePath, JSON.stringify({ "user-group": { Stop: [{ type: "command", command: "echo hi" }] } }));
		writeAgyHooksFile({
			filePath,
			group: buildAgyHooksGroup({ shimPath: "/shim.js", socketsDir: "/s", logsDir: "/l", workspaceId: "w" }),
		});
		const map = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		expect(map["user-group"]).toBeDefined();
		expect(map[AGY_HOOKS_GROUP]).toBeDefined();
	});

	it("creates parent dirs when the file does not exist", () => {
		dir = mkdtempSync(join(tmpdir(), "aiw-agyhooks2-"));
		const filePath = join(dir, ".agents", "hooks.json");
		writeAgyHooksFile({
			filePath,
			group: buildAgyHooksGroup({ shimPath: "/shim.js", socketsDir: "/s", logsDir: "/l", workspaceId: "w" }),
		});
		expect(existsSync(filePath)).toBe(true);
		expect((JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>)[AGY_HOOKS_GROUP]).toBeDefined();
	});

	it("removes only our group on teardown", () => {
		dir = mkdtempSync(join(tmpdir(), "aiw-agyhooks3-"));
		const filePath = join(dir, "hooks.json");
		writeFileSync(filePath, JSON.stringify({ "user-group": { Stop: [] } }));
		writeAgyHooksFile({
			filePath,
			group: buildAgyHooksGroup({ shimPath: "/shim.js", socketsDir: "/s", logsDir: "/l", workspaceId: "w" }),
		});
		removeAgyHooksGroup({ filePath });
		const map = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		expect(map[AGY_HOOKS_GROUP]).toBeUndefined();
		expect(map["user-group"]).toBeDefined();
	});

	it("removeAgyHooksGroup is a no-op when the file is missing", () => {
		dir = mkdtempSync(join(tmpdir(), "aiw-agyhooks4-"));
		expect(() => removeAgyHooksGroup({ filePath: join(dir!, "nope.json") })).not.toThrow();
	});
});
