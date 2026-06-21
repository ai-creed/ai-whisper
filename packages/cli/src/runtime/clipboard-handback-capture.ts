import { execFile } from "node:child_process";

/** Thrown when a clipboard subprocess (`pbpaste`) is killed by its timeout.
 *  A tagged type — distinct from a generic failure — so `captureHandbackText`
 *  can route it into the timeout retry ladder instead of a no-response handback. */
export class CaptureIoTimeoutError extends Error {
	constructor(command: string) {
		super(`clipboard I/O timed out: ${command}`);
		this.name = "CaptureIoTimeoutError";
	}
}

function execFileText(
	command: string,
	args: string[] = [],
	timeoutMs?: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ encoding: "utf8", timeout: timeoutMs ?? 0, killSignal: "SIGTERM" },
			(error, stdout) => {
				if (error) {
					// execFile sets killed=true when it SIGTERMs the child on timeout.
					if ((error as { killed?: boolean }).killed) {
						reject(new CaptureIoTimeoutError(command));
						return;
					}
					reject(
						error instanceof Error
							? error
							: new Error("Clipboard command failed"),
					);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

export async function captureClipboardHandback(input: {
	triggerCopy(): void | Promise<void>;
	/** Called once if clipboard has not changed after the initial trigger delay.
	 *  Use this to dismiss a picker or confirm a secondary prompt (e.g. Claude Code's /copy picker). */
	confirmPicker?: () => void | Promise<void>;
	readClipboard?: () => Promise<string>;
	sleep?: (ms: number) => Promise<void>;
	attempts?: number;
	delayMs?: number;
	/** Delay before first poll; also the window given to confirmPicker to fire. Defaults to delayMs. */
	triggerDelayMs?: number;
	/** Per-exec timeout (ms) applied to the default `pbpaste` read. Ignored when a
	 *  custom readClipboard is injected. */
	clipboardTimeoutMs?: number;
	/** Platform override (defaults to process.platform). Injectable so the default
	 *  pbpaste path is deterministically testable off-darwin. */
	platform?: NodeJS.Platform;
}): Promise<string | null> {
	const readClipboard =
		input.readClipboard ??
		(() => {
			if ((input.platform ?? process.platform) !== "darwin") {
				return Promise.resolve("");
			}
			return execFileText("pbpaste", [], input.clipboardTimeoutMs);
		});
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const attempts = input.attempts ?? 10;
	const delayMs = input.delayMs ?? 100;
	const triggerDelayMs = input.triggerDelayMs ?? delayMs;

	const before = (await readClipboard()).trim();
	await input.triggerCopy();

	// Wait for the trigger to settle, then check if clipboard changed already.
	// If not (e.g. a picker is blocking), fire confirmPicker before polling.
	await sleep(triggerDelayMs);
	const afterTrigger = (await readClipboard()).trim();
	if (afterTrigger.length > 0 && afterTrigger !== before) {
		return afterTrigger;
	}
	if (input.confirmPicker) {
		await input.confirmPicker();
	}

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		await sleep(delayMs);
		const current = (await readClipboard()).trim();
		if (current.length > 0 && current !== before) {
			return current;
		}
	}

	return null;
}
