// test/eval-pair-driver.test.ts
// Requires `pnpm build`: the fake whisper imports the built broker (packages/broker/dist/index.js).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SOCKET_PATH, computePairCost, runPairArm, turnEventSocketPathLength } from "../eval/runner/arms/pair.ts";
import type { TaskMeta } from "../eval/runner/types.ts";

const task: TaskMeta = { slug: "t", category: "feature", shape: "quick-task", dir: "/t", title: "T", taskSection: "do", scopeBullets: ["src/a.ts"], acceptanceSection: "- ok", approach: "plan", budget: { wallClockSeconds: 30, tokenCap: 1_000_000 } };
const repoRoot = join(import.meta.dirname, "..");

/**
 * Fake `whisper`: `collab mount <agent>` seeds the collab + binding rows into
 * AI_WHISPER_STATE_ROOT/state.db using the real broker migrations (storing the
 * realpath of --workspace as the real mount does), refreshes the
 * daemon heartbeat every 5 s, and stays alive; `workflow start` inserts a workflow
 * row with the status given by FAKE_WF_STATUS (plus, with FAKE_WF_ESCALATED_PHASE=1, an
 * escalated phase and chain as the broker's escalate path writes them) and prints the
 * real "Workflow started:" line (FAKE_WF_NO_ROW=1 prints the line but writes no row); anything with `stop` in argv exits 0 immediately.
 */
function fakeWhisper(dir: string): string {
	const p = join(dir, "fake-whisper.mjs");
	writeFileSync(p, `#!/usr/bin/env node
import { openDatabase, applyMigrations } from ${JSON.stringify(join(repoRoot, "packages/broker/dist/index.js"))};
import { realpathSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("stop")) process.exit(0);
const [cmd, sub, agent] = process.argv.slice(2);
const root = process.env.AI_WHISPER_STATE_ROOT;
const dbPath = join(root, "state.db");
const db = openDatabase(dbPath); applyMigrations(db);
const t = new Date().toISOString();
const ws = process.argv[process.argv.indexOf("--workspace") + 1] ?? process.cwd();
if (cmd === "collab" && sub === "mount") {
  db.prepare("INSERT OR IGNORE INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES ('c1', ?, 'ws', 'active', ?, ?)").run(realpathSync(ws), t, t);
  db.prepare("INSERT OR REPLACE INTO broker_daemon (collab_id, host, port, pid, started_at, last_heartbeat_at) VALUES ('c1','127.0.0.1',1,1,?,?)").run(t, t);
  db.prepare("INSERT OR REPLACE INTO session_binding (collab_id, agent_type, binding_state, updated_at) VALUES ('c1', ?, 'bound', ?)").run(agent, t);
  db.close(); process.stdin.resume();
  setInterval(() => { const d = openDatabase(dbPath); d.prepare("UPDATE broker_daemon SET last_heartbeat_at = ?").run(new Date().toISOString()); d.close(); }, 5000);
  process.on("SIGTERM", () => process.exit(0));
  if (process.env.FAKE_MOUNT_EXIT === "1") setTimeout(() => process.exit(1), 300); // the mount crashes after binding
} else if (cmd === "workflow" && sub === "start" && process.env.FAKE_WF_NO_ROW === "1") {
  db.close(); console.log("Workflow started: wf_1");
} else if (cmd === "workflow" && sub === "start") {
  db.prepare("INSERT INTO workflows (workflow_id, collab_id, workflow_type, spec_path, role_bindings, status, current_phase_index, halt_reason, workflow_context, created_at, updated_at) VALUES ('wf_1','c1','quick-task','x','{}',?,0,?, '{}', ?, ?)")
    .run(process.env.FAKE_WF_STATUS ?? "done", process.env.FAKE_WF_HALT ?? null, t, t);
  if (process.env.FAKE_WF_ESCALATED_PHASE === "1") {
    db.prepare("INSERT INTO relay_chains (chain_id, collab_id, status, current_round, max_rounds, created_at, updated_at) VALUES ('ch_1','c1','escalated',2,5,?,?)").run(t, t);
    db.prepare("INSERT INTO workflow_phases (phase_run_id, workflow_id, phase_index, phase_name, chain_id, started_at, ended_at, outcome) VALUES ('p_1','wf_1',0,'implement-and-review','ch_1',?,?,'escalated')").run(t, t);
  }
  db.close(); console.log("Workflow started: wf_1");
} else { db.close(); }
`);
	chmodSync(p, 0o755);
	return p;
}

describe("computePairCost", () => {
	const u = (inp: number, out: number) => ({ inputTokens: inp, outputTokens: out, cacheWriteTokens: 0, cacheReadTokens: 0 });
	const pricing = { impl: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }, rev: { input: 2, cacheWrite: 2, cacheRead: 2, output: 2 }, "claude-haiku-4-5-20251001": { input: 10, cacheWrite: 10, cacheRead: 10, output: 10 }, "gpt-5-mini": { input: 100, cacheWrite: 100, cacheRead: 100, output: 100 } };
	it("prices primary and fallback evaluator usage at their own models", () => {
		const cost = computePairCost({ claude: u(1_000_000, 0), codex: u(1_000_000, 0), evaluatorPrimary: u(1_000_000, 0), evaluatorFallback: u(1_000_000, 0), implementerModel: "impl", reviewerModel: "rev", evaluator: { provider: "anthropic", model: null, fallbackProvider: "openai", fallbackModel: "gpt-5-mini" }, pricing });
		expect(cost).toBeCloseTo(1 + 2 + 10 + 100, 6);
	});
	it("withholds cost when the fallback served tokens but its model is unknown", () => {
		expect(computePairCost({ claude: u(1, 0), codex: u(1, 0), evaluatorPrimary: u(1, 0), evaluatorFallback: u(1, 0), implementerModel: "impl", reviewerModel: "rev", evaluator: { provider: "anthropic", model: null, fallbackProvider: "ollama", fallbackModel: null }, pricing })).toBeNull();
	});
	it("ignores an unused fallback (zero tokens) even when its model is unpriceable", () => {
		expect(computePairCost({ claude: u(1, 0), codex: u(1, 0), evaluatorPrimary: u(1, 0), evaluatorFallback: u(0, 0), implementerModel: "impl", reviewerModel: "rev", evaluator: { provider: "anthropic", model: null, fallbackProvider: "ollama", fallbackModel: null }, pricing })).not.toBeNull();
	});
});

describe("runPairArm", () => {
	let root: string;
	// State roots must be SHORT: the real mount listens on a Unix socket under them and macOS caps socket paths at
	// 104 bytes, which the driver now enforces — so the tests cannot put them under the (long) macOS tmpdir.
	const stateDirs: string[] = [];
	const shortStateRoot = (): string => { const d = mkdtempSync("/tmp/aiwe-"); stateDirs.push(d); return join(d, "state"); };
	afterEach(() => { rmSync(root, { recursive: true, force: true }); for (const d of stateDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

	it("mounts, starts, detects done, and records an estimated-usage row when no transcripts exist", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-pair-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const out = await runPairArm({ task, workspaceDir: ws, runDir: join(root, "run"), stateRoot: shortStateRoot(), trustConfig: { claudeJson: join(root, ".claude.json"), codexToml: join(root, "codex.toml") }, implementerModel: "m-impl", reviewerModel: "m-rev", evaluatorSnapshot: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, sourceStateRoot: join(root, "no-such"), whisperCli: fakeWhisper(root), pollMs: 100, homeDir: join(root, "home"), pricing: {} });
		expect(out.stopReason).toBe("completed");
		expect(out.tokenSource).toBe("estimated");
		expect(out.costUsd).toBeNull();
		expect(out.reviewerModel).toBe("m-rev");
		expect(out.evaluator).toEqual({ provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null, fallbackUsed: false });
		expect(existsSync(join(stateDirs[0] as string, "state", "state.db"))).toBe(true);
		// trust was granted for the mount and released afterwards (never left in the operator's configs)
		expect(readFileSync(join(root, ".claude.json"), "utf8")).not.toContain(ws);
		expect(readFileSync(join(root, "codex.toml"), "utf8")).not.toContain(ws); // the run's AI_WHISPER_STATE_ROOT is the external sibling, not under eval/results
	}, 30_000);

	it("finds the collab when the workspace path is a symlink alias (the real mount stores the realpath)", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-pair-"));
		mkdirSync(join(root, "real-ws"));
		symlinkSync(join(root, "real-ws"), join(root, "ws-alias"), "dir");
		const out = await runPairArm({ task, workspaceDir: join(root, "ws-alias"), runDir: join(root, "run"), stateRoot: shortStateRoot(), trustConfig: { claudeJson: join(root, ".claude.json"), codexToml: join(root, "codex.toml") }, implementerModel: "m", reviewerModel: "r", evaluatorSnapshot: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, sourceStateRoot: root, whisperCli: fakeWhisper(root), pollMs: 100, homeDir: root, pricing: {} });
		expect(out.stopReason).toBe("completed");
		expect(out.workspaceDir).toBe(join(root, "ws-alias"));
	}, 30_000);

	it("refuses a state root inside the repository, including through a symlink alias", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-pair-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const base = { task, workspaceDir: ws, runDir: join(root, "run"), implementerModel: "m", reviewerModel: "r", evaluatorSnapshot: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, sourceStateRoot: root, whisperCli: fakeWhisper(root), homeDir: root, pricing: {}, trustConfig: { claudeJson: join(root, ".claude.json"), codexToml: join(root, "codex.toml") } };
		await expect(runPairArm({ ...base, stateRoot: join(repoRoot, "eval", "results", "x", "state") })).rejects.toThrow(/outside the repository/);
		symlinkSync(join(repoRoot, "eval"), join(root, "alias"), "dir");
		await expect(runPairArm({ ...base, stateRoot: join(root, "alias", "results", "x", "state") })).rejects.toThrow(/outside the repository/);
	});

	it("a mount that dies after binding is a mount_exited product failure, not a cap stop", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-pair-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const out = await runPairArm({ task, workspaceDir: ws, runDir: join(root, "run"), stateRoot: shortStateRoot(), trustConfig: { claudeJson: join(root, ".claude.json"), codexToml: join(root, "codex.toml") }, implementerModel: "m", reviewerModel: "r", evaluatorSnapshot: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, sourceStateRoot: root, whisperCli: fakeWhisper(root), env: { FAKE_MOUNT_EXIT: "1", FAKE_WF_STATUS: "running" }, pollMs: 100, homeDir: root, pricing: {} });
		expect(out.stopReason).toBe("agent_failure");
		expect(out.failureMode).toBe("mount_exited");
		expect(out.seconds).toBeLessThan(20);
	}, 30_000);

	it("refuses a state root whose turn-event socket path would exceed the macOS limit", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-pair-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const longRoot = join(root, "a".repeat(80), "b".repeat(40));
		expect(turnEventSocketPathLength(longRoot)).toBeGreaterThan(MAX_SOCKET_PATH);
		await expect(runPairArm({ task, workspaceDir: ws, runDir: join(root, "run"), stateRoot: longRoot, trustConfig: { claudeJson: join(root, ".claude.json"), codexToml: join(root, "codex.toml") }, implementerModel: "m", reviewerModel: "r", evaluatorSnapshot: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, sourceStateRoot: root, whisperCli: fakeWhisper(root), homeDir: root, pricing: {} })).rejects.toThrow(/socket path/);
	});

	it("classifies a max-rounds halt as escalated", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-pair-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const out = await runPairArm({ task, workspaceDir: ws, runDir: join(root, "run"), stateRoot: shortStateRoot(), trustConfig: { claudeJson: join(root, ".claude.json"), codexToml: join(root, "codex.toml") }, implementerModel: "m", reviewerModel: "r", evaluatorSnapshot: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, sourceStateRoot: root, whisperCli: fakeWhisper(root), env: { FAKE_WF_STATUS: "halted", FAKE_WF_HALT: "max-rounds-reached (5/5)" }, pollMs: 100, homeDir: root, pricing: {} });
		expect(out.stopReason).toBe("escalated");
		expect(out.escalated).toBe(true);
	}, 30_000);

	it("classifies an evaluator escalation as escalated from structured state, whatever the halt reason text", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-pair-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const out = await runPairArm({ task, workspaceDir: ws, runDir: join(root, "run"), stateRoot: shortStateRoot(), trustConfig: { claudeJson: join(root, ".claude.json"), codexToml: join(root, "codex.toml") }, implementerModel: "m", reviewerModel: "r", evaluatorSnapshot: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, sourceStateRoot: root, whisperCli: fakeWhisper(root), env: { FAKE_WF_STATUS: "halted", FAKE_WF_HALT: "low-confidence: reviewer verdict unclear", FAKE_WF_ESCALATED_PHASE: "1" }, pollMs: 100, homeDir: root, pricing: {} });
		expect(out.stopReason).toBe("escalated");
		expect(out.escalated).toBe(true);
		expect(out.failureMode).toBeNull();
	}, 30_000);

	it("gives up on a workflow row that never appears as collab_missing, well before the wall clock", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-pair-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const out = await runPairArm({ task: { ...task, budget: { ...task.budget, wallClockSeconds: 30 } }, workspaceDir: ws, runDir: join(root, "run"), stateRoot: shortStateRoot(), trustConfig: { claudeJson: join(root, ".claude.json"), codexToml: join(root, "codex.toml") }, implementerModel: "m", reviewerModel: "r", evaluatorSnapshot: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, sourceStateRoot: root, whisperCli: fakeWhisper(root), env: { FAKE_WF_NO_ROW: "1" }, pollMs: 50, homeDir: root, pricing: {} });
		expect(out.stopReason).toBe("agent_failure");
		expect(out.failureMode).toBe("collab_missing");
		expect(out.seconds).toBeLessThan(15);
	}, 40_000);

	it("reports mount_bind_timeout as an unsuccessful run, not a harness failure", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-pair-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const never = join(root, "never.mjs");
		writeFileSync(never, "#!/usr/bin/env node\nif (process.argv.includes(\"stop\")) process.exit(0);\nprocess.stdin.resume(); setInterval(() => {}, 1e9);\n"); chmodSync(never, 0o755);
		const out = await runPairArm({ task, workspaceDir: ws, runDir: join(root, "run"), stateRoot: shortStateRoot(), trustConfig: { claudeJson: join(root, ".claude.json"), codexToml: join(root, "codex.toml") }, implementerModel: "m", reviewerModel: "r", evaluatorSnapshot: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, sourceStateRoot: root, whisperCli: never, pollMs: 100, bindTimeoutMs: 1500, homeDir: root, pricing: {} });
		expect(out.stopReason).toBe("agent_failure");
		expect(out.failureMode).toBe("mount_bind_timeout");
	}, 30_000);
});
