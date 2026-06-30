import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCli } from "../packages/cli/src/create-cli.ts";

describe("whisper workflow stats — global, no active collab", () => {
	let stateRoot: string;
	let prevStateRoot: string | undefined;
	let writeSpy: { mockRestore: () => void };
	let out: string;

	beforeEach(() => {
		// Fresh empty state root → getSharedSqlitePath() resolves to a brand-new
		// state.db; createBrokerRuntime applies migrations, so the workflows table
		// exists but is empty.
		stateRoot = mkdtempSync(join(tmpdir(), "aiw-stats-"));
		prevStateRoot = process.env.AI_WHISPER_STATE_ROOT;
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		out = "";
		writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((chunk: unknown): boolean => {
				out += String(chunk);
				return true;
			});
	});

	afterEach(() => {
		writeSpy.mockRestore();
		if (prevStateRoot === undefined) delete process.env.AI_WHISPER_STATE_ROOT;
		else process.env.AI_WHISPER_STATE_ROOT = prevStateRoot;
		rmSync(stateRoot, { recursive: true, force: true });
	});

	it("opens the shared DB and prints the empty summary with no collab in cwd", async () => {
		const cli = createCli();
		await cli.parseAsync(["node", "whisper", "workflow", "stats"]);
		expect(out).toContain("Hands-off time saved: 0m (no completed workflows yet)");
	});

	it("supports --json globally with no collab in cwd", async () => {
		const cli = createCli();
		await cli.parseAsync(["node", "whisper", "workflow", "stats", "--json"]);
		// Substring assertions (not JSON.parse) so any broker/migration log noise
		// on stdout cannot break the test.
		expect(out).toContain('"count": 0');
		expect(out).toContain('"since": null');
	});
});
