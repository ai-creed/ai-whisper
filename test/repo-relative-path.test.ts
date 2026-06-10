import { describe, expect, it } from "vitest";
import { displayArtifactPath, repoRelativePath } from "@ai-whisper/shared";

describe("repoRelativePath", () => {
	it("returns the path relative to root when the path is under root", () => {
		expect(repoRelativePath("/repo/docs/specs/foo-design.md", "/repo")).toBe(
			"docs/specs/foo-design.md",
		);
	});

	it("returns the absolute path unchanged when it is outside root", () => {
		expect(repoRelativePath("/elsewhere/bar.md", "/repo")).toBe("/elsewhere/bar.md");
	});

	it("does not strip a sibling directory that merely shares a name prefix", () => {
		// /repo2 is NOT under /repo — must stay unchanged (path-boundary safe).
		expect(repoRelativePath("/repo2/x.md", "/repo")).toBe("/repo2/x.md");
	});

	it("returns empty string for empty input", () => {
		expect(repoRelativePath("", "/repo")).toBe("");
	});

	it("returns a relative (non-absolute) input unchanged", () => {
		expect(repoRelativePath("docs/foo.md", "/repo")).toBe("docs/foo.md");
	});

	it("returns the path unchanged when root is empty", () => {
		expect(repoRelativePath("/repo/docs/foo.md", "")).toBe("/repo/docs/foo.md");
	});
});

describe("displayArtifactPath", () => {
	it("returns the repo-relative path when the path is under root", () => {
		expect(displayArtifactPath("/repo/docs/specs/foo-design.md", "/repo")).toBe(
			"docs/specs/foo-design.md",
		);
	});

	it("returns the absolute path when outside root", () => {
		expect(displayArtifactPath("/elsewhere/bar.md", "/repo")).toBe("/elsewhere/bar.md");
	});

	it("returns null for an empty path (so callers omit the artifact segment)", () => {
		expect(displayArtifactPath("", "/repo")).toBeNull();
	});

	it("returns null for a whitespace-only path (omit, do not render an empty arrow)", () => {
		expect(displayArtifactPath("   ", "/repo")).toBeNull();
	});
});
