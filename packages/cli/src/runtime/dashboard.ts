import { render } from "ink";
import { createElement } from "react";
import type { ReactElement } from "react";
import type { BrokerRuntime } from "@ai-whisper/broker";
import { getWorkflowDefinition } from "@ai-whisper/broker";
import { displayArtifactPath } from "@ai-whisper/shared";
import {
	Wall,
	Inspector,
	DashboardApp,
	type InspectorSection,
} from "./dashboard-view.js";
import type { Viewport } from "./relay-view.js";
import { logViewportHeight } from "./relay-view.js";
import {
	allocateWallSections,
	buildWallState,
	buildInspectorState,
	partitionWallGroups,
	runKey,
	summarizeWall,
	actionsForStatus,
	type WorkflowAction,
	type InspectorState,
	type PhaseRunRef,
	type RelayViewSnapshot,
} from "./dashboard-state.js";

// Host-only pid-liveness probe (Bug C). Lives here, NOT in the pure builders,
// so computeLiveness stays deterministic. Absent pid → false (conservative, so
// the signal never masks a real hang). EPERM means the process exists but is
// not signalable by us → treat as alive.
export function probeMountAlive(
	pid: number | null,
	kill: (pid: number, signal: number) => void = (p, s) => {
		process.kill(p, s);
	},
): boolean {
	if (pid == null) return false;
	try {
		kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

// Build a per-agent mountAlive resolver from a collab's session attachments.
// Liveness comes ONLY from the `mounted` attachment's pid — the provider process
// recorded at mount (spec §Bug C, lines 122-138). Non-`mounted` kinds
// (`owned`/`adopted`) are NOT a liveness source: a live stale owned pid must
// never stand in for the mount. If there is no `mounted` row for the agent (or
// its pid is null/absent), mountAlive is false (conservative: an absent mount pid
// must allow STUCK, never be masked). Probes process.kill here (host), keeping
// the pure builders deterministic.
export function buildMountAliveByAgent(
	attachments: Array<{ agentType: string; attachmentKind: string; pid: number | null }>,
): (agentType: string) => boolean {
	const mountedPidByAgent = new Map<string, number | null>();
	for (const a of attachments) {
		if (a.attachmentKind === "mounted") {
			mountedPidByAgent.set(a.agentType, a.pid);
		}
	}
	return (agentType: string) =>
		probeMountAlive(mountedPidByAgent.get(agentType) ?? null);
}

const DEFAULT_WINDOW_MS = 1_800_000;

// The `--window all`/`max`/`∞` sentinel (also reached via any sinceMs this
// large). Exported so callers can compare `windowMs === WINDOW_ALL_SENTINEL`
// without duplicating the literal — e.g. create-cli.ts's dashboard action
// uses it to imply run-ledger mode (`showAll: true`) whenever the window is
// unbounded, even without an explicit `--all`.
export const WINDOW_ALL_SENTINEL = Number.MAX_SAFE_INTEGER;

// Parse a human-friendly duration ("30m", "2h", "1d", "45s", "all", or raw ms).
// Returns null if the input is unparseable so the caller can fall back.
export function parseDashboardWindow(input: string | undefined): number | null {
	if (input == null) return null;
	const s = input.trim().toLowerCase();
	if (s === "") return null;
	if (s === "all" || s === "max" || s === "∞") {
		// Effectively "no window" — collabs with any activity ever are eligible.
		return WINDOW_ALL_SENTINEL;
	}
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s);
	if (!m) return null;
	const value = Number.parseFloat(m[1]!);
	if (!Number.isFinite(value) || value <= 0) return null;
	const unit = m[2] ?? "ms";
	const mult =
		unit === "ms" ? 1
		: unit === "s"  ? 1_000
		: unit === "m"  ? 60_000
		: unit === "h"  ? 3_600_000
		: /* "d" */       86_400_000;
	return Math.floor(value * mult);
}

function resolveDashboardWindowMs(override?: number): number {
	if (typeof override === "number" && Number.isFinite(override) && override > 0) {
		return override;
	}
	const raw = process.env.AI_WHISPER_DASHBOARD_WINDOW_MS;
	if (raw === undefined) return DEFAULT_WINDOW_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_MS;
}

type Mode = "wall" | "inspector";

export function createDashboardRuntime(input: {
	broker: BrokerRuntime;
	dashboardId: string;
	stdout: NodeJS.WritableStream;
	pollIntervalMs?: number;
	/** Override the eligible-collab window (ms). When set, this beats the
	 * AI_WHISPER_DASHBOARD_WINDOW_MS env var and the 30-minute default. */
	windowMs?: number;
	/** Recycle (unmount+remount) the ink instance every N actual renders to
	 * hard-bound ink's per-rerender memory retention. Test seam; default 750. */
	__recycleEveryRenders?: number;
	/** Render one card per workflow RUN (no per-collab masking). Sourced from
	 * the CLI `--all`. Default false = one card per collab (latest run). */
	showAll?: boolean;
	/** Injected clock for feedback-line expiry. Test seam; default Date.now. */
	nowMs?: () => number;
}) {
	let stopping = false;
	let started = false;
	let consecutivePollErrors = 0;
	let lastPollError: string | null = null;
	let mode: Mode = "wall";
	let inspectorCollabId: string | null = null;
	let inspectorWorkflowId: string | null = null;
	let inspectorType: string | null = null;
	let inspectorLabel = "";
	let inspectorWorkflowStatus: "running" | "paused" | "done" | "halted" | "canceled" | null = null;
	let inspectorSection: InspectorSection = "live";
	let wallPage = 0;
	let wallSelected = 0;
	let lastPaneRuns: Array<{ collabId: string; workflowId: string | null }> = [];
	let pendingConfirm: { workflowId: string; action: WorkflowAction } | null = null;
	let actionFeedback: { kind: "ok" | "err" | "hint"; text: string } | null = null;
	let actionFeedbackAtMs = 0;
	const nowMs = input.nowMs ?? (() => Date.now());
	const FEEDBACK_TTL_MS = 4000;
	const viewport: Viewport = { offset: 0, follow: true };
	let loopResolve!: () => void;
	const loopDone = new Promise<void>((r) => (loopResolve = r));
	const cols = (input.stdout as { columns?: number }).columns ?? 120;
	const rows = (input.stdout as { rows?: number }).rows ?? 40;
	const windowMs = resolveDashboardWindowMs(input.windowMs);
	const showAll = input.showAll ?? false;
	// Memory-leak controls. ink.rerender() retains ~KB per call (ink 7.0.3), so
	// the 250ms poll OOM'd overnight. (1) skip ink.rerender when the rendered
	// frame is byte-identical to the last (no visual change → no leak); and
	// (3) periodically unmount+remount the ink instance to reclaim its retained
	// state, hard-bounding memory even when frames keep changing.
	let pendingSig = "";
	let lastSig: string | null = null;
	let renderCount = 0;
	let recycles = 0;
	// View-switch clear: ink repaints by erasing only the PREVIOUS frame's
	// tracked line count. Switching wall<->inspector swaps a very different
	// (often viewport-overflowing) frame, so that erase under-covers and the
	// new view renders BELOW leftover content (the "duplicated/appended" bug).
	// On a mode change we ink.clear() first so each view starts from a clean
	// frame. `lastRenderedMode` tracks what is actually on screen, not the
	// pending `mode` (which handleKey may have already flipped).
	let lastRenderedMode: Mode = "wall";
	let clearCount = 0;
	const recycleEvery = Math.max(1, input.__recycleEveryRenders ?? 750);

	function toPhaseRuns(
		raw: Array<{
			phaseRunId: string;
			phaseIndex: number;
			phaseName: string;
			startedAt: string;
			endedAt: string | null;
			outcome: string | null;
		}>,
	): PhaseRunRef[] {
		return raw.map((p) => ({
			phaseRunId: p.phaseRunId,
			phaseIndex: p.phaseIndex,
			phaseName: p.phaseName,
			startedAt: p.startedAt,
			endedAt: p.endedAt,
			outcome: p.outcome,
		}));
	}

	function inspectorState(): InspectorState | null {
		if (!inspectorCollabId) return null;
		const c = input.broker.control;
		const isoNow = new Date().toISOString();
		const collabId = inspectorCollabId;
		// Scope the tail to the focused run (or to manual relays only) so a
		// noisier sibling run on the same collab can't crowd out — or worse,
		// starve — the rows we display. See relay-handoff-repository
		// `RelayHandoffWorkflowFilter`.
		const handoffs = c.listRelayHandoffs(collabId, 200, {
			workflowFilter: inspectorWorkflowId
				? { workflowId: inspectorWorkflowId }
				: { manualOnly: true },
		});
		const wf = inspectorWorkflowId ? c.getWorkflow(inspectorWorkflowId) : null;
		const inspectorWorkspaceRoot = wf ? (c.getCollab(collabId)?.workspaceRoot ?? null) : null;
		const phaseRaw = inspectorWorkflowId
			? c.getWorkflowPhaseRuns(inspectorWorkflowId)
			: [];
		const phaseRuns = toPhaseRuns(phaseRaw);
		const curRun =
			phaseRuns.find((p) => p.endedAt === null) ??
			phaseRuns[phaseRuns.length - 1] ??
			null;
		const curRunChainId = curRun
			? ((phaseRaw.find((p) => p.phaseRunId === curRun.phaseRunId) as
					| { chainId?: string }
					| undefined)?.chainId ?? null)
			: null;
		const chain = curRunChainId ? c.getRelayChain(curRunChainId) : null;
		const turn = c.getRelayTurnState(collabId, isoNow);
		const sessions = c.listSessions(collabId);
		// Task 5: this collab's duo assignments, fetched fresh each tick (same
		// per-tick broker-control-handle fetch pattern as turn/sessions above and
		// getHandsOffStats on the Wall path) and reduced to agentType →
		// characterName for the relay-view build. Never throws: a duo-lookup
		// failure must not break the Inspector poll — degrades to an empty map
		// (today's vendor-name rendering).
		let characterNames: Record<string, string> = {};
		try {
			characterNames = Object.fromEntries(
				c.listDuoAssignmentsForCollab(collabId).map((a) => [a.agentType, a.characterName]),
			);
		} catch {
			characterNames = {};
		}
		// Per-agent pid-liveness (Bug C): probe each mounted agent's recorded pid.
		const mountAliveOf = buildMountAliveByAgent(
			c.listSessionAttachments(collabId),
		);
		const def = inspectorType ? getWorkflowDefinition(inspectorType) : null;
		const phaseMaxRounds: Record<number, number> = {};
		if (def)
			def.phases.forEach((ph, i) => {
				phaseMaxRounds[i] = ph.maxRounds;
			});
		const chainId = chain?.chainId ?? null;
		// When there's no chain to scope by (brand-new workflow with no phase
		// yet, or a manual relay pane), the fallback queries must still be
		// run-scoped — otherwise they pull diagnostics from sibling runs on
		// the same collab. Same defect class as the listRelayHandoffs filter.
		const diagFilter = inspectorWorkflowId
			? { workflowId: inspectorWorkflowId }
			: ({ manualOnly: true } as const);
		const evalDiags = chainId
			? c.listEvaluatorDiagnosticsByCollabAndChain(collabId, chainId, 50)
			: c.listEvaluatorDiagnosticsByCollab(collabId, 50, {
					workflowFilter: diagFilter,
				});
		const capDiags = chainId
			? c.listCaptureDiagnosticsByCollabAndChain(collabId, chainId, 50)
			: c.listCaptureDiagnosticsByCollab(collabId, 50, {
					workflowFilter: diagFilter,
				});
		const costRows = c.listRunCostRows(collabId, inspectorWorkflowId);
		// Bug B: the full workflow run history for this collab (newest-first),
		// surfaced in the Inspector with the currently-inspected one flagged.
		const workflows = c.listWorkflowsForCollab(collabId);

		let activeStep: string | null = null;
		if (curRun) {
			for (let i = handoffs.length - 1; i >= 0; i--) {
				if (handoffs[i]!.phaseRunId === curRun.phaseRunId) {
					activeStep = handoffs[i]!.handoffStep;
					break;
				}
			}
		}
		const fallbackStep =
			def && curRun
				? (def.phases[curRun.phaseIndex]?.initialHandoffStep ?? null)
				: null;
		const lastActivityAt = handoffs.reduce<string | null>((mx, h) => {
			const t = h.lastActivityAt ?? h.createdAt;
			return mx === null || t > mx ? t : mx;
		}, null);

		const snapshot: RelayViewSnapshot = {
			now: isoNow,
			idleThresholdMs: 30_000,
			workflow: wf
				? {
						workflowId: wf.workflowId,
						workflowType: wf.workflowType,
						name: wf.name,
						status: wf.status,
						createdAt: wf.createdAt,
						haltReason: wf.haltReason,
						artifact: displayArtifactPath(wf.specPath ?? "", inspectorWorkspaceRoot ?? ""),
					}
				: null,
			phaseRuns,
			currentPhaseRunId: curRun?.phaseRunId ?? null,
			currentStep: activeStep ?? fallbackStep,
			totalPhases: def ? def.phases.length : phaseRuns.length,
			chain: chain
				? {
						currentRound: chain.currentRound,
						maxRounds: chain.maxRounds,
						status: chain.status,
					}
				: null,
			turn: {
				turnOwner: turn.turnOwner,
				waitingAgent: turn.waitingAgent ?? null,
				handoffState: turn.handoffState,
			},
			sessions: sessions.map((s) => ({
				agentType: s.agentType,
				healthState: s.healthState,
				mountAlive: mountAliveOf(s.agentType),
			})),
			lastActivityAt,
			handoffs,
			characterNames,
		};
		const focusedPhaseRunId = curRun?.phaseRunId ?? null;
		return buildInspectorState({
			snapshot,
			phaseRuns,
			phaseMaxRounds,
			costRows,
			workflowCreatedAt: wf?.createdAt ?? null,
			chainId,
			evidenceHandoffs: handoffs.filter(
				(h) => h.phaseRunId === focusedPhaseRunId,
			),
			evaluatorDiags: evalDiags.map((d) => ({
				verdict: d.verdict,
				confidence: d.confidence,
				reason: d.reason,
				outcome: d.outcome,
			})),
			captureDiags: capDiags.map((d) => ({
				captureStatus: d.captureStatus,
				turnConfidence: d.turnConfidence,
			})),
			focusedPhaseRunId,
			workflows,
			selectedWorkflowId: inspectorWorkflowId,
		});
	}

	function setFeedback(kind: "ok" | "err" | "hint", text: string): void {
		actionFeedback = { kind, text };
		actionFeedbackAtMs = nowMs();
	}

	function expireFeedback(): void {
		if (actionFeedback && nowMs() - actionFeedbackAtMs >= FEEDBACK_TTL_MS) {
			actionFeedback = null;
		}
	}

	// Re-fetch the target run's CURRENT summary (same scope the Wall uses) so the
	// action is validated against live status, not a stale rendered frame.
	function freshStatusFor(
		collabId: string,
		workflowId: string | null,
	): "running" | "paused" | "done" | "halted" | "canceled" | null {
		const sums = showAll
			? input.broker.control.listAllWorkflowSummaries(windowMs, new Date().toISOString())
			: input.broker.control.listActiveCollabSummaries(windowMs, new Date().toISOString());
		const s = sums.find((x) => x.collabId === collabId && x.workflowId === workflowId);
		return s?.workflowStatus ?? null;
	}

	function requestAction(
		target: { collabId: string; workflowId: string | null },
		action: WorkflowAction,
	): void {
		if (!target.workflowId) {
			setFeedback("hint", "no workflow on this card");
			return;
		}
		const status = freshStatusFor(target.collabId, target.workflowId);
		if (!actionsForStatus(status).includes(action)) {
			setFeedback("hint", `${action} not available (${status ?? "no workflow"})`);
			return;
		}
		pendingConfirm = { workflowId: target.workflowId, action };
	}

	function executeConfirmed(): void {
		if (!pendingConfirm) return;
		const { workflowId, action } = pendingConfirm;
		pendingConfirm = null;
		const now = new Date().toISOString();
		const c = input.broker.control;
		try {
			if (action === "pause") c.pauseWorkflow({ workflowId, now });
			else if (action === "resume") c.resumeWorkflow({ workflowId, now });
			else if (action === "done") c.markWorkflowDone({ workflowId, now });
			else c.cancelWorkflow({ workflowId, now });
			const verb =
				action === "pause"
					? "paused"
					: action === "resume"
						? "resumed"
						: action === "done"
							? "marked done"
							: "canceled";
			setFeedback("ok", `${verb} ${workflowId}`);
		} catch (err) {
			setFeedback("err", err instanceof Error ? err.message : String(err));
		}
	}

	// Map a wall/inspector action key to its WorkflowAction (null otherwise).
	function actionForKey(key: string | undefined): WorkflowAction | null {
		if (key === "p") return "pause";
		if (key === "r") return "resume";
		if (key === "c") return "cancel";
		if (key === "d") return "done";
		return null;
	}

	function node(): ReactElement {
		const c = input.broker.control;
		const isoNow = new Date().toISOString();
		expireFeedback();
		if (mode === "inspector" && inspectorCollabId) {
			const st = inspectorState();
			if (st) {
				pendingSig = `i:${JSON.stringify({
					st,
					section: inspectorSection,
					viewport,
					label: inspectorLabel,
					type: inspectorType,
					cols,
					rows,
					confirm: pendingConfirm,
					feedback: actionFeedback,
				})}`;
				return createElement(Inspector, {
					state: st,
					section: inspectorSection,
					viewport,
					cols,
					rows,
					label: inspectorLabel,
					workflowStatus: inspectorWorkflowStatus,
					workflowType: inspectorType,
					confirm: pendingConfirm,
					feedback: actionFeedback,
				});
			}
		}

		const summaries = showAll
			? c.listAllWorkflowSummaries(windowMs, isoNow)
			: c.listActiveCollabSummaries(windowMs, isoNow);
		// Use the sectioned allocator to pre-decide which summaries are visible
		// on this page so per-collab snapshot fetches stay bounded to that set.
		const groups = partitionWallGroups(summaries);
		const allocPreview = allocateWallSections({
			groups,
			cols,
			rows,
			page: wallPage,
		});
		const visibleSummaries = allocPreview.sections.flatMap((sec) => sec.cards);
		const snapshots: Record<
			string,
			{
				handoffs: ReturnType<typeof c.listRelayHandoffs>;
				phaseRuns: PhaseRunRef[];
				totalPhases: number;
			}
		> = {};
		for (const s of visibleSummaries) {
			// Each pane represents ONE run on this collab — either a workflow
			// instance (`s.workflowId`) or the manual relay slice. Scope the
			// tail so we don't tail-mix sibling runs on the same collab.
			const handoffs = c.listRelayHandoffs(s.collabId, 8, {
				workflowFilter: s.workflowId
					? { workflowId: s.workflowId }
					: { manualOnly: true },
			});
			const phaseRaw = s.workflowId
				? c.getWorkflowPhaseRuns(s.workflowId)
				: [];
			const def = s.workflowType ? getWorkflowDefinition(s.workflowType) : null;
			snapshots[runKey(s)] = {
				handoffs,
				phaseRuns: toPhaseRuns(phaseRaw),
				totalPhases: def ? def.phases.length : 0,
			};
			// Per-agent pid-liveness (Bug C) for the VISIBLE pane only (bounded
			// cost): probe each agent's recorded mount pid and attach mountAlive
			// to that agent's sessions[] entry so the Wall's computeLiveness can
			// distinguish a hung worker from a live long-running step.
			const mountAliveOf = buildMountAliveByAgent(
				c.listSessionAttachments(s.collabId),
			);
			s.sessions = s.sessions.map((sess) => ({
				...sess,
				mountAlive: mountAliveOf(sess.agentType),
			}));
		}
		const handsOff = c.getHandsOffStats();
		const wallState = buildWallState({
			summaries,
			now: isoNow,
			idleThresholdMs: 30_000,
			cols,
			rows,
			page: wallPage,
			selected: wallSelected,
			snapshots,
			handsOff: { totalMs: handsOff.totalMs, count: handsOff.count },
		});
		wallPage = wallState.page;
		wallSelected = wallState.selected;
		lastPaneRuns = wallState.panes.map((p) => ({ collabId: p.collabId, workflowId: p.workflowId }));
		const counts = summarizeWall(summaries);
		pendingSig = `w:${JSON.stringify({ wallState, cols, rows, counts, confirm: pendingConfirm, feedback: actionFeedback })}`;
		return createElement(Wall, { state: wallState, cols, rows, showAll, counts, confirm: pendingConfirm, feedback: actionFeedback });
	}

	const inkOptions = {
		stdout: input.stdout as NodeJS.WriteStream,
		exitOnCtrlC: false,
	};
	let ink = render(
		createElement(DashboardApp, { node: node(), onKey: handleKey }),
		inkOptions,
	);
	lastSig = pendingSig; // the initial frame is now on screen
	renderCount = 1;

	function rerender() {
		try {
			const el = node(); // also recomputes pendingSig
			// Fix 1: identical frame → skip ink.rerender entirely (it leaks per call).
			if (pendingSig === lastSig) return;
			lastSig = pendingSig;
			renderCount += 1;
			const full = createElement(DashboardApp, { node: el, onKey: handleKey });
			// View switch (wall<->inspector): erase the whole previous frame before
			// drawing the new view, so a taller prior frame can't leave stale rows
			// behind the shorter one. Same-mode repaints take ink's normal
			// incremental erase (no full clear → no flicker).
			if (mode !== lastRenderedMode) {
				ink.clear();
				clearCount += 1;
				lastRenderedMode = mode;
			}
			// Fix 3: every Nth real render, recycle the ink instance instead of
			// rerendering, so ink's accumulated per-rerender retention is released.
			if (renderCount % recycleEvery === 0) {
				ink.unmount();
				ink = render(full, inkOptions);
				recycles += 1;
			} else {
				ink.rerender(full);
			}
		} catch (err) {
			// Surface rerender failures through pollHealth instead of swallowing
			// them — a silent catch here masked an Inspector section-change bug
			// that left the previous frame on screen while host state moved on.
			consecutivePollErrors += 1;
			lastPollError = err instanceof Error ? err.message : String(err);
		}
	}

	function handleKey(ev: {
		upArrow?: boolean;
		downArrow?: boolean;
		escape?: boolean;
		key?: string;
	}) {
		if (pendingConfirm) {
			if (ev.key === "y" || ev.key === "\r" || ev.key === "\n") executeConfirmed();
			else if (ev.key === "n" || ev.escape) pendingConfirm = null;
			// else: swallow — confirm is modal.
			rerender();
			return;
		}
		if (mode === "wall") {
			if (ev.upArrow || ev.key === "k")
				wallSelected = Math.max(0, wallSelected - 1);
			else if (ev.downArrow || ev.key === "j") wallSelected = wallSelected + 1;
			else if (ev.key === "[") wallPage = Math.max(0, wallPage - 1);
			else if (ev.key === "]") wallPage = wallPage + 1;
			else if (ev.key === "\r" || ev.key === "\n") {
				const run = lastPaneRuns[wallSelected];
				if (run) {
					const sums = showAll
						? input.broker.control.listAllWorkflowSummaries(
								windowMs,
								new Date().toISOString(),
							)
						: input.broker.control.listActiveCollabSummaries(
								windowMs,
								new Date().toISOString(),
							);
					const s = sums.find(
						(x) => x.collabId === run.collabId && x.workflowId === run.workflowId,
					);
					inspectorCollabId = run.collabId;
					inspectorWorkflowId = run.workflowId;
					inspectorType = s?.workflowType ?? null;
					inspectorLabel = s?.label ?? run.collabId;
					inspectorWorkflowStatus = s?.workflowStatus ?? null;
					inspectorSection = "live";
					viewport.offset = 0;
					viewport.follow = true;
					mode = "inspector";
				}
			} else if (actionForKey(ev.key)) {
				const run = lastPaneRuns[wallSelected];
				if (run) requestAction(run, actionForKey(ev.key)!);
			} else if (ev.key === "q") stopping = true;
		} else {
			if (ev.key === "1") inspectorSection = "live";
			else if (ev.key === "2") inspectorSection = "timeline";
			else if (ev.key === "3") inspectorSection = "evidence";
			else if (ev.key === "4") inspectorSection = "cost";
			else if (ev.escape) mode = "wall";
			else if (ev.key === "q") stopping = true;
			else if (actionForKey(ev.key)) {
				if (inspectorCollabId) {
					requestAction(
						{ collabId: inspectorCollabId, workflowId: inspectorWorkflowId },
						actionForKey(ev.key)!,
					);
				}
			}
			else if (inspectorSection === "live") {
				const visibleH = logViewportHeight(rows);
				const linesLen = inspectorState()?.live.logLines.length ?? 0;
				const tailStart = Math.max(0, linesLen - visibleH);
				if (ev.upArrow) {
					viewport.follow = false;
					viewport.offset = Math.min(tailStart, viewport.offset + 1);
				} else if (ev.downArrow) {
					viewport.follow = false;
					viewport.offset = Math.max(0, viewport.offset - 1);
				} else if (ev.key === "g") {
					viewport.follow = false;
					viewport.offset = tailStart;
				} else if (ev.key === "G") {
					viewport.follow = true;
					viewport.offset = 0;
				} else if (ev.key === "f") {
					viewport.follow = !viewport.follow;
					if (viewport.follow) viewport.offset = 0;
				}
			}
		}
		rerender();
	}

	// The dashboard is observe-only and aggregates across ALL collabs — it is
	// NOT attached to a specific collab the way relay-monitor is. We do NOT
	// call registerRelayMonitor / heartbeatRelayMonitor here: those APIs
	// validate the collabId against the `collab` table and would throw
	// "Unknown collab: dashboard" since no such row exists. The dashboardId
	// is still kept as an instance handle for logs + double-start guarding.
	function poll() {
		rerender();
		consecutivePollErrors = 0;
		lastPollError = null;
	}

	return {
		start() {
			if (started) return;
			started = true;
			void (async () => {
				while (!stopping) {
					try {
						poll();
					} catch (err) {
						consecutivePollErrors += 1;
						lastPollError = err instanceof Error ? err.message : String(err);
					}
					// Fix 2: 1s default (was 250ms) — a monitoring dashboard does not
					// need 4 repaints/sec, and it cuts the rerender (leak) rate 4x.
					await new Promise((r) => setTimeout(r, input.pollIntervalMs ?? 1000));
				}
				ink.unmount();
				loopResolve();
			})();
		},
		async stop() {
			stopping = true;
			await loopDone;
			ink.unmount();
		},
		waitUntilStopped() {
			return loopDone;
		},
		__mode: () => mode,
		__section: () => inspectorSection,
		__handleKey: handleKey,
		__viewport: viewport,
		__wallSelected: () => wallSelected,
		__pollHealth: () => ({
			consecutiveErrors: consecutivePollErrors,
			lastError: lastPollError,
		}),
		__renderCount: () => renderCount,
		__recycles: () => recycles,
		__clears: () => clearCount,
		__inspectorWorkflowId: () => inspectorWorkflowId,
		__pendingConfirm: () => pendingConfirm,
		__actionFeedback: () => actionFeedback,
	};
}
