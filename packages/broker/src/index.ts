export const brokerPackage = {
	name: "@ai-whisper/broker",
} as const;

export { brokerConfigSchema, type BrokerConfig } from "./config.js";
export { createControlService } from "./control/create-control-service.js";
export { createBrokerApp } from "./http/create-broker-app.js";
export {
	createBrokerRuntime,
	type BrokerRuntime,
} from "./runtime/create-broker-runtime.js";
export {
	sweepStaleBrokerDaemons,
	defaultIsAlive,
	type IsAliveResult,
} from "./runtime/broker-daemon-sweep.js";
export { applyMigrations } from "./storage/apply-migrations.js";
export { CURRENT_SCHEMA_VERSION } from "./storage/apply-migrations.js";
export {
	EVENT_PROTOCOL_VERSION,
	type HelloFrame,
	type EventFrame,
	type EventSocketFrame,
} from "./runtime/event-protocol.js";
export {
	createEventSocketServer,
	ALL_BROKER_EVENT_NAMES,
	type EventSocketServer,
	type CreateEventSocketServerInput,
} from "./runtime/event-socket-server.js";
export {
	createBrokerEventBus,
	type BrokerEventBus,
	type BrokerEventName,
	type BrokerEventMap,
} from "./runtime/broker-event-bus.js";
export {
	createWorkflowEventBridge,
	type WorkflowEventBridge,
} from "./runtime/workflow-event-bridge.js";
export { enforceOneActiveCollabPerWorkspace } from "./storage/enforce-one-active-collab.js";
export {
	acquireCaptureLease,
	releaseCaptureLease,
	releaseCaptureLeaseForHolderPid,
	sweepStaleCaptureLease,
	DEFAULT_LEASE_TTL_MS,
	type LeaseOptions,
} from "./storage/clipboard-capture-lease.js";
export { openDatabase } from "./storage/open-database.js";
export { getBrokerState } from "./storage/repositories/broker-state-repository.js";
export {
	createCompanionAck,
	getCompanionSession,
	insertCompanionSession,
	updateCompanionHeartbeat,
} from "./storage/repositories/companion-session-repository.js";
export {
	appendEvent,
	listEventsForCollab,
} from "./storage/repositories/event-log-repository.js";
export {
	getSession,
	insertSession,
	listSessionsForCollab,
	reapSupersededSessions,
	updateSessionHealth,
} from "./storage/repositories/session-repository.js";
export {
	insertCaptureDiagnostic,
	listCaptureDiagnosticsByCollab,
	listCaptureDiagnosticsByCollabAndChain,
	listCaptureDiagnosticsByHandoff,
	deleteCaptureDiagnosticsOlderThan,
	type RelayCaptureDiagnosticRecord,
	type CaptureStatus,
} from "./storage/repositories/relay-capture-diagnostics-repository.js";
export {
	insertEvaluatorDiagnostic,
	listEvaluatorDiagnosticsByCollab,
	listEvaluatorDiagnosticsByCollabAndChain,
	listEvaluatorDiagnosticsByHandoff,
	deleteEvaluatorDiagnosticsOlderThan,
	type RelayEvaluatorDiagnosticRecord,
	type EvaluatorOutcome,
} from "./storage/repositories/relay-evaluator-diagnostics-repository.js";
export {
	insertTurnEventDiagnostic,
	listTurnEventDiagnosticsByCollab as listTurnEventDiagnosticsByCollabRepo,
	deleteTurnEventDiagnosticsOlderThan,
	type RelayTurnEventDiagnosticRecord,
	type TurnEventAction,
	type TurnEventFidelityVerdict,
} from "./storage/repositories/relay-turn-event-diagnostics-repository.js";
export { getWorkflowDefinition, listWorkflowTypes } from "./runtime/workflow-registry.js";
export {
	upsertWorkspace,
	getWorkspaceById,
	getWorkspaceByRoot,
	listWorkspaces,
	type WorkspaceRecord,
} from "./storage/repositories/workspace-repository.js";
export {
	upsertSessionAttachment,
	listSessionAttachmentsByCollab,
	deleteSessionAttachment,
	type SessionAttachmentRecord,
	type AgentType,
	type AttachmentKind,
} from "./storage/repositories/session-attachment-repository.js";
export {
	insertBrokerDaemon,
	updateBrokerDaemonPid,
	updateBrokerDaemonHeartbeat,
	getBrokerDaemonByCollab,
	getBrokerDaemonByPort,
	deleteBrokerDaemonByCollab,
	listStaleBrokerDaemons,
	listAllBrokerDaemons,
	setBrokerDaemonEvaluatorStatus,
	type BrokerDaemonRecord,
} from "./storage/repositories/broker-daemon-repository.js";
export {
	upsertRecoveryState,
	getRecoveryState,
	deleteRecoveryState,
	type RecoveryStateRecord,
	type RecoveryStateValue,
} from "./storage/repositories/recovery-state-repository.js";
export type {
	RelayHandoffLogRow,
	RelayHandoffWorkflowFilter,
} from "./storage/repositories/relay-handoff-repository.js";
export type {
	CollabSummary,
	RunCostRow,
	WorkflowSummaryRow,
} from "./storage/repositories/dashboard-repository.js";
