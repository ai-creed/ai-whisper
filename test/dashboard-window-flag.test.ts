import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory (itself hoisted) can reference it — same
// pattern as cli-workflow-start-caller.test.ts. Mocking runCollabDashboard
// (rather than driving it directly) is what lets this test genuinely exercise
// create-cli.ts's `--window` → `showAll` implication formula: asserting on
// what create-cli.ts PASSES to runCollabDashboard, not on a value the test
// computes itself and feeds back in (which would pass whether or not
// create-cli.ts ever wired the sentinel check).
const { runCollabDashboardMock } = vi.hoisted(() => ({
	runCollabDashboardMock: vi.fn(async () => {}),
}));

vi.mock("../packages/cli/src/commands/collab/dashboard.ts", () => ({
	runCollabDashboard: runCollabDashboardMock,
}));

import { createCli } from "../packages/cli/src/create-cli.ts";
import { parseDashboardWindow, WINDOW_ALL_SENTINEL } from "../packages/cli/src/runtime/dashboard.ts";

afterEach(() => {
	runCollabDashboardMock.mockReset();
});

describe("parseDashboardWindow", () => {
	it("parses raw milliseconds (default unit)", () => {
		expect(parseDashboardWindow("1800000")).toBe(1_800_000);
		expect(parseDashboardWindow("250ms")).toBe(250);
	});

	it("parses seconds / minutes / hours / days", () => {
		expect(parseDashboardWindow("45s")).toBe(45 * 1_000);
		expect(parseDashboardWindow("30m")).toBe(30 * 60_000);
		expect(parseDashboardWindow("2h")).toBe(2 * 3_600_000);
		expect(parseDashboardWindow("1d")).toBe(86_400_000);
	});

	it("accepts decimals", () => {
		expect(parseDashboardWindow("1.5h")).toBe(1.5 * 3_600_000);
	});

	it("'all' / 'max' / '∞' return MAX_SAFE_INTEGER (no-window sentinel)", () => {
		expect(parseDashboardWindow("all")).toBe(Number.MAX_SAFE_INTEGER);
		expect(parseDashboardWindow("max")).toBe(Number.MAX_SAFE_INTEGER);
		expect(parseDashboardWindow("∞")).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("is case-insensitive and trims whitespace", () => {
		expect(parseDashboardWindow("  2H ")).toBe(2 * 3_600_000);
		expect(parseDashboardWindow("ALL")).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("returns null for unparseable / non-positive / undefined input", () => {
		expect(parseDashboardWindow(undefined)).toBeNull();
		expect(parseDashboardWindow("")).toBeNull();
		expect(parseDashboardWindow("abc")).toBeNull();
		expect(parseDashboardWindow("0")).toBeNull();
		expect(parseDashboardWindow("-5m")).toBeNull();
		expect(parseDashboardWindow("30 m")).toBeNull(); // internal whitespace rejected
	});
});

describe("`collab dashboard --window` mode implication (create-cli.ts wiring)", () => {
	async function runDashboardCli(...args: string[]) {
		await createCli().parseAsync(["node", "whisper", "collab", "dashboard", ...args]);
	}

	it("--window all implies run-ledger mode without --all", async () => {
		await runDashboardCli("--window", "all");
		expect(runCollabDashboardMock).toHaveBeenCalledWith(
			expect.objectContaining({ showAll: true, windowMs: WINDOW_ALL_SENTINEL }),
		);
	});

	it("--window 30m keeps collab-grouped wall (showAll false)", async () => {
		await runDashboardCli("--window", "30m");
		expect(runCollabDashboardMock).toHaveBeenCalledWith(
			expect.objectContaining({ showAll: false, windowMs: parseDashboardWindow("30m") }),
		);
	});

	it("--all still forces run-ledger mode independently of --window", async () => {
		await runDashboardCli("--window", "30m", "--all");
		expect(runCollabDashboardMock).toHaveBeenCalledWith(
			expect.objectContaining({ showAll: true, windowMs: parseDashboardWindow("30m") }),
		);
	});
});
