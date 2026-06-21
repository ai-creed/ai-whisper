import { describe, expect, it, vi } from "vitest";
import {
	captureClipboardHandback,
	CaptureIoTimeoutError,
} from "../packages/cli/src/runtime/clipboard-handback-capture.ts";

describe("clipboard handback capture", () => {
	it("returns the changed clipboard text after triggering /copy", async () => {
		const triggerCopy = vi.fn();
		const readClipboard = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce("before")
			.mockResolvedValueOnce("before")
			.mockResolvedValueOnce("A clean copied response");
		const sleep = vi.fn(() => Promise.resolve());

		await expect(
			captureClipboardHandback({
				triggerCopy,
				readClipboard,
				sleep,
				attempts: 3,
				delayMs: 0,
			}),
		).resolves.toBe("A clean copied response");

		expect(triggerCopy).toHaveBeenCalledTimes(1);
	});

	it("falls back to null when clipboard never changes", async () => {
		const triggerCopy = vi.fn();
		const readClipboard = vi.fn<() => Promise<string>>().mockResolvedValue("before");
		const sleep = vi.fn(() => Promise.resolve());

		await expect(
			captureClipboardHandback({
				triggerCopy,
				readClipboard,
				sleep,
				attempts: 2,
				delayMs: 0,
			}),
		).resolves.toBeNull();
	});

	it("calls confirmPicker then polls when clipboard has not changed after trigger delay", async () => {
		const triggerCopy = vi.fn();
		const confirmPicker = vi.fn();
		// before, afterTrigger (no change), poll attempt 0 (no change), poll attempt 1 (changed)
		const readClipboard = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce("before")
			.mockResolvedValueOnce("before")
			.mockResolvedValueOnce("before")
			.mockResolvedValueOnce("picked response");
		const sleep = vi.fn(() => Promise.resolve());

		const result = await captureClipboardHandback({
			triggerCopy,
			confirmPicker,
			readClipboard,
			sleep,
			attempts: 3,
			delayMs: 0,
		});

		expect(result).toBe("picked response");
		expect(confirmPicker).toHaveBeenCalledTimes(1);
	});

	it("does not call confirmPicker when clipboard changes immediately after trigger", async () => {
		const triggerCopy = vi.fn();
		const confirmPicker = vi.fn();
		// before, afterTrigger (changed immediately)
		const readClipboard = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce("before")
			.mockResolvedValueOnce("instant response");
		const sleep = vi.fn(() => Promise.resolve());

		const result = await captureClipboardHandback({
			triggerCopy,
			confirmPicker,
			readClipboard,
			sleep,
			attempts: 3,
			delayMs: 0,
		});

		expect(result).toBe("instant response");
		expect(confirmPicker).not.toHaveBeenCalled();
	});
});

describe("clipboard handback capture — pbpaste timeout", () => {
	it("propagates a CaptureIoTimeoutError thrown by the clipboard read (pboard wedge)", async () => {
		const readClipboard = vi.fn<() => Promise<string>>().mockRejectedValue(
			new CaptureIoTimeoutError("pbpaste"),
		);
		await expect(
			captureClipboardHandback({
				triggerCopy: vi.fn(),
				readClipboard,
				sleep: () => Promise.resolve(),
				attempts: 2,
				delayMs: 0,
			}),
		).rejects.toBeInstanceOf(CaptureIoTimeoutError);
	});
});
