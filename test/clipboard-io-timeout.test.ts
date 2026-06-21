import { describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({
	// Statement body (returns void): the code under test uses execFile's callback,
	// never its ChildProcess return — and returning the mock's `any` trips
	// @typescript-eslint/no-unsafe-return.
	execFile: (...args: unknown[]) => {
		execFileMock(...args);
	},
}));
vi.mock("node:fs", () => ({ existsSync: () => true }));

import { makeChangeCountReader } from "../packages/cli/src/runtime/clipboard-change-count.ts";
import { captureClipboardHandback } from "../packages/cli/src/runtime/clipboard-handback-capture.ts";

type ExecCb = (err: unknown, stdout: string) => void;

describe("clipboard I/O timeout threading (default execFile path)", () => {
	it("changeCount: passes timeoutMs + killSignal to the default execFile", async () => {
		execFileMock.mockReset();
		execFileMock.mockImplementation(
			(_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => cb(null, "7\n"),
		);
		const read = makeChangeCountReader({ platform: "darwin", timeoutMs: 8000 });
		expect(await read()).toBe(7);
		const opts = execFileMock.mock.calls[0]![2] as {
			timeout: number;
			killSignal: string;
		};
		expect(opts.timeout).toBe(8000);
		expect(opts.killSignal).toBe("SIGTERM");
	});

	it("pbpaste: passes clipboardTimeoutMs + killSignal to the default execFile", async () => {
		execFileMock.mockReset();
		execFileMock.mockImplementation(
			(_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => cb(null, "x\n"),
		);
		await captureClipboardHandback({
			platform: "darwin",
			clipboardTimeoutMs: 8000,
			triggerCopy: vi.fn(),
			sleep: () => Promise.resolve(),
			attempts: 1,
			delayMs: 0,
		});
		const opts = execFileMock.mock.calls[0]![2] as {
			timeout: number;
			killSignal: string;
		};
		expect(opts.timeout).toBe(8000);
		expect(opts.killSignal).toBe("SIGTERM");
	});
});
