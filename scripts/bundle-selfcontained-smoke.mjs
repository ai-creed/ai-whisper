#!/usr/bin/env node
// Bundle self-containment smoke test. Proves the published artifact resolves
// every inlined/externalized dependency from the tarball alone — no workspace
// symlinks, no `@ai-ezio/*` file: deps in scope. Catches the ERR_MODULE_NOT_FOUND
// class of bug (e.g. an externalized `marked` not declared in CLI dependencies).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliRoot = join(process.cwd(), "packages/cli");
const tmp = mkdtempSync(join(tmpdir(), "whisper-pack-smoke-"));

const run = (cmd, args, cwd) =>
	execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

try {
	// 1) Build then pack the CLI package into the temp dir.
	run("npm", ["pack", "--pack-destination", tmp], cliRoot);
	const tarball = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
	if (!tarball) throw new Error("npm pack produced no tarball");

	// 2) Install the tarball into a clean project (no workspace, no @ai-ezio symlinks).
	run("npm", ["init", "-y"], tmp);
	run("npm", ["install", join(tmp, tarball)], tmp);

	// 3) Run the published bin — must not throw ERR_MODULE_NOT_FOUND.
	const binPath = join(tmp, "node_modules", ".bin", "whisper");
	const out = run(binPath, ["--version"], tmp);
	if (!out.trim()) throw new Error("whisper --version produced no output");

	console.log(`OK: bundle self-contained — whisper --version => ${out.trim()}`);
} catch (err) {
	console.error("FAIL: bundle is not self-contained\n" + (err.stderr || err.message || String(err)));
	process.exitCode = 1;
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
