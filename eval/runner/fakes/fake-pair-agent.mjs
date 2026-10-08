#!/usr/bin/env node
// Passive stand-in for the mounted `claude` / `codex` binaries in dry runs
// (same shape as scripts/e2e/fake-claude-model.mjs): stays alive so the mount
// binds, never drives the workflow — injected evaluator verdicts do.
process.stdout.write("ai-whisper eval dry-run agent stub ready\n");
process.stdin.resume();
process.stdin.on("data", () => {
	process.stdout.write(JSON.stringify({ kind: "review", content: "LGTM", transitionIntent: "completed" }) + "\n");
});
const exit = () => process.exit(0);
process.on("SIGTERM", exit);
process.on("SIGINT", exit);
setInterval(() => {}, 1 << 30);
