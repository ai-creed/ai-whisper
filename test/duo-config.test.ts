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

	it("flag false disables regardless of env (unset)", () => {
		expect(resolveDuoEnabled(false)).toBe(false);
	});

	it("flag false disables even when env would enable", () => {
		process.env.AI_WHISPER_DUO = "on";
		expect(resolveDuoEnabled(false)).toBe(false);
	});

	it("env off/0/false/none (mixed case, trimmed) disables when flag absent", () => {
		for (const value of [
			"off",
			"0",
			"false",
			"none",
			"OFF",
			"Off",
			"FALSE",
			"None",
			"  off  ",
			" none ",
		]) {
			process.env.AI_WHISPER_DUO = value;
			expect(resolveDuoEnabled(undefined)).toBe(false);
		}
	});

	it("unset env with flag undefined is enabled (default ON)", () => {
		expect(resolveDuoEnabled(undefined)).toBe(true);
	});

	it("unrecognized env value falls through to enabled", () => {
		process.env.AI_WHISPER_DUO = "banana";
		expect(resolveDuoEnabled(undefined)).toBe(true);
	});

	it("a truthy flag cannot override a disabling env value (only a negative flag exists)", () => {
		process.env.AI_WHISPER_DUO = "off";
		expect(resolveDuoEnabled(true)).toBe(false);
	});
});
