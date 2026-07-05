import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDuoEnabled } from "../packages/cli/src/runtime/duo-config.ts";

describe("resolveDuoEnabled", () => {
	let prevDuo: string | undefined;

	beforeEach(() => {
		prevDuo = process.env.AI_WHISPER_DUO;
		delete process.env.AI_WHISPER_DUO;
	});

	afterEach(() => {
		if (prevDuo === undefined) {
			delete process.env.AI_WHISPER_DUO;
		} else {
			process.env.AI_WHISPER_DUO = prevDuo;
		}
	});

	it("unset env with flag undefined is disabled (default OFF)", () => {
		expect(resolveDuoEnabled(undefined)).toBe(false);
	});

	it("env on/1/true/yes (mixed case, trimmed) enables when flag absent", () => {
		for (const value of [
			"on",
			"1",
			"true",
			"yes",
			"ON",
			"On",
			"TRUE",
			"Yes",
			"  on  ",
			" true ",
		]) {
			process.env.AI_WHISPER_DUO = value;
			expect(resolveDuoEnabled(undefined)).toBe(true);
		}
	});

	it("env off/0/false/none stays disabled (default OFF, not an enable value)", () => {
		for (const value of ["off", "0", "false", "none", "OFF", "None"]) {
			process.env.AI_WHISPER_DUO = value;
			expect(resolveDuoEnabled(undefined)).toBe(false);
		}
	});

	it("unrecognized env value stays disabled (default OFF)", () => {
		process.env.AI_WHISPER_DUO = "banana";
		expect(resolveDuoEnabled(undefined)).toBe(false);
	});

	it("flag false disables even when env would enable (--no-duo beats env)", () => {
		process.env.AI_WHISPER_DUO = "on";
		expect(resolveDuoEnabled(false)).toBe(false);
	});

	it("flag false disables regardless of env (unset)", () => {
		expect(resolveDuoEnabled(false)).toBe(false);
	});

	it("a truthy flag does not enable on its own — only the env opt-in enables", () => {
		expect(resolveDuoEnabled(true)).toBe(false);
	});

	it("a truthy flag does not block an enabling env value", () => {
		process.env.AI_WHISPER_DUO = "on";
		expect(resolveDuoEnabled(true)).toBe(true);
	});
});
