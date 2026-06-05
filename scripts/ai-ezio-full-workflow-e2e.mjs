import process from "node:process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as pty from "node-pty";
import { createBrokerRuntime } from "@ai-whisper/broker";

// M6 full-workflow e2e: a complete spec-driven-development workflow run to the
// terminal `done` state with ezio as implementer and claude as reviewer, over the
// REAL stack — real `whisper collab mount ezio` (real hax engine) AND real
// `whisper collab mount claude` (real claude mount path, model stubbed), the real
// broker runtime, the real workflow driver / relay state machine / control
// service, and the real `whisper workflow start` CLI (real role resolution).
//
// What is mocked: only the LLMs. ezio's model is HAX_PROVIDER=mock; claude's model
// is a deterministic stub wired via AI_WHISPER_CLAUDE_CMD (scripts/e2e/fake-claude-model.mjs);
// the evaluator LLM is replaced by deterministic injected verdicts via the real
// applyOrchestratorVerdict control method (the same mechanism the broker's own
// integration tests use to drive a workflow). Both agents are mounted with a long
// idle threshold so they stay passive — the injected evaluator verdicts are the
// sole, deterministic phase-advancement authority. (The real ezio PTY protocol
// round-trip itself is additionally covered by e2e:ai-ezio-mount.)

const root = mkdtempSync(join(tmpdir(), "ai-ezio-wf-e2e-"));
process.env.AI_WHISPER_STATE_ROOT = root;
const sqlitePath = join(root, "state.db");

const CLI = join(process.cwd(), "packages/cli/dist/bin/whisper.js");
const HAX_BIN = join(process.cwd(), "../ai-ezio/vendor/hax/build/hax");

const childEnv = {
	...process.env,
	HAX_PROVIDER: "mock",
	AI_EZIO_HAX_BIN: HAX_BIN,
	// The orchestrator must be enabled for createWorkflow, and the start preflight
	// requires a configured evaluator — but the evaluator LLM only fires on an
	// agent handback. A dummy key satisfies the preflight; it is never used because
	// both agents stay passive (long idle threshold), so nothing hands back. Phase
	// advancement comes solely from the injected verdicts below.
	ANTHROPIC_API_KEY: "sk-ant-e2e-dummy-unused-key",
	// claude's model is stubbed (real claude mount path, mocked model).
	AI_WHISPER_CLAUDE_CMD: join(process.cwd(), "scripts/e2e/fake-claude-model.mjs"),
	// Keep the mounted agents passive so they do not auto-accept/handback during
	// the window — injected verdicts are the deterministic advancement authority.
	AI_WHISPER_IDLE_THRESHOLD_MS: "600000",
};
chmodSync(join(process.cwd(), "scripts/e2e/fake-claude-model.mjs"), 0o755);

const sh = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: childEnv });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// 1) Spawn the REAL `whisper collab mount ezio` (auto-creates the collab + daemon
//    and registers the ezio binding through the real schemas).
const mount = pty.spawn(process.execPath, [CLI, "collab", "mount", "ezio"], {
	name: "xterm-color", cwd: root, cols: 100, rows: 30, env: childEnv,
});
let mountLog = "";
mount.onData((d) => { mountLog += d; });

// The REAL `whisper collab mount claude` is spawned later (step 1b), AFTER the
// ezio mount has created the collab + daemon, to avoid a no-live-daemon race.
let claudeMount = null;
let claudeLog = "";

const cleanup = () => {
	try { mount.kill(); } catch {}
	try { claudeMount?.kill(); } catch {}
	try { sh(["collab", "stop"]); } catch {}
	try { rmSync(root, { recursive: true, force: true }); } catch {}
};
const fail = (msg) => { cleanup(); console.error("FAIL: " + msg + "\n--- ezio mount log tail ---\n" + mountLog.slice(-2000) + "\n--- claude mount log tail ---\n" + claudeLog.slice(-2000)); process.exit(1); };

// 2) Wait for the collab + daemon, then attach a passive observer broker on the
//    daemon's shared DB.
let collabId = null;
let daemon = null;
for (let deadline = Date.now() + 30_000; Date.now() < deadline && !daemon; await sleep(300)) {
	try {
		const s = JSON.parse(sh(["collab", "status", "--json"]).stdout ?? "");
		if (s.collabId && s.daemon && s.daemon.port) { collabId = s.collabId; daemon = s.daemon; }
	} catch {}
}
if (!daemon) fail("mount never started a collab/daemon");

const broker = createBrokerRuntime({
	sqlitePath,
	host: daemon.host ?? "127.0.0.1", port: daemon.port,
	runWorkflowDriver: false, runDiagnosticsSweep: false,
	runDaemonHeartbeat: false, runBrokerDaemonSweep: false,
});

// 3) Wait for the real ezio binding to register.
let ezioBound = false;
for (let deadline = Date.now() + 15_000; Date.now() < deadline && !ezioBound; await sleep(300)) {
	try { ezioBound = broker.control.listSessionBindings(collabId).some((b) => b.agentType === "ezio" && b.bindingState === "bound"); } catch {}
}
if (!ezioBound) fail("ezio never registered a bound binding via the real mount command");
console.log("OK: real `whisper collab mount ezio` bound ezio in", collabId);

// 1b) Now that the collab + daemon exist, spawn the REAL claude mount (same cwd
//     → same collab; its model is the AI_WHISPER_CLAUDE_CMD stub).
claudeMount = pty.spawn(process.execPath, [CLI, "collab", "mount", "claude"], {
	name: "xterm-color", cwd: root, cols: 100, rows: 30, env: childEnv,
});
claudeMount.onData((d) => { claudeLog += d; });

// 4) Wait for the real claude mount to bind (real mount path; stubbed model).
let claudeBound = false;
for (let deadline = Date.now() + 30_000; Date.now() < deadline && !claudeBound; await sleep(300)) {
	try { claudeBound = broker.control.listSessionBindings(collabId).some((b) => b.agentType === "claude" && b.bindingState === "bound"); } catch {}
}
if (!claudeBound) fail("claude never registered a bound binding via the real mount command");
console.log("OK: real `whisper collab mount claude` bound claude as reviewer");

// 5) Write a small spec and start the REAL workflow with ezio implementer + claude reviewer.
const specPath = join(root, "m6-e2e-spec.md");
writeFileSync(specPath, "# M6 e2e spec\n\nTrivial spec used to drive a full SDD run.\n\n- do the thing\n");
const start = sh(["workflow", "start", "--type=spec-driven-development", "--spec", specPath, "--implementer", "ezio", "--reviewer", "claude"]);
const m = /Workflow started: (wf_[a-z0-9]+)/.exec(start.stdout ?? "");
if (!m) fail("workflow start did not report a workflow id\nstdout: " + (start.stdout ?? "") + "\nstderr: " + (start.stderr ?? ""));
const workflowId = m[1];
console.log("OK: workflow started", workflowId);

// 6) Assert role bindings resolved to ezio/claude through the real CLI path.
const wf0 = broker.control.getWorkflow(workflowId);
if (!wf0 || wf0.roleBindings.implementer !== "ezio" || wf0.roleBindings.reviewer !== "claude") {
	fail("role bindings did not resolve to ezio/claude: " + JSON.stringify(wf0?.roleBindings));
}
console.log("OK: roleBindings = ezio implementer / claude reviewer");

// 7) Drive every phase to the terminal `done` state by injecting the evaluator
//    verdict for the current handoff step (the LLM evaluator is the mocked seam).
const STEP_VERDICT = { review: "approve", implement: "delivered", fix: "delivered", execute: "execution-pass" };
const applied = new Set();
let status = wf0.status;
for (let deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(300)) {
	const wf = broker.control.getWorkflow(workflowId);
	status = wf?.status;
	if (status === "done") break;
	if (status === "halted" || status === "canceled") fail(`workflow ${status}: ${wf?.haltReason ?? "(no reason)"}`);
	const row = broker.db
		.prepare("SELECT handoff_id, handoff_step FROM relay_handoff WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1")
		.get(workflowId);
	if (!row || applied.has(row.handoff_id)) continue;
	const verdict = STEP_VERDICT[row.handoff_step];
	if (!verdict) continue;
	applied.add(row.handoff_id);
	broker.control.applyOrchestratorVerdict({
		handoffId: row.handoff_id, verdict, confidence: 0.9, reason: "e2e-injected",
		workspaceHeadSha: "abc1234def5678", now: now(),
	});
}
if (status !== "done") fail(`workflow did not reach done (status=${status})`);
console.log("OK: workflow reached terminal status `done`");

// 8) Assert handoffs flowed in BOTH directions (ezio as sender and as target).
const handoffs = broker.db
	.prepare("SELECT sender_agent, target_agent FROM relay_handoff WHERE workflow_id = ?")
	.all(workflowId);
const ezioSent = handoffs.some((h) => h.sender_agent === "ezio");
const ezioTargeted = handoffs.some((h) => h.target_agent === "ezio");
if (!ezioSent || !ezioTargeted) {
	fail(`expected ezio as both sender and target; got ${JSON.stringify(handoffs)}`);
}
console.log("OK: bidirectional handoffs — ezio appears as both sender and target");

cleanup();
console.log("OK: M6 full spec-driven-development workflow completed with ezio implementer + claude reviewer");
process.exit(0);
