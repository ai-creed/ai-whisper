import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLiveSessionRuntime } from "../packages/cli/src/runtime/live-session.ts";
import {
	classifyCapture,
	createMountedTurnOwnedRelay,
} from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";

describe("mounted turn-owned relay", () => {
	it("renders a pending handoff card for the owner and injects/submits the accepted request immediately", async () => {
		const writes: string[] = [];
		const injected: string[] = [];
		const openComposer = vi.fn();
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan\nKeep commits small.",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage: (text: string) => {
				writes.push(text);
			},
			writeUserInput: (text: string) => {
				injected.push(text);
			},
			openComposer,
		});

		relay.refreshOwnerView();
		await relay.acceptPendingHandoff();

		expect(writes.join("")).toContain("Pending handoff from codex");
		expect(injected).toEqual([
			"Implement the approved plan\nKeep commits small.",
			"\r",
		]);
		expect(openComposer).not.toHaveBeenCalled();
	});

	it("does NOT inject a pending handoff while its workflow is paused (delivery suspended)", async () => {
		const injected: string[] = [];
		const acceptRelayHandoff = vi.fn();
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "pending" as const,
				})),
				acceptRelayHandoff,
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				// The owning workflow is paused → delivery suspended.
				isWorkflowDeliverySuspended: vi.fn(() => true),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage: () => {},
			writeUserInput: (text: string) => {
				injected.push(text);
			},
			openComposer: vi.fn(),
		});

		await relay.acceptPendingHandoff();
		// No text injected into the agent, and the broker accept is not even reached.
		expect(injected).toEqual([]);
		expect(acceptRelayHandoff).not.toHaveBeenCalled();

		// checkIdleActions must likewise not auto-accept while paused.
		await relay.checkIdleActions();
		expect(injected).toEqual([]);
		expect(acceptRelayHandoff).not.toHaveBeenCalled();
	});

	it("renders pending handoff cards with distinct multiline local styling", () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan\nKeep commits small.",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage(text: string) {
				writes.push(text);
			},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.refreshOwnerView();

		const rendered = writes.join("");
		const ownerCardBackground = "\u001b[48;5;29m";
		const ownerCardForeground = "\u001b[38;5;250m";
		const ansiReset = "\u001b[0m";
		expect(rendered).toContain("\u001b[48;5;29m");
		expect(rendered).toContain("\u001b[38;5;250m");
		expect(rendered).toContain("[ai-whisper] Pending handoff from codex");
		expect(rendered).toContain("Implement the approved plan");
		expect(rendered).toContain("Keep commits small.");
		expect(rendered).toContain(
			"[a] accept  [e] amend  [d] decline  [space] defer",
		);

		const visibleLines = rendered
			.split("\n")
			.map((line) =>
				line
					.replaceAll(ownerCardBackground, "")
					.replaceAll(ownerCardForeground, "")
					.replaceAll(ansiReset, ""),
			);
		const widths = visibleLines.map((line) => line.length);
		expect(new Set(widths).size).toBe(1);
	});

	it("clears the rendered pending handoff card after accept", async () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi
					.fn()
					.mockReturnValueOnce({
						collabId: "collab_turn",
						turnOwner: "claude" as const,
						waitingAgent: "codex" as const,
						unresolvedHandoffId: "handoff_1",
						handoffState: "pending" as const,
						handoffAgeMs: 1_000,
					})
					.mockReturnValue({
						collabId: "collab_turn",
						turnOwner: "claude" as const,
						waitingAgent: "codex" as const,
						unresolvedHandoffId: "handoff_1",
						handoffState: "pending" as const,
						handoffAgeMs: 1_000,
					}),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan\nKeep commits small.",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage(text: string) {
				writes.push(text);
			},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.refreshOwnerView();
		await relay.acceptPendingHandoff();

		expect(writes.join("")).toContain("Pending handoff from codex");
		expect(writes.join("")).toContain("\r\u001b[2K");
	});

	it("opens the editor when the owner chooses amend before accepting and injects without submitting", async () => {
		const injected: string[] = [];
		const openComposer = vi.fn(() =>
			Promise.resolve(
				"Implement the approved plan\nKeep commits very small.\n",
			),
		);
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan\nKeep commits small.",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput: (text: string) => {
				injected.push(text);
			},
			openComposer,
		});

		await relay.handleOwnerInput("e");

		expect(openComposer).toHaveBeenCalledWith(
			expect.objectContaining({
				initialValue: "Implement the approved plan\nKeep commits small.",
			}),
		);
		expect(injected[0]).toBe(
			"Implement the approved plan\nKeep commits very small.\n",
		);
	});

	it("declines a pending handoff without requiring a reason", () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(""),
		});

		relay.declinePendingHandoff();
		expect(broker.control.declineRelayHandoff).toHaveBeenCalledWith(
			expect.objectContaining({ handoffId: "handoff_1" }),
		);
	});

	it("defers a pending handoff and keeps the sender waiting", () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "pending" as const,
				})),
				deferRelayHandoff: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(""),
		});

		relay.deferPendingHandoff();
		expect(broker.control.deferRelayHandoff).toHaveBeenCalledWith(
			expect.objectContaining({ handoffId: "handoff_1" }),
		);
	});

	it("renders 'Deferred' label when the pending handoff has been deferred", () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "deferred" as const,
					handoffAgeMs: 60_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "deferred" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage: (text: string) => {
				writes.push(text);
			},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.refreshOwnerView();
		expect(writes.join("")).toContain("Deferred");
		expect(writes.join("")).toContain("codex");
	});

	it("does not re-render the same owner card on repeated refreshes", () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage: (text: string) => {
				writes.push(text);
			},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.refreshOwnerView();
		relay.refreshOwnerView();

		expect(writes).toHaveLength(1);
	});

	it("does not fail the handoff when the disconnect comes from the waiting side", () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 10_000,
				})),
				failRelayHandoffOnDisconnect: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				getRelayHandoff: vi.fn(() => null),
			},
		};
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "codex",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.handleOwnerDisconnect();

		expect(broker.control.failRelayHandoffOnDisconnect).not.toHaveBeenCalled();
	});

	it("prefills handback from the latest assistant turn and falls back to blank composer on low confidence", async () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				handoffBackRelay: vi.fn(),
			},
		};
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: ({ initialValue }: { initialValue: string }) =>
				Promise.resolve(initialValue),
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({
					confidence: "high" as const,
					text: "Implemented the plan.",
				}),
			},
		});

		await relay.handBackTo("codex");
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				handoffId: "handoff_1",
				senderAgent: "claude",
				targetAgent: "codex",
				requestText: "Implemented the plan.",
			}),
		);
	});

	it("resets turn capture after successful handback to prevent stale text on retry", async () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				handoffBackRelay: vi.fn(),
			},
		};
		const reset = vi.fn();
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve("done"),
			turnCapture: {
				reset,
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({
					confidence: "high" as const,
					text: "done",
				}),
			},
		});

		await relay.handBackTo("codex");
		expect(reset).toHaveBeenCalled();
	});

	it("keeps turn capture intact when handBackTo composer is cancelled", async () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				handoffBackRelay: vi.fn(),
			},
		};
		const reset = vi.fn();
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null as string | null),
			turnCapture: {
				reset,
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({
					confidence: "high" as const,
					text: "some text",
				}),
			},
		});

		await relay.handBackTo("codex");
		expect(reset).not.toHaveBeenCalled();
		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();
	});

	it("opens blank composer when turn capture confidence is low", async () => {
		const composerArgs: Array<{ prompt: string; initialValue: string }> = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: (args: { prompt: string; initialValue: string }) => {
				composerArgs.push(args);
				return Promise.resolve("manual result");
			},
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({
					confidence: "low" as const,
					text: null,
				}),
			},
		});

		await relay.handBackTo("codex");

		expect(composerArgs[0]?.initialValue).toBe("");
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				targetAgent: "codex",
				requestText: "manual result",
			}),
		);
	});

	it("opens blank handback composer when mounted mode disables capture prefills", async () => {
		const composerArgs: Array<{ prompt: string; initialValue: string }> = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: (args: { prompt: string; initialValue: string }) => {
				composerArgs.push(args);
				return Promise.resolve("manual result");
			},
			prefillHandbackFromCapture: false,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({
					confidence: "high" as const,
					text: "noisy terminal output",
				}),
			},
		});

		await relay.handBackTo("codex");

		expect(composerArgs[0]?.initialValue).toBe("");
	});

	it("uses explicit handback capture when available", async () => {
		const composerArgs: Array<{ prompt: string; initialValue: string }> = [];
		const confirmHandbackCapture = vi.fn(() => Promise.resolve(true));
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 20_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: (args: { prompt: string; initialValue: string }) => {
				composerArgs.push(args);
				return Promise.resolve("manual result");
			},
			confirmHandbackCapture,
			captureHandbackText: () => Promise.resolve("copied latest response"),
			prefillHandbackFromCapture: false,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({
					confidence: "high" as const,
					text: "noisy terminal output",
				}),
			},
		});

		await relay.handBackTo("codex");

		expect(confirmHandbackCapture).toHaveBeenCalledWith(
			expect.objectContaining({
				target: "codex",
				text: "copied latest response",
			}),
		);
		expect(composerArgs).toEqual([]);
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				targetAgent: "codex",
				requestText: "copied latest response",
			}),
		);
	});

	it("does not hand back when copied response confirmation is cancelled", async () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 20_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve("manual result"),
			confirmHandbackCapture: () => Promise.resolve(false),
			captureHandbackText: () => Promise.resolve("copied latest response"),
			prefillHandbackFromCapture: false,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({
					confidence: "high" as const,
					text: "noisy terminal output",
				}),
			},
		});

		await relay.handBackTo("codex");

		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();
	});

	it("shows handback hint and routes h to the original sender after 30s and visible output", async () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 35_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage(text: string) {
				writes.push(text);
			},
			writeUserInput() {},
			openComposer: ({ initialValue }: { initialValue: string }) =>
				Promise.resolve(initialValue),
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({
					confidence: "high" as const,
					text: "Implemented the plan.",
				}),
			},
		});

		relay.refreshOwnerView();
		await relay.handleOwnerInput("h");

		expect(writes.join("")).toContain("Ready to hand back to codex");
		expect(writes.join("")).toContain("[h] hand back");
		expect(writes.join("")).not.toContain(
			"Ready to hand back to codex\n[h] hand back",
		);
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				targetAgent: "codex",
				requestText: "Implemented the plan.",
			}),
		);
	});

	it("does not show the handback hint before the 30s accepted grace period elapses", () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage(text: string) {
				writes.push(text);
			},
			writeUserInput() {},
			openComposer: ({ initialValue }: { initialValue: string }) =>
				Promise.resolve(initialValue),
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({
					confidence: "high" as const,
					text: "Implemented the plan.",
				}),
			},
		});

		relay.refreshOwnerView();

		expect(writes.join("")).not.toContain("Ready to hand back");
	});

	it("forces handback with Ctrl+H before readiness gates and falls back to manual composer", async () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};
		const openComposer = vi.fn(() => Promise.resolve("manual result"));
		const confirmHandbackCapture = vi.fn(() => Promise.resolve(true));

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage(text: string) {
				writes.push(text);
			},
			writeUserInput() {},
			openComposer,
			captureHandbackText: () => Promise.resolve(null),
			confirmHandbackCapture,
			prefillHandbackFromCapture: false,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => false,
				extractLatestAssistantTurn: () => ({
					confidence: "low" as const,
					text: null,
				}),
			},
		});

		await relay.handleOwnerInput("\u0008");

		expect(writes.join("")).toContain("Force handback");
		expect(openComposer).toHaveBeenCalled();
		expect(confirmHandbackCapture).not.toHaveBeenCalled();
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				targetAgent: "codex",
				requestText: "manual result",
			}),
		);
	});

	it("releases the sender and marks the handoff degraded when the owner session exits", () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 10_000,
				})),
				failRelayHandoffOnDisconnect: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				getRelayHandoff: vi.fn(() => null),
			},
		};
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.handleOwnerDisconnect();

		expect(broker.control.failRelayHandoffOnDisconnect).toHaveBeenCalledWith(
			expect.objectContaining({ handoffId: "handoff_1" }),
		);
	});

	it("swallows ordinary waiting-side input but allows Ctrl+C", async () => {
		const stdin = new PassThrough();
		const localMessages: string[] = [];
		const userInputs: string[] = [];

		const onCancel = vi.fn();
		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					userInputs.push(data);
				},
				sendLocalMessage(data: string) {
					localMessages.push(data);
				},
				onExit() {},
			},
			stdin,
			stdout: process.stdout,
			onRelay: () => Promise.resolve(null),
			externalInputGate: {
				isBlocked: () => true,
				renderBlockedMessage: () => "waiting for reply from claude (12s)",
				onCancel,
			},
		});

		await runtime.start();
		stdin.write("hello");
		stdin.write("\u0003");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(userInputs).toEqual([]);
		expect(localMessages.join("")).toContain("waiting for reply from claude");
		expect(onCancel).toHaveBeenCalled();
		expect(runtime).toBeTruthy();
	});

	it("routes owner-side handoff hotkeys before provider passthrough", async () => {
		const stdin = new PassThrough();
		const localMessages: string[] = [];
		const userInputs: string[] = [];
		const handleOwnerInput = vi.fn((text: string) =>
			Promise.resolve(text === "a"),
		);

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					userInputs.push(data);
				},
				sendLocalMessage(data: string) {
					localMessages.push(data);
				},
				onExit() {},
			},
			stdin,
			stdout: process.stdout,
			onRelay: () => Promise.resolve(null),
			externalInputRouter: {
				handleInput: handleOwnerInput,
			},
		});

		await runtime.start();
		stdin.write("a");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(handleOwnerInput).toHaveBeenCalledWith("a");
		expect(userInputs).toEqual([]);
		expect(localMessages).toEqual([]);
	});

	it("routes owner-side handoff hotkeys when the terminal reports printable keys as CSI-u only", async () => {
		const stdin = new PassThrough();
		const localMessages: string[] = [];
		const userInputs: string[] = [];
		const handleOwnerInput = vi.fn((text: string) =>
			Promise.resolve(text === "a"),
		);

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					userInputs.push(data);
				},
				sendLocalMessage(data: string) {
					localMessages.push(data);
				},
				onExit() {},
			},
			stdin,
			stdout: process.stdout,
			onRelay: () => Promise.resolve(null),
			externalInputRouter: {
				handleInput: handleOwnerInput,
			},
		});

		await runtime.start();
		stdin.write("\u001b[97;1:3u");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(handleOwnerInput).toHaveBeenCalledWith("a");
		expect(userInputs).toEqual([]);
		expect(localMessages).toEqual([]);
	});

	describe("autonomous mode (workflow-owned handoff)", () => {
		function makeAutonomousBroker(overrides?: {
			workflowStatus?: string;
			chainStatus?: string;
			hasMeta?: boolean;
			handoffStatus?: "pending" | "deferred" | "accepted";
			applyOrchestratorVerdict?: ReturnType<typeof vi.fn>;
		}) {
			const workflowStatus = overrides?.workflowStatus ?? "running";
			const chainStatus = overrides?.chainStatus ?? "active";
			const hasMeta = overrides?.hasMeta ?? true;
			const handoffStatus = overrides?.handoffStatus ?? "pending";
			const applyOrchestratorVerdict =
				overrides?.applyOrchestratorVerdict ?? vi.fn();

			return {
				control: {
					getRelayTurnState: vi.fn(() => ({
						collabId: "collab_turn",
						turnOwner: "claude" as const,
						waitingAgent: "codex" as const,
						unresolvedHandoffId: "handoff_1",
						handoffState: handoffStatus as "pending" | "accepted",
						handoffAgeMs: 35_000,
					})),
					getRelayHandoff: vi.fn(() => ({
						handoffId: "handoff_1",
						collabId: "collab_turn",
						senderAgent: "codex" as const,
						targetAgent: "claude" as const,
						requestText: "Do the work",
						status: handoffStatus,
					})),
					acceptRelayHandoff: vi.fn(),
					declineRelayHandoff: vi.fn(),
					deferRelayHandoff: vi.fn(),
					handoffBackRelay: vi.fn(),
					getHandoffWithWorkflowMeta: vi.fn(() =>
						hasMeta ? { workflowId: "wf_test", chainId: "ch_test" } : null,
					),
					getWorkflow: vi.fn((id: string) =>
						id === "wf_test" ? { status: workflowStatus } : null,
					),
					getRelayChain: vi.fn((id: string) =>
						id === "ch_test" ? { status: chainStatus } : null,
					),
					applyOrchestratorVerdict,
				},
			};
		}

		it("hides hotkey hints when workflow=running AND chain=active", () => {
			const writes: string[] = [];
			const broker = makeAutonomousBroker();
			const relay = createMountedTurnOwnedRelay({
				broker,
				collabId: "collab_turn",
				currentAgent: "claude",
				writeLocalMessage: (text: string) => {
					writes.push(text);
				},
				writeUserInput() {},
				openComposer: () => Promise.resolve(null),
			});

			relay.refreshOwnerView();
			const rendered = writes.join("");
			expect(rendered).not.toContain("[a]");
			expect(rendered).not.toContain("[d]");
			expect(rendered).not.toContain("[h]");
			expect(rendered).toContain("auto-accept");
		});

		it("shows hotkey hints when handoff has workflow_id but workflow is halted", () => {
			const writes: string[] = [];
			const broker = makeAutonomousBroker({ workflowStatus: "halted" });
			const relay = createMountedTurnOwnedRelay({
				broker,
				collabId: "collab_turn",
				currentAgent: "claude",
				writeLocalMessage: (text: string) => {
					writes.push(text);
				},
				writeUserInput() {},
				openComposer: () => Promise.resolve(null),
			});

			relay.refreshOwnerView();
			const rendered = writes.join("");
			expect(rendered).toContain("[a] accept");
			expect(rendered).toContain("[d] decline");
		});

		it("shows hotkey hints when handoff has workflow_id but chain is abandoned", () => {
			const writes: string[] = [];
			const broker = makeAutonomousBroker({ chainStatus: "abandoned" });
			const relay = createMountedTurnOwnedRelay({
				broker,
				collabId: "collab_turn",
				currentAgent: "claude",
				writeLocalMessage: (text: string) => {
					writes.push(text);
				},
				writeUserInput() {},
				openComposer: () => Promise.resolve(null),
			});

			relay.refreshOwnerView();
			const rendered = writes.join("");
			expect(rendered).toContain("[a] accept");
			expect(rendered).toContain("[d] decline");
		});

		it("a/d/h/space/Ctrl+H are no-ops when workflow=running AND chain=active", async () => {
			const broker = makeAutonomousBroker();
			const relay = createMountedTurnOwnedRelay({
				broker,
				collabId: "collab_turn",
				currentAgent: "claude",
				writeLocalMessage() {},
				writeUserInput() {},
				openComposer: () => Promise.resolve(null),
			});

			await relay.handleOwnerInput("a");
			await relay.handleOwnerInput("d");
			await relay.handleOwnerInput("h");
			await relay.handleOwnerInput(" ");
			await relay.handleOwnerInput("\u0008");

			expect(broker.control.acceptRelayHandoff).not.toHaveBeenCalled();
			expect(broker.control.declineRelayHandoff).not.toHaveBeenCalled();
			expect(broker.control.deferRelayHandoff).not.toHaveBeenCalled();
			expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();
		});

		it("hides the auto-handback ready card when workflow=running AND chain=active", () => {
			const writes: string[] = [];
			const broker = makeAutonomousBroker({ handoffStatus: "accepted" });
			const relay = createMountedTurnOwnedRelay({
				broker,
				collabId: "collab_turn",
				currentAgent: "claude",
				writeLocalMessage: (text: string) => {
					writes.push(text);
				},
				writeUserInput() {},
				openComposer: () => Promise.resolve(null),
				turnCapture: {
					reset: vi.fn(),
					finishAssistantTurn: vi.fn(),
					hasVisibleAssistantTurn: () => true,
					extractLatestAssistantTurn: () => ({
						confidence: "high" as const,
						text: "done",
					}),
				},
			});

			relay.refreshOwnerView();
			const rendered = writes.join("");
			expect(rendered).not.toContain("Ready to hand back");
			expect(rendered).not.toContain("auto-handback");
		});

		it("a/d/h/space/Ctrl+H work when workflow is halted even if workflow_id is set", async () => {
			// "a" — accept pending handoff
			{
				const broker = makeAutonomousBroker({ workflowStatus: "halted" });
				const relay = createMountedTurnOwnedRelay({
					broker,
					collabId: "collab_turn",
					currentAgent: "claude",
					writeLocalMessage() {},
					writeUserInput() {},
					openComposer: () => Promise.resolve("result"),
				});
				await relay.handleOwnerInput("a");
				expect(broker.control.acceptRelayHandoff).toHaveBeenCalledWith(
					expect.objectContaining({ handoffId: "handoff_1" }),
				);
			}

			// "d" — decline pending handoff
			{
				const broker = makeAutonomousBroker({ workflowStatus: "halted" });
				const relay = createMountedTurnOwnedRelay({
					broker,
					collabId: "collab_turn",
					currentAgent: "claude",
					writeLocalMessage() {},
					writeUserInput() {},
					openComposer: () => Promise.resolve("result"),
				});
				await relay.handleOwnerInput("d");
				expect(broker.control.declineRelayHandoff).toHaveBeenCalledWith(
					expect.objectContaining({ handoffId: "handoff_1" }),
				);
			}

			// " " (space) — defer pending handoff
			{
				const broker = makeAutonomousBroker({ workflowStatus: "halted" });
				const relay = createMountedTurnOwnedRelay({
					broker,
					collabId: "collab_turn",
					currentAgent: "claude",
					writeLocalMessage() {},
					writeUserInput() {},
					openComposer: () => Promise.resolve("result"),
				});
				await relay.handleOwnerInput(" ");
				expect(broker.control.deferRelayHandoff).toHaveBeenCalledWith(
					expect.objectContaining({ handoffId: "handoff_1" }),
				);
			}

			// "h" — hand back on an accepted-and-ready handoff (age >= 30s, assistant turn visible)
			{
				const broker = makeAutonomousBroker({
					workflowStatus: "halted",
					handoffStatus: "accepted",
				});
				const relay = createMountedTurnOwnedRelay({
					broker,
					collabId: "collab_turn",
					currentAgent: "claude",
					writeLocalMessage() {},
					writeUserInput() {},
					openComposer: () => Promise.resolve("hand-back result"),
					turnCapture: {
						reset: vi.fn(),
						finishAssistantTurn: vi.fn(),
						hasVisibleAssistantTurn: () => true,
						extractLatestAssistantTurn: () => ({
							confidence: "high" as const,
							text: "hand-back result",
						}),
					},
				});
				await relay.handleOwnerInput("h");
				expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
					expect.objectContaining({
						handoffId: "handoff_1",
						targetAgent: "codex",
					}),
				);
			}

			// Ctrl+H (\u0008) — force hand back on any accepted handoff
			{
				const broker = makeAutonomousBroker({
					workflowStatus: "halted",
					handoffStatus: "accepted",
				});
				const relay = createMountedTurnOwnedRelay({
					broker,
					collabId: "collab_turn",
					currentAgent: "claude",
					writeLocalMessage() {},
					writeUserInput() {},
					openComposer: () => Promise.resolve("forced result"),
				});
				await relay.handleOwnerInput("\u0008");
				expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
					expect.objectContaining({
						handoffId: "handoff_1",
						targetAgent: "codex",
					}),
				);
			}
		});

		it("capture failure on workflow-owned handoff calls applyOrchestratorVerdict escalate", async () => {
			const applyOrchestratorVerdict = vi.fn();
			const broker = makeAutonomousBroker({
				handoffStatus: "accepted",
				applyOrchestratorVerdict,
			});
			const relay = createMountedTurnOwnedRelay({
				broker,
				collabId: "collab_turn",
				currentAgent: "claude",
				writeLocalMessage() {},
				writeUserInput() {},
				openComposer: () => Promise.resolve(null), // composer returns null = capture failure
			});

			await relay.handBackTo("codex");

			expect(applyOrchestratorVerdict).toHaveBeenCalledWith(
				expect.objectContaining({
					handoffId: "handoff_1",
					verdict: "escalate",
					confidence: 1.0,
					reason: expect.stringContaining("capture-failure"),
				}),
			);
			expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();
		});

		it("capture failure on halted workflow falls back to local composer (no escalation)", async () => {
			const applyOrchestratorVerdict = vi.fn();
			const broker = makeAutonomousBroker({
				handoffStatus: "accepted",
				workflowStatus: "halted",
				applyOrchestratorVerdict,
			});
			const relay = createMountedTurnOwnedRelay({
				broker,
				collabId: "collab_turn",
				currentAgent: "claude",
				writeLocalMessage() {},
				writeUserInput() {},
				openComposer: () => Promise.resolve(null),
			});

			await relay.handBackTo("codex");

			expect(applyOrchestratorVerdict).not.toHaveBeenCalled();
		});
	});
});

// Bug 2026-06-03 — Mode C: a single empty auto-handback capture is terminal.
// See docs/superpowers/bugs/2026-06-03-auto-handback-empty-capture-permanent-halt.md.
// checkIdleActions fired the auto-handback exactly once (autoHandbackFiredFor set
// before the capture result was known) and handed back empty on the first miss,
// halting long claude steps on a single transient empty /copy. The fix makes the
// auto path retry on empty (bounded + spaced) instead of giving up after one shot.
describe("auto-handback retry on empty capture (Mode C)", () => {
	function makeAcceptedBroker() {
		return {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 35_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Do the work",
					status: "accepted" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				handoffBackRelay: vi.fn(),
				recordCaptureDiagnostic: vi.fn(() => ({ captureId: "cap_1" })),
				getHandoffWithWorkflowMeta: vi.fn(() => ({
					workflowId: "wf_test",
					chainId: "ch_test",
				})),
			},
		};
	}

	// claude full-screen TUI → PTY turn normalizes to empty/low-confidence.
	const claudeTurnCapture = () => ({
		reset: vi.fn(),
		finishAssistantTurn: vi.fn(),
		hasVisibleAssistantTurn: () => true,
		extractLatestAssistantTurn: () => ({
			confidence: "low" as const,
			text: null,
		}),
	});

	const longReply =
		"Executed the plan: ran the failing test, implemented the fix, all green. " +
		"Committed at abc1234. Verified pnpm test passes with 0 failures.";

	it("does not hand back on the first empty capture, then hands back once a later capture lands", async () => {
		const broker = makeAcceptedBroker();
		let calls = 0;
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
			turnCapture: claudeTurnCapture(),
			autoHandbackRetryMs: 0,
			autoHandbackMaxAttempts: 3,
			captureHandbackText: () => {
				calls += 1;
				return Promise.resolve(calls === 1 ? null : longReply);
			},
		});

		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();

		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).toHaveBeenCalledTimes(1);
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				handoffId: "handoff_1",
				targetAgent: "codex",
				requestText: longReply,
				captureStatus: "ok",
			}),
		);
	});

	it("hands back empty (escalate floor) only after exhausting the attempt budget", async () => {
		const broker = makeAcceptedBroker();
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
			turnCapture: claudeTurnCapture(),
			autoHandbackRetryMs: 0,
			autoHandbackMaxAttempts: 2,
			captureHandbackText: () => Promise.resolve(null),
		});

		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();

		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).toHaveBeenCalledTimes(1);
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				handoffId: "handoff_1",
				requestText: "",
				captureStatus: "no_response_captured",
			}),
		);
	});

	it("does not start a second capture while the first is still in flight (timer overlap)", async () => {
		// The mount timer fires a fresh async checkIdleActions() every 1s. A capture
		// can take ~1.3s + up to 4s lease wait, so a later tick must not start an
		// overlapping /copy for the same handoff before the first attempt records its
		// retry/terminal state. (Sequential-only tests miss this.)
		const broker = makeAcceptedBroker();
		let resolveCapture: ((v: string | null) => void) | undefined;
		const capture = vi.fn(
			() =>
				new Promise<string | null>((resolve) => {
					resolveCapture = resolve;
				}),
		);
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
			turnCapture: claudeTurnCapture(),
			autoHandbackRetryMs: 0,
			autoHandbackMaxAttempts: 3,
			captureHandbackText: capture,
		});

		// First tick: enters, reserves, blocks on the pending capture promise.
		// (checkIdleActions runs synchronously up to `await captureHandbackText`, so
		// captureHandbackText is invoked before the function first suspends.)
		const first = relay.checkIdleActions();
		await Promise.resolve();
		// Second tick while the first is still awaiting capture. Not awaited: in the
		// unfixed code it would suspend on a second never-resolved capture promise.
		// The bug shows synchronously as a second captureHandbackText invocation.
		void relay.checkIdleActions();
		expect(capture).toHaveBeenCalledTimes(1);
		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();

		// Let the first attempt complete with a real handback.
		resolveCapture?.(longReply);
		await first;
		expect(capture).toHaveBeenCalledTimes(1);
		expect(broker.control.handoffBackRelay).toHaveBeenCalledTimes(1);
	});

	it("does not re-attempt /copy within the retry spacing window", async () => {
		const broker = makeAcceptedBroker();
		const capture = vi.fn(() => Promise.resolve(null));
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
			turnCapture: claudeTurnCapture(),
			autoHandbackRetryMs: 60_000,
			autoHandbackMaxAttempts: 3,
			captureHandbackText: capture,
		});

		await relay.checkIdleActions();
		await relay.checkIdleActions();

		expect(capture).toHaveBeenCalledTimes(1);
		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();
	});
});

// Bug 2026-05-29 — Mode A: short claude reply rejected as low-confidence.
// See docs/superpowers/bugs/2026-05-29-handback-capture-failures.md (Mode A).
// captureClipboardHandback only returns on a clipboard-content change AFTER
// /copy, so a non-empty short clipText is freshly-captured by construction.
// Under Claude Code's full-screen TUI, normalizeCapturedOutput strips cursor-
// positioned redraws to empty/junk, so turnResult.text === "" and confidence
// is "low" even when the assistant produced a valid short reply. Today the
// classifier short-circuits to no_response_captured_confidently in that case
// and the workflow halts on a single handback. The fix path (Option B in
// docs/superpowers/specs/2026-05-14-capture-reliability-hardening-design.md)
// trusts a freshly-changed short clipboard on its own merits without
// removing the stale-clipboard gate that the >=100-char / similarity check
// provides for non-fresh content.
// TODO(2026-05-29): RED regression guard — skipped until the Mode A fix lands.
// Re-enable when classifyCapture trusts a fresh short clipboard. See
// docs/superpowers/bugs/2026-05-29-handback-capture-failures.md.
// Bug 2026-06-06 — a stale prior-phase /copy was accepted as the current phase's
// gate handback. See docs/superpowers/bugs/2026-06-06-code-review-gate-passed-on-
// stale-prior-phase-review.md. Recorded occurrence wf_433d667d66664446 (SDD
// code-review phase): the captured reviewer handback (clip_len=3732) was a
// byte-for-byte duplicate of the reviewer's PRIOR plan-writing review, while the
// PTY turn was the freshly-injected review prompt (turn_len=68853,
// turn_confidence=high) and jaccard/containment were NULL — yet capture_status was
// "ok". The >=100-char fast-path in classifyCapture trusts ANY substantial clip as
// a fresh /copy, even when high-confidence current-phase turn text is available to
// validate it against, so prior-phase content resolved the gate before the
// reviewer's real code review ever landed.
//
// The texts below mirror that occurrence: a generic "review the commits, run tests"
// request (the echoed PTY turn) vs a detailed prior-phase PLAN review (the stale
// clip). They share almost no >=4-char vocabulary (verified jaccard 0.018,
// containment 0.177 — both far below the 0.6 / 0.8 accept thresholds), so the only
// reason today's classifier accepts the clip is the length fast-path.
const BUG_20260606_INJECTED_REVIEW_REQUEST =
	"Review the implementer's changes for this phase — the commits in 918ec23..HEAD " +
	"on branch feat/ezio-surface-extraction. Inspect each diff hunk, check the new " +
	"code against the spec acceptance criteria, run the project's verification and " +
	"tests, and report whether the executed code is approved with any blocking findings.";
const BUG_20260606_STALE_PLAN_REVIEW =
	"Review matrix: the implementation plan now covers every spec acceptance " +
	"criterion. Plan extracts the surface module cleanly; Plan lines 24-38 enumerate " +
	"the migration steps and rollback. Approved — the document sequences the work " +
	"sensibly and the phasing reads correctly. No blocking concerns with the written plan.";

describe("classifyCapture — stale prior-phase clipboard (Bug 2026-06-06)", () => {
	it("rejects a substantial clip dissimilar to the high-confidence current-phase turn", () => {
		// High-confidence current-phase turn text IS available, so the clip can and
		// must be similarity-validated. A substantial clip that bears no resemblance
		// to it is stale/unrelated content — not the response to this phase's request
		// — and must NOT resolve the gate. Today the >=100-char fast-path returns
		// "ok" with null scores, accepting the stale prior-phase review as the gate
		// input; that is the defect this guards against.
		const result = classifyCapture(
			{ confidence: "high", text: BUG_20260606_INJECTED_REVIEW_REQUEST },
			BUG_20260606_STALE_PLAN_REVIEW,
		);
		expect(result.status).not.toBe("ok");
	});

	it("still trusts a substantial clip when no high-confidence turn text exists (Claude TUI)", () => {
		// Regression fence: the fast-path's reason for existing — full-screen TUI
		// providers (Claude Code) whose PTY turn normalizes to empty/low-confidence,
		// leaving no text to validate against — must keep working. With no
		// high-confidence turn text, a substantial fresh clip is still accepted.
		const result = classifyCapture(
			{ confidence: "low", text: "" },
			BUG_20260606_STALE_PLAN_REVIEW,
		);
		expect(result.status).toBe("ok");
	});
});

describe("auto-handback gate — stale prior-phase clipboard (Bug 2026-06-06)", () => {
	// codex reviewer hands back to the claude implementer. Mirrors the recorded run:
	// turnOwner=codex (reviewer), an accepted handoff whose request was the review
	// prompt, waiting implementer=claude.
	function makeReviewerBroker() {
		return {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "codex" as const,
					waitingAgent: "claude" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 35_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "claude" as const,
					targetAgent: "codex" as const,
					requestText: BUG_20260606_INJECTED_REVIEW_REQUEST,
					status: "accepted" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				handoffBackRelay: vi.fn(),
				recordCaptureDiagnostic: vi.fn(() => ({ captureId: "cap_1" })),
				getHandoffWithWorkflowMeta: vi.fn(() => ({
					workflowId: "wf_test",
					chainId: "ch_test",
				})),
			},
		};
	}

	// The reviewer's REAL code review, produced only on a later idle tick. Its PTY
	// turn text and its /copy clip agree (it is the genuine current-phase response),
	// so it clears the similarity check and is the handback the gate should deliver.
	const freshCodeReview =
		"Reviewed commits 918ec23..HEAD. Finding: the extracted surface drops the " +
		"error path for an unbound agent, so a mount failure returns success. " +
		"Not approved until the executed code restores that guard and adds a test.";

	it("does not deliver stale prior-phase clipboard content as the gate handback; loops until the fresh review lands", async () => {
		const broker = makeReviewerBroker();
		// Tick 1: reviewer has NOT yet reviewed the code. The PTY turn is the echoed
		// review prompt (high confidence) and the clipboard still holds its
		// prior-phase plan review. Tick 2: the reviewer's fresh code review.
		const turns = [
			{
				confidence: "high" as const,
				text: BUG_20260606_INJECTED_REVIEW_REQUEST,
			},
			{ confidence: "high" as const, text: freshCodeReview },
		];
		const clips = [BUG_20260606_STALE_PLAN_REVIEW, freshCodeReview];
		let tick = 0;
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "codex",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () =>
					turns[Math.min(tick, turns.length - 1)]!,
			},
			autoHandbackRetryMs: 0,
			autoHandbackMaxAttempts: 5,
			captureHandbackText: () =>
				Promise.resolve(clips[Math.min(tick, clips.length - 1)] ?? null),
		});

		// Tick 1 — stale prior-phase content must NOT resolve the gate.
		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();

		// Tick 2 — the reviewer's genuine code review lands and is delivered.
		tick = 1;
		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).toHaveBeenCalledTimes(1);
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				targetAgent: "claude",
				requestText: freshCodeReview,
				captureStatus: "ok",
			}),
		);
	});
});

describe.skip("classifyCapture — short freshly-captured clipboard (Mode A repro)", () => {
	it("accepts a short claude reply when PTY turn text is empty/low-confidence (TUI normalization)", () => {
		const result = classifyCapture(
			{ confidence: "low", text: "" },
			"Task 1 verifies clean. Commit and move on.",
		);
		expect(result.status).toBe("ok");
	});

	it("accepts the other observed real reply pattern (terse 'Not relevant — ...' verdict)", () => {
		const result = classifyCapture(
			{ confidence: "low", text: "" },
			"Not relevant — same merge-at-finish-time memory.",
		);
		expect(result.status).toBe("ok");
	});
});
