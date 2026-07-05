import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderWorkRequest } from "../packages/shared/src/index.ts";

type MockChildProcess = EventEmitter & {
	stdout: PassThrough;
	stderr: PassThrough;
};

type SpawnMock = (
	command: string,
	args: string[],
	options: unknown,
) => MockChildProcess;

const spawnMock = vi.fn<SpawnMock>();

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

const REQUEST: ProviderWorkRequest = {
	workItemId: "work_cursor_provider_test",
	collabId: "collab_test",
	threadId: "thread_test",
	requestedAction: "answer_question",
	instruction: "Reply with minimal JSON.",
};

function newChild(): MockChildProcess {
	const child = new EventEmitter() as MockChildProcess;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	return child;
}

describe("createCursorProvider", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("spawns with the prompt appended after execArgs and parses the JSON envelope", async () => {
		const child = newChild();
		spawnMock.mockReturnValue(child);

		const { createCursorProvider } = await import(
			"../packages/adapter-cursor/src/create-cursor-provider.ts",
		);
		const provider = createCursorProvider({
			executable: "agent",
			execArgs: ["-p", "--force", "--output-format", "json"],
		});

		const replyPromise = provider.handleWork(REQUEST);

		const [command, args] = spawnMock.mock.calls[0] ?? [];
		expect(command).toBe("agent");
		expect(args?.slice(0, 4)).toEqual(["-p", "--force", "--output-format", "json"]);
		// the prompt is the final positional argument
		expect(args?.[args.length - 1]).toContain("instruction: Reply with minimal JSON.");

		child.stdout.write(
			JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: false,
				result: '{"kind":"answer","content":"ok","transitionIntent":"completed"}',
				session_id: "s",
				request_id: "r",
			}),
		);
		child.emit("close", 0);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "ok",
			transitionIntent: "completed",
		});
	});

	it("returns a failure reply with stderr when the process exits non-zero", async () => {
		const child = newChild();
		spawnMock.mockReturnValue(child);

		const { createCursorProvider } = await import(
			"../packages/adapter-cursor/src/create-cursor-provider.ts",
		);
		const provider = createCursorProvider({ executable: "agent", execArgs: ["-p"] });

		const replyPromise = provider.handleWork(REQUEST);

		child.stderr.write("not authenticated");
		child.emit("close", 1);

		const reply = await replyPromise;
		expect(reply.kind).toBe("failure");
		expect(reply.content).toContain("not authenticated");
		expect(reply.transitionIntent).toBe("failed");
	});

	it("returns a failure reply when the process cannot be spawned", async () => {
		const child = newChild();
		spawnMock.mockReturnValue(child);

		const { createCursorProvider } = await import(
			"../packages/adapter-cursor/src/create-cursor-provider.ts",
		);
		const provider = createCursorProvider({ executable: "agent", execArgs: ["-p"] });

		const replyPromise = provider.handleWork(REQUEST);

		child.emit("error", new Error("spawn agent ENOENT"));

		const reply = await replyPromise;
		expect(reply.kind).toBe("failure");
		expect(reply.content).toContain("ENOENT");
		expect(reply.transitionIntent).toBe("failed");
	});
});
