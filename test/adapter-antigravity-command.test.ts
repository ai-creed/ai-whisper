import { describe, expect, it } from "vitest";
import type { AntigravityCommandConfig } from "../packages/adapter-antigravity/src/antigravity-command.ts";

describe("AntigravityCommandConfig", () => {
	it("models executable + execArgs", () => {
		const config: AntigravityCommandConfig = { executable: "agy", execArgs: ["-p"] };
		expect(config.executable).toBe("agy");
		expect(config.execArgs).toEqual(["-p"]);
	});
});
