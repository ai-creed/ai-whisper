import { describe, expect, it } from "vitest";
import { createCli } from "../packages/cli/src/create-cli.ts";

function findOption(cmdPath: string[], optionFlag: string) {
	let cmd = createCli();
	for (const name of cmdPath) {
		const next = cmd.commands.find((c) => c.name() === name);
		if (!next) throw new Error(`command ${name} not found`);
		cmd = next;
	}
	const opt = cmd.options.find((o) => o.long === optionFlag || o.flags.includes(optionFlag));
	if (!opt) throw new Error(`option ${optionFlag} not found on ${cmdPath.join(" ")}`);
	return opt;
}

describe("CLI exposes agy", () => {
	it("skill install --target accepts agy", () => {
		const opt = findOption(["skill", "install"], "--target");
		expect(opt.argChoices).toContain("agy");
	});
});
