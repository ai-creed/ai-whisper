import { execFileSync } from "node:child_process";
import { scrubAgentEnv } from "./arms/agent-env.ts";
import { HarnessFailure, type BillingMode } from "./types.ts";

/**
 * Pre-spend check that the environment can honour the campaign's billing pin.
 *
 * `subscription` probes `claude auth status --json` under the exact env the agents will be spawned with (API
 * credentials scrubbed) and requires a claude.ai login — otherwise every solo run and the Arm C claude mount
 * would fail auth, or worse, silently bill a key the scrub could not reach. `api` only requires a credential
 * in the agent env. Neither path spends tokens. The codex seat is outside this check: it always runs on its
 * own chatgpt login or OPENAI_API_KEY, and the evaluator always bills the API via the run state root's auth.json.
 */

export type ClaudeAuthStatus = { loggedIn: boolean; authMethod: string };
export type ExecFn = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => string;

const defaultExec: ExecFn = (cmd, args, env) =>
	execFileSync(cmd, args, { encoding: "utf8", env: env as Record<string, string>, stdio: ["ignore", "pipe", "pipe"] });

export class BillingPreflightError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BillingPreflightError";
	}
}

export function readClaudeAuthStatus(env: NodeJS.ProcessEnv, exec: ExecFn = defaultExec): ClaudeAuthStatus {
	let raw: string;
	try {
		raw = exec("claude", ["auth", "status", "--json"], env);
	} catch (e) {
		throw new HarnessFailure(`could not run \`claude auth status\`: ${(e as Error).message}`, e);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new HarnessFailure(`\`claude auth status --json\` did not return JSON: ${raw.trim().slice(0, 200)}`, e);
	}
	const o = parsed as { loggedIn?: unknown; authMethod?: unknown };
	if (typeof o.loggedIn !== "boolean" || typeof o.authMethod !== "string") {
		throw new HarnessFailure(`\`claude auth status --json\` returned an unexpected shape: ${raw.trim().slice(0, 200)}`);
	}
	return { loggedIn: o.loggedIn, authMethod: o.authMethod };
}

const CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export function checkBillingPreflight(billing: BillingMode, env: NodeJS.ProcessEnv, repoRoot: string, exec: ExecFn = defaultExec): void {
	const agentEnv = scrubAgentEnv(env, repoRoot, billing);
	if (billing === "api") {
		if (!CREDENTIAL_KEYS.some((k) => (agentEnv[k] ?? "").length > 0)) {
			throw new BillingPreflightError(
				"campaign is pinned to billing=api but ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is not set in this shell; " +
					"export it, or init a new campaign with --billing subscription to run the claude seats on your claude.ai login.",
			);
		}
		return;
	}
	const auth = readClaudeAuthStatus(agentEnv, exec);
	if (auth.loggedIn && auth.authMethod === "claude.ai") return;
	throw new BillingPreflightError(
		`campaign is pinned to billing=subscription but claude reports authMethod "${auth.authMethod}" with the API credentials scrubbed ` +
			"(expected \"claude.ai\"); run `claude` once and log in to claude.ai, or init a new campaign with --billing api.",
	);
}
