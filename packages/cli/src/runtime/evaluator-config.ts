import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getStateRoot } from "./state-root.js";
import { isExecutableOnPath, resolveAgentCliInvocation, type AgentCliAgent } from "./agent-cli-presets.js";

export type EvaluatorStatus =
	| "ready"
	| "missing_anthropic_key"
	| "missing_openai_key"
	| "agent_cli_unavailable"
	| "invalid_config"
	| "disabled"
	| "unknown";

export interface ResolvedEvaluatorConfig {
	provider: "anthropic" | "ollama" | "openai" | "agent-cli";
	fallback: "anthropic" | "ollama" | "openai" | "agent-cli" | null;
	anthropic: { apiKey: string | null; model: string | null };
	ollama: { host: string | null; model: string | null };
	openai: { apiKey: string | null; model: string | null; baseURL: string | null };
	agentCli: { agent: AgentCliAgent | null; executable: string | null; execArgs: string[] | null; promptVia: "arg" | "stdin" | null; model: string | null };
}

// Minimal KEY=VALUE parser. Handles comments (#), blank lines, surrounding
// single/double quotes. NOT full dotenv (no interpolation/escaping) — that's a
// documented limitation; for anything fancier, export a real env var (highest
// precedence). Returns a flat record; callers apply it only where process.env
// does not already define the key.
function parseDotEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue; // no key, skip (don't throw)
		const key = line.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let val = line.slice(eq + 1).trim();
		if (
			val.length >= 2 &&
			((val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'")))
		) {
			val = val.slice(1, -1);
		}
		out[key] = val;
	}
	return out;
}

// Non-throwing perms hygiene check (spec error-handling §): auth.json holds a
// secret, so warn (don't fail) if it's group/world readable. POSIX-only; skipped
// on Windows where st_mode perms bits aren't meaningful.
function warnIfLoosePerms(path: string): void {
	if (process.platform === "win32") return;
	let mode: number;
	try {
		mode = statSync(path).mode;
	} catch {
		return; // missing/unreadable — readJsonFile handles ENOENT
	}
	if (mode & 0o077) {
		console.error(
			`Warning: ${path} is accessible by group/world; it holds secrets. Run: chmod 600 ${path}`,
		);
	}
}

function readJsonFile(path: string, label: string): Record<string, unknown> | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch (err) {
		throw new Error(`Invalid ${label}: ${(err as Error).message}`);
	}
}

export function loadEvaluatorConfig(): ResolvedEvaluatorConfig {
	const root = getStateRoot();

	// .env (lowest of the "env" tier — only fills keys process.env lacks).
	let dotenv: Record<string, string> = {};
	try {
		dotenv = parseDotEnv(readFileSync(join(root, ".env"), "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const envGet = (k: string): string | undefined =>
		process.env[k] ?? dotenv[k];

	const authPath = join(root, "auth.json");
	warnIfLoosePerms(authPath);
	const auth = readJsonFile(authPath, "auth.json");
	const config = readJsonFile(join(root, "config.json"), "config.json");
	const evalCfg = (config?.evaluator ?? {}) as Record<string, unknown>;
	const evalOllama = (evalCfg.ollama ?? {}) as Record<string, unknown>;

	const provider =
		((envGet("AI_WHISPER_EVALUATOR_PROVIDER") ?? (evalCfg.provider as string | undefined)) as ResolvedEvaluatorConfig["provider"] | undefined);
	const resolvedProvider: ResolvedEvaluatorConfig["provider"] =
		provider === "ollama" || provider === "openai" || provider === "agent-cli" ? provider : "anthropic";
	const rawFallback = envGet("AI_WHISPER_EVALUATOR_FALLBACK") ?? (evalCfg.fallback as string | undefined);
	const fallback =
		rawFallback === "anthropic" || rawFallback === "ollama" || rawFallback === "openai" || rawFallback === "agent-cli"
			? rawFallback
			: null;

	const apiKey =
		envGet("ANTHROPIC_API_KEY") ?? (auth?.ANTHROPIC_API_KEY as string | undefined) ?? null;

	const evalOpenai = (evalCfg.openai ?? {}) as Record<string, unknown>;
	const openaiKey = envGet("OPENAI_API_KEY") ?? (auth?.OPENAI_API_KEY as string | undefined) ?? null;

	const evalAgentCli = (evalCfg.agentCli ?? {}) as Record<string, unknown>;
	const rawAgent = envGet("AI_WHISPER_EVALUATOR_AGENT_CLI_AGENT") ?? (evalAgentCli.agent as string | undefined);
	const agent = rawAgent === "claude" || rawAgent === "codex" || rawAgent === "agy" ? rawAgent : null;

	return {
		provider: resolvedProvider,
		fallback,
		anthropic: { apiKey: apiKey && apiKey.length > 0 ? apiKey : null, model: (evalCfg.anthropicModel as string | undefined) ?? null },
		ollama: {
			host: envGet("AI_WHISPER_EVALUATOR_OLLAMA_HOST") ?? (evalOllama.host as string | undefined) ?? null,
			model: envGet("AI_WHISPER_EVALUATOR_OLLAMA_MODEL") ?? (evalOllama.model as string | undefined) ?? null,
		},
		openai: {
			apiKey: openaiKey && openaiKey.length > 0 ? openaiKey : null,
			model: envGet("AI_WHISPER_EVALUATOR_OPENAI_MODEL") ?? (evalOpenai.model as string | undefined) ?? null,
			baseURL: envGet("AI_WHISPER_EVALUATOR_OPENAI_BASE_URL") ?? (evalOpenai.baseURL as string | undefined) ?? null,
		},
		agentCli: {
			agent,
			executable: (evalAgentCli.executable as string | undefined) ?? null,
			execArgs: Array.isArray(evalAgentCli.execArgs) ? (evalAgentCli.execArgs as string[]) : null,
			promptVia: evalAgentCli.promptVia === "arg" || evalAgentCli.promptVia === "stdin" ? evalAgentCli.promptVia : null,
			model: (evalAgentCli.model as string | undefined) ?? null,
		},
	};
}

export function computeEvaluatorStatus(
	cfg: ResolvedEvaluatorConfig,
	ctx: { orchestratorEnabled: boolean; loaderError: Error | null; executableExists?: (exe: string) => boolean },
): Exclude<EvaluatorStatus, "unknown"> {
	if (ctx.loaderError) return "invalid_config";
	if (!ctx.orchestratorEnabled) return "disabled";
	if (cfg.provider === "anthropic" && cfg.anthropic.apiKey === null) {
		return "missing_anthropic_key";
	}
	if (cfg.provider === "openai") {
		if (cfg.openai.apiKey === null) return "missing_openai_key";
		if (cfg.openai.model === null) return "invalid_config";
	}
	if (cfg.provider === "agent-cli") {
		if (cfg.agentCli.agent === null) return "invalid_config";
		const { executable } = resolveAgentCliInvocation({
			agent: cfg.agentCli.agent,
			executable: cfg.agentCli.executable,
			execArgs: cfg.agentCli.execArgs,
			promptVia: cfg.agentCli.promptVia,
		});
		const exists = (ctx.executableExists ?? isExecutableOnPath)(executable);
		if (!exists) return "agent_cli_unavailable";
	}
	return "ready";
}

export function isEvaluatorReady(status: EvaluatorStatus): boolean {
	// "unknown" = older daemon where status column is NULL; treat as ready so pre-migration setups aren't false-blocked.
	return status === "ready" || status === "unknown";
}

// Statuses that must block workflow start with an actionable remediation.
// (disabled/unknown/ready all PROCEED — disabled is governed by createWorkflow's
// own orchestrator check.) Centralized so the literal set lives in one place.
export function isEvaluatorPreflightBlocked(status: EvaluatorStatus): boolean {
	return (
		status === "missing_anthropic_key" ||
		status === "missing_openai_key" ||
		status === "agent_cli_unavailable" ||
		status === "invalid_config"
	);
}
