import type { RelayHandoffLogRow } from "@ai-whisper/broker";
import { agentTypes, type AgentType } from "@ai-whisper/shared";

// Fixed column widths for the workflow event line (kept here so Task 5/6
// renderers stay aligned with this producer).
const COL = { pr: 6, route: 13, step: 9, verdict: 9 } as const;

export type PhaseRunRef = {
	phaseRunId: string;
	phaseIndex: number;
	phaseName: string;
	startedAt: string;
	endedAt: string | null;
	outcome: string | null;
};

export type LogLine =
	| { kind: "event"; text: string; isLatest: boolean }
	| { kind: "phase-rule"; text: string }
	| { kind: "phase-summary"; text: string; ok: boolean };

// Formats timestamp in UTC intentionally (relay logs recorded in UTC).
function hhmmss(iso: string): string {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function pad(s: string, n: number): string {
	return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

// Shared duration formatter. Defined here (this file is created in Task 4);
// Task 5 reuses it and MUST NOT redefine it.
export function fmtDur(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(s / 60);
	return m > 0 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function isOkOutcome(outcome: string | null): boolean {
	if (!outcome) return false;
	return !/escalat|halt|fail|cancel/i.test(outcome);
}

function summaryLine(
	phase: PhaseRunRef,
	rounds: number,
	handovers: number,
): LogLine {
	const ok = isOkOutcome(phase.outcome);
	const dur =
		phase.endedAt != null
			? fmtDur(Date.parse(phase.endedAt) - Date.parse(phase.startedAt))
			: "?";
	return {
		kind: "phase-summary",
		ok,
		text: `${ok ? "✔" : "✖"} ${phase.phaseName} — ${rounds} rounds (${handovers} handovers) · ${dur} → ${phase.outcome ?? "?"}`,
	};
}

export function deriveLogLines(
	handoffs: RelayHandoffLogRow[],
	phaseRuns: PhaseRunRef[],
	totalPhases: number,
): LogLine[] {
	const byPhaseRun = new Map(phaseRuns.map((p) => [p.phaseRunId, p]));
	const out: LogLine[] = [];
	let lastPhaseRunId: string | null = null;
	// stats for the currently-open phase run (for its summary on close)
	let curRunId: string | null = null;
	let curRounds = 0;
	let curHandovers = 0;

	function flushSummary() {
		if (curRunId === null) return;
		const run = byPhaseRun.get(curRunId);
		// only summarize a phase run that has actually ended
		if (run && run.endedAt != null) {
			out.push(summaryLine(run, Math.max(1, curRounds), curHandovers));
		}
	}

	handoffs.forEach((h, i) => {
		const isLatest = i === handoffs.length - 1;
		// If a handoff carries a phaseRunId not present in phaseRuns, phase is
		// undefined and the event intentionally degrades to the route-only line;
		// it is also excluded from phase stats. Defensive against upstream data gaps.
		const phase = h.phaseRunId ? byPhaseRun.get(h.phaseRunId) : undefined;

		if (h.phaseRunId && h.phaseRunId !== lastPhaseRunId && phase) {
			// closing the previous phase run → emit its summary first
			flushSummary();
			out.push({
				kind: "phase-rule",
				text: `── phase ${phase.phaseIndex + 1}/${totalPhases} · ${phase.phaseName} ──`,
			});
			lastPhaseRunId = h.phaseRunId;
			curRunId = h.phaseRunId;
			curRounds = 0;
			curHandovers = 0;
		}

		if (h.phaseRunId && h.phaseRunId === curRunId) {
			curHandovers += 1;
			if (h.roundNumber != null) curRounds = Math.max(curRounds, h.roundNumber);
		}

		const time = hhmmss(h.createdAt);
		const route = `${h.senderAgent}→${h.targetAgent}`;
		const preview = (h.handbackText ?? "").replace(/\s+/g, " ").trim();

		if (h.workflowId && phase && h.roundNumber != null) {
			const pr = `P${phase.phaseIndex + 1}·R${h.roundNumber}`;
			const step = pad(h.handoffStep ?? "-", COL.step);
			const verdict = pad(h.evaluatorVerdict ?? "-", COL.verdict);
			out.push({
				kind: "event",
				isLatest,
				text: `${time}  ${pad(pr, COL.pr)}  ${pad(route, COL.route)}  ${step}  ${verdict}  ${preview}`,
			});
		} else {
			out.push({
				kind: "event",
				isLatest,
				text: `${time}  ${pad(route, COL.route)}  ${preview}`,
			});
		}
	});

	// summarize the final phase run if it has ended
	flushSummary();

	return out;
}

export type RelayViewSnapshot = {
	now: string;
	idleThresholdMs: number;
	workflow: {
		workflowId: string;
		workflowType: string;
		name: string | null;
		status: "running" | "paused" | "done" | "halted" | "canceled";
		createdAt: string;
		haltReason?: string | null;
		// Repo-relative spec/goal/bug-report path; threaded by the snapshot
		// builders (Fix 4). Absent/null → omitted from the wf row.
		artifact?: string | null;
	} | null;
	phaseRuns: Array<{
		phaseRunId: string;
		phaseIndex: number;
		phaseName: string;
		startedAt: string;
		endedAt: string | null;
		outcome: string | null;
	}>;
	currentPhaseRunId: string | null;
	currentStep: string | null;
	totalPhases: number;
	chain: {
		currentRound: number;
		maxRounds: number;
		status: "active" | "done" | "escalated" | "abandoned";
	} | null;
	turn: {
		turnOwner: AgentType | "none";
		waitingAgent: AgentType | null;
		handoffState: string;
	};
	// Liveness is PER-AGENT: each entry optionally carries `mountAlive`, the
	// host's pid-liveness probe for that agent's mount process (Bug C). Absent
	// (undefined) is treated as not-alive (conservative) — see computeLiveness.
	sessions: Array<{ agentType: string; healthState: string; mountAlive?: boolean }>;
	lastActivityAt: string | null;
	handoffs: RelayHandoffLogRow[];
};

// Decoupled stuck threshold (Bug C): independent of the turn-idle threshold,
// env-overridable, default 5 min. The execute/review steps get a larger budget
// because a real LLM work pass legitimately produces no relay activity for
// minutes. Unmapped steps fall back to the baseline (never shorter), so the
// change can only relax false STUCKs, not tighten them.
const STUCK_DEFAULT_MS = 300_000;
const STUCK_STEP_MS = 600_000;

function stuckBaseMs(): number {
	const raw = process.env.AI_WHISPER_STUCK_THRESHOLD_MS;
	if (raw === undefined) return STUCK_DEFAULT_MS;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : STUCK_DEFAULT_MS;
}

function stuckBudgetMs(step: string | null, baseMs: number): number {
	if (step === "execute" || step === "review") return Math.max(baseMs, STUCK_STEP_MS);
	return baseMs;
}

export type RelayViewState = {
	wf: string;
	progress: string;
	elapsed: string;
	turn: string;
	health: string;
	agentHealth: Array<{
		agent: AgentType;
		health: "healthy" | "degraded" | "dead";
	}>;
	live: string;
	why: string | null; // when set, render the red ⚠ why row instead of live
	last: string;
	stuck: boolean;
	logLines: LogLine[];
};

// `fmtDur` is already defined in this file (Task 4) — do NOT redefine it here.

// Display order for the per-agent health dots: the driver agent (codex|ezio)
// first, then claude. Stable tiebreak by agentType keeps output deterministic.
const AGENT_DISPLAY_RANK: Record<AgentType, number> = { codex: 0, ezio: 0, claude: 1 };

function isAgentType(s: string): s is AgentType {
	return (agentTypes as readonly string[]).includes(s);
}

// wf row (Fix 4): full id first (never truncated under width pressure), the
// type once, then the repo-relative artifact when present. The artifact is
// trimmed defensively so a whitespace value never renders an empty arrow
// (the builders normalize via displayArtifactPath, but this is belt-and-braces).
function buildWfRow(w: NonNullable<RelayViewSnapshot["workflow"]>): string {
	const base = `${w.workflowId}  ${w.workflowType}`;
	const artifact = w.artifact?.trim();
	return artifact ? `${base}  → ${artifact}` : base;
}

// Returns a formatted elapsed string, or "—" if either timestamp is unparseable
// (broker/DB timestamps are trusted, but a malformed one must not render "NaNs"
// in a liveness monitor).
function elapsedSince(fromIso: string | null | undefined, toIso: string): string {
	if (fromIso == null) return "—";
	const a = Date.parse(fromIso);
	const b = Date.parse(toIso);
	if (Number.isNaN(a) || Number.isNaN(b)) return "—";
	return fmtDur(b - a);
}

// Pure liveness/stuck classifier (Bug C). Deterministic — takes plain snapshot
// data including a PER-AGENT `mountAlive` boolean and does NO I/O. The host
// (dashboard.ts) probes pids and feeds `mountAlive`; the builders stay pure.
export function computeLiveness(snap: RelayViewSnapshot): {
	stuck: boolean;
	why: string | null;
	liveText: string;
} {
	// Trusted broker timestamps, but a malformed one must not render "NaNs"
	// (mirrors the elapsedSince guard above); clock skew must not show "-3s".
	const nowMs = Date.parse(snap.now);
	const lastMs = snap.lastActivityAt ? Date.parse(snap.lastActivityAt) : null;
	const idleMs =
		lastMs !== null && !Number.isNaN(nowMs) && !Number.isNaN(lastMs)
			? Math.max(0, nowMs - lastMs)
			: 0;
	const idleS = Math.floor(idleMs / 1000);
	const thresholdMs = snap.idleThresholdMs;
	// Decoupled, phase-aware budget (NOT derived from the turn-idle threshold).
	const budget = stuckBudgetMs(snap.currentStep, stuckBaseMs());

	const round = snap.chain?.currentRound ?? 1;
	const maxRounds = snap.chain?.maxRounds ?? 1;
	const chainStatus = snap.chain?.status;
	const terminal =
		snap.workflow && snap.workflow.status !== "running" ? snap.workflow.status : null;

	// Relevant agent = the one actually working the step: the turn owner, else
	// the agent we are waiting on when owner is "none". The idle-past-budget and
	// health→stuck decisions key off THIS agent's mountAlive/health so a dead
	// non-active peer never forces STUCK and a dead active worker always does.
	const activeAgent =
		snap.turn.turnOwner !== "none" ? snap.turn.turnOwner : snap.turn.waitingAgent;
	const activeSess =
		activeAgent != null
			? (snap.sessions.find((s) => s.agentType === activeAgent) ?? null)
			: null;
	const activeAlive = activeSess?.mountAlive ?? false; // absent → false (conservative)
	const activeOffline = activeSess?.healthState === "offline";

	// why precedence: halt_reason > chain escalated/abandoned > round-max
	//                  > idle-past-budget(+pid) > active-session offline/dead
	let why: string | null = null;
	let stuck = false;
	let liveOverride: string | null = null;

	if (terminal === "paused") {
		// Operator-suspended and resumable — quiescent, never stuck. Short-circuit
		// BEFORE the idle/mount-liveness checks (a paused run is idle with mounts
		// torn down, which would otherwise trip the "no progress" STUCK branch).
		return { stuck: false, why: null, liveText: "paused" };
	}
	if (terminal === "done") {
		// A completed workflow is finished, never stuck. Short-circuit BEFORE the
		// idle/mount-liveness checks — a done run backfilled onto the wall has
		// aged past budget and its mounts are gone, which would otherwise trip
		// the "no progress and mount not alive" branch and render it STUCK.
		return { stuck: false, why: null, liveText: "done" };
	} else if (terminal === "halted" || terminal === "canceled") {
		stuck = true;
		why = snap.workflow?.haltReason
			? `${terminal}: ${snap.workflow.haltReason}`
			: `workflow ${terminal}`;
	} else if (chainStatus === "escalated" || chainStatus === "abandoned") {
		stuck = true;
		why = `STUCK — chain ${chainStatus}`;
	// maxRounds>1: a single-round workflow never round-max-stucks (escalation comes via chain.status).
	} else if (snap.chain && round >= maxRounds && maxRounds > 1) {
		stuck = true;
		why = `STUCK ${fmtDur(idleMs)} — round ${round}/${maxRounds} max reached → escalated`;
	} else if (idleMs >= budget && (activeOffline || !activeAlive)) {
		// Past the budget AND the active worker's mount is dead/absent or its
		// session is offline → genuinely stuck.
		stuck = true;
		why = `STUCK ${fmtDur(idleMs)} — no progress and mount not alive`;
	} else if (idleMs >= budget) {
		// Past the budget but the active worker's mount is alive (and not
		// offline) → legitimately long-running, NOT stuck.
		liveOverride = `long-running ${fmtDur(idleMs)} — step in progress (mount alive)`;
	} else if (activeOffline) {
		// Under budget but the active session is offline/dead → stuck.
		stuck = true;
		why = "STUCK — provider offline";
	}

	// live text (only when not stuck). A long-running override (idle past budget
	// but mount alive) supersedes the countdown so the dashboard shows the
	// reassuring "long-running … (mount alive)" instead of a bare idle counter.
	let liveText = `idle ${idleS}s`;
	if (!stuck) {
		if (liveOverride !== null) {
			liveText = liveOverride;
		} else {
			const remainMs = Math.max(0, thresholdMs - idleMs);
			if (snap.turn.handoffState === "accepted") {
				liveText = `idle ${idleS}s · auto-handback in ${Math.ceil(remainMs / 1000)}s`;
			} else if (snap.turn.handoffState === "pending") {
				liveText = `idle ${idleS}s · auto-accept in ${Math.ceil(remainMs / 1000)}s`;
			}
		}
	}

	return { stuck, why, liveText };
}

export function buildRelayViewState(snap: RelayViewSnapshot): RelayViewState {
	const wf = snap.workflow ? buildWfRow(snap.workflow) : "(no workflow — manual relay)";

	const cur = snap.phaseRuns.find((p) => p.phaseRunId === snap.currentPhaseRunId) ?? null;
	const round = snap.chain?.currentRound ?? 1;
	const maxRounds = snap.chain?.maxRounds ?? 1;
	const progress = cur
		? `Phase ${cur.phaseIndex + 1}/${snap.totalPhases} ${cur.phaseName} · Round ${round}/${maxRounds} · Step ${snap.currentStep ?? "-"}`
		: "—";

	const totalEl = elapsedSince(snap.workflow?.createdAt, snap.now);
	const phaseEl = elapsedSince(cur?.startedAt, snap.now);
	const elapsed = `total ${totalEl} · phase ${phaseEl}`;

	const turn = `${snap.turn.turnOwner} · waiting ${snap.turn.waitingAgent ?? "none"} · handoff ${snap.turn.handoffState}`;

	// Bug A / agent identity: derive the health dots from the REAL session rows
	// (so ezio shows and a never-present codex does not), filtering unknown
	// agent types and sorting into canonical driver-first order. healthy → "●";
	// degraded (alive but impaired) → "◐(degraded)"; offline → "●(dead)".
	const agentHealth = snap.sessions
		.filter((x) => isAgentType(x.agentType))
		.map((x) => {
			const health: "healthy" | "degraded" | "dead" =
				x.healthState === "healthy"
					? "healthy"
					: x.healthState === "degraded"
						? "degraded"
						: "dead";
			return { agent: x.agentType as AgentType, health };
		})
		.sort((a, b) => {
			const r = AGENT_DISPLAY_RANK[a.agent] - AGENT_DISPLAY_RANK[b.agent];
			return r !== 0 ? r : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0;
		});

	const dots = agentHealth
		.map(({ agent, health }) => {
			const glyph =
				health === "healthy" ? "●" : health === "degraded" ? "◐(degraded)" : "●(dead)";
			return `${glyph} ${agent}`;
		})
		.join("  ");

	// stuck + why computed in Task 6; placeholder defaults overwritten there.
	const { stuck, why, liveText } = computeLiveness(snap);

	const terminal =
		snap.workflow && snap.workflow.status !== "running" ? snap.workflow.status : null;
	// chain.status (active/done/escalated/abandoned) is shown when not terminal
	// and not the soft "stuck" state.
	const chainStatus = snap.chain?.status;
	const chainState =
		terminal ??
		(chainStatus && chainStatus !== "active"
			? chainStatus
			: stuck
				? "stuck"
				: "active");
	const alive = !terminal && !stuck && (chainStatus ?? "active") === "active";
	const health = `${dots}  Chain ${chainState}${alive ? " · ALIVE" : ""}`;

	const lastHandoff = snap.handoffs[snap.handoffs.length - 1] ?? null;
	const last = lastHandoff
		? `${lastHandoff.evaluatorVerdict ?? "-"} ${
				lastHandoff.evaluatorConfidence ?? "-"
			} · capture ${lastHandoff.captureStatus ?? "-"}${
				lastHandoff.evaluatorReason ? ` · "${lastHandoff.evaluatorReason}"` : ""
			}`
		: "—";

	const logLines = deriveLogLines(snap.handoffs, snap.phaseRuns, snap.totalPhases);

	// Spec §6: when the workflow is terminal, the log ends with an explicit
	// terminal line.
	if (terminal) {
		const id = snap.workflow!.workflowId;
		logLines.push(
			terminal === "done"
				? { kind: "phase-summary", ok: true, text: `✔ workflow-done: ${id}` }
				: {
						kind: "phase-summary",
						ok: false,
						text: `✖ workflow-${terminal}: ${id}${
							snap.workflow!.haltReason ? ` — ${snap.workflow!.haltReason}` : ""
						}`,
					},
		);
	}

	return {
		wf,
		progress,
		elapsed,
		turn,
		health,
		agentHealth,
		live: liveText,
		why,
		last,
		stuck,
		logLines,
	};
}
