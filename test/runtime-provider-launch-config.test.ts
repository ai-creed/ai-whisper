import { describe, expect, it } from "vitest";
import { getLiveSessionBrokerTempRoot } from "../packages/cli/src/runtime/paths.ts";
import {
	getInteractiveSessionExecArgsForTarget,
	getProviderExecArgsForTarget,
} from "../packages/cli/src/runtime/providers.ts";

describe("interactive session launch config", () => {
	it("runs codex with full autonomy (no approvals, no sandbox)", () => {
		expect(getInteractiveSessionExecArgsForTarget("codex")).toEqual([
			"--dangerously-bypass-approvals-and-sandbox",
			"--add-dir",
			getLiveSessionBrokerTempRoot(),
		]);
	});

	it("runs claude with full autonomy (all permission checks bypassed)", () => {
		expect(getInteractiveSessionExecArgsForTarget("claude")).toEqual([
			"--add-dir",
			getLiveSessionBrokerTempRoot(),
			"--dangerously-skip-permissions",
		]);
	});

	it("runs cursor with full autonomy and no broker add-dir (--force grants file access)", () => {
		expect(getInteractiveSessionExecArgsForTarget("cursor")).toEqual(["--force"]);
	});
});

describe("one-shot provider launch config", () => {
	it("runs codex one-shot execution with full autonomy", () => {
		expect(getProviderExecArgsForTarget("codex")).toEqual([
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
			"--add-dir",
			getLiveSessionBrokerTempRoot(),
		]);
	});

	it("runs claude one-shot execution with full autonomy", () => {
		expect(getProviderExecArgsForTarget("claude")).toEqual([
			"-p",
			"--add-dir",
			getLiveSessionBrokerTempRoot(),
			"--dangerously-skip-permissions",
		]);
	});

	it("runs cursor one-shot headless with json output and no broker add-dir", () => {
		expect(getProviderExecArgsForTarget("cursor")).toEqual([
			"-p",
			"--force",
			"--output-format",
			"json",
		]);
	});
});
