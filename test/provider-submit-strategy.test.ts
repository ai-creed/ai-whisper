import { describe, expect, it, vi } from "vitest";
import { submitInjectedProviderInput } from "../packages/cli/src/runtime/provider-submit-strategy.ts";

describe("provider submit strategy", () => {
	it("types Codex input as a short keystream before submitting (default fallback)", async () => {
		const writes: string[] = [];
		const sleep = vi.fn(() => Promise.resolve());

		await submitInjectedProviderInput({
			target: "codex",
			text: "hi",
			writeUserInput: (text) => { writes.push(text); },
			sleep,
		});

		expect(writes).toEqual(["h", "i", "\r"]);
		expect(sleep).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenNthCalledWith(1, 5);
		expect(sleep).toHaveBeenNthCalledWith(2, 5);
		expect(sleep).toHaveBeenNthCalledWith(3, 100);
	});

	it("writes Claude input in one chunk before submitting", async () => {
		const writes: string[] = [];
		const sleep = vi.fn(() => Promise.resolve());

		await submitInjectedProviderInput({
			target: "claude",
			text: "tell me a joke",
			writeUserInput: (text) => { writes.push(text); },
			sleep,
		});

		expect(writes).toEqual(["tell me a joke", "\r"]);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(75);
	});

	// Bracketed paste (codex). Spike-validated against codex v0.135.0
	// (docs/superpowers/specs/2026-05-30-codex-bracketed-paste-injection-design.md):
	// a single atomic write of ESC[200~ <text> ESC[201~ delivers the whole
	// (possibly multi-line) prompt as one pasted block — newlines stay literal,
	// no premature submit — and a single \r on a separate beat submits it.
	describe("codex — bracketed paste (when enabled)", () => {
		it("writes the payload wrapped in paste markers in ONE write, then submits with \\r", async () => {
			const writes: string[] = [];
			const sleep = vi.fn(() => Promise.resolve());

			await submitInjectedProviderInput({
				target: "codex",
				text: "hi",
				bracketedPasteEnabled: true,
				writeUserInput: (chunk) => { writes.push(chunk); },
				sleep,
			});

			expect(writes).toEqual(["\x1b[200~hi\x1b[201~", "\r"]);
			expect(sleep).toHaveBeenCalledTimes(1);
			expect(sleep).toHaveBeenCalledWith(100);
		});

		it("delivers a multi-line payload literally in one write and submits with \\r (corrected Mode B)", async () => {
			const writes: string[] = [];
			const sleep = vi.fn(() => Promise.resolve());
			const text = ["line 1: do the work", "line 2: verify it", "line 3: report back"].join("\n");

			await submitInjectedProviderInput({
				target: "codex",
				text,
				bracketedPasteEnabled: true,
				writeUserInput: (chunk) => { writes.push(chunk); },
				sleep,
			});

			// One atomic write carries the full multi-line payload, newlines intact.
			expect(writes[0]).toBe(`\x1b[200~${text}\x1b[201~`);
			// Unlike the original (disproven) Mode B assumption, a single \r DOES
			// submit a bracketed paste — the tail IS \r and it works.
			expect(writes).toHaveLength(2);
			expect(writes[1]).toBe("\r");
		});

		it("strips any embedded end-marker so the paste cannot be closed early", async () => {
			const writes: string[] = [];
			const sleep = vi.fn(() => Promise.resolve());

			await submitInjectedProviderInput({
				target: "codex",
				text: "a\x1b[201~b",
				bracketedPasteEnabled: true,
				writeUserInput: (chunk) => { writes.push(chunk); },
				sleep,
			});

			expect(writes[0]).toBe("\x1b[200~ab\x1b[201~");
		});

		it("falls back to the keystream drip when bracketed paste is NOT enabled", async () => {
			const writes: string[] = [];
			const sleep = vi.fn(() => Promise.resolve());

			await submitInjectedProviderInput({
				target: "codex",
				text: "hi",
				bracketedPasteEnabled: false,
				writeUserInput: (chunk) => { writes.push(chunk); },
				sleep,
			});

			expect(writes).toEqual(["h", "i", "\r"]);
		});
	});

	describe("codex — strategy override", () => {
		it("strategyOverride=keystream wins over an enabled detector", async () => {
			const writes: string[] = [];
			await submitInjectedProviderInput({
				target: "codex",
				text: "hi",
				bracketedPasteEnabled: true,
				strategyOverride: "keystream",
				writeUserInput: (chunk) => { writes.push(chunk); },
				sleep: () => Promise.resolve(),
			});
			expect(writes).toEqual(["h", "i", "\r"]);
		});

		it("strategyOverride=bracketed wins even when the detector is disabled", async () => {
			const writes: string[] = [];
			await submitInjectedProviderInput({
				target: "codex",
				text: "hi",
				bracketedPasteEnabled: false,
				strategyOverride: "bracketed",
				writeUserInput: (chunk) => { writes.push(chunk); },
				sleep: () => Promise.resolve(),
			});
			expect(writes).toEqual(["\x1b[200~hi\x1b[201~", "\r"]);
		});
	});

	it("writes agy input in one chunk before submitting (claude-style)", async () => {
		const writes: string[] = [];
		const sleep = vi.fn(() => Promise.resolve());
		await submitInjectedProviderInput({
			target: "agy",
			text: "do the thing",
			writeUserInput: (text) => { writes.push(text); },
			sleep,
		});
		expect(writes).toEqual(["do the thing", "\r"]);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(75);
	});
});

