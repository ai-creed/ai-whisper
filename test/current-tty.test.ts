import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveCurrentTty } from "../packages/cli/src/runtime/current-tty.ts";

describe("resolveCurrentTty", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("throws an actionable WSL2 message on Windows", () => {
		const spy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			expect(() => resolveCurrentTty()).toThrowError(/not supported natively on Windows/);
			expect(() => resolveCurrentTty()).toThrowError(/WSL2/);
		} finally {
			spy.mockRestore();
		}
	});

	it("resolves the current tty from process stdin when available", () => {
		const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean; path?: string };
		const originalIsTTY = stdin.isTTY;
		const originalPath = stdin.path;

		stdin.isTTY = true;
		stdin.path = "/dev/tty";

		try {
			expect(resolveCurrentTty()).toBe("/dev/tty");
		} finally {
			stdin.isTTY = originalIsTTY;
			if (originalPath === undefined) {
				delete stdin.path;
			} else {
				stdin.path = originalPath;
			}
		}
	});
});
