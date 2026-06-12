import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	resolveCliVersion,
	resolveInstallPath,
} from "../packages/cli/src/runtime/cli-package-info.ts";

describe("cli-package-info", () => {
	it("resolveCliVersion returns the ai-whisper package semver", () => {
		expect(resolveCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("resolveInstallPath points at a directory whose package.json is ai-whisper", () => {
		const installPath = resolveInstallPath();
		expect(existsSync(installPath)).toBe(true);
		const pkg = JSON.parse(
			readFileSync(join(installPath, "package.json"), "utf8"),
		) as { name?: string };
		expect(pkg.name).toBe("ai-whisper");
	});

	it("create-cli still re-exports resolveCliVersion (back-compat)", async () => {
		const createCli = await import("../packages/cli/src/create-cli.ts");
		expect(createCli.resolveCliVersion()).toBe(resolveCliVersion());
	});
});
