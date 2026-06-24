import { Box, Text, useInput, useStdin } from "ink";
import type { AgentType } from "@ai-whisper/shared";
import type { ReactElement, ReactNode } from "react";
import type { WallState, WallPaneState } from "./dashboard-state.js";
import { RelayView, type Viewport } from "./relay-view.js";
import { fmtDur } from "./relay-view-state.js";
import type { InspectorState } from "./dashboard-state.js";
import { THEME, AGENT_COLOR } from "./theme.js";
import { statusGlyph } from "./dashboard-glyph.js";

const MIN_PANE_COLS = 40;
const MIN_PANE_ROWS = 5;
const NARROW_PANE_COLS = 48;
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";

// Map verbose workflow-type IDs to short, dimmed badges shown in the card
// header on narrow panes (width < NARROW_PANE_COLS). The Inspector always
// renders the full name. Unknown types fall back to the first dash-segment
// (e.g. "code-review" → "code"), capped at 8 chars.
const TYPE_ABBREVIATION: Record<string, string> = {
	"complex-bug-fixing": "bugfix",
	"spec-driven-development": "sdd",
	"ralph-loop": "ralph",
};

export function abbreviateWorkflowType(full: string): string {
	const known = TYPE_ABBREVIATION[full];
	if (known) return known;
	const head = full.split("-")[0] ?? full;
	return head.length > 8 ? head.slice(0, 8) : head;
}

export function gridCapacity(cols: number, rows: number): number {
	const c = Math.max(1, Math.floor(cols / MIN_PANE_COLS));
	const r = Math.max(1, Math.floor(rows / MIN_PANE_ROWS));
	return c * r;
}

function progressBar(progress: { current: number; total: number }): string {
	const total = Math.max(1, progress.total);
	const current = Math.max(0, Math.min(total, progress.current));
	return BAR_FILLED.repeat(current) + BAR_EMPTY.repeat(total - current);
}

// Middle-ellipsis: keep the END of the path (the filename — the most identifying
// part) and as much of the head as fits. Returns the string unchanged when it
// already fits, or a hard slice when the budget is too small for an ellipsis.
export function midEllipsis(path: string, width: number): string {
	if (width <= 1 || path.length <= width) return path;
	if (width <= 3) return path.slice(0, width);
	const keepEnd = Math.ceil((width - 1) / 2);
	const keepStart = width - 1 - keepEnd;
	return path.slice(0, keepStart) + "…" + path.slice(path.length - keepEnd);
}

// Front-ellipsis: keep the END of the string (the distinctive tail — a worktree
// leaf, or a filename's topic + extension) and drop the front. Returns the string
// unchanged when it fits; a hard tail slice when the budget is too small for an
// ellipsis.
export function keepTail(s: string, width: number): string {
	if (width <= 0 || s.length <= width) return s;
	if (width <= 3) return s.slice(s.length - width);
	return "…" + s.slice(s.length - (width - 1));
}

// Last path segment (the filename). Falls back to the whole string for a bare
// name or a trailing-slash path. Artifacts are repo-relative posix paths.
function artifactBasename(p: string): string {
	return p.slice(p.lastIndexOf("/") + 1) || p;
}

// Start time as UTC HH:MM (matches the relay logs' UTC timestamps). Null when
// the timestamp is missing/unparseable so the caller can omit the segment.
export function hhmmUTC(iso: string): string | null {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function dotForHealth(h: "healthy" | "degraded" | "dead"): {
	glyph: string;
	color: string;
} {
	return h === "healthy"
		? { glyph: "●", color: THEME.ok }
		: h === "degraded"
			? { glyph: "◐", color: THEME.warn }
			: { glyph: "○", color: THEME.err };
}

function padRight(s: string, n: number): string {
	return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

// Intentionally ignores isWide — cwd clips identically at any width, so both
// FullCard and CompactCard share the same budget formula.
function cwdLine(cwd: string | null, width: number): ReactElement {
	const budget = Math.max(8, width - 2 - 2 - 2); // border, indent, "⌂ "
	return (
		<Text wrap="truncate" color={THEME.muted}>
			{"  "}⌂ {cwd ? keepTail(cwd, budget) : "—"}
		</Text>
	);
}

function statusKeyToWorkflowStatus(
	key: WallPaneState["statusKey"],
): "running" | "paused" | "done" | "halted" | "canceled" | null {
	if (key === "idle") return null;
	if (key === "stuck") return "running"; // stuck-while-running default
	return key;
}

export function FullCard(props: {
	pane: WallPaneState;
	selected: boolean;
	width: number;
}): ReactElement {
	const { pane } = props;
	const chevron = props.selected ? "▸ " : "  ";
	// Wide pane (≥ NARROW_PANE_COLS) shows the full workflow type dimmed.
	// Narrow pane abbreviates so the header doesn't truncate (e.g.
	// "complex-bug-fixing" → "bugfix"). Inspector always shows the full name.
	const isWide = props.width >= NARROW_PANE_COLS;
	const typeText = pane.workflowType
		? isWide
			? pane.workflowType
			: abbreviateWorkflowType(pane.workflowType)
		: null;

	if (pane.statusKey === "stuck") {
		// Stuck card: red border + ⚠ glyph, why text dominant.
		const why = pane.stuckWhy ?? "";
		const splitAt = Math.max(0, props.width - 4);
		return (
			<Box
				flexDirection="column"
				width={props.width}
				borderStyle="single"
				borderColor={THEME.err}
			>
				<Text wrap="truncate" bold>
					{chevron}
					<Text color={THEME.err}>⚠</Text> {pane.label}
					{typeText ? <Text color={THEME.muted}> {typeText}</Text> : null}
				</Text>
				{cwdLine(pane.cwd, props.width)}
				<Text wrap="truncate" color={THEME.err}>
					{"  "}
					{why.slice(0, splitAt)}
				</Text>
				<Text wrap="truncate" color={THEME.err}>
					{"  "}
					{why.slice(splitAt)}
				</Text>
			</Box>
		);
	}

	const glyph = statusGlyph({
		workflowStatus: statusKeyToWorkflowStatus(pane.statusKey),
		stuck: false,
	});
	const borderColor = props.selected ? THEME.select : THEME.muted;
	const progressText = pane.progress
		? `P${pane.progress.current}/${pane.progress.total}`
		: "—";
	// Narrow-pane fallback keys off the PER-PANE width (spec §Full card and
	// edge cases): when the rendered card itself is < NARROW_PANE_COLS the
	// progress bar collapses to plain `P<n>/<total>` text. Terminal-total
	// width is irrelevant — a 2-col 80-col terminal renders 40-col panes,
	// which are narrow, so the bar drops.
	const showBar = pane.progress != null && isWide;
	const roundText =
		pane.round != null ? `  R${pane.round.current}/${pane.round.max}` : "";

	const startHHMM = pane.startIso ? hhmmUTC(pane.startIso) : null;
	// Trim defensively: a whitespace-only artifact must omit the subline (and keep
	// both event rows), never render an empty arrow. The broker/builders already
	// normalize via displayArtifactPath; this is belt-and-braces at the view.
	const artifactText = pane.artifact?.trim() || null;
	// Wide cards show " · HH:MM · elapsed"; narrow cards drop the time tail so the
	// artifact gets the full width.
	const timeTail = isWide
		? startHHMM
			? ` · ${startHHMM} · ${pane.elapsed}`
			: ` · ${pane.elapsed}`
		: "";
	// Budget for the artifact: inner width minus border, indent, "→ ", and the tail.
	const artifactBudget = Math.max(8, props.width - 2 - 2 - 2 - timeTail.length);
	const eventCount = artifactText ? 1 : 2; // subline displaces the older event row

	return (
		<Box
			flexDirection="column"
			width={props.width}
			borderStyle="single"
			borderColor={borderColor}
		>
			<Text
				wrap="truncate"
				bold
				{...(props.selected ? { color: THEME.select as string } : {})}
			>
				{chevron}
				<Text color={glyph.color}>{glyph.glyph}</Text> {pane.label}
				{typeText ? <Text color={THEME.muted}> {typeText}</Text> : null}
				{roundText ? <Text color={THEME.muted}>{roundText}</Text> : null}
			</Text>
			{cwdLine(pane.cwd, props.width)}
			{artifactText ? (
				<Text wrap="truncate" color={THEME.muted}>
					{"  "}→{" "}
					{keepTail(
						artifactBasename(artifactText),
						artifactBudget,
					)}
					{timeTail}
				</Text>
			) : null}
			<Text wrap="truncate">
				{"  "}
				<Text color={THEME.muted}>{progressText}</Text>{" "}
				{showBar ? <Text color={THEME.muted}>{progressBar(pane.progress!)}</Text> : null}
				{pane.agentHealth.map((ah, i) => {
					const d = dotForHealth(ah.health);
					return (
						<Text key={i}>
							{"  "}
							<Text color={AGENT_COLOR[ah.agent]}>{ah.agent}</Text>
							<Text color={d.color}>{d.glyph}</Text>
						</Text>
					);
				})}
			</Text>
			{pane.events.slice(0, eventCount).map((e, i) => (
				<Text key={i} wrap="truncate" color={THEME.muted}>
					{"  "}
					{padRight(e.step, 9)} {padRight(e.route, 13)} {padRight(e.verdict, 9)}
				</Text>
			))}
		</Box>
	);
}

export function CompactCard(props: {
	pane: WallPaneState;
	selected: boolean;
	width: number;
}): ReactElement {
	const { pane } = props;
	const statusWord =
		pane.statusKey === "done"
			? "done"
			: pane.statusKey === "canceled"
				? "canceled"
				: pane.statusKey === "stuck"
					? "halted"
					: pane.statusKey === "idle"
						? "idle"
						: "running";
	const glyph = statusGlyph({
		workflowStatus:
			pane.statusKey === "idle"
				? null
				: pane.statusKey === "stuck"
					? "halted"
					: pane.statusKey,
		stuck: false,
	});
	const borderColor =
		pane.statusKey === "stuck" || pane.statusKey === "canceled"
			? THEME.err
			: props.selected
				? THEME.select
				: THEME.muted;
	const chevron = props.selected ? "▸ " : "  ";
	// CompactCard intentionally uses strict > here (not >= like FullCard).
	// The compact L1 packs glyph + label + type + " · " + status + " · " + elapsed
	// onto one line. At exactly NARROW_PANE_COLS (48) that string overflows and
	// truncates elapsed unless the workflow type is abbreviated. FullCard's L1
	// does not carry status/elapsed, so it can safely widen at >=. Do not
	// "unify" these thresholds — the off-by-one is load-bearing.
	const isWide = props.width > NARROW_PANE_COLS;
	const typeText = pane.workflowType
		? isWide
			? pane.workflowType
			: abbreviateWorkflowType(pane.workflowType)
		: null;
	const statusElapsed = `${statusWord} · ${pane.elapsed}`;
	const compactArtifact = pane.artifact?.trim() || null;
	// Dedicated artifact line: budget = inner width minus border(2), indent(2), "→ "(2).
	const artBudget = Math.max(8, props.width - 2 - 2 - 2);
	const base = compactArtifact ? artifactBasename(compactArtifact) : null;
	return (
		<Box
			flexDirection="column"
			width={props.width}
			borderStyle="single"
			borderColor={borderColor}
		>
			<Text
				wrap="truncate"
				bold
				{...(props.selected ? { color: THEME.select as string } : {})}
			>
				{chevron}
				<Text color={glyph.color}>{glyph.glyph}</Text> {pane.label}
				{typeText ? <Text color={THEME.muted}> {typeText}</Text> : null}
				<Text color={THEME.muted}> · {statusElapsed}</Text>
			</Text>
			{cwdLine(pane.cwd, props.width)}
			<Text wrap="truncate" color={THEME.muted}>
				{"  "}→ {base ? keepTail(base, artBudget) : "—"}
			</Text>
		</Box>
	);
}

export function Wall(props: {
	state: WallState;
	cols: number;
	rows: number;
}): ReactElement {
	const { state } = props;
	if (state.sections.length === 0) {
		return (
			<Box width={props.cols} flexDirection="column">
				<Text color={THEME.muted}>no active collabs (last 30m)</Text>
			</Box>
		);
	}
	const colsCount = Math.max(1, Math.floor(props.cols / MIN_PANE_COLS));
	const paneWidth = Math.floor(props.cols / colsCount);
	let globalIdx = 0;
	return (
		<Box flexDirection="column" width={props.cols}>
			{state.sections.map((sec) => {
				const rows: WallPaneState[][] = [];
				for (let i = 0; i < sec.panes.length; i += colsCount) {
					rows.push(sec.panes.slice(i, i + colsCount));
				}
				return (
					<Box key={sec.group} flexDirection="column">
						<Text color={THEME.muted}>{sec.label}</Text>
						{rows.map((row, ri) => (
							<Box key={ri} flexDirection="row">
								{row.map((pane) => {
									const idx = globalIdx++;
									const selected = idx === state.selected;
									return sec.cardKind === "full" ? (
										<FullCard
											key={pane.collabId}
											pane={pane}
											selected={selected}
											width={paneWidth}
										/>
									) : (
										<CompactCard
											key={pane.collabId}
											pane={pane}
											selected={selected}
											width={paneWidth}
										/>
									);
								})}
							</Box>
						))}
					</Box>
				);
			})}
			<Text color={THEME.muted}>
				{`page ${state.page + 1}/${Math.max(1, state.pageCount)} · ${
					state.totalRuns
				} runs · ↑↓/jk select · ↵ inspect · [ ] page · q quit`}
			</Text>
			<Text color={THEME.muted}>
				● running ⚠ stuck/halted ✓ done ✖ canceled ◌ idle
			</Text>
		</Box>
	);
}

export type InspectorSection = "live" | "timeline" | "evidence" | "cost";

function TabBar(props: { active: InspectorSection }): ReactElement {
	const t = (k: InspectorSection, n: string): ReactNode => {
		const text = k === props.active ? `[${n}]` : ` ${n} `;
		return k === props.active ? (
			<Text key={k} color={THEME.accent} bold>
				{text}
			</Text>
		) : (
			<Text key={k} color={THEME.muted}>
				{text}
			</Text>
		);
	};
	return (
		<Text wrap="truncate">
			{t("live", "1 Live")}
			{t("timeline", "2 Timeline")}
			{t("evidence", "3 Evidence")}
			{t("cost", "4 Cost")}
		</Text>
	);
}

function outcomeColor(outcome: string | null): string | undefined {
	if (!outcome) return undefined;
	if (/escalat|halt|fail|cancel/i.test(outcome)) return THEME.err;
	return THEME.ok;
}

export function Inspector(props: {
	state: InspectorState;
	section: InspectorSection;
	viewport: Viewport;
	cols: number;
	rows: number;
	label: string;
	workflowType: string | null;
	workflowStatus?: "running" | "paused" | "done" | "halted" | "canceled" | null;
}): ReactElement {
	const s = props.state;
	const headGlyph = statusGlyph({
		workflowStatus: props.workflowStatus ?? null,
		stuck: props.state.live.stuck,
	});
	const innerRows = Math.max(3, props.rows - 2);
	return (
		<Box flexDirection="column" width={props.cols}>
			<Text wrap="truncate" bold>
				<Text color={headGlyph.color}>{headGlyph.glyph}</Text> {props.label}
				{" · "}
				<Text color={THEME.muted}>{props.workflowType ?? "manual relay"}</Text>
			</Text>
			<Text wrap="truncate">
				<TabBar active={props.section} />
				<Text color={THEME.muted}>
					{`   1-4 section${
						props.section === "live" ? " · ↑↓/g/G/f scroll" : ""
					} · Esc wall · q quit`}
				</Text>
			</Text>
			{props.section === "live" ? (
				<RelayView
					state={s.live}
					viewport={props.viewport}
					rows={innerRows}
					cols={props.cols}
				/>
			) : props.section === "timeline" ? (
				<Box flexDirection="column">
					{s.workflowHistory.length > 0 ? (
						<Box flexDirection="column">
							<Text wrap="truncate" color={THEME.muted}>
								{`WORKFLOW HISTORY (${s.workflowHistory.length})`}
							</Text>
							{s.workflowHistory.map((w) => {
								// Paused is excluded from this phase — broker types forbid it
								// from reaching here. Other statuses go through statusGlyph.
								const wfStatus =
									w.status === "paused"
										? null // defensive: should never happen
										: w.status;
								const g = statusGlyph({ workflowStatus: wfStatus, stuck: false });
								return (
									<Text
										key={w.workflowId}
										wrap="truncate"
										bold={w.selected}
										{...(w.selected ? {} : { color: THEME.muted })}
									>
										{`${w.selected ? "▸" : " "} `}
										<Text color={g.color}>{g.glyph}</Text>
										{` ${w.workflowId.slice(0, 12)}  ${w.workflowType}  ${w.status}  ${w.createdAt}`}
									</Text>
								);
							})}
						</Box>
					) : null}
					<Text wrap="truncate" color={THEME.muted}>
						{`${padRight("PHASE", 18)}  ${padRight("R/MAX", 5)}  ${padRight(
							"TIME",
							6,
						)}  ${padRight("~TOK", 9)}  OUTCOME`}
					</Text>
					{s.timeline.map((p) => (
						<Text key={p.phaseRunId} wrap="truncate">
							{`${padRight(p.phaseName, 18)}  ${padRight(
								`${p.roundsUsed}/${p.maxRounds}`,
								5,
							)}  ${padRight(
								p.durationMs == null ? "–" : fmtDur(p.durationMs),
								6,
							)}  ${padRight(`≈${p.estInTokens + p.estOutTokens}`, 9)}  `}
							{(() => {
								const oc = outcomeColor(p.outcome);
								return oc ? (
									<Text color={oc}>{p.outcome ?? "⋯"}</Text>
								) : (
									<Text>{p.outcome ?? "⋯"}</Text>
								);
							})()}
						</Text>
					))}
					<Text wrap="truncate" bold>
						{`TOTAL  ≈${s.cost.estInputTokens + s.cost.estOutputTokens}  ${fmtDur(
							s.cost.totalMs,
						)}`}
					</Text>
				</Box>
			) : props.section === "evidence" ? (
				<Box flexDirection="column">
					<Text wrap="truncate" color={THEME.muted}>
						{`${s.evidence.phase ?? "—"} · chain ${s.evidence.chainId ?? "—"}`}
					</Text>
					{s.evidence.items.map((it, i) => (
						<Text key={i} wrap="truncate">
							{`R${it.round ?? "-"} ${it.step ?? "-"} ${it.sender}→${it.target} `}
							{(() => {
								const vc = outcomeColor(it.verdict);
								return vc ? (
									<Text color={vc}>{it.verdict ?? "-"}</Text>
								) : (
									<Text>{it.verdict ?? "-"}</Text>
								);
							})()}
							{` ${it.confidence ?? "-"} ${it.reasonExcerpt}`}
						</Text>
					))}
					{s.evidence.diagnostics.map((d, i) => (
						<Text key={`d${i}`} wrap="truncate" color={THEME.muted}>
							{`${d.kind}: ${d.text}`}
						</Text>
					))}
					<Text wrap="truncate" color={THEME.warn}>
						{`▸ ${s.evidence.likelyCause}`}
					</Text>
				</Box>
			) : (
				<Box flexDirection="column">
					<Text wrap="truncate">
						{`total ${fmtDur(s.cost.totalMs)} · in ≈${s.cost.estInputTokens} · out ≈${s.cost.estOutputTokens}  (est, not metered)`}
					</Text>
					{s.cost.perPhase.map((p, i) => (
						<Text key={i} wrap="truncate" color={THEME.muted}>
							{`${p.phaseName}  in ≈${p.estInTokens}  out ≈${p.estOutTokens}  ${
								p.durationMs == null ? "–" : fmtDur(p.durationMs)
							}`}
						</Text>
					))}
				</Box>
			)}
		</Box>
	);
}

type KeyEv = {
	upArrow?: boolean;
	downArrow?: boolean;
	escape?: boolean;
	key?: string;
};

// Mounted ONLY when raw mode is supported. Isolating useInput in a child
// lets us mount it conditionally without breaking the rules of hooks — the
// same pattern as relay-view-input's InputCapture, but dashboard-owned so
// relay-view-input.tsx stays untouched (spec §8 / F4).
function DashInput(props: {
	onKey: (ev: KeyEv) => void;
	children: ReactNode;
}): ReactElement {
	useInput((inputCh, key) => {
		if (key.escape) return props.onKey({ escape: true });
		if (key.upArrow) return props.onKey({ upArrow: true });
		if (key.downArrow) return props.onKey({ downArrow: true });
		props.onKey({ key: inputCh });
	});
	return <>{props.children}</>;
}

export function DashboardApp(props: {
	node: ReactElement;
	onKey: (ev: KeyEv) => void;
}): ReactElement {
	const { isRawModeSupported } = useStdin();
	return isRawModeSupported ? (
		<DashInput onKey={props.onKey}>{props.node}</DashInput>
	) : (
		props.node
	);
}
