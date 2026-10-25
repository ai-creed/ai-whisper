import { describe, expect, it } from "vitest";
import {
	getDeliveryModeForTarget,
	parseNoticeCapMs,
	parseNoticeStrict,
} from "../packages/cli/src/runtime/providers.ts";

describe("getDeliveryModeForTarget", () => {
	it("maps ezio to native and every other target to notice", () => {
		expect(getDeliveryModeForTarget("ezio", {})).toBe("native");
		for (const target of ["claude", "codex", "agy"] as const) {
			expect(getDeliveryModeForTarget(target, {})).toBe("notice");
		}
	});

	it("AI_WHISPER_NOTICE_PATH=off sends non-ezio targets to paste; ezio stays native", () => {
		const env = { AI_WHISPER_NOTICE_PATH: "off" };
		for (const target of ["claude", "codex", "agy"] as const) {
			expect(getDeliveryModeForTarget(target, env)).toBe("paste");
		}
		expect(getDeliveryModeForTarget("ezio", env)).toBe("native");
	});

	it("other values of the kill switch do not disable the notice path", () => {
		expect(getDeliveryModeForTarget("claude", { AI_WHISPER_NOTICE_PATH: "on" })).toBe("notice");
		expect(getDeliveryModeForTarget("claude", { AI_WHISPER_NOTICE_PATH: "" })).toBe("notice");
	});
});

describe("parseNoticeCapMs", () => {
	it("defaults to 900000 when unset, empty or garbage", () => {
		expect(parseNoticeCapMs({})).toBe(900000);
		expect(parseNoticeCapMs({ AI_WHISPER_NOTICE_IDLE_CAP_MS: "" })).toBe(900000);
		expect(parseNoticeCapMs({ AI_WHISPER_NOTICE_IDLE_CAP_MS: "soon" })).toBe(900000);
		expect(parseNoticeCapMs({ AI_WHISPER_NOTICE_IDLE_CAP_MS: "NaN" })).toBe(900000);
	});

	it("floors values below 60000 at 60000", () => {
		expect(parseNoticeCapMs({ AI_WHISPER_NOTICE_IDLE_CAP_MS: "1000" })).toBe(60000);
		expect(parseNoticeCapMs({ AI_WHISPER_NOTICE_IDLE_CAP_MS: "0" })).toBe(60000);
		expect(parseNoticeCapMs({ AI_WHISPER_NOTICE_IDLE_CAP_MS: "-5" })).toBe(60000);
	});

	it("accepts values at or above the floor", () => {
		expect(parseNoticeCapMs({ AI_WHISPER_NOTICE_IDLE_CAP_MS: "60000" })).toBe(60000);
		expect(parseNoticeCapMs({ AI_WHISPER_NOTICE_IDLE_CAP_MS: "120000" })).toBe(120000);
	});
});

describe("parseNoticeStrict", () => {
	it("is true only for exactly 1", () => {
		expect(parseNoticeStrict({ AI_WHISPER_NOTICE_STRICT: "1" })).toBe(true);
		expect(parseNoticeStrict({ AI_WHISPER_NOTICE_STRICT: "true" })).toBe(false);
		expect(parseNoticeStrict({ AI_WHISPER_NOTICE_STRICT: "0" })).toBe(false);
		expect(parseNoticeStrict({})).toBe(false);
	});
});
