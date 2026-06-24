import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeLiveness } from "../packages/cli/src/runtime/relay-view-state.ts";
import type { RelayViewSnapshot } from "../packages/cli/src/runtime/relay-view-state.ts";

// Anchor: now = T0; lastActivityAt set per-test to control idleMs.
const NOW = "2026-05-20T01:00:00.000Z";
function ago(ms: number): string {
	return new Date(Date.parse(NOW) - ms).toISOString();
}

function snap(p: Partial<RelayViewSnapshot>): RelayViewSnapshot {
	return {
		now: NOW,
		idleThresholdMs: 30_000,
		workflow: {
			workflowId: "wf_1",
			workflowType: "spec-driven-development",
			name: "x",
			status: "running",
			createdAt: ago(3_600_000),
			haltReason: null,
		},
		phaseRuns: [],
		currentPhaseRunId: "pr1",
		currentStep: "execute",
		totalPhases: 4,
		chain: { currentRound: 1, maxRounds: 1, status: "active" },
		turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
		sessions: [
			{ agentType: "codex", healthState: "healthy", mountAlive: true },
			{ agentType: "claude", healthState: "healthy", mountAlive: true },
		],
		lastActivityAt: ago(5_000),
		handoffs: [],
		...p,
	};
}

const BASE = 300_000; // 5 min default
const STEP = 600_000; // 10 min execute/review

describe("computeLiveness — decoupled phase-aware threshold + per-agent mountAlive (Bug C)", () => {
	const ENV = "AI_WHISPER_STUCK_THRESHOLD_MS";
	beforeEach(() => {
		delete process.env[ENV];
	});
	afterEach(() => {
		delete process.env[ENV];
	});

	it("idle just under the baseline budget on a non-execute step → not stuck", () => {
		const r = computeLiveness(snap({ currentStep: "ack", lastActivityAt: ago(BASE - 10_000) }));
		expect(r.stuck).toBe(false);
	});

	it("a DONE workflow is never stuck — even when long-idle with a dead/absent mount", () => {
		// Regression: a completed run backfilled onto the wall had aged far past
		// budget and its sessions were gone (mountAlive absent → false), so it fell
		// through to the idle+mount-dead branch and rendered "STUCK". A terminal
		// `done` workflow is finished, not stuck.
		const r = computeLiveness(
			snap({
				workflow: {
					workflowId: "wf_done",
					workflowType: "spec-driven-development",
					name: "x",
					status: "done",
					createdAt: ago(3_600_000),
					haltReason: null,
				},
				lastActivityAt: ago(STEP * 5), // long past any budget
				sessions: [], // mounts gone → mountAlive absent → false
				turn: { turnOwner: "none", waitingAgent: null, handoffState: "idle" },
			}),
		);
		expect(r.stuck).toBe(false);
		expect(r.why).toBeNull();
	});

	it("idle over baseline but under the larger execute budget → not stuck (phase-aware)", () => {
		const r = computeLiveness(snap({ currentStep: "execute", lastActivityAt: ago(BASE + 60_000) }));
		expect(r.stuck).toBe(false);
	});

	it("review step uses the larger budget too", () => {
		const r = computeLiveness(snap({ currentStep: "review", lastActivityAt: ago(BASE + 60_000) }));
		expect(r.stuck).toBe(false);
	});

	it("idle over budget AND active agent mountAlive=true → long-running, not stuck", () => {
		const r = computeLiveness(
			snap({
				currentStep: "execute",
				lastActivityAt: ago(STEP + 30_000),
				sessions: [
					{ agentType: "codex", healthState: "healthy", mountAlive: true },
					{ agentType: "claude", healthState: "healthy", mountAlive: true },
				],
			}),
		);
		expect(r.stuck).toBe(false);
		expect(r.liveText).toMatch(/long-running/);
	});

	it("idle over budget AND active agent mountAlive=false → stuck", () => {
		const r = computeLiveness(
			snap({
				currentStep: "execute",
				lastActivityAt: ago(STEP + 30_000),
				turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
				sessions: [
					{ agentType: "codex", healthState: "healthy", mountAlive: false },
					{ agentType: "claude", healthState: "healthy", mountAlive: true },
				],
			}),
		);
		expect(r.stuck).toBe(true);
		expect(r.why).toMatch(/mount not alive|no progress/);
	});

	it("relevant-agent: active (turnOwner) dead while idle peer alive → stuck", () => {
		const r = computeLiveness(
			snap({
				currentStep: "execute",
				lastActivityAt: ago(STEP + 30_000),
				turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
				sessions: [
					{ agentType: "codex", healthState: "healthy", mountAlive: false }, // active, dead
					{ agentType: "claude", healthState: "healthy", mountAlive: true }, // peer, alive
				],
			}),
		);
		expect(r.stuck).toBe(true);
	});

	it("relevant-agent: active alive while idle peer dead → long-running, not stuck", () => {
		const r = computeLiveness(
			snap({
				currentStep: "execute",
				lastActivityAt: ago(STEP + 30_000),
				turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
				sessions: [
					{ agentType: "codex", healthState: "healthy", mountAlive: true }, // active, alive
					{ agentType: "claude", healthState: "healthy", mountAlive: false }, // peer, dead
				],
			}),
		);
		expect(r.stuck).toBe(false);
		expect(r.liveText).toMatch(/long-running/);
	});

	it("owner none → falls back to waitingAgent as the relevant agent", () => {
		// owner none, waiting claude; claude is dead → stuck.
		const dead = computeLiveness(
			snap({
				currentStep: "execute",
				lastActivityAt: ago(STEP + 30_000),
				turn: { turnOwner: "none", waitingAgent: "claude", handoffState: "pending" },
				sessions: [
					{ agentType: "codex", healthState: "healthy", mountAlive: true },
					{ agentType: "claude", healthState: "healthy", mountAlive: false },
				],
			}),
		);
		expect(dead.stuck).toBe(true);
		// owner none, waiting claude; claude alive → long-running.
		const alive = computeLiveness(
			snap({
				currentStep: "execute",
				lastActivityAt: ago(STEP + 30_000),
				turn: { turnOwner: "none", waitingAgent: "claude", handoffState: "pending" },
				sessions: [
					{ agentType: "codex", healthState: "healthy", mountAlive: false },
					{ agentType: "claude", healthState: "healthy", mountAlive: true },
				],
			}),
		);
		expect(alive.stuck).toBe(false);
	});

	it("degraded-but-alive active agent over budget → NOT stuck (degraded ≠ stuck)", () => {
		const r = computeLiveness(
			snap({
				currentStep: "execute",
				lastActivityAt: ago(STEP + 30_000),
				turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
				sessions: [
					{ agentType: "codex", healthState: "degraded", mountAlive: true },
					{ agentType: "claude", healthState: "healthy", mountAlive: true },
				],
			}),
		);
		expect(r.stuck).toBe(false);
		expect(r.liveText).toMatch(/long-running/);
	});

	it("offline active agent over budget → stuck even with mountAlive unknown", () => {
		const r = computeLiveness(
			snap({
				currentStep: "execute",
				lastActivityAt: ago(STEP + 30_000),
				turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
				sessions: [
					{ agentType: "codex", healthState: "offline" },
					{ agentType: "claude", healthState: "healthy", mountAlive: true },
				],
			}),
		);
		expect(r.stuck).toBe(true);
	});

	it("offline active agent UNDER budget → stuck (provider offline)", () => {
		const r = computeLiveness(
			snap({
				currentStep: "execute",
				lastActivityAt: ago(5_000),
				turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
				sessions: [
					{ agentType: "codex", healthState: "offline" },
					{ agentType: "claude", healthState: "healthy", mountAlive: true },
				],
			}),
		);
		expect(r.stuck).toBe(true);
	});

	it("higher-precedence: halt wins over a live mount", () => {
		const r = computeLiveness(
			snap({
				lastActivityAt: ago(STEP + 30_000),
				workflow: {
					workflowId: "wf_1",
					workflowType: "spec-driven-development",
					name: "x",
					status: "halted",
					createdAt: ago(3_600_000),
					haltReason: "boom",
				},
				sessions: [
					{ agentType: "codex", healthState: "healthy", mountAlive: true },
					{ agentType: "claude", healthState: "healthy", mountAlive: true },
				],
			}),
		);
		expect(r.stuck).toBe(true);
		expect(r.why).toContain("boom");
	});

	it("higher-precedence: chain escalated wins over a live mount", () => {
		const r = computeLiveness(
			snap({
				lastActivityAt: ago(5_000),
				chain: { currentRound: 2, maxRounds: 5, status: "escalated" },
			}),
		);
		expect(r.stuck).toBe(true);
		expect(r.why).toContain("chain escalated");
	});

	it("higher-precedence: round-max wins over a live mount", () => {
		const r = computeLiveness(
			snap({
				lastActivityAt: ago(5_000),
				chain: { currentRound: 5, maxRounds: 5, status: "active" },
			}),
		);
		expect(r.stuck).toBe(true);
		expect(r.why).toContain("round 5/5");
	});

	it("a PAUSED workflow is quiescent, not stuck — even when long-idle with a dead/absent mount", () => {
		// Regression: a paused workflow fell through to idle/mount-liveness checks
		// because there was no short-circuit for `paused`. The run is idle well past
		// budget and its mount is gone (mountAlive absent → false), so it was
		// wrongly reported stuck:true. A paused workflow is operator-suspended and
		// resumable — it is quiescent, never stuck.
		const r = computeLiveness(
			snap({
				workflow: {
					workflowId: "wf_paused",
					workflowType: "spec-driven-development",
					name: "x",
					status: "paused",
					createdAt: ago(3_600_000),
					haltReason: null,
				},
				lastActivityAt: ago(STEP * 5), // long past any budget
				sessions: [], // mounts gone → mountAlive absent → false
				turn: { turnOwner: "none", waitingAgent: null, handoffState: "idle" },
			}),
		);
		expect(r.stuck).toBe(false);
		expect(r.why).toBeNull();
		expect(r.liveText).toBe("paused");
	});

	it("env override of AI_WHISPER_STUCK_THRESHOLD_MS changes the boundary", () => {
		process.env[ENV] = "120000"; // 2 min base
		// non-execute step → base budget = 120s. idle 130s with dead active → stuck.
		const r = computeLiveness(
			snap({
				currentStep: "ack",
				lastActivityAt: ago(130_000),
				sessions: [
					{ agentType: "codex", healthState: "healthy", mountAlive: false },
					{ agentType: "claude", healthState: "healthy", mountAlive: true },
				],
			}),
		);
		expect(r.stuck).toBe(true);
		// idle 110s < 120s base → not stuck even with dead mount.
		const under = computeLiveness(
			snap({
				currentStep: "ack",
				lastActivityAt: ago(110_000),
				sessions: [
					{ agentType: "codex", healthState: "healthy", mountAlive: false },
					{ agentType: "claude", healthState: "healthy", mountAlive: true },
				],
			}),
		);
		expect(under.stuck).toBe(false);
	});
});
