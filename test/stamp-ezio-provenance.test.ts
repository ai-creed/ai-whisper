import { describe, it, expect } from "vitest";
import {
	renderProvenanceModule,
	collectProvenance,
	findEzioRoot,
} from "../packages/cli/scripts/stamp-ezio-provenance.mjs";

const seams = (over = {}) => ({
	pkgRoot: "/repo/packages/cli",
	ezioRoot: "/repo/../ai-ezio",
	now: () => new Date("2026-06-11T00:00:00.000Z"),
	readJson: (p: string) =>
		p.includes("ai-ezio")
			? { version: "0.2.0-beta.1" }
			: { name: "ai-whisper", version: "0.5.6" },
	gitShortSha: () => "abc1234",
	...over,
});

describe("collectProvenance", () => {
	it("reads real ezio + whisper versions and git sha", () => {
		const p = collectProvenance(seams());
		expect(p).toEqual({
			ezioCliVersion: "0.2.0-beta.1",
			ezioGitSha: "abc1234",
			builtAt: "2026-06-11T00:00:00.000Z",
			whisperVersion: "0.5.6",
		});
	});

	it("fails loudly when the ezio checkout is unresolved (null root)", () => {
		expect(() => collectProvenance(seams({ ezioRoot: null }))).toThrow(/ezio checkout/);
	});

	it("fails loudly when the ezio package.json is unreadable", () => {
		const p = seams({
			readJson: (path: string) => {
				if (path.includes("ai-ezio")) throw new Error("ENOENT");
				return { name: "ai-whisper", version: "0.5.6" };
			},
		});
		expect(() => collectProvenance(p)).toThrow(/unreadable/);
	});
});

describe("findEzioRoot", () => {
	it("resolves the sibling ../ai-ezio when its cli package.json exists", () => {
		const seen: string[] = [];
		const root = findEzioRoot({
			pkgRoot: "/Users/me/Dev/ai-whisper/packages/cli",
			fileExists: (p: string) => {
				seen.push(p);
				return p === "/Users/me/Dev/ai-ezio/packages/cli/package.json";
			},
		});
		expect(root).toBe("/Users/me/Dev/ai-ezio");
		expect(seen).toContain("/Users/me/Dev/ai-ezio/packages/cli/package.json");
	});

	it("returns null when the sibling checkout is absent (→ fail loudly upstream)", () => {
		const root = findEzioRoot({
			pkgRoot: "/Users/me/Dev/ai-whisper/packages/cli",
			fileExists: () => false,
		});
		expect(root).toBeNull();
	});
});

describe("renderProvenanceModule", () => {
	it("emits an importable TS module with the stamped values", () => {
		const src = renderProvenanceModule({
			ezioCliVersion: "0.2.0-beta.1",
			ezioGitSha: "abc1234",
			builtAt: "2026-06-11T00:00:00.000Z",
			whisperVersion: "0.5.6",
		});
		expect(src).toContain('import type { EzioProvenance } from "../ezio-provenance-types.js";');
		expect(src).toContain('ezioCliVersion: "0.2.0-beta.1"');
		expect(src).toContain('whisperVersion: "0.5.6"');
		expect(src).toContain("export const EZIO_PROVENANCE: EzioProvenance =");
	});
});
