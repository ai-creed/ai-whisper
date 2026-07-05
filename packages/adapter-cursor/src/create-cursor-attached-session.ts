import type { InteractiveSessionController } from "@ai-whisper/shared";

export function createCursorAttachedSession(input: {
	stdin: NodeJS.ReadableStream;
	stdout: NodeJS.WritableStream;
	cwd: string;
}): InteractiveSessionController {
	return {
		start: async () => {},
		stop: async () => {},
		writeUserInput(data: string) {
			input.stdout.write(data);
		},
		sendLocalMessage(message: string) {
			input.stdout.write(message);
		},
		onExit() {
			// Attached sessions have no child process to monitor.
		},
	};
}
