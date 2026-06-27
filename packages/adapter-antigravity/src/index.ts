export const adapterAntigravityPackage = {
	name: "@ai-whisper/adapter-antigravity",
} as const;

export { createAntigravityProvider } from "./create-antigravity-provider.js";
export {
	buildAntigravityFileBackedBrokerPrompt,
	buildAntigravityPrompt,
} from "./antigravity-prompt.js";
export { parseAntigravityOutput } from "./parse-antigravity-output.js";
export type { AntigravityCommandConfig } from "./antigravity-command.js";
export { createAntigravityLiveSession } from "./create-antigravity-live-session.js";

