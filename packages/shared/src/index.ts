export const sharedPackageName = "@ai-whisper/shared";
export type { BrokerArtifactHandle } from "./broker-artifact.js";
export { InteractiveBrokerError } from "./interactive-broker-error.js";

export { brokerSchemaVersion } from "./version.js";
export type { Brand } from "./brand.js";
export {
	artifactManifestIdSchema,
	collabIdSchema,
	createArtifactManifestId,
	createCollabId,
	createEventId,
	createReplyId,
	createSessionId,
	createThreadId,
	createWorkItemId,
	eventIdSchema,
	replyIdSchema,
	sessionIdSchema,
	threadIdSchema,
	workItemIdSchema,
} from "./id.js";
export {
	agentTypes,
	type AgentType,
	artifactCategories,
	attachTargetModes,
	bindingSources,
	brokerHealthStates,
	collabStates,
	eventTypes,
	replyKinds,
	requestedActions,
	sessionRegistrationStates,
	threadStates,
	transitionIntents,
	workItemStates,
} from "./literals.js";
export { extractJsonObjectCandidates } from "./extract-json-object-candidates.js";
export { repoRelativePath, displayArtifactPath } from "./repo-relative-path.js";
export { brokerStatusSchema, type BrokerStatus } from "./broker-status.js";
export { collabSchema, type Collab } from "./collab.js";
export { sessionSchema, type Session } from "./session.js";
export { threadSchema, type Thread } from "./thread.js";
export {
	contextPacketSchema,
	deltaContextPacketSchema,
	fullContextPacketSchema,
	type DeltaContextPacket,
	type FullContextPacket,
	workItemSchema,
	type WorkItem,
} from "./work-item.js";
export { replySchema, type Reply } from "./reply.js";
export {
	artifactEntrySchema,
	artifactManifestSchema,
	type ArtifactManifest,
} from "./artifact-manifest.js";
export { eventEnvelopeSchema, type EventEnvelope } from "./event-envelope.js";
export {
	endpointHealthStates,
	type EndpointHealthState,
} from "./endpoint-health.js";
export {
	companionHeartbeatSchema,
	companionRegistrationAckSchema,
	companionRegistrationSchema,
	type CompanionHeartbeat,
	type CompanionRegistration,
	type CompanionRegistrationAck,
} from "./companion-registration.js";
export {
	providerCapabilitiesSchema,
	type ProviderCapabilities,
} from "./provider-capabilities.js";
export {
	mockProviderReplySchema,
	type CompanionProvider,
	type MockProviderReply,
	type ProviderReply,
	type ProviderWorkContext,
	type ProviderWorkRequest,
} from "./provider-contract.js";
export {
	providerIdentitySchema,
	createProviderIdentity,
	type ProviderIdentity,
} from "./provider-identity.js";
export {
	relayDirectiveSchema,
	relayTargets,
	type RelayDirective,
} from "./relay-host.js";
export type {
	InteractiveSessionController,
	OverlayIO,
	OverlayRunner,
	TurnFidelityDecision,
} from "./interactive-session.js";
export {
	appendInteractiveBrokerChunk,
	beginBrokerReply,
	endBrokerReply,
	type InteractiveBrokerFrameState,
} from "./interactive-broker-protocol.js";
export { ensureNodePtySpawnHelperExecutable } from "./node-pty-support.js";
export { attachClaimSchema, type AttachClaim } from "./attach-claim.js";
export { sessionBindingSchema, type SessionBinding } from "./session-binding.js";
