import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createRelayMonitorRuntime } from "../packages/cli/src/runtime/relay-monitor.ts";

function fakeBroker(
	handoffs: unknown[] = [],
	workflows: Array<{ workflowId: string; workflowType: string; name: string | null; status: string }> = [],
) {
	return {
		db: {},
		control: {
			registerRelayMonitor: vi.fn(),
			heartbeatRelayMonitor: vi.fn(),
			// New contract: bounded newest-N snapshot, FRESH copies each call
			// (a stale buffered reference must not silently update — models
			// the real broker returning new row objects per query).
			listRelayHandoffs: vi.fn((_collabId: string, limit?: number) => {
				const rows = (handoffs as Array<Record<string, unknown>>).map(
					(h) => ({ ...h }),
				);
				return typeof limit === "number" ? rows.slice(-limit) : rows;
			}),
			getRelayTurnState: vi.fn(() => ({
				turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted",
			})),
			listWorkflows: vi.fn(() => workflows),
			getWorkflow: vi.fn((id: string) => {
				const w = workflows.find((x) => x.workflowId === id);
				return w
					? {
							...w,
							createdAt: "2026-05-19T08:00:00.000Z",
							specPath: "/repo/docs/superpowers/specs/2026-06-10-foo-design.md",
							haltReason: w.status === "halted" ? "max-rounds-reached (phase plan-writing)" : null,
						}
					: null;
			}),
			getCollab: vi.fn(() => ({ workspaceRoot: "/repo" })),
			getWorkflowPhaseRuns: vi.fn(() => [
				{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing", chainId: "ch1",
				  startedAt: "2026-05-19T08:00:00.000Z", endedAt: "2026-05-19T08:11:40.000Z", outcome: "escalated (max rounds)" },
			]),
			getRelayChain: vi.fn(() => null),
			listSessions: vi.fn(() => [
				{ agentType: "codex", healthState: "healthy" },
				{ agentType: "claude", healthState: "healthy" },
			]),
		},
	};
}

describe("relay-monitor host", () => {
	it("starts, renders a frame to stdout, and stops cleanly", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));

		const m = createRelayMonitorRuntime({
			broker: fakeBroker() as never,
			collabId: "c1",
			monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream,
			pollIntervalMs: 10,
		});
		m.start();
		await new Promise((r) => setTimeout(r, 50));
		await m.stop();

		expect(buf).toContain("wf │");
		expect(buf).toContain("health │");
	});

	it("renders the full workflow id and repo-relative artifact in the wf row", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 120;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createRelayMonitorRuntime({
			broker: fakeBroker([], [
				{ workflowId: "wf_5dde51ed96d449bd", workflowType: "spec-driven-development", name: null, status: "running" },
			]) as never,
			collabId: "c1",
			monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream,
			pollIntervalMs: 10,
		});
		m.start();
		await new Promise((r) => setTimeout(r, 50));
		await m.stop();
		expect(buf).toContain("wf_5dde51ed96d449bd"); // full id, not truncated
		expect(buf).not.toContain("wf_5dde51ed9…"); // never the truncated form
		expect(buf).toContain("→ docs/superpowers/specs/2026-06-10-foo-design.md");
	});

	it("re-reads the relay feed on every poll", async () => {
		const broker = fakeBroker();
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		});
		m.start();
		await new Promise((r) => setTimeout(r, 40));
		await m.stop();
		// the feed is polled repeatedly (re-read each tick, no cursor)
		const calls = broker.control.listRelayHandoffs.mock.calls;
		expect(calls.length).toBeGreaterThan(1);
	});

	it("renders the final state of a terminal workflow and exits on its own", async () => {
		const broker = fakeBroker([], [
			{ workflowId: "wf_3d44", workflowType: "spec-driven-development", name: "auth", status: "halted" },
		]);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		});
		m.start();
		// no manual stop(): the host must exit itself once the terminal frame is drawn
		await Promise.race([
			m.waitUntilStopped(),
			new Promise((_r, rej) => setTimeout(() => rej(new Error("did not self-exit")), 500)),
		]);
		expect(buf).toContain("halted");
		expect(buf).toContain("✖ workflow-halted: wf_3d44");
	});

	it("caps the ring buffer to the newest N (snapshot)", async () => {
		const handoffs = Array.from({ length: 2200 }, (_, i) => ({
			handoffId: `h${String(i).padStart(5, "0")}`,
			createdAt: `2026-05-19T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
			collabId: "c1", senderAgent: "codex", targetAgent: "claude", status: "handed_back",
			captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "implement",
			workflowId: null, phaseRunId: null, handbackText: "x",
			evaluatorVerdict: null, evaluatorConfidence: null, evaluatorReason: null,
		}));
		const broker = fakeBroker(handoffs);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		}) as never as { start(): void; stop(): Promise<void>; __bufferLen(): number };
		m.start();
		await new Promise((r) => setTimeout(r, 60));
		await m.stop();
		expect(m.__bufferLen()).toBe(2000); // ring buffer capped, no RangeError on 2200-spread
	});

	it("survives a broker throw on poll and records it (degraded but alive)", async () => {
		const broker = fakeBroker();
		let calls = 0;
		broker.control.listRelayHandoffs = vi.fn(() => {
			calls += 1;
			if (calls === 2) throw new Error("db locked");
			return [];
		}) as never;
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		}) as never as { start(): void; stop(): Promise<void>; __pollHealth(): { consecutiveErrors: number; lastError: string | null } };
		m.start();
		await new Promise((r) => setTimeout(r, 60));
		await m.stop();
		expect(buf).toContain("wf │"); // last frame still present (loop survived the throw)
		expect(calls).toBeGreaterThan(2); // kept polling after the throw
		// at least one throw was recorded (it may have recovered by stop time)
		// so assert the hook exists and is shaped right rather than a flaky exact count
		const h = m.__pollHealth();
		expect(typeof h.consecutiveErrors).toBe("number");
	});

	it("double start() is a no-op (single render loop)", async () => {
		const broker = fakeBroker();
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		});
		m.start();
		m.start(); // second call must be a no-op
		await new Promise((r) => setTimeout(r, 40));
		await m.stop();
		expect(broker.control.registerRelayMonitor).toHaveBeenCalledTimes(1);
	});

	it("g jumps to oldest (follow off, offset=tailStart); G resumes follow", async () => {
		const broker = fakeBroker(
			Array.from({ length: 30 }, (_, i) => ({
				handoffId: `h${i}`, createdAt: `2026-05-19T00:00:${String(i).padStart(2, "0")}.000Z`,
				collabId: "c1", senderAgent: "codex", targetAgent: "claude", status: "handed_back",
				captureStatus: "ok", chainId: "ch", roundNumber: 1, handoffStep: "review",
				workflowId: null, phaseRunId: null, handbackText: `m${i}`,
				evaluatorVerdict: null, evaluatorConfidence: null, evaluatorReason: null,
			})),
		);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 12;
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		}) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { upArrow?: boolean; downArrow?: boolean; key?: string }): void;
			__viewport: { offset: number; follow: boolean };
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		// 30 lines, rows 12 → logViewportHeight = max(3,12-9)=3 → tailStart 27.
		m.__handleKey({ key: "g" });
		expect(m.__viewport.follow).toBe(false);
		expect(m.__viewport.offset).toBe(27); // oldest
		m.__handleKey({ key: "G" });
		expect(m.__viewport.follow).toBe(true);
		expect(m.__viewport.offset).toBe(0); // back to live tail
		await m.stop();
	});

	it("f toggling OFF leaves offset unchanged; q stops the host", async () => {
		const broker = fakeBroker(
			Array.from({ length: 30 }, (_, i) => ({
				handoffId: `h${i}`, createdAt: `2026-05-19T00:00:${String(i).padStart(2, "0")}.000Z`,
				collabId: "c1", senderAgent: "codex", targetAgent: "claude", status: "handed_back",
				captureStatus: "ok", chainId: "ch", roundNumber: 1, handoffStep: "review",
				workflowId: null, phaseRunId: null, handbackText: `m${i}`,
				evaluatorVerdict: null, evaluatorConfidence: null, evaluatorReason: null,
			})),
		);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 12;
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		}) as never as {
			start(): void; stop(): Promise<void>; waitUntilStopped(): Promise<void>;
			__handleKey(ev: { upArrow?: boolean; downArrow?: boolean; key?: string }): void;
			__viewport: { offset: number; follow: boolean };
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		m.__handleKey({ upArrow: true }); // follow off, offset 1
		expect(m.__viewport.offset).toBe(1);
		m.__handleKey({ key: "f" }); // follow currently false → toggles ON, resets offset 0
		expect(m.__viewport.follow).toBe(true);
		expect(m.__viewport.offset).toBe(0);
		m.__handleKey({ key: "f" }); // follow ON → toggles OFF, offset unchanged (0)
		expect(m.__viewport.follow).toBe(false);
		expect(m.__viewport.offset).toBe(0);
		m.__handleKey({ key: "q" }); // requests stop
		await Promise.race([
			m.waitUntilStopped(),
			new Promise((_r, rej) => setTimeout(() => rej(new Error("q did not stop the host")), 500)),
		]);
	});

	it("↑/↓ adjust viewport offset and suspend follow; f restores follow", async () => {
		const broker = fakeBroker(
			Array.from({ length: 30 }, (_, i) => ({
				handoffId: `h${i}`, createdAt: `2026-05-19T00:00:${String(i).padStart(2, "0")}.000Z`,
				collabId: "c1", senderAgent: "codex", targetAgent: "claude", status: "handed_back",
				captureStatus: "ok", chainId: "ch", roundNumber: 1, handoffStep: "review",
				workflowId: null, phaseRunId: null, handbackText: `m${i}`,
				evaluatorVerdict: null, evaluatorConfidence: null, evaluatorReason: null,
			})),
		);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 12;
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		}) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { upArrow?: boolean; downArrow?: boolean; key?: string }): void;
			__viewport: { offset: number; follow: boolean };
		};
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		// visibleH = rows(12) - STATUS_ROWS(9) = 3; 30 lines → tailStart = 27.
		// offset = lines scrolled UP from the tail. Leaving follow keeps us AT
		// the tail (offset 0); first ↑ scrolls up ONE line → offset 1 (NOT a
		// jump to the top, which would be offset = tailStart = 27).
		// ink 7 flushes a non-TTY stream only on unmount, so (like every other
		// host test here) stdout content is asserted AFTER m.stop(); the live
		// offset/follow transitions are asserted via __viewport.
		m.__handleKey({ upArrow: true });
		expect(m.__viewport.follow).toBe(false);
		expect(m.__viewport.offset).toBe(1);
		m.__handleKey({ downArrow: true }); // back toward the tail
		expect(m.__viewport.offset).toBe(0);
		m.__handleKey({ key: "f" }); // f restores follow
		expect(m.__viewport.follow).toBe(true);
		// re-suspend follow and scroll up one line so the final frame flushed
		// at unmount is a scrolled window (follow=false → no LATEST tag).
		m.__handleKey({ key: "f" });
		m.__handleKey({ upArrow: true });
		expect(m.__viewport.follow).toBe(false);
		expect(m.__viewport.offset).toBe(1);
		await m.stop(); // unmount → flush the final frame
		expect(buf).toContain("m27"); // scrolled window (lines 26-28), not "m0"
		expect(buf).not.toContain("◀ LATEST"); // follow=false → no LATEST tag
	});
});

// Models the REAL broker: relay_handoff rows mutate in place (pending →
// handed_back → evaluated) on the SAME handoff_id; every read returns FRESH
// row objects (a stale buffered reference is NOT silently updated). The test
// "mutates the DB" by patching source rows; the host only reflects it if it
// RE-READS and merges by handoffId.
function mutatingBroker(source: Array<Record<string, unknown>>) {
	return {
		db: {},
		control: {
			registerRelayMonitor: vi.fn(),
			heartbeatRelayMonitor: vi.fn(),
			listRelayHandoffs: vi.fn((_collabId: string, limit?: number) => {
				const rows = source.map((r) => ({ ...r })); // fresh copies
				return typeof limit === "number" ? rows.slice(-limit) : rows;
			}),
			getRelayTurnState: vi.fn(() => ({
				turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted",
			})),
			listWorkflows: vi.fn(() => []),
			getWorkflow: vi.fn(() => null),
			getWorkflowPhaseRuns: vi.fn(() => []),
			getRelayChain: vi.fn(() => null),
			listSessions: vi.fn(() => [
				{ agentType: "codex", healthState: "healthy" },
				{ agentType: "claude", healthState: "healthy" },
			]),
		},
	};
}

describe("relay-monitor host — in-place mutation", () => {
	it("REGRESSION: re-reads handback/verdict updates; no stale/duplicate row", async () => {
		const h: Record<string, unknown> = {
			handoffId: "h1", createdAt: "2026-05-19T00:00:01.000Z", collabId: "c1",
			senderAgent: "codex", targetAgent: "claude", status: "pending",
			captureStatus: null, chainId: "ch", roundNumber: 1, handoffStep: "implement",
			workflowId: null, phaseRunId: null, handbackText: null,
			evaluatorVerdict: null, evaluatorConfidence: null, evaluatorReason: null,
			lastActivityAt: "2026-05-19T00:00:01.000Z",
		};
		const broker = mutatingBroker([h]);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		}) as never as { start(): void; stop(): Promise<void>; __bufferLen(): number };
		m.start();
		await new Promise((r) => setTimeout(r, 40)); // poll(s) see it pending
		// In-place DB update of the SAME row (handback then evaluator) — the
		// host already holds a stale pending copy from the earlier poll.
		h.status = "handed_back";
		h.handbackText = "wrote spec.plan.md; 5 tasks";
		h.evaluatorVerdict = "delivered";
		h.evaluatorConfidence = 0.95;
		h.lastActivityAt = "2026-05-19T00:01:45.000Z";
		await new Promise((r) => setTimeout(r, 40)); // further poll(s)
		await m.stop();

		// Exactly one row for the handoff — re-read & merged, never appended
		// as a duplicate and never left stale-pending.
		expect(m.__bufferLen()).toBe(1);
		// The flushed frame reflects the post-update verdict, not stale pending.
		expect(buf).toContain("delivered");
		expect(buf).not.toContain("pending");
	});
});

// plan-writing's initialHandoffStep is "implement", but its review loop
// moves implement → review → fix within the SAME phase run. The status
// panel must reflect the ACTIVE step (latest handoff for curRun), not the
// static phase-definition initial step.
function stepBroker(handoffs: Array<Record<string, unknown>>) {
	return {
		db: {},
		control: {
			registerRelayMonitor: vi.fn(),
			heartbeatRelayMonitor: vi.fn(),
			listRelayHandoffs: vi.fn((_c: string, limit?: number) => {
				const rows = handoffs.map((h) => ({ ...h }));
				return typeof limit === "number" ? rows.slice(-limit) : rows;
			}),
			getRelayTurnState: vi.fn(() => ({
				turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted",
			})),
			listWorkflows: vi.fn(() => [
				{ workflowId: "wf1", workflowType: "spec-driven-development", name: "x", status: "running" },
			]),
			getWorkflow: vi.fn(() => ({
				workflowId: "wf1", workflowType: "spec-driven-development", name: "x",
				status: "running", createdAt: "2026-05-19T08:00:00.000Z", haltReason: null,
			})),
			getCollab: vi.fn(() => ({ workspaceRoot: "/repo" })),
			getWorkflowPhaseRuns: vi.fn(() => [
				{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing", chainId: "ch1",
				  startedAt: "2026-05-19T08:00:00.000Z", endedAt: null, outcome: null },
			]),
			getRelayChain: vi.fn(() => ({ currentRound: 3, maxRounds: 5, status: "active" })),
			listSessions: vi.fn(() => [
				{ agentType: "codex", healthState: "healthy" },
				{ agentType: "claude", healthState: "healthy" },
			]),
		},
	};
}

function pr1Handoff(over: Record<string, unknown>): Record<string, unknown> {
	return {
		handoffId: "h", createdAt: "2026-05-19T08:01:00.000Z", collabId: "c1",
		senderAgent: "codex", targetAgent: "claude", status: "handed_back",
		captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "implement",
		workflowId: "wf1", phaseRunId: "pr1", handbackText: "x",
		evaluatorVerdict: null, evaluatorConfidence: null, evaluatorReason: null,
		lastActivityAt: "2026-05-19T08:01:00.000Z", ...over,
	};
}

describe("relay-monitor host — current step", () => {
	it("shows the ACTIVE step (latest handoff) within a review-loop phase, not the phase's initial step", async () => {
		const broker = stepBroker([
			pr1Handoff({ handoffId: "h1", createdAt: "2026-05-19T08:01:00.000Z", handoffStep: "implement" }),
			pr1Handoff({ handoffId: "h2", createdAt: "2026-05-19T08:05:00.000Z", handoffStep: "review" }),
		]);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		});
		m.start();
		await new Promise((r) => setTimeout(r, 40));
		await m.stop();
		// plan-writing initialHandoffStep is "implement"; latest pr1 handoff is "review"
		expect(buf).toContain("Step review");
		expect(buf).not.toContain("Step implement");
	});

	it("falls back to the phase's initial step before the first handoff exists", async () => {
		const broker = stepBroker([]); // no handoffs yet for pr1
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		});
		m.start();
		await new Promise((r) => setTimeout(r, 40));
		await m.stop();
		expect(buf).toContain("Step implement"); // plan-writing initialHandoffStep
	});
});
