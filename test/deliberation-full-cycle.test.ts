import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createRelayOrchestrator } from "../packages/cli/src/runtime/relay-orchestrator.ts";

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "whisper-delib-"));
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

describe("deliberation full cycle (mock orchestrator)", () => {
	it("advances all four layers and resolves every placeholder in every rendered handoff", async () => {
		const repo = initRepo();
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4323,
		});

		try {
			broker.control.startCollab({
				collabId: "collab_delib1",
				workspaceRoot: repo,
				displayName: "delib1",
				orchestratorEnabled: true,
				orchestratorMaxRounds: 10,
				now: "2026-06-22T00:00:00Z",
			});
			for (const agent of ["claude", "codex"] as const) {
				broker.control.setSessionBinding({
					collabId: "collab_delib1",
					agentType: agent,
					sessionId: `session_delib_${agent}`,
					bindingSource: "adopted",
					now: "2026-06-22T00:00:00Z",
				});
			}

			function gitHead(): string {
				return execSync(`git -C "${repo}" rev-parse HEAD`).toString().trim();
			}

			// Verdict sequence — one findings→fix round on objectives (to exercise the
			// renderFixTemplateOnFindings: true render site for objectives/approaches/tradeoffs)
			// AND one findings→fix round on synthesis (to exercise DELIB_SYNTHESIS_FIX, which
			// must target the committed findings doc and re-commit it):
			//
			// Step  0: objectives implement  → delivered   (Explorer proposes)
			// Step  1: objectives review     → findings    (Challenger has concerns)
			// Step  2: objectives fix        → delivered   (Explorer addresses findings)
			// Step  3: objectives review     → approve     (Challenger approves; advance to approaches)
			// Step  4: approaches implement  → delivered
			// Step  5: approaches review     → approve     (advance to tradeoffs)
			// Step  6: tradeoffs implement   → delivered
			// Step  7: tradeoffs review      → approve     (advance to synthesis)
			// Step  8: synthesis implement   → delivered   (Explorer writes + commits findings doc)
			// Step  9: synthesis review      → findings    (Challenger has concerns about synthesis)
			// Step 10: synthesis fix         → delivered   (Explorer rewrites + re-commits findings doc)
			// Step 11: synthesis review      → approve     (workflow done)
			const verdicts: Array<"approve" | "delivered" | "findings"> = [
				"delivered", // 0
				"findings",  // 1
				"delivered", // 2
				"approve",   // 3
				"delivered", // 4
				"approve",   // 5
				"delivered", // 6
				"approve",   // 7
				"delivered", // 8
				"findings",  // 9
				"delivered", // 10
				"approve",   // 11
			];
			let step = 0;

			const orchestrator = createRelayOrchestrator({
				broker,
				collabId: "collab_delib1",
				evaluate: async () => {
					const v = verdicts[step];
					step += 1;
					if (!v) throw new Error(`unexpected eval step ${step - 1}`);
					if (v === "findings") {
						return {
							verdict: "findings" as const,
							confidence: 0.9,
							reason: "mock findings — Challenger found a gap",
						};
					}
					return { verdict: v, confidence: 0.9, reason: "mock" };
				},
				readWorkspaceHead: async () => gitHead(),
				pollIntervalMs: 10,
			});

			const { workflowId } = broker.control.createWorkflow({
				collabId: "collab_delib1",
				workflowType: "deliberation",
				specPath: "docs/ideas/some-idea.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-06-22T00:00:00Z",
			});

			// WorkflowDriver fires setImmediate after workflow.created to call beginPhaseRun.
			// Yield to let it run before we start driving.
			await new Promise((r) => setImmediate(r));

			// Capture every rendered request_text (the kickoff + review + fix handoffs)
			const capturedHandoffs: string[] = [];
			const visitedPhases: string[] = [];

			// Capture synthesis fix handoff for re-commit assertion (Finding 1 coverage).
			let synthesisFix: string | undefined;

			// Drive each verdict round.
			for (let i = 0; i < verdicts.length; i++) {
				// Find the oldest pending handoff for this workflow, joined with its phase name.
				const row = broker.db
					.prepare(
						`SELECT h.handoff_id, h.sender_agent, h.target_agent, h.handoff_step,
						        h.request_text, wp.phase_name
						 FROM relay_handoff h
						 LEFT JOIN workflow_phases wp ON wp.phase_run_id = h.phase_run_id
						 WHERE h.workflow_id = ? AND h.status = 'pending'
						 ORDER BY h.created_at ASC LIMIT 1`,
					)
					.get(workflowId) as
					| {
							handoff_id: string;
							sender_agent: "codex" | "claude";
							target_agent: "codex" | "claude";
							handoff_step: string;
							request_text: string;
							phase_name: string | null;
					  }
					| undefined;
				if (!row) {
					throw new Error(`Step ${i}: no pending handoff found for workflow ${workflowId}`);
				}

				// Capture the rendered request_text for the placeholder-guard assertion
				capturedHandoffs.push(row.request_text);

				// Capture synthesis fix handoff (step 10) for the re-commit assertion
				if (row.phase_name === "synthesis" && row.handoff_step === "fix") {
					synthesisFix = row.request_text;
				}

				// Track phase order (avoid duplicates for the implement→review→fix sequence)
				const phaseName = row.phase_name ?? "unknown";
				if (visitedPhases[visitedPhases.length - 1] !== phaseName) {
					visitedPhases.push(phaseName);
				}

				broker.control.acceptRelayHandoff({
					handoffId: row.handoff_id,
					acceptedAt: new Date().toISOString(),
				});

				broker.control.handoffBackRelay({
					handoffId: row.handoff_id,
					senderAgent: row.target_agent,
					targetAgent: row.sender_agent,
					requestText: `done step ${i}`,
					now: new Date().toISOString(),
				});

				// Orchestrator evaluates the handed-back handoff
				await orchestrator.pollOnce();

				// Yield for WorkflowDriver to call beginPhaseRun for the next phase (if any)
				await new Promise((r) => setImmediate(r));
			}

			// ── Assertions ────────────────────────────────────────────────────────────

			// (a) Workflow reached terminal completion
			const wf = broker.control.getWorkflow(workflowId);
			expect(wf?.status).toBe("done");

			// (b) Phases visited in order: objectives → approaches → tradeoffs → synthesis
			expect(visitedPhases).toEqual(["objectives", "approaches", "tradeoffs", "synthesis"]);

			// (c) No captured request_text leaks a literal placeholder
			expect(capturedHandoffs.length).toBeGreaterThanOrEqual(12);
			for (const text of capturedHandoffs) {
				expect(text).not.toContain("{deliberationDir}");
				expect(text).not.toContain("{findingsPath}");
			}

			// (d) The synthesis layer kickoff request_text resolved {findingsPath} to the
			//     committed doc path under docs/superpowers/deliberations/
			const synthesisKickoff = capturedHandoffs.find((t) =>
				t.includes("LAYER 4 of 4: SYNTHESIS"),
			);
			expect(synthesisKickoff).toBeDefined();
			expect(synthesisKickoff!).toContain("docs/superpowers/deliberations/");

			// (e) The synthesis fix handoff (DELIB_SYNTHESIS_FIX) targets the committed findings
			//     doc — it must contain the resolved findingsPath and a re-commit instruction.
			expect(synthesisFix).toBeDefined();
			expect(synthesisFix!).toContain("docs/superpowers/deliberations/");
			// Must instruct re-committing the findings doc (git add + git commit)
			expect(synthesisFix!).toMatch(/git add|git commit/i);
		} finally {
			await broker.stop();
		}
	}, 30_000);
});
