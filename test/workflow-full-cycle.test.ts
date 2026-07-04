import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createRelayOrchestrator } from "../packages/cli/src/runtime/relay-orchestrator.ts";

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "whisper-full-"));
	execSync("git init --quiet", { cwd: dir });
	execSync(
		"git -c user.email=t@t -c user.name=t commit --allow-empty -m init --quiet",
		{ cwd: dir },
	);
	writeFileSync(join(dir, "spec.md"), "# spec\n");
	execSync(
		"git -c user.email=t@t -c user.name=t add . && git -c user.email=t@t -c user.name=t commit -m spec --quiet",
		{ cwd: dir },
	);
	return dir;
}

// quick-task's single phase anchors its commit base on entry, which makes the
// real WorkflowDriver read the workspace HEAD via a genuine `git` subprocess
// (see workspace-head-reader.ts) before it writes the kickoff handoff — unlike
// the other cases in this file, a single setImmediate tick is not guaranteed to
// outlast that real child-process call. Poll briefly instead of assuming one
// tick is enough.
async function waitForPendingHandoff(
	broker: ReturnType<typeof createBrokerRuntime>,
	workflowId: string,
): Promise<{
	handoff_id: string;
	sender_agent: "codex" | "claude";
	target_agent: "codex" | "claude";
	handoff_step: string;
	request_text: string;
}> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const row = broker.db
			.prepare(
				`SELECT handoff_id, sender_agent, target_agent, handoff_step, request_text
				 FROM relay_handoff
				 WHERE workflow_id = ? AND status = 'pending'
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.get(workflowId) as
			| {
					handoff_id: string;
					sender_agent: "codex" | "claude";
					target_agent: "codex" | "claude";
					handoff_step: string;
					request_text: string;
			  }
			| undefined;
		if (row) return row;
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for a pending handoff on workflow ${workflowId}`);
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe("workflow full cycle (mock orchestrator)", () => {
	it("spec-refining → plan-writing → plan-execution → code-review all approve", async () => {
		const repo = initRepo();
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4321,
		});

		try {
			broker.control.startCollab({
				collabId: "collab_c1",
				workspaceRoot: repo,
				displayName: "c1",
				orchestratorEnabled: true,
				orchestratorMaxRounds: 3,
				now: "2026-04-21T00:00:00Z",
			});
			for (const agent of ["claude", "codex"] as const) {
				broker.control.setSessionBinding({
					collabId: "collab_c1",
					agentType: agent,
					sessionId: `session_${agent}`,
					bindingSource: "adopted",
					now: "2026-04-21T00:00:00Z",
				});
			}

			function gitHead(): string {
				return execSync(`git -C "${repo}" rev-parse HEAD`).toString().trim();
			}

			function makeRealCommit(label: string): string {
				writeFileSync(join(repo, `${label}.txt`), `content for ${label}\n`);
				execSync(
					`git -c user.email=t@t -c user.name=t -C "${repo}" add . && git -c user.email=t@t -c user.name=t -C "${repo}" commit -m ${label} --quiet`,
				);
				return gitHead();
			}

			// Verdict sequence:
			// Step 0: spec-refining review → approve (advances to plan-writing)
			// Step 1: plan-writing implement → delivered (creates review handoff)
			// Step 2: plan-writing review → approve (advances to plan-execution)
			// Step 3: plan-execution execute → execution-pass (advances to code-review)
			// Step 4: code-review review → approve (workflow done)
			const verdicts: Array<"approve" | "delivered" | "execution-pass"> = [
				"approve",
				"delivered",
				"approve",
				"execution-pass",
				"approve",
			];
			let step = 0;
			let executionCommitSha = "";

			const orchestrator = createRelayOrchestrator({
				broker,
				collabId: "collab_c1",
				evaluate: async () => {
					const v = verdicts[step];
					step += 1;
					if (!v) throw new Error(`unexpected eval step ${step - 1}`);
					return { verdict: v, confidence: 0.9, reason: "mock" };
				},
				readWorkspaceHead: async () => gitHead(),
				pollIntervalMs: 10,
			});

			const { workflowId } = broker.control.createWorkflow({
				collabId: "collab_c1",
				workflowType: "spec-driven-development",
				specPath: "spec.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-04-21T00:00:00Z",
			});

			// WorkflowDriver fires setImmediate after workflow.created to call beginPhaseRun.
			// Yield to let it run before we start driving.
			await new Promise((r) => setImmediate(r));

			// Drive each round: find the pending workflow handoff, accept it, hand it back
			// with appropriate text, then let the orchestrator evaluate.
			for (let i = 0; i < verdicts.length; i++) {
				// Find the most recent pending handoff for this workflow
				const row = broker.db
					.prepare(
						`SELECT handoff_id, sender_agent, target_agent, handoff_step
						 FROM relay_handoff
						 WHERE workflow_id = ? AND status = 'pending'
						 ORDER BY created_at DESC LIMIT 1`,
					)
					.get(workflowId) as
					| {
							handoff_id: string;
							sender_agent: "codex" | "claude";
							target_agent: "codex" | "claude";
							handoff_step: string;
					  }
					| undefined;
				if (!row) {
					throw new Error(`Step ${i}: no pending handoff found for workflow ${workflowId}`);
				}

				broker.control.acceptRelayHandoff({
					handoffId: row.handoff_id,
					acceptedAt: new Date().toISOString(),
				});

				// Build handback text appropriate for each verdict
				let handbackText: string;
				if (verdicts[i] === "execution-pass") {
					// Make a real commit so there's a SHA to extract
					executionCommitSha = makeRealCommit(`exec-${i}`);
					handbackText = `Implemented. Latest commit: ${executionCommitSha}`;
				} else {
					handbackText = `done step ${i}`;
				}

				// In orchestrated mode, nextHandoffId is ignored — pass a placeholder
				broker.control.handoffBackRelay({
					handoffId: row.handoff_id,
					senderAgent: row.target_agent,
					targetAgent: row.sender_agent,
					requestText: handbackText,
					now: new Date().toISOString(),
				});

				// Orchestrator evaluates the handed-back handoff
				await orchestrator.pollOnce();

				// Yield for WorkflowDriver to call beginPhaseRun for the next phase (if any)
				await new Promise((r) => setImmediate(r));
			}

			const wf = broker.control.getWorkflow(workflowId);
			expect(wf?.status).toBe("done");

			const ctx = wf!.workflowContext as {
				baseBeforeExecution?: string;
				headAfterExecution?: string;
				commitRange?: string;
			};
			expect(ctx.baseBeforeExecution).toBeDefined();
			expect(ctx.headAfterExecution).toBeDefined();
			expect(ctx.commitRange).toBe(
				`${ctx.baseBeforeExecution}..${ctx.headAfterExecution}`,
			);
			expect(ctx.baseBeforeExecution).not.toBe(ctx.headAfterExecution);
		} finally {
			await broker.stop();
		}
	}, 30_000);

	it("findings→fix loop resolves before phase advance", async () => {
		const repo = initRepo();
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4322,
		});

		try {
			broker.control.startCollab({
				collabId: "collab_c2",
				workspaceRoot: repo,
				displayName: "c2",
				orchestratorEnabled: true,
				orchestratorMaxRounds: 5,
				now: "2026-04-21T00:00:00Z",
			});
			for (const agent of ["claude", "codex"] as const) {
				broker.control.setSessionBinding({
					collabId: "collab_c2",
					agentType: agent,
					sessionId: `session_${agent}_2`,
					bindingSource: "adopted",
					now: "2026-04-21T00:00:00Z",
				});
			}

			function gitHead(): string {
				return execSync(`git -C "${repo}" rev-parse HEAD`).toString().trim();
			}

			function makeRealCommit(label: string): string {
				writeFileSync(join(repo, `${label}.txt`), `content for ${label}\n`);
				execSync(
					`git -c user.email=t@t -c user.name=t -C "${repo}" add . && git -c user.email=t@t -c user.name=t -C "${repo}" commit -m ${label} --quiet`,
				);
				return gitHead();
			}

			// Verdict sequence:
			// Step 0: spec-refining review → findings (creates fix handoff in same phase)
			// Step 1: spec-refining fix → delivered (creates review handoff)
			// Step 2: spec-refining review → approve (advances to plan-writing)
			// Step 3: plan-writing implement → delivered (creates review handoff)
			// Step 4: plan-writing review → approve (advances to plan-execution)
			// Step 5: plan-execution execute → execution-pass (advances to code-review)
			// Step 6: code-review review → approve (workflow done)
			const verdicts: Array<"approve" | "delivered" | "execution-pass" | "findings"> = [
				"findings",
				"delivered",
				"approve",
				"delivered",
				"approve",
				"execution-pass",
				"approve",
			];
			let step = 0;
			let executionCommitSha = "";

			const orchestrator = createRelayOrchestrator({
				broker,
				collabId: "collab_c2",
				evaluate: async () => {
					const v = verdicts[step];
					step += 1;
					if (!v) throw new Error(`unexpected eval step ${step - 1}`);
					if (v === "findings") {
						return {
							verdict: "findings" as const,
							confidence: 0.9,
							reason: "mock findings",
							followUpMessage: "Please address the spec gaps.",
						};
					}
					return { verdict: v, confidence: 0.9, reason: "mock" };
				},
				readWorkspaceHead: async () => gitHead(),
				pollIntervalMs: 10,
			});

			const { workflowId } = broker.control.createWorkflow({
				collabId: "collab_c2",
				workflowType: "spec-driven-development",
				specPath: "spec.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-04-21T00:00:00Z",
			});

			// Yield to let WorkflowDriver call beginPhaseRun
			await new Promise((r) => setImmediate(r));

			// Drive each round — findings creates a new handoff so we need up to verdicts.length iterations
			for (let i = 0; i < verdicts.length; i++) {
				const row = broker.db
					.prepare(
						`SELECT handoff_id, sender_agent, target_agent, handoff_step
						 FROM relay_handoff
						 WHERE workflow_id = ? AND status = 'pending'
						 ORDER BY created_at ASC LIMIT 1`,
					)
					.get(workflowId) as
					| {
							handoff_id: string;
							sender_agent: "codex" | "claude";
							target_agent: "codex" | "claude";
							handoff_step: string;
					  }
					| undefined;
				if (!row) {
					throw new Error(`Step ${i}: no pending handoff found for workflow ${workflowId}`);
				}

				broker.control.acceptRelayHandoff({
					handoffId: row.handoff_id,
					acceptedAt: new Date().toISOString(),
				});

				let handbackText: string;
				if (verdicts[i] === "execution-pass") {
					executionCommitSha = makeRealCommit(`exec2-${i}`);
					handbackText = `Implemented. Latest commit: ${executionCommitSha}`;
				} else {
					handbackText = `done step ${i}`;
				}

				broker.control.handoffBackRelay({
					handoffId: row.handoff_id,
					senderAgent: row.target_agent,
					targetAgent: row.sender_agent,
					requestText: handbackText,
					now: new Date().toISOString(),
				});

				await orchestrator.pollOnce();

				// Yield for WorkflowDriver to call beginPhaseRun for the next phase (if any)
				await new Promise((r) => setImmediate(r));
			}

			const wf = broker.control.getWorkflow(workflowId);
			expect(wf?.status).toBe("done");

			const ctx = wf!.workflowContext as {
				baseBeforeExecution?: string;
				headAfterExecution?: string;
				commitRange?: string;
			};
			expect(ctx.baseBeforeExecution).toBeDefined();
			expect(ctx.headAfterExecution).toBeDefined();
			expect(ctx.commitRange).toBe(
				`${ctx.baseBeforeExecution}..${ctx.headAfterExecution}`,
			);
			expect(ctx.baseBeforeExecution).not.toBe(ctx.headAfterExecution);
		} finally {
			await broker.stop();
		}
	}, 30_000);

	it("quick-task implement → review → approve completes", async () => {
		const repo = initRepo();
		// Gate-valid task brief (mirrors the four-section contract validateTaskBrief
		// enforces). The harness calls broker.control.createWorkflow directly, which
		// bypasses the CLI gate — but writing a real, valid brief keeps the rendered
		// handoff assertions below realistic.
		const briefRelPath = ".ai-whisper/tasks/2026-04-21-parser-null-guard.md";
		mkdirSync(join(repo, ".ai-whisper", "tasks"), { recursive: true });
		// Mirror the real quick-task skill: quick-task has no broker setup step to
		// gitignore .ai-whisper/ (unlike ralph/bugfix/deliberation), so the skill
		// itself now writes this file — reproduce that here so `git add .` below
		// behaves like the real workflow instead of silently staging the brief.
		writeFileSync(join(repo, ".ai-whisper", ".gitignore"), "*\n");
		writeFileSync(
			join(repo, briefRelPath),
			`## Task
Add a null guard to the parser entry point.

## Approved approach
Return early when the input is undefined instead of throwing.

## Scope
- src/parser.ts
- test/parser.test.ts

## Acceptance checks
- \`pnpm test\` passes
`,
		);

		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4323,
		});

		try {
			broker.control.startCollab({
				collabId: "collab_c3",
				workspaceRoot: repo,
				displayName: "c3",
				orchestratorEnabled: true,
				orchestratorMaxRounds: 5,
				now: "2026-04-21T00:00:00Z",
			});
			for (const agent of ["claude", "codex"] as const) {
				broker.control.setSessionBinding({
					collabId: "collab_c3",
					agentType: agent,
					sessionId: `session_${agent}_3`,
					bindingSource: "adopted",
					now: "2026-04-21T00:00:00Z",
				});
			}

			function gitHead(): string {
				return execSync(`git -C "${repo}" rev-parse HEAD`).toString().trim();
			}

			function makeRealCommit(label: string): string {
				writeFileSync(join(repo, `${label}.txt`), `content for ${label}\n`);
				execSync(
					`git -c user.email=t@t -c user.name=t -C "${repo}" add . && git -c user.email=t@t -c user.name=t -C "${repo}" commit -m ${label} --quiet`,
				);
				return gitHead();
			}

			// Verdict sequence:
			// Step 0: implement-and-review implement → delivered (creates review handoff)
			// Step 1: implement-and-review review → approve (single phase, so workflow done)
			const verdicts: Array<"approve" | "delivered"> = ["delivered", "approve"];
			let step = 0;

			const orchestrator = createRelayOrchestrator({
				broker,
				collabId: "collab_c3",
				evaluate: async () => {
					const v = verdicts[step];
					step += 1;
					if (!v) throw new Error(`unexpected eval step ${step - 1}`);
					return { verdict: v, confidence: 0.9, reason: "mock" };
				},
				readWorkspaceHead: async () => gitHead(),
				pollIntervalMs: 10,
			});

			const { workflowId } = broker.control.createWorkflow({
				collabId: "collab_c3",
				workflowType: "quick-task",
				specPath: briefRelPath,
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-04-21T00:00:00Z",
			});

			// The kickoff handoff must render {specPath} to the real brief path and
			// carry the scope-guard clause verbatim.
			const kickoffRow = await waitForPendingHandoff(broker, workflowId);
			expect(kickoffRow.handoff_step).toBe("implement");
			expect(kickoffRow.request_text).toContain(briefRelPath);
			expect(kickoffRow.request_text).toMatch(/CANNOT PROCEED/);

			for (let i = 0; i < verdicts.length; i++) {
				const row = await waitForPendingHandoff(broker, workflowId);

				if (i === 1) {
					// After the implementer's handback, routing must have moved to review.
					expect(row.handoff_step).toBe("review");
				}

				broker.control.acceptRelayHandoff({
					handoffId: row.handoff_id,
					acceptedAt: new Date().toISOString(),
				});

				let handbackText: string;
				if (verdicts[i] === "delivered") {
					const sha = makeRealCommit(`quick-${i}`);
					// The task brief must stay untracked after the implementer's commit —
					// the fixture's .ai-whisper/.gitignore (written above) is what keeps
					// `git add .` in makeRealCommit from silently staging it.
					const trackedFiles = execSync(`git -C "${repo}" ls-files`).toString();
					expect(trackedFiles).not.toContain(briefRelPath);
					handbackText = `Implemented. Latest commit: ${sha}`;
				} else {
					handbackText = `done step ${i}`;
				}

				broker.control.handoffBackRelay({
					handoffId: row.handoff_id,
					senderAgent: row.target_agent,
					targetAgent: row.sender_agent,
					requestText: handbackText,
					now: new Date().toISOString(),
				});

				await orchestrator.pollOnce();

				// Yield for WorkflowDriver to react (no next phase here, but keep the
				// same drive shape as the other cases in this file).
				await new Promise((r) => setImmediate(r));
			}

			const wf = broker.control.getWorkflow(workflowId);
			expect(wf?.status).toBe("done");
		} finally {
			await broker.stop();
		}
	}, 30_000);
});
