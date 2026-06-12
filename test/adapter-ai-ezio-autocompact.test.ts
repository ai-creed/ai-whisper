import { describe, expect, it, vi } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createAiEzioLiveSession } from "../packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts";
import type { AiEzioEngineSession } from "../packages/adapter-ai-ezio/src/ai-ezio-engine.ts";

function fakeEngine() {
	let onEvent: (e: ProtocolEvent) => void = () => {};
	const session: AiEzioEngineSession = {
		start: vi.fn(async () => ({ type: "ready" })),
		submit: vi.fn(),
		interrupt: vi.fn(),
		submitAndWait: vi.fn(async () => ({ turnId: "t", content: "" })),
		registerDelegatedTools: vi.fn(),
		sendToolResult: vi.fn(),
		onExit: vi.fn(),
		close: vi.fn(),
	};
	return {
		create: (opts: { onEvent: (e: ProtocolEvent) => void }) => {
			onEvent = opts.onEvent;
			return session;
		},
		emit: (e: ProtocolEvent) => onEvent(e),
		session,
	};
}

/** A controllable stand-in for the harness AutoCompactDriver — records the
 * events piped to it and lets a test toggle `compacting()`. */
function fakeDriver() {
	let compacting = false;
	const events: ProtocolEvent[] = [];
	return {
		driver: {
			handleEvent: (e: ProtocolEvent) => {
				events.push(e);
			},
			compacting: () => compacting,
			compactNow: vi.fn(async () => ({ kind: "skipped", reason: "not-armed" as const })),
			whenSettled: vi.fn(async () => {}),
		},
		events,
		setCompacting: (b: boolean) => {
			compacting = b;
		},
	};
}

describe("createAiEzioLiveSession — auto-compaction wiring", () => {
	it("pipes every protocol event into the auto-compact driver", async () => {
		const f = fakeEngine();
		const d = fakeDriver();
		const live = createAiEzioLiveSession({
			createEngineSession: f.create,
			buildAutoCompact: () => d.driver,
			stdout: { write: vi.fn() } as never,
		});
		await live.start();
		f.emit({
			type: "assistant_turn_finished",
			turnId: "t",
			content: "a",
			usage: { contextTokens: 9, contextLimit: 10 },
		});
		f.emit({ type: "idle" });
		const types = d.events.map((e) => e.type);
		expect(types).toEqual(expect.arrayContaining(["assistant_turn_finished", "idle"]));
	});

	it("suppresses the handback while compacting so the summarize turn never relays", async () => {
		const f = fakeEngine();
		const d = fakeDriver();
		const live = createAiEzioLiveSession({
			createEngineSession: f.create,
			buildAutoCompact: () => d.driver,
			stdout: { write: vi.fn() } as never,
		});
		const finished: string[] = [];
		live.onTurnFinished?.((c) => finished.push(c));
		await live.start();

		// Cycle in progress: the injected summarize turn must NOT be handed back.
		d.setCompacting(true);
		f.emit({ type: "assistant_turn_finished", turnId: "s", content: "MY SUMMARY" });
		f.emit({ type: "idle" });
		expect(finished).toEqual([]);

		// Cycle done: a genuine turn relays as normal.
		d.setCompacting(false);
		f.emit({ type: "assistant_turn_finished", turnId: "t", content: "real answer" });
		f.emit({ type: "idle" });
		expect(finished).toEqual(["real answer"]);
	});
});
