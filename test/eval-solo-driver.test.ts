// test/eval-solo-driver.test.ts
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSoloArm } from "../eval/runner/arms/solo.ts";
import { HarnessFailure, type TaskMeta } from "../eval/runner/types.ts";

const task = (over: Partial<TaskMeta["budget"]> = {}): TaskMeta => ({
	slug: "t", category: "feature", shape: "quick-task", dir: "/t", title: "T", taskSection: "do", scopeBullets: ["src/a.ts"],
	acceptanceSection: "- ok", approach: "plan", budget: { wallClockSeconds: 60, tokenCap: 1_000_000, ...over },
});

function fakeClaude(dir: string, script: string): string {
	const p = join(dir, "fake-claude.cjs"); // .cjs so the inline script may use require()
	writeFileSync(p, "#!/usr/bin/env node\n" + script);
	chmodSync(p, 0o755);
	return p;
}
const asst = (id: string, inp: number, out: number) => `JSON.stringify({type:"assistant",message:{id:"${id}",usage:{input_tokens:${inp},output_tokens:${out}}}})`;

describe("runSoloArm", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("completes on a success result, records metered usage and the result cost", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-solo-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const cmd = fakeClaude(root, `
let prompt = ""; process.stdin.on("data", (d) => prompt += d); process.stdin.on("end", () => {
  require("node:fs").writeFileSync("prompt.txt", prompt);
  console.log(JSON.stringify({type:"assistant",message:{id:"m1",usage:{input_tokens:100,output_tokens:10},content:[{type:"text",text:"FINDING: missing empty-input test"}]}}));
  console.log(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0.05,num_turns:1,result:"SELF-REVIEW CYCLE 1 COMPLETE: 1 findings",usage:{input_tokens:100,output_tokens:10}}));
});`);
		const out = await runSoloArm({ task: task(), arm: "B", workspaceDir: ws, runDir: join(root, "run"), implementerModel: "m", claudeCommand: cmd, pricing: {} });
		expect(out.stopReason).toBe("completed");
		expect(out.tokenSource).toBe("metered");
		expect(out.usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
		expect(out.costUsd).toBe(0.05);
		expect(out.reviewFindings).toBe(1);
		expect(out.rounds).toBe(1);
		expect(readFileSync(join(ws, "prompt.txt"), "utf8")).toContain("Self-review protocol");
		expect(existsSync(join(root, "run", "transcript.jsonl"))).toBe(true);
	});

	it("stops at the token cap from metered usage", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-solo-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const cmd = fakeClaude(root, `
process.stdin.resume();
let i = 0; const t = setInterval(() => { console.log(${asst('"+(i++)+"', 400, 100)}); }, 20);
process.on("SIGTERM", () => { clearInterval(t); process.exit(143); });`);
		const out = await runSoloArm({ task: task({ tokenCap: 1200 }), arm: "A", workspaceDir: ws, runDir: join(root, "run"), implementerModel: "m", claudeCommand: cmd, pricing: { m: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 } } });
		expect(out.stopReason).toBe("token_cap");
		expect(out.stopSource).toBe("metered");
		expect(out.usage.inputTokens + out.usage.outputTokens).toBeGreaterThan(1200);
		expect(out.costUsd).not.toBeNull();
	});

	it("stops at the wall-clock cap", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-solo-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const cmd = fakeClaude(root, "process.stdin.resume(); setInterval(() => {}, 1000); process.on(\"SIGTERM\", () => process.exit(143));");
		const out = await runSoloArm({ task: task({ wallClockSeconds: 1 }), arm: "A", workspaceDir: ws, runDir: join(root, "run"), implementerModel: "m", claudeCommand: cmd, pricing: {} });
		expect(out.stopReason).toBe("wall_clock_cap");
		expect(out.seconds).toBeGreaterThanOrEqual(1);
	});

	it("classifies a non-success result as agent_failure", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-solo-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		const cmd = fakeClaude(root, "process.stdin.resume(); process.stdin.on(\"end\", () => { console.log(JSON.stringify({type:\"result\",subtype:\"error_max_turns\",usage:{input_tokens:1,output_tokens:1}})); });");
		const out = await runSoloArm({ task: task(), arm: "A", workspaceDir: ws, runDir: join(root, "run"), implementerModel: "m", claudeCommand: cmd, pricing: {} });
		expect(out.stopReason).toBe("agent_failure");
		expect(out.failureMode).toBe("error_max_turns");
	});

	it("throws HarnessFailure when the claude binary cannot be spawned", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-solo-"));
		const ws = join(root, "ws"); mkdirSync(ws);
		await expect(runSoloArm({ task: task(), arm: "A", workspaceDir: ws, runDir: join(root, "run"), implementerModel: "m", claudeCommand: join(root, "missing"), pricing: {} })).rejects.toBeInstanceOf(HarnessFailure);
	});
});
