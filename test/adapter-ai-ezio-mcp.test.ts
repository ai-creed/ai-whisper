import { describe, expect, it, vi } from "vitest";
import { createAiEzioLiveSession } from "@ai-whisper/adapter-ai-ezio";
import { createMcpHost } from "@ai-ezio/mcp-host";
import type { McpClient } from "@ai-ezio/mcp-host";
import type { ProtocolEvent } from "@ai-ezio/protocol";

// A fake engine session that captures the adapter's onEvent and records the
// delegated-tool API calls the MCP host drives.
function fakeEngine() {
	const calls: string[] = [];
	let registered: unknown[] = [];
	const results: Array<[string, string, string]> = [];
	let onEvent: ((e: ProtocolEvent) => void) | undefined;
	const session = {
		start: async () => calls.push("start"),
		submit: () => calls.push("submit"),
		interrupt: () => {},
		submitAndWait: async () => ({ turnId: "t", content: "" }),
		registerDelegatedTools: (t: unknown) => {
			calls.push("register");
			registered = t as unknown[];
		},
		sendToolResult: (id: string, out: string, st: string) =>
			results.push([id, out, st]),
		onExit: () => {},
		close: () => {},
	};
	return {
		calls,
		results,
		getRegistered: () => registered,
		emit: (e: ProtocolEvent) => onEvent?.(e),
		create: (opts: { onEvent: (e: ProtocolEvent) => void }) => {
			onEvent = opts.onEvent;
			return session as never;
		},
	};
}

function fakeClient(): McpClient {
	return {
		listTools: async () => [
			{ name: "echo", description: "", parametersSchema: { type: "object" } },
		],
		callTool: async (_t, a) => ({
			output: `echo:${JSON.stringify(a)}`,
			status: "ok",
		}),
		close: async () => {},
	};
}

describe("adapter-ai-ezio mounted MCP wiring", () => {
	it("registers delegated tools before any submit and routes a delegated call", async () => {
		const fake = fakeEngine();
		const host = createMcpHost(
			{ servers: [{ name: "stub", command: "x", args: [] }], toolPolicy: {}, hostPrivateTools: [] },
			{ mode: "mounted", cwd: "/repo", connect: async () => fakeClient() },
		);
		const controller = createAiEzioLiveSession({
			stdout: { write: () => true } as never,
			createEngineSession: fake.create,
			mcpHost: host,
			buildAutoCompact: () => null,
		});

		await controller.start();

		// register happened during start, before any submit
		expect(fake.calls).toContain("register");
		expect(fake.calls.indexOf("register")).toBeGreaterThan(
			fake.calls.indexOf("start"),
		);
		expect(fake.calls).not.toContain("submit");
		expect((fake.getRegistered() as Array<{ name: string }>)[0]!.name).toBe(
			"stub__echo",
		);

		// a delegated request routed through the adapter's onEvent -> host -> sendToolResult
		fake.emit({
			type: "tool_call_requested",
			turnId: "t",
			callId: "c1",
			name: "stub__echo",
			args: { msg: "hi" },
		});
		await vi.waitFor(() => expect(fake.results.length).toBe(1));
		expect(fake.results[0]![0]).toBe("c1");
		expect(fake.results[0]![2]).toBe("ok");
		expect(fake.results[0]![1]).toContain("hi");
	});
});
