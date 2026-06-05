#!/usr/bin/env node
// Deterministic stand-in for the `claude` model binary, wired via
// AI_WHISPER_CLAUDE_CMD in the M6 full-workflow e2e. The REAL claude mount path
// runs (`whisper collab mount claude` spawns this in a PTY); only the model is
// mocked, mirroring HAX_PROVIDER=mock for ezio. It stays alive so the mounted
// session persists and the claude binding registers, and — if it ever receives
// input — emits a mockProviderReplySchema-shaped JSON reply that approves the
// current step. In the e2e the agent is kept passive via a long idle threshold,
// so phase advancement comes from injected evaluator verdicts; this reply is a
// safety net, not the drive path.
process.stdout.write("ai-whisper claude e2e model stub ready\n");

process.stdin.resume();
process.stdin.on("data", () => {
	process.stdout.write(
		JSON.stringify({ kind: "review", content: "LGTM", transitionIntent: "completed" }) + "\n",
	);
});

const exit = () => process.exit(0);
process.on("SIGTERM", exit);
process.on("SIGINT", exit);

// Keep the process alive indefinitely (until the mount kills it).
setInterval(() => {}, 1 << 30);
