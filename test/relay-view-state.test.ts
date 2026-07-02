import { describe, expect, it } from "vitest";
import { deriveLogLines, buildRelayViewState, fmtDurCoarse } from "../packages/cli/src/runtime/relay-view-state.ts";
import type { RelayViewSnapshot } from "../packages/cli/src/runtime/relay-view-state.ts";
import type { RelayHandoffLogRow } from "@ai-whisper/broker";

function row(p: Partial<RelayHandoffLogRow>): RelayHandoffLogRow {
	return {
		handoffId: "h", createdAt: "2026-05-19T08:21:03.000Z", collabId: "c1",
		senderAgent: "codex", targetAgent: "claude", status: "handed_back",
		captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "implement",
		workflowId: "wf1", phaseRunId: "pr1", handbackText: "wrote spec.plan.md; 5 tasks added",
		evaluatorVerdict: "delivered", evaluatorConfidence: 0.95, evaluatorReason: null,
		lastActivityAt: "2026-05-19T08:21:03.000Z",
		...p,
	};
}

const phaseRuns = [
	{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing",
	  startedAt: "2026-05-19T08:21:00.000Z", endedAt: "2026-05-19T08:24:12.000Z", outcome: "approve" },
	{ phaseRunId: "pr2", phaseIndex: 2, phaseName: "plan-execution",
	  startedAt: "2026-05-19T08:25:00.000Z", endedAt: null, outcome: null },
];

describe("deriveLogLines", () => {
	it("workflow handoff → P·R / step / verdict columns + preview", () => {
		const lines = deriveLogLines([row({})], phaseRuns, 4);
		const ev = lines.find((l) => l.kind === "event")!;
		expect(ev.text).toContain("08:21:03");
		expect(ev.text).toContain("P2·R1"); // phaseIndex 1 → "P2" (1-based display)
		expect(ev.text).toContain("codex→claude");
		expect(ev.text).toContain("implement");
		expect(ev.text).toContain("delivered");
		expect(ev.text).toContain("wrote spec.plan.md");
	});

	it("manual relay (null workflow) degrades to time · route · preview", () => {
		const lines = deriveLogLines(
			[row({ workflowId: null, phaseRunId: null, roundNumber: null, handoffStep: null, evaluatorVerdict: null })],
			phaseRuns, 4,
		);
		const ev = lines.find((l) => l.kind === "event")!;
		expect(ev.text).toContain("codex→claude");
		expect(ev.text).not.toMatch(/P\d·R\d/);
		expect(ev.text).not.toContain("implement");
	});

	it("emits a phase-start rule when phaseRunId changes", () => {
		const lines = deriveLogLines(
			[row({ handoffId: "h1", phaseRunId: "pr1" }), row({ handoffId: "h2", phaseRunId: "pr2" })],
			phaseRuns, 4,
		);
		expect(lines.filter((l) => l.kind === "phase-rule").map((l) => l.text)).toEqual([
			"── phase 2/4 · plan-writing ──",
			"── phase 3/4 · plan-execution ──",
		]);
	});

	it("emits a phase-complete summary when leaving a closed phase run", () => {
		const lines = deriveLogLines(
			[
				row({ handoffId: "h1", phaseRunId: "pr1", roundNumber: 1, handoffStep: "implement" }),
				row({ handoffId: "h2", phaseRunId: "pr1", roundNumber: 1, handoffStep: "review" }),
				row({ handoffId: "h3", phaseRunId: "pr1", roundNumber: 2, handoffStep: "fix" }),
				row({ handoffId: "h4", phaseRunId: "pr1", roundNumber: 2, handoffStep: "review" }),
				row({ handoffId: "h5", phaseRunId: "pr2", roundNumber: 1, handoffStep: "execute" }),
			],
			phaseRuns, 4,
		);
		const sum = lines.find((l) => l.kind === "phase-summary");
		expect(sum?.text).toBe(
			"✔ plan-writing — 2 rounds (4 handovers) · 3m12s → approve",
		);
		expect(sum && sum.kind === "phase-summary" ? sum.ok : null).toBe(true);
	});

	it("marks an escalated phase summary with ✖ and ok=false", () => {
		const escRuns = [
			{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing",
			  startedAt: "2026-05-19T08:21:00.000Z", endedAt: "2026-05-19T08:32:40.000Z",
			  outcome: "escalated (max rounds)" },
			{ phaseRunId: "pr2", phaseIndex: 2, phaseName: "plan-execution",
			  startedAt: "2026-05-19T08:33:00.000Z", endedAt: null, outcome: null },
		];
		const lines = deriveLogLines(
			[
				row({ handoffId: "a", phaseRunId: "pr1", roundNumber: 5 }),
				row({ handoffId: "b", phaseRunId: "pr2", roundNumber: 1 }),
			],
			escRuns, 4,
		);
		const sum = lines.find((l) => l.kind === "phase-summary");
		expect(sum?.text).toContain("✖ plan-writing — 5 rounds");
		expect(sum?.text).toContain("→ escalated (max rounds)");
		expect(sum && sum.kind === "phase-summary" ? sum.ok : null).toBe(false);
	});

	it("does NOT summarize a phase run that has not ended", () => {
		const lines = deriveLogLines([row({ phaseRunId: "pr2", roundNumber: 1 })], phaseRuns, 4);
		expect(lines.some((l) => l.kind === "phase-summary")).toBe(false);
	});

	it("returns [] for empty handoffs", () => {
		expect(deriveLogLines([], phaseRuns, 4)).toEqual([]);
	});

	it("unknown phaseRunId degrades to route-only line, no rule, no summary", () => {
		const lines = deriveLogLines(
			[row({ phaseRunId: "pr-missing", workflowId: "wf1" })],
			phaseRuns, 4,
		);
		expect(lines.some((l) => l.kind === "phase-rule")).toBe(false);
		expect(lines.some((l) => l.kind === "phase-summary")).toBe(false);
		const ev = lines.find((l) => l.kind === "event")!;
		expect(ev.text).toContain("codex→claude");
		expect(ev.text).not.toMatch(/P\d·R\d/);
	});

	it("Task 5: route substitutes character labels when a charNames map is passed", () => {
		const lines = deriveLogLines([row({})], phaseRuns, 4, { codex: "Bo", claude: "Al" });
		const ev = lines.find((l) => l.kind === "event")!;
		expect(ev.text).toContain("Bo (codex)");
	});

	it("Task 5: route is byte-identical to today when charNames is omitted (regression)", () => {
		const lines = deriveLogLines([row({})], phaseRuns, 4);
		const ev = lines.find((l) => l.kind === "event")!;
		expect(ev.text).toContain("codex→claude");
	});

	it("Task 5: route is byte-identical to today when charNames is an empty map (regression)", () => {
		const lines = deriveLogLines([row({})], phaseRuns, 4, {});
		const ev = lines.find((l) => l.kind === "event")!;
		expect(ev.text).toContain("codex→claude");
	});
});

const baseSnapshot: RelayViewSnapshot = {
	now: "2026-05-19T08:30:00.000Z",
	idleThresholdMs: 30_000,
	currentStep: "execute" as string | null,
	workflow: {
		workflowId: "wf_048c", workflowType: "spec-driven-development",
		name: "slugify", status: "running" as const,
		createdAt: "2026-05-19T08:22:48.000Z",
		haltReason: null as string | null,
	},
	phaseRuns: [
		{ phaseRunId: "pr1", phaseIndex: 0, phaseName: "spec-refining",
		  startedAt: "2026-05-19T08:22:48.000Z", endedAt: "2026-05-19T08:23:18.000Z", outcome: "approve" },
		{ phaseRunId: "pr2", phaseIndex: 2, phaseName: "plan-execution",
		  startedAt: "2026-05-19T08:27:52.000Z", endedAt: null, outcome: null },
	],
	currentPhaseRunId: "pr2",
	totalPhases: 4,
	chain: { currentRound: 1, maxRounds: 1, status: "active" as const },
	turn: { turnOwner: "codex" as const, waitingAgent: "claude" as const, handoffState: "accepted" as const },
	sessions: [
		{ agentType: "codex", healthState: "healthy" },
		{ agentType: "claude", healthState: "healthy" },
	],
	lastActivityAt: "2026-05-19T08:29:52.000Z",
	handoffs: [],
};

describe("buildRelayViewState — status", () => {
	it("maps progress/turn/health, total+phase elapsed, ALIVE when running & not stuck", () => {
		const s = buildRelayViewState(baseSnapshot);
		expect(s.progress).toBe("Phase 3/4 plan-execution · Round 1/1 · Step execute");
		expect(s.turn).toBe("codex · waiting claude · handoff accepted");
		expect(s.health).toContain("ALIVE");
		expect(s.elapsed).toBe("total 7m12s · phase 2m08s");
		expect(s.stuck).toBe(false);
	});

	it("omits ALIVE and shows terminal state when workflow halted", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow!, status: "halted" },
		});
		expect(s.health).not.toContain("ALIVE");
		expect(s.health).toContain("halted");
	});

	it("manual relay (workflow null) → wf label, progress —, elapsed —, last —", () => {
		const s = buildRelayViewState({
			...baseSnapshot, workflow: null, chain: null,
			currentPhaseRunId: null, currentStep: null, handoffs: [],
		});
		expect(s.wf).toBe("(no workflow — manual relay)");
		expect(s.progress).toBe("—");
		expect(s.elapsed).toBe("total — · phase —");
		expect(s.last).toBe("—");
	});

	it("chain null → Round 1/1 fallback in progress", () => {
		const s = buildRelayViewState({ ...baseSnapshot, chain: null });
		expect(s.progress).toBe("Phase 3/4 plan-execution · Round 1/1 · Step execute");
	});

	it("currentPhaseRunId not in phaseRuns → progress — and phase elapsed —", () => {
		const s = buildRelayViewState({ ...baseSnapshot, currentPhaseRunId: "nope" });
		expect(s.progress).toBe("—");
		expect(s.elapsed).toBe("total 7m12s · phase —");
	});

	it("terminal done appends ✔ workflow-done tail line after deriveLogLines", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow!, status: "done" },
		});
		const tail = s.logLines[s.logLines.length - 1];
		expect(tail).toEqual({ kind: "phase-summary", ok: true, text: "✔ workflow-done: wf_048c" });
		expect(s.health).not.toContain("ALIVE");
	});

	it("terminal canceled with haltReason appends ✖ tail with reason", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow!, status: "canceled", haltReason: "user aborted" },
		});
		const tail = s.logLines[s.logLines.length - 1];
		expect(tail).toEqual({
			kind: "phase-summary", ok: false,
			text: "✖ workflow-canceled: wf_048c — user aborted",
		});
	});

	it("terminal canceled with empty-string haltReason omits the — suffix", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow!, status: "canceled", haltReason: "" },
		});
		const tail = s.logLines[s.logLines.length - 1];
		expect(tail && tail.kind === "phase-summary" ? tail.text : "").toBe(
			"✖ workflow-canceled: wf_048c",
		);
	});

	it("Task 5: turn row renders character labels when a characterNames map is provided", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			characterNames: { codex: "Batman", claude: "Robin" },
		});
		expect(s.turn).toBe("Batman (codex) · waiting Robin (claude) · handoff accepted");
	});

	it("Task 5: turn row is byte-identical to today when characterNames is omitted (regression)", () => {
		const s = buildRelayViewState(baseSnapshot);
		expect(s.turn).toBe("codex · waiting claude · handoff accepted");
	});

	it("Task 5: turn row is byte-identical to today when characterNames is an empty map (regression)", () => {
		const s = buildRelayViewState({ ...baseSnapshot, characterNames: {} });
		expect(s.turn).toBe("codex · waiting claude · handoff accepted");
	});

	it("Task 5: turnOwner 'none' / waitingAgent null render 'none' even with a populated characterNames map", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			turn: { turnOwner: "none", waitingAgent: null, handoffState: "idle" },
			characterNames: { codex: "Batman", claude: "Robin" },
		});
		expect(s.turn).toBe("none · waiting none · handoff idle");
	});

	it("review fix: health line renders character labels when a characterNames map is provided", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			characterNames: { codex: "Batman", claude: "Robin" },
		});
		expect(s.health).toContain("● Batman (codex)");
		expect(s.health).toContain("● Robin (claude)");
	});

	it("review fix: health line is byte-identical to today when characterNames is omitted (regression)", () => {
		const s = buildRelayViewState(baseSnapshot);
		expect(s.health).toContain("● codex  ● claude");
	});

	it("empty sessions → no health dots (no synthesized dead peers)", () => {
		const s = buildRelayViewState({ ...baseSnapshot, sessions: [] });
		expect(s.health).not.toContain("codex");
		expect(s.health).not.toContain("claude");
		expect(s.health).not.toContain("(dead)");
	});

	it("health dots: healthy → ●, degraded → distinct ◐(degraded), offline → ●(dead) (Bug A)", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			sessions: [
				{ agentType: "codex", healthState: "degraded" },
				{ agentType: "claude", healthState: "offline" },
			],
		});
		// degraded must NOT read as dead
		expect(s.health).toContain("◐(degraded) codex");
		expect(s.health).not.toContain("●(dead) codex");
		// offline reads as dead
		expect(s.health).toContain("●(dead) claude");
	});

	it("healthy session renders the alive ● glyph (not dead, not degraded)", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			sessions: [
				{ agentType: "codex", healthState: "healthy" },
				{ agentType: "claude", healthState: "healthy" },
			],
		});
		expect(s.health).toContain("● codex");
		expect(s.health).not.toContain("●(dead) codex");
		expect(s.health).not.toContain("◐(degraded) codex");
	});

	it("populated last handoff renders verdict/confidence/capture/reason", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			handoffs: [{
				handoffId: "h", createdAt: "2026-05-19T08:29:00.000Z", collabId: "c1",
				senderAgent: "codex", targetAgent: "claude", status: "handed_back",
				captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "review",
				workflowId: "wf_048c", phaseRunId: "pr2",
				handbackText: "done", evaluatorVerdict: "delivered",
				evaluatorConfidence: 0.95, evaluatorReason: "looks good",
				lastActivityAt: "2026-05-19T08:29:00.000Z",
			}],
		});
		expect(s.last).toBe('delivered 0.95 · capture ok · "looks good"');
	});
});

describe("buildRelayViewState — wf row (Fix 4)", () => {
	const wfSnap: RelayViewSnapshot = {
		...baseSnapshot,
		workflow: {
			workflowId: "wf_5dde51ed96d449bd",
			workflowType: "spec-driven-development",
			name: null,
			status: "running",
			createdAt: "2026-05-19T08:22:48.000Z",
			haltReason: null,
			artifact: "docs/superpowers/specs/2026-06-10-foo-design.md",
		},
	};

	it("leads with the FULL workflow id, then the type once, then the artifact", () => {
		const s = buildRelayViewState(wfSnap);
		expect(s.wf).toContain("wf_5dde51ed96d449bd");
		expect(s.wf).not.toContain("…"); // id never truncated
		expect(s.wf).toContain("→ docs/superpowers/specs/2026-06-10-foo-design.md");
		// type appears exactly once (the quoted name-fallback duplicate is gone)
		expect(s.wf.split("spec-driven-development").length - 1).toBe(1);
		expect(s.wf).not.toContain('"');
		// order: id < type < artifact arrow
		expect(s.wf.indexOf("wf_5dde51ed96d449bd")).toBeLessThan(
			s.wf.indexOf("spec-driven-development"),
		);
		expect(s.wf.indexOf("spec-driven-development")).toBeLessThan(s.wf.indexOf("→"));
	});

	it("omits the artifact arrow when no artifact is present", () => {
		const s = buildRelayViewState({
			...wfSnap,
			workflow: { ...wfSnap.workflow!, artifact: null },
		});
		expect(s.wf).toContain("wf_5dde51ed96d449bd");
		expect(s.wf).toContain("spec-driven-development");
		expect(s.wf).not.toContain("→");
	});

	it("omits the artifact arrow for a whitespace-only artifact (no empty arrow)", () => {
		const s = buildRelayViewState({
			...wfSnap,
			workflow: { ...wfSnap.workflow!, artifact: "   " },
		});
		expect(s.wf).not.toContain("→");
	});

	it("manual relay (workflow null) keeps the existing string", () => {
		const s = buildRelayViewState({
			...wfSnap,
			workflow: null,
			chain: null,
			currentPhaseRunId: null,
			currentStep: null,
		});
		expect(s.wf).toBe("(no workflow — manual relay)");
	});
});

describe("computeLiveness via buildRelayViewState", () => {
	it("idle countdown to auto-handback when accepted and within threshold", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			now: "2026-05-19T08:30:00.000Z",
			lastActivityAt: "2026-05-19T08:29:52.000Z", // idle 8s
			idleThresholdMs: 30_000,
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
		});
		expect(s.stuck).toBe(false);
		expect(s.live).toBe("idle 8s · auto-handback in 22s");
		expect(s.why).toBeNull();
	});

	it("stuck: round at maxRounds → why states round-max → escalate", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			chain: { currentRound: 5, maxRounds: 5, status: "active" as const },
			lastActivityAt: "2026-05-19T08:26:58.000Z", // idle 182s
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toContain("round 5/5 max reached");
	});

	it("stuck: chain.status escalated/abandoned → why + health shows it", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			chain: { currentRound: 2, maxRounds: 5, status: "escalated" as const },
			lastActivityAt: "2026-05-19T08:29:55.000Z", // only idle 5s — not idle-stuck
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toContain("chain escalated");
		expect(s.health).toContain("Chain escalated");
		expect(s.health).not.toContain("ALIVE");
	});

	it("stuck: idle past the (execute) budget AND the active mount is not alive", () => {
		// baseSnapshot.currentStep = "execute" → 10-min budget. Idle 11 min and
		// the active agent (turnOwner codex) has no live mount → STUCK (Bug C).
		const s = buildRelayViewState({
			...baseSnapshot,
			now: "2026-05-19T08:30:00.000Z",
			lastActivityAt: "2026-05-19T08:19:00.000Z", // idle 11m ≥ 10m budget
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "pending" },
			sessions: [
				{ agentType: "codex", healthState: "healthy", mountAlive: false },
				{ agentType: "claude", healthState: "healthy", mountAlive: true },
			],
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toMatch(/no progress and mount not alive/);
	});

	it("long-running (NOT stuck): idle past budget but the active mount is alive", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			now: "2026-05-19T08:30:00.000Z",
			lastActivityAt: "2026-05-19T08:19:00.000Z", // idle 11m ≥ 10m budget
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "pending" },
			sessions: [
				{ agentType: "codex", healthState: "healthy", mountAlive: true },
				{ agentType: "claude", healthState: "healthy", mountAlive: true },
			],
		});
		expect(s.stuck).toBe(false);
		expect(s.live).toMatch(/long-running/);
	});

	it("halt_reason wins as the why when workflow halted", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow!, status: "halted", haltReason: "max-rounds-reached (phase plan-writing)" },
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toContain("max-rounds-reached");
	});

	it("stuck: active session offline (provider offline) even under budget", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			lastActivityAt: "2026-05-19T08:29:55.000Z", // idle 5s — not idle-stuck
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
			sessions: [
				{ agentType: "codex", healthState: "offline" }, // active agent offline
				{ agentType: "claude", healthState: "healthy", mountAlive: true },
			],
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toContain("provider offline");
	});

	it("NOT stuck: active session degraded-but-alive (degraded ≠ stuck)", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			lastActivityAt: "2026-05-19T08:29:55.000Z", // idle 5s
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
			sessions: [
				{ agentType: "codex", healthState: "degraded", mountAlive: true },
				{ agentType: "claude", healthState: "healthy", mountAlive: true },
			],
		});
		expect(s.stuck).toBe(false);
	});

	it("empty sessions is NOT provider-stuck", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			lastActivityAt: "2026-05-19T08:29:55.000Z", // idle 5s
			sessions: [],
		});
		expect(s.stuck).toBe(false);
		expect(s.why).toBeNull();
	});

	it("pending handoff within threshold → auto-accept countdown", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			now: "2026-05-19T08:30:00.000Z",
			lastActivityAt: "2026-05-19T08:29:52.000Z", // idle 8s
			idleThresholdMs: 30_000,
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "pending" },
		});
		expect(s.stuck).toBe(false);
		expect(s.live).toBe("idle 8s · auto-accept in 22s");
	});

	it("chain abandoned → stuck with why", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			chain: { currentRound: 2, maxRounds: 5, status: "abandoned" as const },
			lastActivityAt: "2026-05-19T08:29:55.000Z", // idle 5s
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toContain("chain abandoned");
	});

	it("null lastActivityAt → idle 0s, not idle-stuck", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			lastActivityAt: null,
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
		});
		expect(s.stuck).toBe(false);
		expect(s.live).toBe("idle 0s · auto-handback in 30s");
	});

	it("halted with no haltReason → why is 'workflow halted'", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow!, status: "halted", haltReason: null },
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toBe("workflow halted");
	});

	it("unparseable timestamps degrade to idle 0s, never 'NaN'", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			now: "not-a-date",
			lastActivityAt: "also-not-a-date",
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
		});
		expect(s.live).not.toContain("NaN");
		expect(s.why ?? "").not.toContain("NaN");
		expect(s.live).toBe("idle 0s · auto-handback in 30s");
	});
});

describe("agentHealth structured field", () => {
	it("exposes structured agentHealth alongside the dots string", () => {
		const state = buildRelayViewState({
			now: "2026-05-28T00:00:00.000Z",
			idleThresholdMs: 60_000,
			workflow: null,
			phaseRuns: [],
			currentPhaseRunId: null,
			currentStep: null,
			totalPhases: 0,
			chain: null,
			turn: { turnOwner: "none", waitingAgent: null, handoffState: "idle" },
			sessions: [
				{ agentType: "codex", healthState: "healthy", mountAlive: true },
				{ agentType: "claude", healthState: "degraded", mountAlive: true },
			],
			lastActivityAt: null,
			handoffs: [],
		});
		expect(state.agentHealth).toEqual([
			{ agent: "codex", health: "healthy" },
			{ agent: "claude", health: "degraded" },
		]);
	});

	it("agentHealth is empty when there are no sessions (no synthesized dead peers)", () => {
		const state = buildRelayViewState({
			now: "2026-05-28T00:00:00.000Z",
			idleThresholdMs: 60_000,
			workflow: null,
			phaseRuns: [],
			currentPhaseRunId: null,
			currentStep: null,
			totalPhases: 0,
			chain: null,
			turn: { turnOwner: "none", waitingAgent: null, handoffState: "idle" },
			sessions: [],
			lastActivityAt: null,
			handoffs: [],
		});
		expect(state.agentHealth).toEqual([]);
	});

	it("derives agentHealth from real sessions incl. ezio (repro: ezio+claude, no phantom codex)", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			turn: { turnOwner: "ezio", waitingAgent: "claude", handoffState: "accepted" },
			sessions: [
				{ agentType: "ezio", healthState: "healthy" },
				{ agentType: "claude", healthState: "healthy" },
			],
		});
		expect(s.agentHealth).toEqual([
			{ agent: "ezio", health: "healthy" },
			{ agent: "claude", health: "healthy" },
		]);
		expect(s.health).toContain("ezio");
		expect(s.health).not.toContain("codex");
	});

	it("codex+claude keeps canonical [codex, claude] order regardless of session order", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			sessions: [
				{ agentType: "claude", healthState: "healthy" },
				{ agentType: "codex", healthState: "healthy" },
			],
		});
		expect(s.agentHealth).toEqual([
			{ agent: "codex", health: "healthy" },
			{ agent: "claude", health: "healthy" },
		]);
	});

	it("filters out sessions with an unrecognized agentType", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			sessions: [
				{ agentType: "ezio", healthState: "healthy" },
				{ agentType: "gremlin", healthState: "healthy" },
				{ agentType: "claude", healthState: "healthy" },
			],
		});
		expect(s.agentHealth.map((a) => a.agent)).toEqual(["ezio", "claude"]);
	});
});

describe("fmtDurCoarse", () => {
	it.each([
		[0, "0m"],
		[45_000, "0m"], // 45s — sub-minute
		[2_820_000, "47m"], // 47m
		[3_600_000, "1h 0m"], // exact 1h — lower field shown though zero
		[12_240_000, "3h 24m"], // 3h 24m
		[86_400_000, "1d 0h"], // exact 1d — lower field shown though zero
		[90_000_000, "1d 1h"], // 25h
		[1_138_800_000, "13d 4h"], // 13d 4h 20m — minutes dropped at day scale
	])("formats %i ms as %s", (ms, expected) => {
		expect(fmtDurCoarse(ms)).toBe(expected);
	});

	it("clamps negative input to 0m", () => {
		expect(fmtDurCoarse(-5000)).toBe("0m");
	});
});
