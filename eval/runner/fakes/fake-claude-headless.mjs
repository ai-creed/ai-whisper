#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` in dry runs: no API, no
// model. It consumes the prompt, leaves a visible edit + commit in the
// workspace, and emits the two stream events the runner relies on.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { prompt += d; });
process.stdin.on("end", () => {
	writeFileSync("prompt.txt", prompt);
	writeFileSync("DRY_RUN_TOUCHED", "dry run\n");
	try {
		execFileSync("git", ["-c", "user.name=dry-run", "-c", "user.email=dry-run@local", "add", "-A"], { stdio: "ignore" });
		execFileSync("git", ["-c", "user.name=dry-run", "-c", "user.email=dry-run@local", "commit", "-q", "-m", "dry-run"], { stdio: "ignore" });
	} catch { /* not a git repo — fine for unit use */ }
	process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 1234, output_tokens: 56, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + "\n");
	process.stdout.write(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 1234, output_tokens: 56, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) + "\n");
	process.exit(0);
});
