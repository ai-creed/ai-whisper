import { describe, expect, it, vi } from "vitest";
import { submitInjectedProviderInput } from "../packages/cli/src/runtime/provider-submit-strategy.ts";

describe("submitInjectedProviderInput (ai-ezio)", () => {
	it("submits the text exactly once with no trailing carriage return", async () => {
		const writeUserInput = vi.fn();
		await submitInjectedProviderInput({
			target: "ezio",
			text: "implement the plan",
			writeUserInput,
		});
		expect(writeUserInput).toHaveBeenCalledTimes(1);
		expect(writeUserInput).toHaveBeenCalledWith("implement the plan");
		expect(writeUserInput).not.toHaveBeenCalledWith("\r");
	});
});
