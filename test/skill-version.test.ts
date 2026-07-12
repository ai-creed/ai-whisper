import { describe, expect, it } from "vitest";
import {
	compareSemver,
	parseSkillVersion,
} from "../packages/cli/src/commands/skill/version.ts";

describe("parseSkillVersion", () => {
	it("reads version from frontmatter", () => {
		expect(parseSkillVersion("---\nname: x\nversion: 0.1.0\n---\nbody")).toBe("0.1.0");
	});

	it("accepts quoted values", () => {
		expect(parseSkillVersion('---\nversion: "1.2.3"\n---\nbody')).toBe("1.2.3");
	});

	it("returns null without a frontmatter block", () => {
		expect(parseSkillVersion("just a body")).toBeNull();
	});

	it("returns null when frontmatter has no version line", () => {
		expect(parseSkillVersion("---\nname: x\n---\nbody")).toBeNull();
	});

	it("ignores version lines outside the frontmatter block", () => {
		expect(parseSkillVersion("---\nname: x\n---\nversion: 9.9.9")).toBeNull();
	});

	it("returns null for malformed values (prerelease is out of scope)", () => {
		expect(parseSkillVersion("---\nversion: 1.0.0-rc1\n---\nbody")).toBeNull();
		expect(parseSkillVersion("---\nversion: abc\n---\nbody")).toBeNull();
	});
});

describe("compareSemver", () => {
	it("orders numerically per part (no lexicographic traps)", () => {
		expect(compareSemver("0.2.0", "0.10.0")).toBe(-1);
		expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
		expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
	});

	it("treats missing parts as zero", () => {
		expect(compareSemver("1", "1.0.0")).toBe(0);
		expect(compareSemver("1.1", "1.0.5")).toBe(1);
	});
});
