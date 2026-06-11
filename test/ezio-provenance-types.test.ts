import { describe, it, expect } from "vitest";
import {
	DEV_PROVENANCE,
	isDevProvenance,
	type EzioProvenance,
} from "../packages/cli/src/ezio-provenance-types.js";

describe("ezio provenance types", () => {
	it("DEV_PROVENANCE is recognised as a dev/unstamped build", () => {
		expect(isDevProvenance(DEV_PROVENANCE)).toBe(true);
	});

	it("a real stamp is not treated as dev", () => {
		const real: EzioProvenance = {
			ezioCliVersion: "0.2.0-beta.1",
			ezioGitSha: "abc1234",
			builtAt: "2026-06-11T00:00:00.000Z",
			whisperVersion: "0.5.6",
		};
		expect(isDevProvenance(real)).toBe(false);
	});
});
