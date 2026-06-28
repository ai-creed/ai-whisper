import { spawn } from "node:child_process";
import {
	createProviderIdentity,
	type CompanionProvider,
	type InteractiveSessionController,
	type ProviderReply,
	type ProviderWorkContext,
	type ProviderWorkRequest,
} from "@ai-whisper/shared";
import type { CursorCommandConfig } from "./cursor-command.js";
import { buildCursorFileBackedBrokerPrompt, buildCursorPrompt } from "./cursor-prompt.js";
import { parseCursorOutput } from "./parse-cursor-output.js";

export function createCursorProvider(
	config: CursorCommandConfig,
): CompanionProvider {
	return {
		getIdentity() {
			return createProviderIdentity({
				providerId: "cursor-agent-cli",
				toolFamily: "cursor",
				providerVersion: "1.0.0",
			});
		},
		getCapabilities() {
			return {
				supportsDirectPackets: true,
				supportsNormalization: true,
				supportsRelayInterception: true,
				supportsLocalBuffering: false,
				supportsLaunchHooks: true,
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
			// When an artifact handle is provided, use the retained request.json as
			// the authoritative source of truth instead of rebuilding from inline fields.
			const prompt = context?.artifactHandle
				? buildCursorFileBackedBrokerPrompt(context.artifactHandle.requestFilePath)
				: buildCursorPrompt(request);

			return new Promise((resolve) => {
				// Cursor takes the prompt as the final positional argument; there is no
				// --prompt flag and no supported stdin prompt path.
				const child = spawn(config.executable, [...config.execArgs, prompt], {
					stdio: ["ignore", "pipe", "pipe"],
				});

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
				child.on("close", (code) => {
					if (settled) return;
					settled = true;
					// On failure Cursor exits non-zero and writes a human message to
					// stderr, emitting no JSON on stdout.
					if (code !== 0) {
						resolve({
							kind: "failure",
							content: `Cursor exited with code ${code}: ${stderr.trim()}`,
							transitionIntent: "failed",
						});
						return;
					}

					resolve(parseCursorOutput(stdout));
				});
			});
		},
	};
}
