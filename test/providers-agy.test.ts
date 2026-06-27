// test/providers-agy.test.ts
import { describe, expect, it } from "vitest";
import {
	createProviderForTarget,
	getInteractiveSessionExecArgsForTarget,
	getProviderExecArgsForTarget,
} from "../packages/cli/src/runtime/providers.ts";

describe("agy runtime dispatch", () => {
	it("provider exec args include -p and the autonomy flag", () => {
		const args = getProviderExecArgsForTarget("agy");
		expect(args[0]).toBe("-p");
		expect(args).toContain("--dangerously-skip-permissions");
		expect(args).toContain("--add-dir");
	});

	it("interactive exec args include the autonomy flag and no -p", () => {
		const args = getInteractiveSessionExecArgsForTarget("agy");
		expect(args).toContain("--dangerously-skip-permissions");
		expect(args).toContain("--add-dir");
		expect(args).not.toContain("-p");
	});

	it("createProviderForTarget returns the antigravity identity", () => {
		const provider = createProviderForTarget("agy");
		expect(provider.getIdentity().toolFamily).toBe("antigravity");
	});
});
