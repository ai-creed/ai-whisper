import {
	createProviderIdentity,
	type CompanionProvider,
	type InteractiveSessionController,
	type ProviderCapabilities,
	type ProviderReply,
	type ProviderWorkContext,
	type ProviderWorkRequest,
} from "@ai-whisper/shared";
import { TurnError, EngineExitedError } from "@ai-ezio/harness";
import {
	defaultCreateEngineSession,
	type CreateEngineSession,
} from "./ai-ezio-engine.js";
import { buildAiEzioPrompt } from "./ai-ezio-prompt.js";
import { mapTurnToReply } from "./map-reply.js";

// Tracks the adapter package version; satisfies providerIdentitySchema's
// `providerVersion: z.string().min(1)`.
const AI_EZIO_PROVIDER_VERSION = "0.1.0";

export function createAiEzioProvider(config?: {
	createEngineSession?: CreateEngineSession;
}): CompanionProvider {
	const create = config?.createEngineSession ?? defaultCreateEngineSession;

	// Health is DERIVED from the engine Session's observed liveness/outcome, not
	// hardcoded: a clean turn → healthy; an in-turn failure (TurnError) → degraded;
	// the engine dying (EngineExitedError, fd-3 EOF) → offline.
	let health: "healthy" | "degraded" | "offline" = "healthy";

	// All five booleans + `extensions` are REQUIRED by providerCapabilitiesSchema.
	// supportsRelayInterception is true: ezio's mount routes through the shared
	// live-session.ts stdin interception (M5), so operator-typed @@ directives in
	// an ezio mount are intercepted and create handoffs (senderAgent = "ezio") —
	// the declaration matches the already-wired behavior (M6, full parity).
	const capabilities: ProviderCapabilities = {
		supportsDirectPackets: true,
		supportsNormalization: false,
		supportsRelayInterception: true,
		supportsLocalBuffering: false,
		supportsLaunchHooks: true,
		extensions: {},
	};

	return {
		getIdentity: () =>
			createProviderIdentity({
				providerId: "ezio",
				toolFamily: "hax",
				providerVersion: AI_EZIO_PROVIDER_VERSION,
			}),
		getCapabilities: () => capabilities,
		getHealthState: () => health,
		attachInteractiveSession: (_session: InteractiveSessionController) => {
			// M5: the live session is created via createAiEzioLiveSession in the
			// mount runtime; no attach-time wiring is required here.
		},
		async handleWork(
			request: ProviderWorkRequest,
			context?: ProviderWorkContext,
		): Promise<ProviderReply> {
			const session = create({ onEvent: () => {} });
			try {
				await session.start();
				const { content } = await session.submitAndWait(buildAiEzioPrompt(request, context));
				health = "healthy";
				return mapTurnToReply({ ok: true, content });
			} catch (error) {
				if (error instanceof EngineExitedError) {
					health = "offline";
					return mapTurnToReply({ ok: false, error: error.message });
				}
				health = "degraded";
				const message = error instanceof TurnError ? error.message : String(error);
				return mapTurnToReply({ ok: false, error: message });
			} finally {
				session.close();
			}
		},
	};
}
