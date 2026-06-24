import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createDashboardRuntime } from "../packages/cli/src/runtime/dashboard.ts";

function fakeBroker(summaries: unknown[] = []) {
	const control = {
		registerRelayMonitor: vi.fn(),
		heartbeatRelayMonitor: vi.fn(),
		listActiveCollabSummaries: vi.fn((_w: number, _n?: string) =>
			(summaries as Array<Record<string, unknown>>).map((s) => ({ ...s })),
		),
		listAllWorkflowSummaries: vi.fn((_w: number, _n?: string) =>
			(summaries as Array<Record<string, unknown>>).map((s) => ({ ...s })),
		),
		listRelayHandoffs: vi.fn(() => []),
		getWorkflow: vi.fn(() => null),
		getCollab: vi.fn(() => ({ workspaceRoot: "/repo" })),
		getWorkflowPhaseRuns: vi.fn(() => []),
		getRelayChain: vi.fn(() => null),
		getRelayTurnState: vi.fn(() => ({ turnOwner: "none", waitingAgent: null, handoffState: "idle" })),
		listSessions: vi.fn(() => []),
		listSessionAttachments: vi.fn(() => []),
		listEvaluatorDiagnosticsByCollab: vi.fn(() => []),
		listEvaluatorDiagnosticsByCollabAndChain: vi.fn(() => []),
		listCaptureDiagnosticsByCollab: vi.fn(() => []),
		listCaptureDiagnosticsByCollabAndChain: vi.fn(() => []),
		listRunCostRows: vi.fn(() => []),
		listWorkflowsForCollab: vi.fn(() => []),
	};
	return { db: {}, control };
}
function S(p: Record<string, unknown>) {
	return {
		collabId: "c1", label: "oauth", workflowId: "wf", workflowType: "spec-driven-development",
		workflowStatus: "running", currentPhaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing",
		currentRound: 3, maxRounds: 5, chainStatus: "active",
		turn: { owner: "codex", waiting: "claude", handoffState: "accepted" },
		sessions: [{ agentType: "codex", healthState: "healthy" }], lastActivityAt: "2026-05-20T00:00:00.000Z", ...p,
	};
}

describe("dashboard host", () => {
	it("renders the Wall and stops cleanly", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createDashboardRuntime({ broker: fakeBroker([S({})]) as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 });
		m.start();
		await new Promise((r) => setTimeout(r, 50));
		await m.stop();
		expect(buf).toContain("oauth");
		expect(buf).toContain("page 1/");
	});

	it("Enter switches to Inspector, Esc back; q stops", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createDashboardRuntime({ broker: fakeBroker([S({})]) as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as {
			start(): void; stop(): Promise<void>; waitUntilStopped(): Promise<void>;
			__handleKey(ev: { upArrow?: boolean; downArrow?: boolean; escape?: boolean; key?: string }): void;
			__mode(): string;
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		expect(m.__mode()).toBe("wall");
		m.__handleKey({ key: "\r" }); // Enter
		expect(m.__mode()).toBe("inspector");
		m.__handleKey({ escape: true }); // Esc
		expect(m.__mode()).toBe("wall");
		m.__handleKey({ key: "q" });
		await Promise.race([
			m.waitUntilStopped(),
			new Promise((_r, rej) => setTimeout(() => rej(new Error("q did not stop")), 500)),
		]);
	});

	it("Inspector ignores non-Esc empty-key events (Left/Right/Tab don't bounce to Wall)", async () => {
		// Regression: ink's useInput collapses many non-printable keys (Left,
		// Right, Tab, PageUp, Home, …) to inputCh = "". Earlier code treated
		// `ev.key === ""` as Esc and silently exited Inspector on any of them.
		// Now Esc is forwarded as `escape: true`; the empty-key events must be
		// no-ops in Inspector.
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createDashboardRuntime({ broker: fakeBroker([S({})]) as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { upArrow?: boolean; downArrow?: boolean; escape?: boolean; key?: string }): void;
			__mode(): string;
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		m.__handleKey({ key: "\r" }); // Enter → Inspector
		expect(m.__mode()).toBe("inspector");
		m.__handleKey({ key: "" }); // Left/Right/Tab/PageUp/Home — all surface as ""
		expect(m.__mode()).toBe("inspector"); // MUST still be Inspector
		m.__handleKey({ escape: true }); // explicit Esc now exits
		expect(m.__mode()).toBe("wall");
		await m.stop();
	});

	it("clears the screen on a wall<->inspector switch, but not on same-mode repaints", async () => {
		// Bug: switching views left the prior (taller) frame on screen and the new
		// view rendered below it ("duplicated/appended"). A view switch must fully
		// clear first; same-mode repaints must NOT (ink's incremental erase handles
		// those — a full clear every poll would flicker).
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createDashboardRuntime({
			broker: fakeBroker([S({})]) as never,
			dashboardId: "d1",
			stdout: stdout as unknown as NodeJS.WritableStream,
			pollIntervalMs: 10,
		}) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { key?: string; escape?: boolean }): void;
			__mode(): string; __clears(): number;
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		const base = m.__clears();
		m.__handleKey({ key: "\r" }); // wall → inspector
		expect(m.__mode()).toBe("inspector");
		expect(m.__clears()).toBe(base + 1); // switch cleared once
		// A same-mode no-op key must not add a clear (frame may be identical →
		// skipped entirely, or repaint without a full clear).
		m.__handleKey({ key: "1" }); // inspector section "live" (already live) — same mode
		expect(m.__clears()).toBe(base + 1);
		m.__handleKey({ escape: true }); // inspector → wall
		expect(m.__mode()).toBe("wall");
		expect(m.__clears()).toBe(base + 2); // switch back cleared again
		await m.stop();
	});

	it("survives a broker throw on poll (degraded but alive)", async () => {
		const broker = fakeBroker([S({})]);
		let n = 0;
		broker.control.listActiveCollabSummaries = vi.fn(() => {
			n += 1;
			if (n === 2) throw new Error("db locked");
			return [S({})];
		}) as never;
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 });
		m.start();
		await new Promise((r) => setTimeout(r, 60));
		await m.stop();
		expect(buf).toContain("oauth");
		expect(n).toBeGreaterThan(2);
	});

	it("double start() is a no-op (single poll loop, not two)", async () => {
		const broker = fakeBroker([S({})]);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 });
		m.start();
		m.start();
		await new Promise((r) => setTimeout(r, 60));
		await m.stop();
		// Single poll loop @ 10ms interval over 60ms should be a small number of
		// summary reads; two loops would roughly double it. Loose bounds catch
		// doubling without being flaky on slow CI.
		const calls = (broker.control.listActiveCollabSummaries as { mock: { calls: unknown[] } }).mock.calls.length;
		expect(calls).toBeGreaterThan(0);
		expect(calls).toBeLessThan(15);
	});

	it("F1: fetches per-collab snapshots ONLY for the visible page", async () => {
		const many = Array.from({ length: 5 }, (_, i) =>
			S({ collabId: `c${i}`, lastActivityAt: `2026-05-20T00:0${9 - i}:00.000Z` }),
		);
		const broker = fakeBroker(many);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 40; // gridCapacity(40,10) = 1*2 = 2
		(stdout as unknown as { rows: number }).rows = 10;
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 });
		m.start();
		await new Promise((r) => setTimeout(r, 40));
		await m.stop();
		const fetched = new Set(
			(broker.control.listRelayHandoffs as { mock: { calls: unknown[][] } }).mock.calls.map((cargs) => cargs[0]),
		);
		expect(fetched.size).toBeGreaterThan(0);
		expect(fetched.size).toBeLessThanOrEqual(2); // page capacity, NEVER all 5
	});

	it("F2: Inspector Live shows the ACTIVE step (latest handoff), not the phase initial", async () => {
		const phaseRuns = [{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing", chainId: "ch1", startedAt: "2026-05-20T00:00:00.000Z", endedAt: null, outcome: null }];
		const handoffs = [
			{ handoffId: "h1", createdAt: "2026-05-20T00:01:00.000Z", collabId: "c1", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "implement", workflowId: "wf1", phaseRunId: "pr1", handbackText: "x", evaluatorVerdict: "delivered", evaluatorConfidence: 0.6, evaluatorReason: "r", lastActivityAt: "2026-05-20T00:01:00.000Z" },
			{ handoffId: "h2", createdAt: "2026-05-20T00:05:00.000Z", collabId: "c1", senderAgent: "claude", targetAgent: "codex", status: "handed_back", captureStatus: "ok", chainId: "ch1", roundNumber: 3, handoffStep: "review", workflowId: "wf1", phaseRunId: "pr1", handbackText: null, evaluatorVerdict: "findings", evaluatorConfidence: 0.4, evaluatorReason: "r2", lastActivityAt: "2026-05-20T00:06:30.000Z" },
		];
		const broker = fakeBroker([S({ collabId: "c1", workflowId: "wf1", workflowType: "spec-driven-development", phaseIndex: 1, currentRound: 3, maxRounds: 5, chainStatus: "active" })]);
		broker.control.listRelayHandoffs = vi.fn(() => handoffs.map((h) => ({ ...h }))) as never;
		broker.control.getWorkflow = vi.fn(() => ({ workflowId: "wf1", workflowType: "spec-driven-development", name: "oauth", status: "running", createdAt: "2026-05-20T00:00:00.000Z", haltReason: null })) as never;
		broker.control.getWorkflowPhaseRuns = vi.fn(() => phaseRuns.map((p) => ({ ...p }))) as never;
		broker.control.getRelayChain = vi.fn(() => ({ chainId: "ch1", currentRound: 3, maxRounds: 5, status: "active" })) as never;
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as { start(): void; stop(): Promise<void>; __handleKey(ev: { key?: string }): void };
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		m.__handleKey({ key: "\r" }); // Enter → Inspector (live)
		await new Promise((r) => setTimeout(r, 20));
		await m.stop();
		expect(buf).toContain("Step review"); // latest handoff step (h2)
		expect(buf).not.toContain("Step implement"); // NOT plan-writing's initialHandoffStep
	});

	it("F4: Inspector Live wf row shows the full workflow id and the repo-relative artifact", async () => {
		const phaseRuns = [{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing", chainId: "ch1", startedAt: "2026-05-20T00:00:00.000Z", endedAt: null, outcome: null }];
		const handoffs = [
			{ handoffId: "h1", createdAt: "2026-05-20T00:01:00.000Z", collabId: "c1", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "implement", workflowId: "wf_5dde51ed96d449bd", phaseRunId: "pr1", handbackText: "x", evaluatorVerdict: "delivered", evaluatorConfidence: 0.6, evaluatorReason: "r", lastActivityAt: "2026-05-20T00:01:00.000Z" },
		];
		const broker = fakeBroker([S({ collabId: "c1", workflowId: "wf_5dde51ed96d449bd", workflowType: "spec-driven-development", phaseIndex: 1, currentRound: 1, maxRounds: 5, chainStatus: "active" })]);
		broker.control.listRelayHandoffs = vi.fn(() => handoffs.map((h) => ({ ...h }))) as never;
		broker.control.getWorkflow = vi.fn(() => ({ workflowId: "wf_5dde51ed96d449bd", workflowType: "spec-driven-development", name: null, status: "running", createdAt: "2026-05-20T00:00:00.000Z", haltReason: null, specPath: "/repo/docs/foo.md" })) as never;
		broker.control.getCollab = vi.fn(() => ({ workspaceRoot: "/repo" })) as never;
		broker.control.getWorkflowPhaseRuns = vi.fn(() => phaseRuns.map((p) => ({ ...p }))) as never;
		broker.control.getRelayChain = vi.fn(() => ({ chainId: "ch1", currentRound: 1, maxRounds: 5, status: "active" })) as never;
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 120;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as { start(): void; stop(): Promise<void>; __handleKey(ev: { key?: string }): void };
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		m.__handleKey({ key: "\r" }); // Enter → Inspector (live)
		await new Promise((r) => setTimeout(r, 20));
		await m.stop();
		expect(buf).toContain("wf_5dde51ed96d449bd"); // full id, not truncated
		expect(buf).not.toContain("wf_5dde51ed9…");
		expect(buf).toContain("→ docs/foo.md"); // repo-relative artifact in the wf row
	});

	it("F3: Inspector Live g/G/↑/f scroll-follow behaves like relay-monitor", async () => {
		const broker = fakeBroker([S({ collabId: "c1" })]);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { upArrow?: boolean; downArrow?: boolean; key?: string }): void;
			__viewport: { offset: number; follow: boolean };
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		m.__handleKey({ key: "\r" }); // Enter → inspector live
		expect(m.__viewport).toMatchObject({ offset: 0, follow: true });
		m.__handleKey({ upArrow: true });
		expect(m.__viewport.follow).toBe(false);
		expect(m.__viewport.offset).toBeGreaterThanOrEqual(0);
		m.__handleKey({ key: "g" });
		expect(m.__viewport.follow).toBe(false); // jump to oldest
		m.__handleKey({ key: "G" });
		expect(m.__viewport).toMatchObject({ offset: 0, follow: true }); // back to tail
		m.__handleKey({ key: "f" });
		expect(m.__viewport.follow).toBe(false); // toggle off
		await m.stop();
	});

	it("forwards a workflow-scoped filter to listRelayHandoffs for each Wall pane and the Inspector", async () => {
		// A single collab can have multiple workflow runs over time + manual
		// relays. The dashboard must scope its handoff reads to the specific
		// run a pane (or the Inspector) represents — otherwise the wall tail
		// and Inspector Live can mix unrelated rows, and (with a tight LIMIT)
		// a noisier sibling run on the same collab can starve the displayed
		// run's tail entirely. Filter is applied SQL-side via `workflowFilter`.
		const broker = fakeBroker([
			S({ collabId: "c_wf", workflowId: "wf_a", workflowType: "spec-driven-development" }),
			S({ collabId: "c_man", workflowId: null, workflowType: null, label: "manual one" }),
		]);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { key?: string }): void;
			__wallSelected(): number;
		};
		m.start();
		await new Promise((r) => setTimeout(r, 40));

		// Wall pane forwarding: at least one call per pane, each with a filter
		// that matches the pane's workflowId (or { manualOnly: true } for null).
		const wallCalls = (broker.control.listRelayHandoffs as { mock: { calls: unknown[][] } }).mock.calls.map(
			(c) => ({ collabId: c[0] as string, opts: c[2] as { workflowFilter?: unknown } | undefined }),
		);
		const wfCall = wallCalls.find((c) => c.collabId === "c_wf");
		const manCall = wallCalls.find((c) => c.collabId === "c_man");
		expect(wfCall?.opts?.workflowFilter).toEqual({ workflowId: "wf_a" });
		expect(manCall?.opts?.workflowFilter).toEqual({ manualOnly: true });

		// Inspector forwarding: Enter to inspect the workflow-backed pane.
		// wallSelected may have been clamped by the wall page; ensure we have
		// the workflow pane selected.
		while (m.__wallSelected() > 0) m.__handleKey({ key: "k" });
		(broker.control.listRelayHandoffs as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
		m.__handleKey({ key: "\r" });
		await new Promise((r) => setTimeout(r, 20));
		const inspectorCall = (broker.control.listRelayHandoffs as { mock: { calls: unknown[][] } }).mock.calls.find(
			(c) => (c[2] as { workflowFilter?: { workflowId?: string } } | undefined)?.workflowFilter?.workflowId === "wf_a",
		);
		expect(inspectorCall).toBeDefined();
		expect(inspectorCall![1]).toBe(200); // Inspector pulls the full tail
		await m.stop();
	});

	it("forwards a workflow-scoped filter to the diagnostics fallback when there's no chain to scope by", async () => {
		// The Inspector falls back to listEvaluator/CaptureDiagnosticsByCollab
		// when getRelayChain returns null (brand-new workflow with no phase yet,
		// or manual relay panes). Same defect class as the handoff filter —
		// without an SQL-level workflow filter, sibling-run diagnostics on the
		// same collab would leak into the Evidence section.
		const broker = fakeBroker([
			S({ collabId: "c_wf", workflowId: "wf_a", workflowType: "spec-driven-development" }),
			S({ collabId: "c_man", workflowId: null, workflowType: null, label: "manual one" }),
		]);
		// Force the "no chain" fallback by returning empty phase runs (so
		// curRun is null → chain is null → chainId is null).
		broker.control.getWorkflowPhaseRuns = vi.fn(() => []) as never;
		broker.control.getRelayChain = vi.fn(() => null) as never;
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { key?: string; escape?: boolean }): void;
			__wallSelected(): number;
		};
		m.start();
		await new Promise((r) => setTimeout(r, 40));

		// Inspect the workflow-backed pane → fallback fires with workflowId filter.
		while (m.__wallSelected() > 0) m.__handleKey({ key: "k" });
		(broker.control.listEvaluatorDiagnosticsByCollab as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
		(broker.control.listCaptureDiagnosticsByCollab as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
		(broker.control.listEvaluatorDiagnosticsByCollabAndChain as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
		(broker.control.listCaptureDiagnosticsByCollabAndChain as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
		m.__handleKey({ key: "\r" });
		await new Promise((r) => setTimeout(r, 20));

		const evalWfCall = (broker.control.listEvaluatorDiagnosticsByCollab as { mock: { calls: unknown[][] } }).mock.calls[0];
		const capWfCall = (broker.control.listCaptureDiagnosticsByCollab as { mock: { calls: unknown[][] } }).mock.calls[0];
		expect(evalWfCall).toBeDefined();
		expect(capWfCall).toBeDefined();
		expect((evalWfCall![2] as { workflowFilter?: unknown }).workflowFilter).toEqual({ workflowId: "wf_a" });
		expect((capWfCall![2] as { workflowFilter?: unknown }).workflowFilter).toEqual({ workflowId: "wf_a" });
		// The chain-scoped variants must NOT be called when chain is null.
		expect((broker.control.listEvaluatorDiagnosticsByCollabAndChain as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
		expect((broker.control.listCaptureDiagnosticsByCollabAndChain as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);

		// Escape back to the wall, select the manual pane, inspect → fallback fires with manualOnly.
		m.__handleKey({ escape: true });
		await new Promise((r) => setTimeout(r, 20));
		m.__handleKey({ key: "j" }); // move to manual pane
		(broker.control.listEvaluatorDiagnosticsByCollab as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
		(broker.control.listCaptureDiagnosticsByCollab as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
		m.__handleKey({ key: "\r" });
		await new Promise((r) => setTimeout(r, 20));
		const evalManCall = (broker.control.listEvaluatorDiagnosticsByCollab as { mock: { calls: unknown[][] } }).mock.calls[0];
		const capManCall = (broker.control.listCaptureDiagnosticsByCollab as { mock: { calls: unknown[][] } }).mock.calls[0];
		expect(evalManCall).toBeDefined();
		expect(capManCall).toBeDefined();
		expect((evalManCall![2] as { workflowFilter?: unknown }).workflowFilter).toEqual({ manualOnly: true });
		expect((capManCall![2] as { workflowFilter?: unknown }).workflowFilter).toEqual({ manualOnly: true });
		await m.stop();
	});

	// Memory-leak guards (ink.rerender leaks ~KB/call; the 250ms poll OOM'd
	// overnight). Fix 1: skip rerender on an unchanged frame. Fix 3: recycle the
	// ink instance every N renders to hard-bound retained memory.
	it("leak fix 1: skips ink rerender when the frame is unchanged", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		// Empty dashboard → a static frame (no per-pane ticking idle/elapsed timers).
		const m = createDashboardRuntime({
			broker: fakeBroker([]) as never,
			dashboardId: "d1",
			stdout: stdout as unknown as NodeJS.WritableStream,
			pollIntervalMs: 10,
		}) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { key?: string }): void; __renderCount(): number;
		};
		m.start();
		const c1 = m.__renderCount();
		for (let i = 0; i < 20; i++) m.__handleKey({ key: "x" }); // no-op key → rerender(), identical frame
		expect(m.__renderCount()).toBe(c1); // unchanged frame → ZERO extra ink rerenders
		await m.stop();
	});

	it("leak fix 3: recycles the ink instance every N renders and keeps rendering", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		let n = 0;
		const broker = fakeBroker([]);
		// each frame is DISTINCT (label changes) → every poll actually renders
		broker.control.listActiveCollabSummaries = vi.fn(() => [S({ label: `oauth-${n++}` })]) as never;
		const m = createDashboardRuntime({
			broker: broker as never,
			dashboardId: "d1",
			stdout: stdout as unknown as NodeJS.WritableStream,
			pollIntervalMs: 10,
			__recycleEveryRenders: 3,
		} as never) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { key?: string }): void; __recycles(): number;
		};
		m.start();
		for (let i = 0; i < 12; i++) m.__handleKey({ key: "x" }); // 12 distinct frames → renders
		expect(m.__recycles()).toBeGreaterThan(0); // recycled at least once
		expect(buf).toContain("oauth-"); // still rendering after a recycle
		await m.stop();
	});

	it("Enter inspects the SELECTED pane's run, not the collab's latest (two runs, one collab)", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const broker = fakeBroker([
			S({ collabId: "c1", workflowId: "wf_a", label: "A" }),
			S({ collabId: "c1", workflowId: "wf_b", label: "B" }),
		]);
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { key?: string; downArrow?: boolean }): void;
			__inspectorWorkflowId(): string | null;
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		m.__handleKey({ downArrow: true }); // move selection to the 2nd pane (wf_b)
		m.__handleKey({ key: "\r" }); // Enter
		expect(m.__inspectorWorkflowId()).toBe("wf_b");
		await m.stop();
	});

	it("showAll fetches listAllWorkflowSummaries instead of listActiveCollabSummaries", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const broker = fakeBroker([S({ collabId: "c1", workflowId: "wf_a" })]);
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10, showAll: true }) as never as { start(): void; stop(): Promise<void> };
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		await m.stop();
		expect((broker.control.listAllWorkflowSummaries as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
		expect((broker.control.listActiveCollabSummaries as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
	});
});
