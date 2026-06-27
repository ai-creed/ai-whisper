import { spawn } from "node:child_process";
import {
	createProviderIdentity,
	type CompanionProvider,
	type InteractiveSessionController,
	type ProviderReply,
	type ProviderWorkContext,
	type ProviderWorkRequest,
} from "@ai-whisper/shared";
import type { AntigravityCommandConfig } from "./antigravity-command.js";
import {
	buildAntigravityFileBackedBrokerPrompt,
	buildAntigravityPrompt,
} from "./antigravity-prompt.js";
import { parseAntigravityOutput } from "./parse-antigravity-output.js";

export function createAntigravityProvider(
	config: AntigravityCommandConfig,
): CompanionProvider {
	return {
		getIdentity() {
			return createProviderIdentity({
				providerId: "google-antigravity-cli",
				toolFamily: "antigravity",
				providerVersion: "1.0.0",
			});
		},
		getCapabilities() {
			return {
				supportsDirectPackets: true,
				supportsNormalization: true,
				supportsRelayInterception: true,
				supportsLocalBuffering: false,
				supportsLaunchHooks: false,
				extensions: {},
			};
		},
		getHealthState() {
			return "healthy";
		},
		attachInteractiveSession(session: InteractiveSessionController) {
			void session;
		},
		handleWork(request: ProviderWorkRequest, context?: ProviderWorkContext): Promise<ProviderReply> {
			const prompt = context?.artifactHandle
				? buildAntigravityFileBackedBrokerPrompt(context.artifactHandle.requestFilePath)
				: buildAntigravityPrompt(request);

			return new Promise((resolve) => {
				let child;
				try {
					child = spawn(config.executable, [...config.execArgs, prompt], {
						stdio: ["ignore", "pipe", "pipe"],
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					resolve({
						kind: "failure",
						content: `Failed to spawn ${config.executable}: ${message}`,
						transitionIntent: "failed",
					});
					return;
				}

				let stdout = "";
				let stderr = "";
				let settled = false;

				child.stdout.on("data", (chunk) => {
					stdout += String(chunk);
				});
				child.stderr.on("data", (chunk) => {
					stderr += String(chunk);
				});
				child.on("error", (err) => {
					if (settled) return;
					settled = true;
					resolve({
						kind: "failure",
						content: `Failed to spawn ${config.executable}: ${err.message}`,
						transitionIntent: "failed",
					});
				});
				child.on("close", (code, signal) => {
					if (settled) return;
					settled = true;
					if (code === null) {
						resolve({
							kind: "failure",
							content: `Antigravity exited due to signal: ${signal}`,
							transitionIntent: "failed",
						});
						return;
					}
					if (code !== 0) {
						resolve({
							kind: "failure",
							content: `Antigravity exited with code ${code}: ${stderr.trim()}`,
							transitionIntent: "failed",
						});
						return;
					}
					resolve(parseAntigravityOutput(stdout));
				});
			});
		},
	};
}
