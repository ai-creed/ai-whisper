import { describe, expect, it, vi } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createAiEzioLiveSession } from "../packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts";
import type { AiEzioEngineSession } from "../packages/adapter-ai-ezio/src/ai-ezio-engine.ts";

function fakeEngine() {
	let onEvent: (e: ProtocolEvent) => void = () => {};
	const submit = vi.fn();
	const session: AiEzioEngineSession = {
		start: vi.fn(async () => ({ type: "ready" })),
		submit,
		submitAndWait: vi.fn(async () => ({ turnId: "t", content: "" })),
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
		submit,
	};
}

describe("createAiEzioLiveSession", () => {
	it("writeUserInput submits over the protocol (single submit, no keystrokes)", async () => {
		const f = fakeEngine();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: { write: vi.fn() } as never });
		await live.start();
		live.writeUserInput("do the thing");
		expect(f.submit).toHaveBeenCalledTimes(1);
		expect(f.submit).toHaveBeenCalledWith("do the thing");
	});

	it("renders assistant_delta to onProviderOutput", async () => {
		const f = fakeEngine();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: { write: vi.fn() } as never });
		const out: string[] = [];
		live.onProviderOutput?.((d) => out.push(d));
		await live.start();
		f.emit({ type: "assistant_delta", turnId: "t", text: "hello" });
		expect(out.join("")).toContain("hello");
	});

	it("fires onTurnFinished with the authoritative content on idle", async () => {
		const f = fakeEngine();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: { write: vi.fn() } as never });
		const finished: string[] = [];
		live.onTurnFinished?.((content) => finished.push(content));
		await live.start();
		f.emit({ type: "assistant_turn_finished", turnId: "t", content: "final answer" });
		f.emit({ type: "idle" });
		expect(finished).toEqual(["final answer"]);
	});

	it("does not fire onTurnFinished on the startup idle (no turn yet)", async () => {
		const f = fakeEngine();
		const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: { write: vi.fn() } as never });
		const finished: string[] = [];
		live.onTurnFinished?.((content) => finished.push(content));
		await live.start();
		f.emit({ type: "idle" });
		expect(finished).toEqual([]);
	});
});
