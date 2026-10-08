import { describe, expect, it } from "vitest";
import type { ResolvedEvaluatorConfig } from "../packages/cli/src/runtime/evaluator-config.ts";
import { checkPinDrift, resolveCliVersions, snapshotEvaluator } from "../eval/runner/pins.ts";
import type { Pins } from "../eval/runner/types.ts";

const cfg = (over: Partial<ResolvedEvaluatorConfig> = {}): ResolvedEvaluatorConfig => ({
	provider: "anthropic", fallback: "openai",
	anthropic: { apiKey: "k", model: null },
	ollama: { host: null, model: null },
	openai: { apiKey: "k", model: "gpt-5-mini", baseURL: null },
	agentCli: { agent: null, executable: null, execArgs: null, promptVia: null, model: null },
	...over,
});

describe("snapshotEvaluator", () => {
	it("records the primary model and the FALLBACK provider's own model", () => {
		expect(snapshotEvaluator(cfg())).toEqual({ provider: "anthropic", model: null, fallbackProvider: "openai", fallbackModel: "gpt-5-mini" });
	});
	it("nulls the fallback pair when no fallback is configured", () => {
		expect(snapshotEvaluator(cfg({ fallback: null }))).toEqual({ provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null });
	});
});

describe("checkPinDrift", () => {
	const pins: Pins = {
		implementerModel: "claude-sonnet-4-5", reviewerModel: "gpt-5",
		evaluator: { provider: "anthropic", model: null, fallbackProvider: "openai", fallbackModel: "gpt-5-mini" },
		cliVersions: { whisper: "0.16.0+abc", claude: "2.0.0", codex: "0.50.0" },
	};
	it("is empty when nothing drifted", () => {
		expect(checkPinDrift(pins, { reviewerModel: "gpt-5", evaluator: pins.evaluator, cliVersions: pins.cliVersions })).toEqual([]);
	});
	it("names a fallback model drift (the exact gap the spec review caught)", () => {
		const drift = checkPinDrift(pins, { reviewerModel: "gpt-5", evaluator: { ...pins.evaluator, fallbackModel: "gpt-5-nano" }, cliVersions: pins.cliVersions });
		expect(drift).toEqual(["evaluator.fallbackModel: pinned gpt-5-mini, live gpt-5-nano"]);
	});
	it("names every drifted field at once", () => {
		const drift = checkPinDrift(pins, { reviewerModel: "gpt-4.1", evaluator: { ...pins.evaluator, provider: "openai" }, cliVersions: { ...pins.cliVersions, codex: "0.51.0" } });
		expect(drift).toHaveLength(3);
	});
});

describe("resolveCliVersions", () => {
	it("parses semver from the binaries and stamps whisper with the git sha", () => {
		const exec = (cmd: string, args: string[]): string => {
			if (cmd === "claude") return "2.0.14 (Claude Code)";
			if (cmd === "codex") return "codex-cli 0.50.0";
			if (cmd === "git" && args[0] === "rev-parse") return "abc1234";
			throw new Error(`unexpected ${cmd}`);
		};
		const v = resolveCliVersions({ exec });
		expect(v.claude).toBe("2.0.14");
		expect(v.codex).toBe("0.50.0");
		expect(v.whisper).toMatch(/^\d+\.\d+\.\d+\+abc1234$/);
	});
});
