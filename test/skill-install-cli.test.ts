import { describe, expect, it, vi, beforeEach } from "vitest";

// Intercept the helper so the CLI-boundary test proves the parser accepts and
// routes `--target ezio` WITHOUT performing a real filesystem install.
// vi.hoisted because vi.mock is hoisted above plain declarations.
const { runSkillInstall } = vi.hoisted(() => ({
	runSkillInstall: vi.fn(async () => ({ installedAt: [] as string[] })),
}));
vi.mock("../packages/cli/src/commands/skill/install.ts", () => ({ runSkillInstall }));

import { createCli } from "../packages/cli/src/create-cli.ts";

function skillInstallTargetOption() {
	const cli = createCli();
	const skill = cli.commands.find((c) => c.name() === "skill")!;
	const install = skill.commands.find((c) => c.name() === "install")!;
	return install.options.find((o) => o.long === "--target")!;
}

describe("whisper skill install --target ezio (CLI boundary)", () => {
	beforeEach(() => runSkillInstall.mockClear());

	it("the --target choices include ezio (and claude, codex, all)", () => {
		const opt = skillInstallTargetOption();
		expect(opt.argChoices).toEqual(
			expect.arrayContaining(["claude", "codex", "ezio", "all"]),
		);
	});

	it("Commander accepts ezio and routes it to runSkillInstall", async () => {
		const cli = createCli().exitOverride();
		await cli.parseAsync(["node", "whisper", "skill", "install", "--target", "ezio"]);
		expect(runSkillInstall).toHaveBeenCalledWith(
			expect.objectContaining({ target: "ezio" }),
		);
	});

	it("rejects an unknown target (choices still enforced)", async () => {
		const cli = createCli().exitOverride();
		cli.configureOutput({ writeErr: () => {}, writeOut: () => {} });
		await expect(
			cli.parseAsync(["node", "whisper", "skill", "install", "--target", "gpt"]),
		).rejects.toBeTruthy();
		expect(runSkillInstall).not.toHaveBeenCalled();
	});
});
