import { delimiter, resolve } from "node:path";
import { isInside } from "../paths.ts";

const DROPPED_KEYS = new Set(["INIT_CWD", "PWD", "OLDPWD", "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"]);

/**
 * CLAUDE_CODE_ variables and CLAUDECODE are dropped too: a mounted claude inheriting CLAUDE_CODE_CHILD_SESSION from a Claude Code
 * parent (e.g. a runner launched from inside Claude Code) disables its transcript saving, which un-meters Arm C.
 *
 * The child env for an agent session: the runner is launched via `pnpm eval`, so its env carries
 * npm/pnpm script variables, the repo cwd and the repo's node_modules/.bin on PATH — all of which
 * would point the agent back at this repository.
 */
export function scrubAgentEnv(env: NodeJS.ProcessEnv, repoRoot: string): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (/^npm_|^CLAUDE_CODE_/.test(key) || DROPPED_KEYS.has(key)) continue;
		out[key] = value;
	}
	if (out.PATH !== undefined) {
		out.PATH = out.PATH.split(delimiter).filter((entry) => !isInside(resolve(entry), repoRoot)).join(delimiter);
	}
	return out;
}
