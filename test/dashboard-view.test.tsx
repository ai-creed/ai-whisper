import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import {
	Wall,
	gridCapacity,
	Inspector,
	midEllipsis,
	keepTail,
	FullCard,
	CompactCard,
} from "../packages/cli/src/runtime/dashboard-view.tsx";
import type {
	InspectorState,
	PhaseStat,
	WallPaneState,
	WallState,
	WorkflowHistoryItem,
} from "../packages/cli/src/runtime/dashboard-state.ts";
import type { WallSummaryCounts } from "../packages/cli/src/runtime/dashboard-state.ts";
import { CARD_HEIGHT } from "../packages/cli/src/runtime/dashboard-state.ts";
import type { RelayViewState } from "../packages/cli/src/runtime/relay-view-state.ts";
import type { Viewport } from "../packages/cli/src/runtime/relay-view.ts";
import { readFileSync } from "node:fs";

// ---- Shared Wall fixture helpers (Tasks 8-12) ----

type PaneOverrides = Partial<WallPaneState> & {
	collabId: string;
	statusKey: WallPaneState["statusKey"];
};

function mkPane(p: PaneOverrides): WallPaneState {
	return {
		workflowId: `wf-${p.collabId}`,
		label: "lbl",
		workflowType: "complex-bug-fixing",
		round: { current: 1, max: 3 },
		progress: { current: 2, total: 5 },
		agentHealth: [
			{ agent: "codex", health: "healthy" },
			{ agent: "claude", health: "healthy" },
		],
		stuckWhy: null,
		events: [
			{ step: "review", route: "codex→claude", verdict: "pass" },
			{ step: "execute", route: "claude→codex", verdict: "-" },
		],
		elapsed: "1m23s",
		startIso: null,
		artifact: null,
		cwd: null,
		cardKind: "full",
		...p,
	};
}

type SectionInput = {
	group: WallState["sections"][number]["group"];
	label?: string;
	cardKind?: "full" | "compact";
	panes: WallPaneState[];
};

function mkSection(input: SectionInput): WallState["sections"][number] {
	const cardKind = input.cardKind ?? (input.group === "active" ? "full" : "compact");
	const groupLabels: Record<WallState["sections"][number]["group"], string> = {
		active: "ACTIVE",
		idleManual: "IDLE / MANUAL",
		halted: "HALTED",
		doneCanceled: "DONE / CANCELED",
	};
	const label = input.label ?? `${groupLabels[input.group]} (${input.panes.length})`;
	return { group: input.group, label, cardKind, panes: input.panes };
}

function mkWallState(input: {
	sections?: WallState["sections"];
	selected?: number;
	page?: number;
	pageCount?: number;
	totalRuns?: number;
}): WallState {
	const sections = input.sections ?? [];
	const panes = sections.flatMap((s) => s.panes);
	const totalRuns = input.totalRuns ?? panes.length;
	return {
		sections,
		panes,
		page: input.page ?? 0,
		pageCount: input.pageCount ?? 1,
		totalRuns,
		selected: input.selected ?? 0,
	};
}

function stripAnsi(s: string): string {
	// ESC [ ... letter — drop SGR codes so text-content assertions can match.
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

// Lines of a single rendered card: total non-blank rows minus the 2 border rows.
// A bordered Ink box renders `│…│` on every content row, so non-blank == box rows.
function cardContentLines(frame: string): number {
	return stripAnsi(frame).split("\n").filter((l) => l.trim().length > 0).length - 2;
}

describe("Compact card — readable filename", () => {
	const compactPane = (artifact: string | null) =>
		mkPane({
			collabId: "d1",
			statusKey: "done",
			label: "devel",
			workflowType: "spec-driven-development",
			elapsed: "5h12m",
			artifact,
			cardKind: "compact",
			events: [],
		});

	it("shows the full basename on its own line, status+elapsed on L1, no P4/4 packing", () => {
		const out = stripAnsi(
			render(
				<CompactCard
					pane={compactPane("docs/superpowers/specs/2026-06-23-pr-e2e-gate-devel-design.md")}
					selected={false}
					width={48}
				/>,
			).lastFrame() ?? "",
		);
		expect(out).toContain("2026-06-23-pr-e2e-gate-devel-design.md");
		expect(out).toContain("done");
		expect(out).toContain("5h12m");
		expect(out).not.toContain("docs/superpowers"); // directory dropped
		expect(out).not.toContain("P4/4"); // progress token gone from compact
	});

	it("renders the → — placeholder and keeps the compact content-line count", () => {
		const noArt = stripAnsi(render(<CompactCard pane={compactPane(null)} selected={false} width={48} />).lastFrame() ?? "");
		const withArt = stripAnsi(render(<CompactCard pane={compactPane("docs/x/foo.md")} selected={false} width={48} />).lastFrame() ?? "");
		expect(noArt).toContain("→ —");
		// Isolated card (no Wall chrome): same content-line count with/without artifact.
		expect(cardContentLines(noArt)).toBe(cardContentLines(withArt));
	});
});

describe("cwd line + card height budget", () => {
	const fullPane = (over: Partial<WallPaneState> = {}) =>
		mkPane({
			collabId: "c1",
			statusKey: "running",
			label: "ai-14all",
			cwd: "~/Dev/ai-14all/.worktrees/devel",
			artifact: "docs/specs/2026-06-23-x-design.md",
			events: [
				{ step: "review", route: "ezio→claude", verdict: "pass" },
				{ step: "draft", route: "claude→ezio", verdict: "-" },
			],
			...over,
		});
	const renderFull = (over: Partial<WallPaneState> = {}, width = 56) =>
		stripAnsi(render(<FullCard pane={fullPane(over)} selected={false} width={width} />).lastFrame() ?? "");

	it("full card WITH artifact shows the cwd line and renders exactly 5 content lines", () => {
		const out = renderFull();
		expect(out).toContain("⌂ ~/Dev/ai-14all/.worktrees/devel");
		expect(out).toContain("x-design.md"); // basename artifact line present
		expect(cardContentLines(out)).toBe(CARD_HEIGHT.full - 2); // exactly 5
	});

	it("full card with NO artifact event-displaces to still render exactly 5 lines", () => {
		const out = renderFull({ artifact: null }); // 2 events available → eventCount 2
		expect(out).not.toContain("x-design.md"); // artifact line gone
		expect(cardContentLines(out)).toBe(CARD_HEIGHT.full - 2); // still exactly 5
	});

	it("full card with no artifact and fewer than two events renders fewer lines, never more", () => {
		const out = renderFull({
			artifact: null,
			events: [{ step: "review", route: "ezio→claude", verdict: "pass" }], // only 1
		});
		expect(cardContentLines(out)).toBeLessThan(CARD_HEIGHT.full - 2); // 4 — not padded
	});

	it("stuck full card shows the cwd line (early-return) and stays within budget", () => {
		const out = renderFull({
			statusKey: "stuck",
			stuckWhy: "STUCK 6m12s — round 3/3 max reached → escalated",
		});
		expect(out).toContain("⌂ ~/Dev/ai-14all/.worktrees/devel");
		expect(out).toContain("STUCK 6m12s");
		expect(cardContentLines(out)).toBeLessThanOrEqual(CARD_HEIGHT.full - 2);
	});

	it("compact card shows the cwd line and renders exactly 3 content lines", () => {
		const out = stripAnsi(
			render(
				<CompactCard pane={fullPane({ statusKey: "done", cardKind: "compact", events: [] })} selected={false} width={56} />,
			).lastFrame() ?? "",
		);
		expect(out).toContain("⌂ ~/Dev/ai-14all/.worktrees/devel");
		expect(cardContentLines(out)).toBe(CARD_HEIGHT.compact - 2); // exactly 3
	});

	it("renders ⌂ — when cwd is null", () => {
		expect(renderFull({ cwd: null })).toContain("⌂ —");
	});

	it("front-clips a long cwd on a narrow card (keepTail applied to cwd, not raw)", () => {
		const out = renderFull({}, 32); // budget 26 < 31-char path → must clip
		expect(out).toMatch(/⌂ …/); // leading ellipsis present
		expect(out).toContain("worktrees/devel"); // distinctive tail kept
		expect(out).not.toContain("⌂ ~/Dev/ai-14all/.worktrees/devel"); // full string NOT shown whole
	});

	it("renders main vs worktree cwd readably and distinctly on a wide card", () => {
		const main = renderFull({ cwd: "~/Dev/ai-cortex" });
		const wt = renderFull({ cwd: "~/Dev/ai-14all/.worktrees/devel" });
		expect(main).toContain("⌂ ~/Dev/ai-cortex"); // main checkout fully readable
		expect(main).not.toContain(".worktrees"); // clearly not a worktree
		expect(wt).toContain("⌂ ~/Dev/ai-14all/.worktrees/devel"); // worktree fully readable + distinct
	});
});

// ---- Shared Inspector fixture helpers (Task 13) ----

const defaultViewport: Viewport = { offset: 0, follow: true };

function mkLive(p: Partial<RelayViewState> = {}): RelayViewState {
	return {
		wf: 'complex-bug-fixing  wf123…  "demo"',
		progress: "Phase 2/5 plan-writing · Round 1/3 · Step review",
		elapsed: "total 1m23s · phase 0m45s",
		turn: "codex · waiting claude · handoff accepted",
		health: "● codex  ● claude  Chain active · ALIVE",
		agentHealth: [
			{ agent: "codex", health: "healthy" },
			{ agent: "claude", health: "healthy" },
		],
		live: "idle 5s",
		why: null,
		last: "approve 0.92 · capture ok",
		stuck: false,
		logLines: [],
		...p,
	};
}

function mkInspectorState(p: {
	stuck: boolean;
	timeline?: PhaseStat[];
	workflowHistory?: WorkflowHistoryItem[];
}): InspectorState {
	return {
		live: mkLive({
			stuck: p.stuck,
			why: p.stuck ? "STUCK 6m12s — round 3/3 max reached → escalated" : null,
		}),
		timeline: p.timeline ?? [
			{
				phaseRunId: "pr-0",
				phaseIndex: 0,
				phaseName: "plan",
				roundsUsed: 1,
				maxRounds: 3,
				durationMs: 60_000,
				outcome: "approve",
				estInTokens: 100,
				estOutTokens: 50,
			},
		],
		workflowHistory: p.workflowHistory ?? [],
		evidence: {
			phase: "plan",
			chainId: "chain-1",
			items: [],
			diagnostics: [],
			likelyCause: "no blocking signal — run progressing",
		},
		cost: { totalMs: 60_000, estInputTokens: 100, estOutputTokens: 50, perPhase: [] },
	};
}

describe("gridCapacity", () => {
	it("derives cols×rows from terminal size with a min pane floor, ≥1", () => {
		expect(gridCapacity(100, 24)).toBe(
			Math.max(1, Math.floor(100 / 40)) * Math.max(1, Math.floor(24 / 5)),
		);
		expect(gridCapacity(10, 3)).toBe(1);
	});
});

describe("Wall — theme migration (Task 8)", () => {
	it("uses no raw cyan/magenta literals in dashboard-view source", () => {
		const src = readFileSync("packages/cli/src/runtime/dashboard-view.tsx", "utf8");
		expect(src).not.toMatch(/"cyan"|"magenta"/);
	});

	it("Wall pane uses single-style borders", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [mkPane({ collabId: "c1", statusKey: "running" })],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const out = lastFrame() ?? "";
		expect(out).toMatch(/[┌┐└┘]/);
		expect(out).not.toMatch(/[╭╮╰╯]/);
	});
});

describe("Wall — full ACTIVE card (Task 9)", () => {
	it("full ACTIVE card renders chevron, glyph, label, dimmed type, round, progress bar, and agent dots", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							label: "mylabel",
							workflowType: "complex-bug-fixing",
							round: { current: 1, max: 3 },
							progress: { current: 2, total: 5 },
						}),
					],
				}),
			],
			selected: 0,
		});
		// cols=100 → colsCount=2, paneWidth=50 (>= NARROW_PANE_COLS=48) → bar renders.
		const { lastFrame } = render(<Wall state={state} cols={100} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("▸ ● mylabel");
		expect(out).toContain("complex-bug-fixing");
		expect(out).toContain("R1/3");
		expect(out).toContain("P2/5");
		expect(out).toMatch(/[▰▱]/); // progress bar present
		expect(out).toContain("codex");
		expect(out).toContain("claude");
	});

	it("two-pane 80-col wall drops the bar (each pane is 40 cols, below NARROW_PANE_COLS)", () => {
		// Spec §Full card narrow-pane fallback keys off PER-PANE width, not
		// terminal width. At cols=80 the grid is 2 columns × 40 cols per pane;
		// 40 < 48 → bar must collapse to plain `P<n>/<total>` text even though
		// the terminal itself is wide.
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							label: "alpha",
							progress: { current: 2, total: 5 },
						}),
						mkPane({
							collabId: "c2",
							statusKey: "running",
							label: "beta",
							progress: { current: 1, total: 5 },
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("P2/5");
		expect(out).toContain("P1/5");
		expect(out).not.toMatch(/[▰▱]/);
	});

	it("narrow pane (80-col, 2-col grid → 40-col panes) abbreviates the workflow type so the header doesn't truncate", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							label: "ai-whisper",
							workflowType: "complex-bug-fixing",
							round: { current: 1, max: 3 },
							progress: { current: 2, total: 5 },
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("bugfix");
		expect(out).not.toContain("complex-bug-fixing");
	});

	it("wide pane (cols=96 → 2×48-col panes, paneWidth≥NARROW_PANE_COLS) keeps the full dimmed workflow type", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							label: "ai-whisper",
							workflowType: "complex-bug-fixing",
							round: { current: 1, max: 3 },
							progress: { current: 2, total: 5 },
						}),
					],
				}),
			],
		});
		// cols=96 → colsCount=floor(96/40)=2 → paneWidth=48 (≥NARROW_PANE_COLS).
		const { lastFrame } = render(<Wall state={state} cols={96} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("complex-bug-fixing");
		expect(out).not.toMatch(/\bbugfix\b/);
	});

	it("narrow pane drops the bar and shows P n/total text only", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							label: "mylabel",
							workflowType: "complex-bug-fixing",
							round: { current: 1, max: 3 },
							progress: { current: 2, total: 5 },
						}),
					],
				}),
			],
			selected: 0,
		});
		const { lastFrame } = render(<Wall state={state} cols={45} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("P2/5");
		expect(out).not.toMatch(/[▰▱]/);
	});

	it("renders the degraded per-agent dot as ◐ in THEME.warn (yellow SGR 33)", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							agentHealth: [
								{ agent: "codex", health: "healthy" },
								{ agent: "claude", health: "degraded" },
							],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const raw = lastFrame() ?? "";
		const out = stripAnsi(raw);
		expect(out).toContain("◐");
		// degraded dot uses THEME.warn (yellow). Allow either SGR 33 or the 256/16M variants chalk may emit.
		expect(raw).toMatch(/\x1b\[(33|93|38;5;\d+|38;2;[\d;]+)m[^\x1b]*◐/);
		// claude name uses AGENT_COLOR.claude (#D97757). Allow 256-color or true-color encodings.
		expect(raw).toMatch(/\x1b\[(38;5;\d+|38;2;217;119;87)m[^\x1b]*claude/);
	});

	it("renders the dead per-agent dot as ○ in THEME.err (red SGR 31)", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							agentHealth: [
								{ agent: "codex", health: "dead" },
								{ agent: "claude", health: "healthy" },
							],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const raw = lastFrame() ?? "";
		const out = stripAnsi(raw);
		expect(out).toContain("○");
		// dead dot uses THEME.err (red). Allow SGR 31 or 256/truecolor encodings.
		expect(raw).toMatch(/\x1b\[(31|91|38;5;\d+|38;2;[\d;]+)m[^\x1b]*○/);
		// codex name uses AGENT_COLOR.codex (#5FB3C9).
		expect(raw).toMatch(/\x1b\[(38;5;\d+|38;2;95;179;201)m[^\x1b]*codex/);
	});

	it("renders a healthy per-agent dot as ● in THEME.ok (green SGR 32)", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							agentHealth: [
								{ agent: "codex", health: "healthy" },
								{ agent: "claude", health: "healthy" },
							],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const raw = lastFrame() ?? "";
		// healthy dot uses THEME.ok (green).
		expect(raw).toMatch(/\x1b\[(32|92|38;5;\d+|38;2;[\d;]+)m[^\x1b]*●/);
	});
});

describe("Wall — stuck card variant (Task 10)", () => {
	it("stuck card uses ⚠ glyph, red border, and suppresses event rows even when events are present", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "stuck",
							label: "mylabel",
							workflowType: "complex-bug-fixing",
							round: { current: 3, max: 3 },
							stuckWhy: "STUCK 6m12s — round 3/3 max reached → escalated",
							events: [
								{ step: "review", route: "codex→claude", verdict: "pass" },
								{ step: "execute", route: "claude→codex", verdict: "-" },
							],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("⚠");
		expect(out).toContain("STUCK 6m12s");
		expect(out).not.toMatch(/codex→claude/);
		expect(out).not.toMatch(/claude→codex/);
		expect(out).not.toMatch(/\breview\b/);
		expect(out).not.toMatch(/\bexecute\b/);
		expect(out).not.toMatch(/\bpass\b/);
	});
});

describe("Wall — compact card (Task 11)", () => {
	it("compact DONE card uses ✓ glyph, status word, elapsed; no event rows", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "doneCanceled",
					panes: [
						mkPane({
							collabId: "d1",
							statusKey: "done",
							label: "donelabel",
							workflowType: "spec-driven-development",
							round: null,
							progress: { current: 5, total: 5 },
							elapsed: "4m12s",
							cardKind: "compact",
							events: [],
						}),
					],
				}),
			],
		});
		// cols=80 → paneWidth=40 (< NARROW_PANE_COLS=48) → workflow type
		// renders in abbreviated form. "spec-driven-development" → "sdd".
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("✓ donelabel");
		expect(out).toContain("sdd");
		expect(out).not.toContain("spec-driven-development");
		// New compact shape (Task 2): P token removed; status+elapsed on L1, → — on L2.
		expect(out).not.toContain("P5/5");
		expect(out).toContain("done");
		expect(out).toContain("4m12s");
		expect(out).toContain("→ —"); // no artifact → placeholder line
	});

	it("compact CANCELED card uses ✖ glyph in err color", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "doneCanceled",
					panes: [
						mkPane({
							collabId: "x1",
							statusKey: "canceled",
							label: "cancellabel",
							workflowType: "complex-bug-fixing",
							round: null,
							progress: { current: 3, total: 5 },
							elapsed: "2m08s",
							cardKind: "compact",
							events: [],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const raw = lastFrame() ?? "";
		const out = stripAnsi(raw);
		expect(out).toContain("✖");
		// Err color guard: the raw frame must contain a red SGR (any encoding).
		expect(raw).toMatch(/\x1b\[(31|91|38;5;\d+|38;2;[\d;]+)m/);
	});

	it("compact HALTED card uses ⚠ glyph in err color", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "halted",
					panes: [
						mkPane({
							collabId: "h1",
							statusKey: "stuck",
							label: "haltlabel",
							workflowType: "spec-driven-development",
							round: null,
							progress: { current: 2, total: 4 },
							elapsed: "5m00s",
							cardKind: "compact",
							stuckWhy: null,
							events: [],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const raw = lastFrame() ?? "";
		const out = stripAnsi(raw);
		expect(out).toContain("⚠");
		expect(raw).toMatch(/\x1b\[(31|91|38;5;\d+|38;2;[\d;]+)m/);
	});
});

describe("Wall — sectioned grid + footer (Task 12)", () => {
	it("Wall renders a labeled section header with the group count for each non-empty section", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({ collabId: "a1", statusKey: "running", label: "alpha" }),
						mkPane({ collabId: "a2", statusKey: "running", label: "beta" }),
					],
				}),
				mkSection({
					group: "halted",
					panes: [
						mkPane({
							collabId: "h1",
							statusKey: "stuck",
							label: "halt1",
							round: null,
							progress: { current: 1, total: 4 },
							cardKind: "compact",
							events: [],
						}),
					],
				}),
				mkSection({
					group: "doneCanceled",
					panes: [
						mkPane({
							collabId: "d1",
							statusKey: "done",
							label: "donelabel",
							round: null,
							progress: { current: 5, total: 5 },
							elapsed: "4m12s",
							cardKind: "compact",
							events: [],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={30} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("ACTIVE (2)");
		expect(out).toContain("HALTED (1)");
		expect(out).toContain("DONE / CANCELED (1)");
	});

	it("Wall footer includes the keybinding row and the glyph legend", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [mkPane({ collabId: "a1", statusKey: "running", label: "alpha" })],
				}),
			],
			pageCount: 2,
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={30} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toMatch(/page \d+\/\d+/);
		expect(out).toContain("● running");
		expect(out).toContain("⚠ stuck/halted");
		expect(out).toContain("✓ done");
		expect(out).toContain("✖ canceled");
		expect(out).toContain("◌ idle");
	});

	it("empty Wall keeps the existing 'no active collabs' message", () => {
		const empty = { sections: [], panes: [], page: 0, pageCount: 1, totalRuns: 0, selected: 0 } as WallState;
		const { lastFrame } = render(<Wall state={empty} cols={80} rows={30} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("no active collabs");
	});
});

describe("Inspector polish (Task 13)", () => {
	it("Inspector header shows the status glyph in THEME color before the label", () => {
		const state = mkInspectorState({ stuck: false });
		const { lastFrame } = render(
			<Inspector
				state={state}
				section="live"
				viewport={defaultViewport}
				cols={120}
				rows={40}
				label="mylabel"
				workflowType="complex-bug-fixing"
				workflowStatus="running"
			/>,
		);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toMatch(/●\s+mylabel/);
	});

	it("Inspector tab bar marks the active tab with the accent color (SGR sequence present before [2 Timeline])", () => {
		const state = mkInspectorState({ stuck: false });
		const { lastFrame } = render(
			<Inspector
				state={state}
				section="timeline"
				viewport={defaultViewport}
				cols={120}
				rows={40}
				label="mylabel"
				workflowType="complex-bug-fixing"
				workflowStatus="running"
			/>,
		);
		const raw = lastFrame() ?? "";
		expect(raw).toMatch(/\x1b\[[0-9;]*m\[2 Timeline\]/);
	});

	it("Inspector timeline outcome colors are tied to THEME tokens (ok green, fail red)", () => {
		const state = mkInspectorState({
			stuck: false,
			timeline: [
				{
					phaseRunId: "pr-0",
					phaseIndex: 0,
					phaseName: "plan",
					roundsUsed: 1,
					maxRounds: 3,
					durationMs: 60_000,
					outcome: "approve",
					estInTokens: 100,
					estOutTokens: 50,
				},
				{
					phaseRunId: "pr-1",
					phaseIndex: 1,
					phaseName: "implement",
					roundsUsed: 3,
					maxRounds: 3,
					durationMs: 240_000,
					outcome: "escalate",
					estInTokens: 400,
					estOutTokens: 200,
				},
			],
		});
		const { lastFrame } = render(
			<Inspector
				state={state}
				section="timeline"
				viewport={defaultViewport}
				cols={120}
				rows={40}
				label="mylabel"
				workflowType="complex-bug-fixing"
				workflowStatus="running"
			/>,
		);
		const raw = lastFrame() ?? "";
		// Approve gets the ok (green) SGR; escalate gets err (red) SGR.
		expect(raw).toMatch(/\x1b\[(32|92|38;5;\d+|38;2;[\d;]+)m[^\x1b]*approve/);
		expect(raw).toMatch(/\x1b\[(31|91|38;5;\d+|38;2;[\d;]+)m[^\x1b]*escalate/);
	});

	it("Inspector workflow history colors statuses via the in-scope glyph map (no paused)", () => {
		const state = mkInspectorState({
			stuck: false,
			workflowHistory: [
				{
					workflowId: "wf-run",
					workflowType: "complex-bug-fixing",
					name: null,
					status: "running",
					currentPhaseIndex: 1,
					createdAt: "2026-05-28T00:00:00Z",
					selected: true,
				},
				{
					workflowId: "wf-done",
					workflowType: "spec-driven-development",
					name: null,
					status: "done",
					currentPhaseIndex: 4,
					createdAt: "2026-05-27T00:00:00Z",
					selected: false,
				},
				{
					workflowId: "wf-halt",
					workflowType: "complex-bug-fixing",
					name: null,
					status: "halted",
					currentPhaseIndex: 2,
					createdAt: "2026-05-26T00:00:00Z",
					selected: false,
				},
				{
					workflowId: "wf-canx",
					workflowType: "ralph-loop",
					name: null,
					status: "canceled",
					currentPhaseIndex: 0,
					createdAt: "2026-05-25T00:00:00Z",
					selected: false,
				},
			],
		});
		const { lastFrame } = render(
			<Inspector
				state={state}
				section="timeline"
				viewport={defaultViewport}
				cols={120}
				rows={40}
				label="mylabel"
				workflowType="complex-bug-fixing"
				workflowStatus="running"
			/>,
		);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toMatch(/●/); // running
		expect(out).toMatch(/✓/); // done
		expect(out).toMatch(/⚠/); // halted
		expect(out).toMatch(/✖/); // canceled
		expect(out).not.toContain("⏸"); // paused deferred
	});

	it("renders re-run phases (same phaseIndex after escalate→resume) without a duplicate React key warning", () => {
		// Escalate→resume re-runs a phase: the escalated run gets endedAt set, then
		// resume opens a fresh phase_runs row at the SAME phaseIndex. getWorkflowPhaseRuns
		// returns both, so two timeline rows share a phaseIndex. Keying the list on the
		// unique phaseRunId (not phaseIndex) must keep React keys unique.
		const state = mkInspectorState({
			stuck: false,
			timeline: [
				{
					phaseRunId: "pr-escalated",
					phaseIndex: 2,
					phaseName: "code-review",
					roundsUsed: 3,
					maxRounds: 3,
					durationMs: 120_000,
					outcome: "escalate",
					estInTokens: 200,
					estOutTokens: 100,
				},
				{
					phaseRunId: "pr-resumed",
					phaseIndex: 2,
					phaseName: "code-review",
					roundsUsed: 1,
					maxRounds: 3,
					durationMs: 60_000,
					outcome: "approve",
					estInTokens: 150,
					estOutTokens: 80,
				},
			],
		});
		const errors: string[] = [];
		const spy = vi
			.spyOn(console, "error")
			.mockImplementation((...args: unknown[]) => {
				errors.push(args.map(String).join(" "));
			});
		try {
			render(
				<Inspector
					state={state}
					section="timeline"
					viewport={defaultViewport}
					cols={120}
					rows={40}
					label="mylabel"
					workflowType="complex-bug-fixing"
					workflowStatus="running"
				/>,
			);
		} finally {
			spy.mockRestore();
		}
		expect(errors.join("\n")).not.toMatch(/same key/i);
	});
});

describe("Wall — artifact subline + started-at (Fix 2/3)", () => {
	it("full ACTIVE card renders the artifact subline, HH:MM (UTC), elapsed, and real agent dots", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							label: "mylabel",
							artifact: "docs/foo.md",
							startIso: "2026-06-10T09:15:00.000Z",
							elapsed: "1m23s",
							agentHealth: [
								{ agent: "ezio", health: "healthy" },
								{ agent: "claude", health: "healthy" },
							],
							events: [
								{ step: "review", route: "ezio→claude", verdict: "pass" },
								{ step: "draft", route: "claude→ezio", verdict: "-" },
							],
						}),
					],
				}),
			],
			selected: 0,
		});
		const { lastFrame } = render(<Wall state={state} cols={100} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("→ foo.md"); // basename only, no directory
		expect(out).toContain("09:15"); // UTC HH:MM from startIso
		expect(out).toContain("1m23s");
		expect(out).toContain("ezio");
		expect(out).not.toContain("codex"); // no phantom agent anywhere on the card
		// event tail reduced 2 → 1: only the most recent event row renders
		expect(out).toContain("review");
		expect(out).toContain("ezio→claude");
		expect(out).not.toContain("draft");
		expect(out).not.toContain("claude→ezio");
	});

	it("full card stays the same height with the artifact subline (event tail 2→1, no 5th line)", () => {
		const mk = (artifact: string | null) =>
			mkWallState({
				sections: [
					mkSection({
						group: "active",
						panes: [
							mkPane({
								collabId: "c1",
								statusKey: "running",
								label: "mylabel",
								artifact,
								startIso: "2026-06-10T09:15:00.000Z",
								events: [
									{ step: "review", route: "ezio→claude", verdict: "pass" },
									{ step: "draft", route: "claude→ezio", verdict: "-" },
								],
							}),
						],
					}),
				],
			});
		const lineCount = (s: string) => stripAnsi(s).split("\n").length;
		const withArtifact = lineCount(render(<Wall state={mk("docs/foo.md")} cols={100} rows={20} />).lastFrame() ?? "");
		const without = lineCount(render(<Wall state={mk(null)} cols={100} rows={20} />).lastFrame() ?? "");
		// Adding the subline must NOT grow the card: it displaces the older event row.
		expect(withArtifact).toBe(without);
	});

	it("narrow full card drops the time tail but keeps the artifact basename", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							label: "mylabel",
							artifact: "docs/superpowers/specs/2026-06-10-foo-design.md",
							startIso: "2026-06-10T09:15:00.000Z",
							elapsed: "1m23s",
						}),
					],
				}),
			],
		});
		// cols=45 → single 45-col pane (< NARROW_PANE_COLS=48) → time tail dropped.
		const { lastFrame } = render(<Wall state={state} cols={45} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("→");
		expect(out).toContain("design.md"); // basename survives middle-ellipsis
		expect(out).not.toContain("09:15"); // time tail dropped on the narrow card
	});

	it("full card with no artifact falls back to the prior shape (no empty subline, two events)", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							label: "mylabel",
							artifact: null,
							events: [
								{ step: "review", route: "ezio→claude", verdict: "pass" },
								{ step: "draft", route: "claude→ezio", verdict: "-" },
							],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={100} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).not.toContain("→ "); // no artifact subline (event routes' bare "→" are fine)
		// both events retained when there is no subline
		expect(out).toContain("review");
		expect(out).toContain("draft");
	});

	it("compact card L2 shows basename only (no dir), status+elapsed on L1, P token gone", () => {
		// Renamed from "…prepends the artifact and RETAINS P/x" (Task 2 reflow).
		const state = mkWallState({
			sections: [
				mkSection({
					group: "doneCanceled",
					panes: [
						mkPane({
							collabId: "d1",
							statusKey: "done",
							label: "donelabel",
							round: null,
							progress: { current: 5, total: 5 },
							elapsed: "4m12s",
							artifact: "docs/foo.md",
							cardKind: "compact",
							events: [],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={100} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		// New shape: L2 shows basename only; full path dropped.
		expect(out).toContain("→ foo.md");
		expect(out).not.toContain("→ docs/foo.md"); // directory prefix stripped
		expect(out).not.toContain("P5/5"); // progress token removed from compact
		expect(out).toContain("done");
		expect(out).toContain("4m12s");
	});

	it("compact card with no artifact shows → — placeholder on L2", () => {
		// Renamed from "…keeps today's line 2 (no leading arrow)" (Task 2 reflow).
		const state = mkWallState({
			sections: [
				mkSection({
					group: "doneCanceled",
					panes: [
						mkPane({
							collabId: "d2",
							statusKey: "done",
							label: "donelabel",
							round: null,
							progress: { current: 5, total: 5 },
							elapsed: "4m12s",
							artifact: null,
							cardKind: "compact",
							events: [],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={100} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		// New shape: no artifact → always renders → — placeholder.
		expect(out).toContain("→ —");
		expect(out).not.toContain("P5/5"); // progress token removed from compact
		expect(out).toContain("done");
	});

	it("whitespace-only artifact omits the subline and keeps both event rows (full card)", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							label: "mylabel",
							artifact: "   ",
							events: [
								{ step: "review", route: "ezio→claude", verdict: "pass" },
								{ step: "draft", route: "claude→ezio", verdict: "-" },
							],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={100} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).not.toContain("→ "); // no empty-arrow subline (event routes' bare "→" are fine)
		expect(out).toContain("review");
		expect(out).toContain("draft"); // both events retained (fallback shape)
	});
});

describe("midEllipsis", () => {
	it("keeps the basename and fits the budget", () => {
		const r = midEllipsis("docs/superpowers/specs/2026-06-10-foo-design.md", 24);
		expect(r.length).toBeLessThanOrEqual(24);
		expect(r).toContain("…");
		expect(r.endsWith("design.md")).toBe(true);
	});

	it("returns the string unchanged when it already fits", () => {
		expect(midEllipsis("docs/foo.md", 40)).toBe("docs/foo.md");
	});
});

describe("keepTail", () => {
	it("returns the string unchanged when it already fits", () => {
		expect(keepTail("foo-design.md", 40)).toBe("foo-design.md");
	});
	it("keeps the tail with a leading ellipsis on overflow", () => {
		const r = keepTail("2026-06-23-pr-e2e-gate-devel-design.md", 20);
		expect(r.length).toBe(20);
		expect(r.startsWith("…")).toBe(true);
		expect(r.endsWith("-design.md")).toBe(true);
	});
	it("hard-slices the tail when width <= 3 (no room for an ellipsis)", () => {
		expect(keepTail("abcdef", 3)).toBe("def");
		expect(keepTail("abcdef", 2)).toBe("ef");
	});
	it("treats width <= 1 as a 1-char tail at most", () => {
		expect(keepTail("abc", 1)).toBe("c");
	});
});

	describe("Full card — artifact basename", () => {
		it("renders the artifact basename (dir dropped) and keeps the time tail", () => {
			const state = mkWallState({
				sections: [
					mkSection({
						group: "active",
						panes: [
							mkPane({
								collabId: "c1",
								statusKey: "running",
								label: "ai-cortex",
								artifact: "docs/superpowers/specs/2026-06-23-library-design.md",
								startIso: "2026-06-23T09:15:00.000Z",
								elapsed: "5h12m",
							}),
						],
					}),
				],
			});
			const out = stripAnsi(render(<Wall state={state} cols={100} rows={20} />).lastFrame() ?? "");
			expect(out).toContain("2026-06-23-library-design.md");
			expect(out).not.toContain("docs/superpowers");
			expect(out).toContain("09:15"); // time tail preserved
			expect(out).toContain("5h12m");
		});
	});

describe("Wall — footer label (Task 4 --all mode)", () => {
	it("footer label: default counts collabs, --all counts runs", () => {
		const state: WallState = {
			sections: [{ group: "active", label: "ACTIVE (2)", cardKind: "full", panes: [] }],
			panes: [], page: 0, pageCount: 1, totalRuns: 2, selected: 0,
		};
		const def = render(<Wall state={state} cols={120} rows={24} />);
		expect(def.lastFrame()).toContain("2 collabs");
		expect(def.lastFrame()).not.toContain("2 runs");
		const all = render(<Wall state={state} cols={120} rows={24} showAll />);
		expect(all.lastFrame()).toContain("2 runs");
		expect(all.lastFrame()).not.toContain("2 collabs");
	});
});

describe("Wall — per-run card keys (Task 3 --all support)", () => {
	it("renders two runs of one collab without a duplicate-key warning (--all)", () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const mk = (workflowId: string, label: string): WallPaneState => ({
			collabId: "c1", workflowId, statusKey: "running", label,
			workflowType: "deliberation", round: null, progress: null,
			agentHealth: [], stuckWhy: null, events: [], elapsed: "1m",
			startIso: null, artifact: null, cwd: null, cardKind: "full",
		});
		const state: WallState = {
			sections: [{ group: "active", label: "ACTIVE (2)", cardKind: "full", panes: [mk("wf_a", "A"), mk("wf_b", "B")] }],
			panes: [mk("wf_a", "A"), mk("wf_b", "B")],
			page: 0, pageCount: 1, totalRuns: 2, selected: 0,
		};
		const { lastFrame } = render(<Wall state={state} cols={120} rows={24} />);
		expect(lastFrame()).toContain("A");
		expect(lastFrame()).toContain("B");
		const dupKeyWarning = warn.mock.calls.some((c) => String(c[0]).includes("same key"));
		expect(dupKeyWarning).toBe(false);
		warn.mockRestore();
	});
});

describe("Wall action status line", () => {
	it("renders the confirm prompt when confirm is set", () => {
		const state = mkWallState({
			sections: [mkSection({ group: "active", panes: [mkPane({ collabId: "c1", statusKey: "running" })] })],
		});
		const { lastFrame } = render(
			<Wall state={state} cols={120} rows={24} confirm={{ workflowId: "wf_abc", action: "cancel" }} />,
		);
		expect(lastFrame() ?? "").toContain("Cancel wf_abc? (y/n)");
	});

	it("renders feedback text when feedback is set and no confirm", () => {
		const state = mkWallState({
			sections: [mkSection({ group: "active", panes: [mkPane({ collabId: "c1", statusKey: "running" })] })],
		});
		const { lastFrame } = render(
			<Wall state={state} cols={120} rows={24} feedback={{ kind: "ok", text: "paused wf_abc" }} />,
		);
		expect(lastFrame() ?? "").toContain("paused wf_abc");
	});

	it("footer help advertises p/r/c", () => {
		const state = mkWallState({
			sections: [mkSection({ group: "active", panes: [mkPane({ collabId: "c1", statusKey: "running" })] })],
		});
		const { lastFrame } = render(<Wall state={state} cols={120} rows={24} />);
		expect(lastFrame() ?? "").toContain("p/r/c act");
	});
});

describe("Wall summary bar", () => {
	it("renders the counts as the first line, dims zero buckets", () => {
		const counts: WallSummaryCounts = { running: 2, paused: 1, stuck: 0, done: 3, canceled: 0, idle: 1 };
		const state = mkWallState({
			sections: [mkSection({ group: "active", panes: [mkPane({ collabId: "c1", statusKey: "running" })] })],
			totalRuns: 7,
		});
		const { lastFrame } = render(<Wall state={state} cols={120} rows={24} counts={counts} />);
		const frame = lastFrame() ?? "";
		// First non-empty line is the summary bar.
		const firstLine = frame.split("\n").find((l) => l.trim().length > 0) ?? "";
		expect(firstLine).toContain("2 running");
		expect(firstLine).toContain("1 paused");
		expect(firstLine).toContain("3 done");
		expect(firstLine).toContain("1 idle");
		expect(firstLine).toContain("0 stuck");
	});

	it("omits the bar when counts is not provided", () => {
		const state = mkWallState({
			sections: [mkSection({ group: "active", panes: [mkPane({ collabId: "c1", statusKey: "running" })] })],
		});
		const { lastFrame } = render(<Wall state={state} cols={120} rows={24} />);
		const firstLine = (lastFrame() ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
		expect(firstLine).not.toContain("running"); // first line is the ACTIVE section header, not a bar
	});
});

describe("Inspector action status line", () => {
	it("renders the confirm prompt and p/r/c help", () => {
		const { lastFrame } = render(
			<Inspector
				state={mkInspectorState({ stuck: false })}
				section="timeline"
				viewport={defaultViewport}
				cols={120}
				rows={24}
				label="oauth"
				workflowType="spec-driven-development"
				workflowStatus="running"
				confirm={{ workflowId: "wf_z", action: "pause" }}
			/>,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Pause wf_z? (y/n)");
		expect(frame).toContain("p/r/c act");
	});
});
