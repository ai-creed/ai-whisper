import { delimiter, resolve } from "node:path";
import { isInside } from "../paths.ts";
import type { BillingMode } from "../types.ts";

const DROPPED_KEYS = new Set(["INIT_CWD", "PWD", "OLDPWD", "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"]);
/** Credentials `claude` prefers over its claude.ai login; dropped under subscription billing. Deleted, never set to undefined: node-pty stringifies env values. */
const ANTHROPIC_CREDENTIAL_KEYS = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

/**
 * CLAUDE_CODE_ variables and CLAUDECODE are dropped too: a mounted claude inheriting CLAUDE_CODE_CHILD_SESSION from a Claude Code
 * parent (e.g. a runner launched from inside Claude Code) disables its transcript saving, which un-meters Arm C.
 *
 * The child env for an agent session: the runner is launched via `pnpm eval`, so its env carries
 * npm/pnpm script variables, the repo cwd and the repo's node_modules/.bin on PATH — all of which
 * would point the agent back at this repository.
 */
export function scrubAgentEnv(env: NodeJS.ProcessEnv, repoRoot: string, billing: BillingMode): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (/^npm_|^CLAUDE_CODE_/.test(key) || DROPPED_KEYS.has(key)) continue;
		if (billing === "subscription" && ANTHROPIC_CREDENTIAL_KEYS.has(key)) continue;
		out[key] = value;
	}
	if (out.PATH !== undefined) {
		out.PATH = out.PATH.split(delimiter).filter((entry) => !isInside(resolve(entry), repoRoot)).join(delimiter);
	}
	return out;
}
