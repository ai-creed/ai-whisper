import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertOutsideRepo, isInside, physicalPath } from "../eval/runner/paths.ts";

describe("physical-path containment", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("physicalPath resolves symlinks in existing ancestors and keeps the non-existent tail", () => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "eval-paths-")));
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(root, "alias"), "dir");
		expect(physicalPath(join(root, "alias", "not", "yet", "created"))).toBe(join(root, "real", "not", "yet", "created"));
		expect(isInside(join(root, "alias", "x"), join(root, "real"))).toBe(true);
		expect(isInside(join(root, "real-sibling"), join(root, "real"))).toBe(false); // prefix must end at a separator
	});

	it("symlink alias regression: a workspace root aliased INTO the repo is refused", () => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "eval-paths-")));
		const repo = join(root, "repo"); mkdirSync(join(repo, "eval", "tasks"), { recursive: true });
		symlinkSync(join(repo, "eval"), join(root, "ws-alias"), "dir"); // looks external, physically inside the repo
		expect(() => assertOutsideRepo("workspace", join(root, "ws-alias", "c", "t", "A", "1"), repo)).toThrow(/workspace must live outside the repository/);
	});

	it("symlink alias regression: the repo given through an alias still contains its physical children", () => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "eval-paths-")));
		const repo = join(root, "repo"); mkdirSync(repo);
		symlinkSync(repo, join(root, "repo-alias"), "dir");
		expect(() => assertOutsideRepo("toolchain", join(repo, "eval", "toolchain"), join(root, "repo-alias"))).toThrow(/toolchain must live outside the repository/);
		expect(() => assertOutsideRepo("toolchain", join(root, "elsewhere"), join(root, "repo-alias"))).not.toThrow();
	});

	it("is a guard only: callers keep the path they passed even when it is an alias", () => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "eval-paths-")));
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(root, "alias"), "dir");
		const given = join(root, "alias", "ws");
		expect(assertOutsideRepo("workspace", given, join(root, "repo"))).toBeUndefined();
		expect(physicalPath(given)).not.toBe(given); // the guard compared the realpath, but did not hand it back
	});
});
