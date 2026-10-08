import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEvaluatorConfig, type ResolvedEvaluatorConfig } from "../../packages/cli/src/runtime/evaluator-config.ts";
import type { CliVersions, EvaluatorSnapshot, Pins } from "./types.ts";

type Provider = ResolvedEvaluatorConfig["provider"];

function modelFor(cfg: ResolvedEvaluatorConfig, provider: Provider | null): string | null {
	if (provider === null) return null;
	if (provider === "anthropic") return cfg.anthropic.model;
	if (provider === "openai") return cfg.openai.model;
	if (provider === "ollama") return cfg.ollama.model;
	return cfg.agentCli.model;
}

export function snapshotEvaluator(cfg: ResolvedEvaluatorConfig): EvaluatorSnapshot {
	return {
		provider: cfg.provider,
		model: modelFor(cfg, cfg.provider),
		fallbackProvider: cfg.fallback,
		fallbackModel: modelFor(cfg, cfg.fallback),
	};
}

export function resolveEvaluatorSnapshot(sourceStateRoot: string): EvaluatorSnapshot {
	const prev = process.env.AI_WHISPER_STATE_ROOT;
	process.env.AI_WHISPER_STATE_ROOT = sourceStateRoot;
	try {
		return snapshotEvaluator(loadEvaluatorConfig());
	} finally {
		if (prev === undefined) delete process.env.AI_WHISPER_STATE_ROOT;
		else process.env.AI_WHISPER_STATE_ROOT = prev;
	}
}

const defaultExec = (cmd: string, args: string[]): string =>
	execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function semverOf(output: string, label: string): string {
	const m = /\d+\.\d+\.\d+/.exec(output);
	if (!m) throw new Error(`could not parse a version from ${label} --version output: ${output.trim()}`);
	return m[0];
}

export function resolveCliVersions(input: { exec?: (cmd: string, args: string[]) => string; repoRoot?: string } = {}): CliVersions {
	const exec = input.exec ?? defaultExec;
	const repoRoot = input.repoRoot ?? join(import.meta.dirname, "..", "..");
	const pkg = JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8")) as { version: string };
	// Results commits land between slices; they must not move the pin or every later drift check would fail.
	const sha = exec("git", ["-C", repoRoot, "log", "-1", "--format=%h", "--", ".", ":!eval/results"]).trim();
	return {
		whisper: `${pkg.version}+${sha}`,
		claude: semverOf(exec("claude", ["--version"]), "claude"),
		codex: semverOf(exec("codex", ["--version"]), "codex"),
	};
}

export function checkPinDrift(
	pinned: Pins,
	live: { reviewerModel: string; evaluator: EvaluatorSnapshot; cliVersions: CliVersions },
): string[] {
	const out: string[] = [];
	const cmp = (field: string, a: string | null, b: string | null): void => {
		if (a !== b) out.push(`${field}: pinned ${a ?? "null"}, live ${b ?? "null"}`);
	};
	cmp("reviewerModel", pinned.reviewerModel, live.reviewerModel);
	cmp("evaluator.provider", pinned.evaluator.provider, live.evaluator.provider);
	cmp("evaluator.model", pinned.evaluator.model, live.evaluator.model);
	cmp("evaluator.fallbackProvider", pinned.evaluator.fallbackProvider, live.evaluator.fallbackProvider);
	cmp("evaluator.fallbackModel", pinned.evaluator.fallbackModel, live.evaluator.fallbackModel);
	cmp("cliVersions.whisper", pinned.cliVersions.whisper, live.cliVersions.whisper);
	cmp("cliVersions.claude", pinned.cliVersions.claude, live.cliVersions.claude);
	cmp("cliVersions.codex", pinned.cliVersions.codex, live.cliVersions.codex);
	return out;
}

export class DriftError extends Error {
	constructor(public readonly fields: string[]) {
		super(`campaign pins drifted; refusing to run before any spend:\n  - ${fields.join("\n  - ")}`);
		this.name = "DriftError";
	}
}
