// Gated real-codex turn-event e2e — the real-binary leg the deterministic
// vitest smoke (test/codex-turn-event-smoke.test.ts) cannot cover: does the REAL
// codex binary, launched through our mount with the default-on `-c notify=[...]`
// injection, actually fire `notify` on a completed turn and reach our shim/socket?
//
// It launches a real `whisper collab mount codex` in a PTY, types one trivial
// prompt, and waits for the shim's arrival log to record a codex event that
// CONNECTED to the mount socket (connect: "ok") — proof that real notify fired
// and was delivered to us. If a workflow were active it would also write a
// relay_turn_event_diagnostics row; with no workflow the row is
// `ignored_no_workflow`, which we additionally check best-effort.
//
// This is NONDETERMINISTIC and environment-dependent (needs an installed +
// AUTHED codex), so it AUTO-SKIPS (exit 0) when codex isn't on PATH or the CLI
// isn't built. Run it manually: `pnpm e2e:codex-events`. Knobs:
//   CODEX_WARMUP_MS  (default 9000) — boot/auth time before typing the prompt
//   CODEX_DEADLINE_MS(default 90000) — max wait for the codex event to arrive
import process from "node:process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as pty from "node-pty";

const CLI = join(process.cwd(), "packages/cli/dist/bin/whisper.js");
const WARMUP_MS = Number(process.env.CODEX_WARMUP_MS ?? 9000);
const DEADLINE_MS = Number(process.env.CODEX_DEADLINE_MS ?? 90000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function skip(reason) {
	console.log(`SKIP: ${reason}`);
	console.log(
		"      (Run the deterministic chain smoke instead: `npx vitest run test/codex-turn-event-smoke.test.ts`.)",
	);
	process.exit(0);
}

// --- Preconditions: auto-skip rather than fail when the env can't run this. ---
const codexOnPath =
	spawnSync(process.platform === "win32" ? "where" : "command", ["-v", "codex"], {
		encoding: "utf8",
		shell: true,
	}).status === 0;
if (!codexOnPath) skip("codex is not on PATH (install + auth codex to run the real-binary leg)");
if (!existsSync(CLI)) skip(`CLI not built at ${CLI} — run \`pnpm build\` first`);

// --- One temp dir is BOTH the workspace (collab key) and the state root. ---
const root = mkdtempSync(join(tmpdir(), "aiwcx-e2e-"));
process.env.AI_WHISPER_STATE_ROOT = root;
const today = new Date().toISOString().slice(0, 10);
const arrivalLog = join(root, "logs", `turn-events-${today}.jsonl`);

const sh = (args) =>
	spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: process.env });

// Turn-events default ON (this is the whole point) → the mount injects
// `-c notify=[shim ...]` for codex and starts the codex socket listener.
// Codex runs in full-autonomy so approval prompts never block the turn.
const mount = pty.spawn(
	process.execPath,
	[CLI, "collab", "mount", "codex", "--", "--dangerously-bypass-approvals-and-sandbox"],
	{ name: "xterm-color", cwd: root, cols: 100, rows: 30, env: process.env },
);
let mountLog = "";
mount.onData((d) => {
	mountLog += d;
});

const cleanup = () => {
	// NEVER send Ctrl-C to an idle codex — it exits the session (and would orphan
	// the mount). Kill the PTY and stop the collab directly.
	try {
		mount.kill();
	} catch {}
	try {
		sh(["collab", "stop"]);
	} catch {}
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {}
};

function fail(msg) {
	console.error(`FAIL: ${msg}\n--- mount pane tail ---\n${mountLog.slice(-2500)}`);
	cleanup();
	process.exit(1);
}

// Confirm the mount actually enabled the codex event path (default-on wiring).
// Strip ALL whitespace before matching: the startup line is rendered into a
// fixed-width PTY and can wrap mid-token ("codex=O\nN"), so a literal
// newline-sensitive match would false-negative on a line it actually contains.
function startupLineShowsCodexOn() {
	return mountLog.replace(/\s+/g, "").toLowerCase().includes("codex=on");
}

// A codex arrival-log line that CONNECTED to the mount socket is the real-binary
// proof: notify fired and reached us.
function codexEventConnected() {
	if (!existsSync(arrivalLog)) return false;
	for (const line of readFileSync(arrivalLog, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (e.provider === "codex" && e.connect === "ok") return true;
		} catch {}
	}
	return false;
}

// Best-effort: a codex row in the diagnostics table proves the listener received
// + normalized the event too. With no workflow active the action is
// `ignored_no_workflow`. Uses the sqlite3 CLI if present; non-fatal if absent.
function codexDiagnosticsRow() {
	const out = spawnSync(
		"sqlite3",
		[
			join(root, "state.db"),
			"SELECT action FROM relay_turn_event_diagnostics WHERE provider='codex' LIMIT 1;",
		],
		{ encoding: "utf8" },
	);
	return out.status === 0 ? out.stdout.trim() : "";
}

try {
	// 1) Let codex boot + authenticate, then confirm the event path is on.
	await sleep(WARMUP_MS);
	if (!startupLineShowsCodexOn()) {
		fail("mount startup line never reported codex=ON (default-on event wiring did not engage)");
	}
	console.log("OK: mount launched codex with the event path ON (codex=ON in startup line)");

	// 2) Submit ONE trivial prompt. Typing text then Enter (\r) submits in the
	//    codex TUI — NOT Ctrl-C.
	mount.write("Reply with exactly the single word READY and nothing else.");
	await sleep(400);
	mount.write("\r");

	// 3) Wait for the real codex notify → shim → mount socket.
	const deadline = Date.now() + DEADLINE_MS;
	let connected = false;
	while (Date.now() < deadline) {
		if (codexEventConnected()) {
			connected = true;
			break;
		}
		await sleep(750);
	}
	if (!connected) {
		fail(
			`no codex turn-event reached the mount socket within ${DEADLINE_MS}ms ` +
				`(arrival log ${existsSync(arrivalLog) ? "exists but has no connected codex line" : "was never written"}). ` +
				"Is codex authed and able to complete a turn?",
		);
	}
	console.log("OK: real codex `notify` fired and CONNECTED to the mount socket (arrival log: provider=codex connect=ok)");

	const row = codexDiagnosticsRow();
	if (row) {
		console.log(`OK: listener recorded a codex relay_turn_event_diagnostics row (action=${row})`);
	} else {
		console.log("NOTE: no codex diagnostics row read (sqlite3 absent, or row not yet flushed) — arrival-log proof stands");
	}

	console.log("PASS: real codex turn-event path verified end-to-end");
	cleanup();
	process.exit(0);
} catch (err) {
	fail(`unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
}
