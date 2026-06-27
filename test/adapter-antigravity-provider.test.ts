import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderWorkRequest } from "../packages/shared/src/index.ts";

type MockChildProcess = EventEmitter & { stdout: PassThrough; stderr: PassThrough };
const spawnMock = vi.fn<(command: string, args: string[], options: unknown) => MockChildProcess>();
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const REQUEST: ProviderWorkRequest = {
	workItemId: "work_agy",
	collabId: "collab_test",
	threadId: "thread_test",
	requestedAction: "answer_question",
	instruction: "Reply with minimal JSON.",
};

describe("createAntigravityProvider", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("reports the antigravity identity and capabilities", async () => {
		const { createAntigravityProvider } = await import(
			"../packages/adapter-antigravity/src/create-antigravity-provider.ts",
		);
		const provider = createAntigravityProvider({ executable: "agy", execArgs: ["-p"] });
		expect(provider.getIdentity()).toEqual({
			providerId: "google-antigravity-cli",
			toolFamily: "antigravity",
			providerVersion: "1.0.0",
		});
		expect(provider.getCapabilities()).toEqual({
			supportsDirectPackets: true,
			supportsNormalization: true,
			supportsRelayInterception: true,
			supportsLocalBuffering: false,
			supportsLaunchHooks: false,
			extensions: {},
		});
		expect(provider.getHealthState()).toBe("healthy");
	});

	it("spawns agy and parses the JSON reply from stdout", async () => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = new EventEmitter() as MockChildProcess;
		child.stdout = stdout;
		child.stderr = stderr;
		spawnMock.mockReturnValue(child);

		const { createAntigravityProvider } = await import(
			"../packages/adapter-antigravity/src/create-antigravity-provider.ts",
		);
		const provider = createAntigravityProvider({ executable: "agy", execArgs: ["-p"] });
		const replyPromise = provider.handleWork(REQUEST);

		stdout.write('{"kind":"answer","content":"ok","transitionIntent":"completed"}\n');
		child.emit("close", 0);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "ok",
			transitionIntent: "completed",
		});
		expect(spawnMock.mock.calls[0]?.[0]).toBe("agy");
	});

	it("parses malformed output into a failure reply", async () => {
		const { parseAntigravityOutput } = await import(
			"../packages/adapter-antigravity/src/parse-antigravity-output.ts",
		);
		expect(parseAntigravityOutput("no json here")).toEqual({
			kind: "failure",
			content: "Provider output did not contain JSON",
			transitionIntent: "failed",
		});
	});

	it("handles synchronous spawn exceptions in handleWork", async () => {
		const error = new Error("spawn ENOENT");
		spawnMock.mockImplementation(() => {
			throw error;
		});

		const { createAntigravityProvider } = await import(
			"../packages/adapter-antigravity/src/create-antigravity-provider.ts",
		);
		const provider = createAntigravityProvider({ executable: "agy", execArgs: ["-p"] });
		const replyPromise = provider.handleWork(REQUEST);

		await expect(replyPromise).resolves.toEqual({
			kind: "failure",
			content: "Failed to spawn agy: spawn ENOENT",
			transitionIntent: "failed",
		});
	});

	it("handles process termination by signal in the close handler", async () => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = new EventEmitter() as MockChildProcess;
		child.stdout = stdout;
		child.stderr = stderr;
		spawnMock.mockReturnValue(child);

		const { createAntigravityProvider } = await import(
			"../packages/adapter-antigravity/src/create-antigravity-provider.ts",
		);
		const provider = createAntigravityProvider({ executable: "agy", execArgs: ["-p"] });
		const replyPromise = provider.handleWork(REQUEST);

		child.emit("close", null, "SIGTERM");

		await expect(replyPromise).resolves.toEqual({
			kind: "failure",
			content: "Antigravity exited due to signal: SIGTERM",
			transitionIntent: "failed",
		});
	});
});
