export const adapterCursorPackage = {
	name: "@ai-whisper/adapter-cursor",
} as const;

export { createCursorProvider } from "./create-cursor-provider.js";
export { createCursorLiveSession } from "./create-cursor-live-session.js";
export { createCursorAttachedSession } from "./create-cursor-attached-session.js";
export { buildCursorFileBackedBrokerPrompt, buildCursorPrompt } from "./cursor-prompt.js";
export { parseCursorOutput } from "./parse-cursor-output.js";
export type { CursorCommandConfig } from "./cursor-command.js";
