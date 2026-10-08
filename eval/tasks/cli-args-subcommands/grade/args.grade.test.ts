import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.ts";

const spec = {
	flags: { verbose: "boolean" as const },
	commands: {
		build: { flags: { out: "string" as const, watch: "boolean" as const }, help: "Build the project" },
		clean: { flags: {}, help: "Remove artifacts" },
	},
};

describe("parseArgs subcommands (held-out)", () => {
	it("selects command and parses its flags", () => {
		const r = parseArgs(["build", "--out", "dist"], spec);
		expect(r.command).toBe("build");
		expect(r.commandFlags).toEqual({ out: "dist" });
		expect(r.positionals).toEqual([]);
	});
	it("global flag after command", () => {
		const r = parseArgs(["build", "--verbose", "--out=x"], spec);
		expect(r.command).toBe("build");
		expect(r.flags).toEqual({ verbose: true });
		expect(r.commandFlags).toEqual({ out: "x" });
	});
	it("global flag before command", () => {
		const r = parseArgs(["--verbose", "build", "--watch"], spec);
		expect(r.command).toBe("build");
		expect(r.flags).toEqual({ verbose: true });
		expect(r.commandFlags).toEqual({ watch: true });
	});
	it("command flag before command is unknown", () => {
		expect(() => parseArgs(["--out", "dist", "build"], spec)).toThrow(/^unknown flag --out$/);
	});
	it("no command gives null", () => {
		const r = parseArgs(["--verbose", "file.txt"], spec);
		expect(r.command).toBeNull();
		expect(r.commandFlags).toEqual({});
		expect(r.positionals).toEqual(["file.txt"]);
	});
	it("-- stops parsing inside command", () => {
		const r = parseArgs(["build", "--out", "d", "--", "--watch", "clean"], spec);
		expect(r.command).toBe("build");
		expect(r.commandFlags).toEqual({ out: "d" });
		expect(r.positionals).toEqual(["--watch", "clean"]);
	});
	it("unknown flag message format", () => {
		let message = "";
		try {
			parseArgs(["build", "--bogus=1"], spec);
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).toMatch(/^unknown flag --bogus$/);
	});
});
