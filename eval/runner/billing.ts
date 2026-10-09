import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotEnv } from "../../packages/cli/src/runtime/evaluator-config.ts";
import { scrubAgentEnv } from "./arms/agent-env.ts";
import { HarnessFailure, type BillingMode, type EvaluatorSnapshot } from "./types.ts";

/**
 * Pre-spend check that the environment can honour the campaign's billing pin.
 *
 * `subscription` probes `claude auth status --json` under the exact env the agents will be spawned with (API
 * credentials scrubbed) and requires a claude.ai login — otherwise every solo run and the Arm C claude mount
 * would fail auth, or worse, silently bill a key the scrub could not reach. `api` only requires a credential
 * in the agent env. Under `subscription` an anthropic evaluator (primary or fallback) must also have its key on disk
 * in the source state root, since the scrubbed mount env no longer carries it to the broker. Neither path spends
 * tokens. The codex seat is outside this check: it runs on its own chatgpt login or OPENAI_API_KEY.
 */

export type ClaudeAuthStatus = { loggedIn: boolean; authMethod: string; apiProvider: string | null };
export type ExecFn = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => string;

// Neutral cwd: the agents run in workspaces outside the repo, so a project-level .claude/settings in the repo must not
// colour the probe.
const defaultExec: ExecFn = (cmd, args, env) =>
	execFileSync(cmd, args, { encoding: "utf8", env: env as Record<string, string>, cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });

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
	const o = parsed as { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown };
	if (typeof o.loggedIn !== "boolean" || typeof o.authMethod !== "string") {
		throw new HarnessFailure(`\`claude auth status --json\` returned an unexpected shape: ${raw.trim().slice(0, 200)}`);
	}
	return { loggedIn: o.loggedIn, authMethod: o.authMethod, apiProvider: typeof o.apiProvider === "string" ? o.apiProvider : null };
}

const CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export interface BillingPreflightInput {
	billing: BillingMode;
	env: NodeJS.ProcessEnv;
	repoRoot: string;
	/** The campaign's pinned evaluator: an anthropic primary or fallback needs a key the daemon can still find once the env is scrubbed. */
	evaluator: EvaluatorSnapshot;
	/** Where the pair driver copies auth.json / .env from into each run's state root. */
	sourceStateRoot: string;
}

/** The key as the daemon will resolve it with the shell env scrubbed: auth.json, then .env, in the source state root. Files only. */
function stateRootHasAnthropicKey(stateRoot: string): boolean {
	const read = (name: string): string | null => {
		try {
			return readFileSync(join(stateRoot, name), "utf8");
		} catch {
			return null;
		}
	};
	const auth = read("auth.json");
	if (auth !== null) {
		try {
			const key = (JSON.parse(auth) as { ANTHROPIC_API_KEY?: unknown }).ANTHROPIC_API_KEY;
			if (typeof key === "string" && key.length > 0) return true;
		} catch {
			// malformed auth.json: the daemon would reject it too; fall through to .env
		}
	}
	const dotenv = read(".env");
	return dotenv !== null && (parseDotEnv(dotenv).ANTHROPIC_API_KEY ?? "").length > 0;
}

export function checkBillingPreflight(input: BillingPreflightInput, exec: ExecFn = defaultExec): void {
	const agentEnv = scrubAgentEnv(input.env, input.repoRoot, input.billing);
	if (input.billing === "api") {
		if (!CREDENTIAL_KEYS.some((k) => (agentEnv[k] ?? "").length > 0)) {
			throw new BillingPreflightError(
				"campaign is pinned to billing=api but ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is not set in this shell; " +
					"export it, or init a new campaign with --billing subscription to run the claude seats on your claude.ai login.",
			);
		}
		return;
	}
	const needsAnthropicKey = input.evaluator.provider === "anthropic" || input.evaluator.fallbackProvider === "anthropic";
	if (needsAnthropicKey && !stateRootHasAnthropicKey(input.sourceStateRoot)) {
		throw new BillingPreflightError(
			"campaign is pinned to billing=subscription, which scrubs ANTHROPIC_API_KEY from the Arm C mount, but the pinned evaluator " +
				`is anthropic and ${join(input.sourceStateRoot, "auth.json")} (or .env there) carries no ANTHROPIC_API_KEY for the broker to fall back to; ` +
				"write it there as { \"ANTHROPIC_API_KEY\": \"sk-ant-...\" } (mode 600), or init a new campaign with --billing api.",
		);
	}
	const auth = readClaudeAuthStatus(agentEnv, exec);
	if (auth.loggedIn && auth.authMethod === "claude.ai" && (auth.apiProvider === null || auth.apiProvider === "firstParty")) return;
	if (auth.loggedIn && auth.authMethod === "claude.ai") {
		throw new BillingPreflightError(
			`campaign is pinned to billing=subscription but claude reports apiProvider "${auth.apiProvider}" (expected "firstParty"); ` +
				"a settings-file env block is routing claude to a third-party provider. Remove it, or init a new campaign with --billing api.",
		);
	}
	throw new BillingPreflightError(
		`campaign is pinned to billing=subscription but claude reports authMethod "${auth.authMethod}" with the API credentials scrubbed ` +
			"(expected \"claude.ai\"); run `claude` once and log in to claude.ai, or init a new campaign with --billing api.",
	);
}
