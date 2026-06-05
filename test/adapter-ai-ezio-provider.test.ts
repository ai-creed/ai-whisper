import { describe, expect, it, vi } from "vitest";
import {
	mockProviderReplySchema,
	providerIdentitySchema,
	providerCapabilitiesSchema,
} from "@ai-whisper/shared";
import { EngineExitedError, TurnError } from "@ai-ezio/harness";
import { createAiEzioProvider } from "../packages/adapter-ai-ezio/src/create-ai-ezio-provider.ts";
import type { AiEzioEngineSession } from "../packages/adapter-ai-ezio/src/ai-ezio-engine.ts";

function engineReturning(content: string): AiEzioEngineSession {
	return {
		start: vi.fn(async () => ({ type: "ready" })),
		submit: vi.fn(),
		interrupt: vi.fn(),
		submitAndWait: vi.fn(async () => ({ turnId: "t", content })),
		onExit: vi.fn(),
		close: vi.fn(),
	};
}

function engineThrowing(error: Error): AiEzioEngineSession {
	return {
		start: vi.fn(async () => ({ type: "ready" })),
		submit: vi.fn(),
		interrupt: vi.fn(),
		submitAndWait: vi.fn(async () => {
			throw error;
		}),
		onExit: vi.fn(),
		close: vi.fn(),
	};
}

const request = {
	workItemId: "w1",
	collabId: "c1",
	threadId: "th1",
	requestedAction: "implement_plan" as const,
	instruction: "build the widget",
};

describe("createAiEzioProvider", () => {
	it("identity is schema-valid with providerId, toolFamily, and providerVersion", () => {
		const p = createAiEzioProvider({ createEngineSession: () => engineReturning("") });
		const identity = p.getIdentity();
		expect(() => providerIdentitySchema.parse(identity)).not.toThrow();
		expect(identity.providerId).toBe("ezio");
		expect(identity.providerVersion.length).toBeGreaterThanOrEqual(1);
	});

	it("capabilities are schema-valid, with direct packets, relay interception, and extensions", () => {
		const p = createAiEzioProvider({ createEngineSession: () => engineReturning("") });
		const caps = p.getCapabilities();
		expect(() => providerCapabilitiesSchema.parse(caps)).not.toThrow();
		expect(caps.supportsDirectPackets).toBe(true);
		expect(caps.supportsRelayInterception).toBe(true);
		expect(caps.extensions).toBeDefined();
	});

	it("handleWork returns a schema-valid answer reply from the turn content", async () => {
		const session = engineReturning("done building");
		const p = createAiEzioProvider({ createEngineSession: () => session });
		const reply = await p.handleWork(request);
		expect(() => mockProviderReplySchema.parse(reply)).not.toThrow();
		expect(reply).toMatchObject({ kind: "answer", content: "done building" });
		// eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock assertion, not invoked
		expect(session.submitAndWait).toHaveBeenCalledTimes(1);
	});

	it("handleWork maps a tool-only (empty) turn to a valid non-empty answer", async () => {
		const p = createAiEzioProvider({ createEngineSession: () => engineReturning("") });
		const reply = await p.handleWork(request);
		expect(() => mockProviderReplySchema.parse(reply)).not.toThrow();
		expect(reply.content.length).toBeGreaterThanOrEqual(1);
	});

	it("handleWork passes the artifact request-file path into the prompt", async () => {
		const session = engineReturning("ok");
		const p = createAiEzioProvider({ createEngineSession: () => session });
		await p.handleWork(request, {
			artifactHandle: {
				workItemId: "w1",
				artifactDirPath: "/tmp/art/w1",
				requestFilePath: "/tmp/art/w1/request.md",
				statusFilePath: "/tmp/art/w1/status.json",
			},
		});
		const submitted = (session.submitAndWait as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
		expect(submitted).toContain("/tmp/art/w1/request.md");
	});

	it("getHealthState is healthy after a successful turn", async () => {
		const p = createAiEzioProvider({ createEngineSession: () => engineReturning("ok") });
		await p.handleWork(request);
		expect(p.getHealthState()).toBe("healthy");
	});

	it("getHealthState degrades when a turn fails (TurnError)", async () => {
		const p = createAiEzioProvider({
			createEngineSession: () => engineThrowing(new TurnError("turn failed", "t")),
		});
		await p.handleWork(request);
		expect(p.getHealthState()).toBe("degraded");
	});

	it("getHealthState goes offline when the engine exits (EngineExitedError)", async () => {
		const p = createAiEzioProvider({
			createEngineSession: () => engineThrowing(new EngineExitedError()),
		});
		await p.handleWork(request);
		expect(p.getHealthState()).toBe("offline");
	});
});
