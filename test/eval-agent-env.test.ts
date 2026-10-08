import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scrubAgentEnv } from "../eval/runner/arms/agent-env.ts";

describe("scrubAgentEnv", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("drops npm/pnpm script and cwd variables and keeps everything else", () => {
		root = mkdtempSync(join(tmpdir(), "eval-env-"));
		const env = { npm_config_user_agent: "pnpm", npm_lifecycle_event: "eval", npm_package_name: "ai-whisper", INIT_CWD: "/repo", PWD: "/repo", OLDPWD: "/x", HOME: "/home/u", ANTHROPIC_API_KEY: "k", NPM_TOKEN: "t" };
		const out = scrubAgentEnv(env, root);
		expect(out).toEqual({ HOME: "/home/u", ANTHROPIC_API_KEY: "k", NPM_TOKEN: "t" });
		expect(env.INIT_CWD).toBe("/repo"); // input untouched
	});

	it("removes PATH entries inside the repo (including through a symlink alias) and keeps the rest in order", () => {
		root = mkdtempSync(join(tmpdir(), "eval-env-"));
		const repo = join(root, "repo"); mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
		symlinkSync(repo, join(root, "alias"), "dir");
		const PATH = [join(repo, "node_modules", ".bin"), "/usr/bin", join(root, "alias", "node_modules", ".bin"), "/bin", repo, join(root, "elsewhere")].join(delimiter);
		expect(scrubAgentEnv({ PATH }, repo).PATH).toBe(["/usr/bin", "/bin", join(root, "elsewhere")].join(delimiter));
	});
});
