import { describe, expect, it } from "vitest";
import { checkCliBrokerVersion } from "../packages/cli/src/runtime/cli-broker-version-check.ts";

describe("checkCliBrokerVersion", () => {
	it("equal versions pass", () => {
		expect(
			checkCliBrokerVersion({ cliVersion: "0.17.0", brokerVersion: "0.17.0", context: "show" }),
		).toEqual({ ok: true });
	});

	it("show mismatch prints resend copy", () => {
		const expected =
			"ai-whisper CLI 0.17.0 does not match the running broker 0.16.0. Stop here and end your turn; ai-whisper will resend this handoff. Do not read ~/.ai-whisper/state.db directly.";
		for (const context of ["show", "turn-done"] as const) {
			expect(
				checkCliBrokerVersion({ cliVersion: "0.17.0", brokerVersion: "0.16.0", context }),
			).toEqual({ ok: false, message: expected });
		}
	});

	it("reply mismatch prints not-recorded copy", () => {
		expect(
			checkCliBrokerVersion({ cliVersion: "0.17.0", brokerVersion: "0.16.0", context: "reply" }),
		).toEqual({
			ok: false,
			message:
				"ai-whisper CLI 0.17.0 does not match the running broker 0.16.0. Your reply was not recorded. End your turn with your complete handback as your final message; ai-whisper will capture it. Do not read ~/.ai-whisper/state.db directly.",
		});
	});

	it("null daemon version is a mismatch printed as unknown", () => {
		const r = checkCliBrokerVersion({ cliVersion: "0.17.0", brokerVersion: null, context: "show" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.message).toContain("running broker unknown.");
	});
});
