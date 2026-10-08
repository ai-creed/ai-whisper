import { describe, expect, it } from "vitest";
import { renderHelp } from "../src/help.ts";

describe("renderHelp (held-out)", () => {
	it("renderHelp lists commands and flags", () => {
		const out = renderHelp({
			flags: { verbose: "boolean" },
			commands: {
				build: { flags: { out: "string" }, help: "Build the project" },
				clean: { flags: {}, help: "Remove artifacts" },
			},
		});
		for (const needle of ["build", "clean", "Build the project", "Remove artifacts", "--verbose", "--out"]) {
			expect(out).toContain(needle);
		}
		expect(out.indexOf("--verbose")).toBeLessThan(out.indexOf("build"));
	});
});
