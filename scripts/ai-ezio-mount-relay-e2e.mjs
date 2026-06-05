import process from "node:process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as pty from "node-pty";
import { createBrokerRuntime } from "@ai-whisper/broker";

// One temp dir is BOTH the workspace (collab key) and the state root (DB home).
// getSharedSqlitePath()/getStateRoot() (packages/cli/src/runtime/state-root.ts)
// derive the DB from AI_WHISPER_STATE_ROOT, so set it for THIS process and every
// child; both the spawned mount and the observer broker then share state.db.
const root = mkdtempSync(join(tmpdir(), "ai-ezio-e2e-"));
process.env.AI_WHISPER_STATE_ROOT = root;
const sqlitePath = join(root, "state.db");

// M8: drive a DETERMINISTIC tool turn so we can assert the mounted pane renders a
// tool call (`⏺ bash`) and its output. The mock DSL replays one turn per stream()
// call; a tool user-turn spans two streams (the tool call, then a follow-up). echo
// emits a unique marker we can grep for in the pane AND the handback.
const TOOL_MARKER = "M8_TOOL_OUTPUT_MARKER";
const mockScriptPath = join(root, "mock-tool-turn.txt");
writeFileSync(
	mockScriptPath,
	`tool bash {"command":"echo ${TOOL_MARKER}"}\nend-turn\ntext Done\nend-turn\n`,
);

// The built CLI binary is dist/bin/whisper.js (esbuild bundle).
const CLI = join(process.cwd(), "packages/cli/dist/bin/whisper.js");
// The real hax engine built in the sibling ai-ezio repo (HAX_PROVIDER=mock makes
// the turn deterministic — no LLM round-trip).
const HAX_BIN = join(process.cwd(), "../ai-ezio/vendor/hax/build/hax");

const sh = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: process.env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const childEnv = {
	...process.env,
	HAX_PROVIDER: "mock",
	HAX_MOCK_SCRIPT: mockScriptPath,
	AI_EZIO_HAX_BIN: HAX_BIN,
	AI_WHISPER_IDLE_THRESHOLD_MS: "5000",
};

// 1) Spawn the REAL `whisper collab mount ezio` in a pty (real tty; the command
//    auto-spawns its broker daemon and registers the ai-ezio binding).
const mount = pty.spawn(process.execPath, [CLI, "collab", "mount", "ezio"], {
	name: "xterm-color", cwd: root, cols: 100, rows: 30, env: childEnv,
});
let mountLog = "";
mount.onData((d) => { mountLog += d; });

const cleanup = () => { try { mount.kill(); } catch {} try { sh(["collab", "stop"]); } catch {} try { rmSync(root, { recursive: true, force: true }); } catch {} };

const now = () => new Date().toISOString();

// 2) Wait until the mount auto-created the collab + daemon (status --json carries
//    collabId + daemon host/port). Mirror mount.ts: the observer broker attaches
//    to the SAME shared DB using the daemon's host/port (it does not bind a second
//    listener; the runX:false flags keep it passive).
let collabId = null;
let daemon = null;
for (let deadline = Date.now() + 30_000; Date.now() < deadline && !daemon; await sleep(300)) {
	try {
		const s = JSON.parse(sh(["collab", "status", "--json"]).stdout ?? "");
		if (s.collabId && s.daemon && s.daemon.port) { collabId = s.collabId; daemon = s.daemon; }
	} catch {}
}
if (!daemon) { cleanup(); console.error("FAIL: mount never started a collab/daemon\n" + mountLog.slice(-2000)); process.exit(1); }

const broker = createBrokerRuntime({
	sqlitePath,
	host: daemon.host ?? "127.0.0.1", port: daemon.port,
	runWorkflowDriver: false, runDiagnosticsSweep: false,
	runDaemonHeartbeat: false, runBrokerDaemonSweep: false,
});

// Confirm the ai-ezio binding registered through the real schemas (authoritative).
let registered = false;
for (let deadline = Date.now() + 15_000; Date.now() < deadline && !registered; await sleep(300)) {
	try { registered = broker.control.listSessionBindings(collabId).some((b) => b.agentType === "ezio"); } catch {}
}
if (!registered) { cleanup(); console.error("FAIL: ezio never registered a binding via the real mount command\n" + mountLog.slice(-2000)); process.exit(1); }
console.log("OK: real `whisper collab mount ezio` registered an ezio binding in", collabId);

// 3) Inject ONE relay handoff TARGETING ai-ezio. createRelayHandoff flips turn
//    ownership to the target (ai-ezio) so the mounted process sees it as pending;
//    @@directive delivery is M6.
broker.control.createRelayHandoff({
	handoffId: "handoff_e2e", collabId,
	senderAgent: "codex", targetAgent: "ezio",
	requestText: "Reply with the single word READY.", now: now(),
});

// 4) The mounted ai-ezio auto-accepts (idle timer ~5s), submits over the real
//    protocol, runs hax(mock), and hands back. handoffBackRelay marks the
//    ORIGINAL handoff (codex→ai-ezio) "handed_back" AND creates a new handoff
//    whose sender is ai-ezio. Either proves the protocol round trip.
let proof = null;
for (let deadline = Date.now() + 40_000; Date.now() < deadline && !proof; await sleep(300)) {
	const orig = broker.control.getRelayHandoff("handoff_e2e");
	if (orig && orig.status === "handed_back") { proof = { kind: "original-handed-back", status: orig.status }; break; }
	const fromAiEzio = broker.control.listRelayHandoffs(collabId, 30).find((h) => h.senderAgent === "ezio");
	if (fromAiEzio) { proof = { kind: "handback-from-ai-ezio", senderAgent: fromAiEzio.senderAgent, status: fromAiEzio.status }; break; }
}

if (!proof) { cleanup(); console.error("FAIL: no protocol handback recorded from ezio\n" + mountLog.slice(-2500)); process.exit(1); }
console.log("OK: real relay handoff handed back via protocol by ezio:", JSON.stringify(proof));

// M8: the mounted pane shows a REPL-like banner on ready (which uses hax's dim
// `›`: `ezio › provider · …`) AND a magenta `❯` prompt AFTER the driven turn —
// the banner and the prompt are now DISTINCT glyphs (M7 used `›` for both). So:
//   - the banner line still matches `ezio … ›`
//   - a `❯` prompt appears in the pane AFTER the banner line.
await sleep(500); // let the pty pane output flush
const bannerMatch = /ezio[^\n]*›[^\n]*\n/.exec(mountLog);
if (!bannerMatch) { cleanup(); console.error("FAIL: no banner line in mount pane\n" + mountLog.slice(-2500)); process.exit(1); }
const afterBanner = mountLog.slice(bannerMatch.index + bannerMatch[0].length);
if (!afterBanner.includes("❯")) {
	cleanup();
	console.error("FAIL: no post-turn `❯` prompt after the driven turn (banner-only)\n" + mountLog.slice(-2500));
	process.exit(1);
}
console.log("OK: banner on ready (›) + post-turn `❯` prompt rendered in the mounted ezio pane");

// M8 tool rendering: the driven tool turn must surface a tool-call marker (`⏺`)
// AND the tool's output (the echo marker) in the pane, proving tool_call_started/
// tool_call_finished flow from the hax dispatch seam through the mounted renderer.
if (!afterBanner.includes("⏺") || !afterBanner.includes(TOOL_MARKER)) {
	cleanup();
	console.error(`FAIL: tool call (⏺) and output (${TOOL_MARKER}) not rendered in the mounted ezio pane\n` + mountLog.slice(-2500));
	process.exit(1);
}
console.log(`OK: M8 tool call (⏺ bash) + output (${TOOL_MARKER}) rendered in the mounted ezio pane`);

cleanup();
process.exit(0);
