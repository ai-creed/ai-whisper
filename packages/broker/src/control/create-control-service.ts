import { type AgentType,
	artifactManifestSchema,
	attachClaimSchema,
	brokerSchemaVersion,
	collabSchema,
	companionRegistrationSchema,
	providerCapabilitiesSchema,
	providerIdentitySchema,
	replySchema,
	sessionBindingSchema,
	sessionSchema,
	threadSchema,
	workItemSchema,
	type ProviderCapabilities,
	type ProviderIdentity,
} from "@ai-whisper/shared";
import type Database from "better-sqlite3";
import * as crypto from "node:crypto";
import { nanoid } from "nanoid";
import {
	appendEvent,
	listEventsForCollab,
} from "../storage/repositories/event-log-repository.js";
import { insertArtifactManifest } from "../storage/repositories/artifact-manifest-repository.js";
import {
	getAttachClaim,
	insertAttachClaim,
	markAttachClaimConsumed,
	markAttachClaimReplaced,
} from "../storage/repositories/attach-claim-repository.js";
import {
	createCompanionAck,
	deleteCompanionSessionsForCollab,
	getCompanionSession,
	insertCompanionSession,
	updateCompanionHeartbeat,
} from "../storage/repositories/companion-session-repository.js";
import {
	insertCollab,
	getCollab,
} from "../storage/repositories/collab-repository.js";
import { getWorkflowById } from "../storage/repositories/workflow-repository.js";
import {
	captureWorkspaceSnapshotSync,
	diffChangedFilesSince,
} from "../runtime/workspace-snapshot.js";
import {
	insertReply,
	listRepliesForThread,
	listUnconsumedRepliesForSession,
	markRepliesConsumed as markRepliesConsumedInDb,
} from "../storage/repositories/reply-repository.js";
import {
	getSessionBinding,
	listSessionBindingsForCollab,
	upsertSessionBinding,
} from "../storage/repositories/session-binding-repository.js";
import {
	listSessionAttachmentsByCollab,
	type SessionAttachmentRecord,
} from "../storage/repositories/session-attachment-repository.js";
import {
	insertSession,
	getSession,
	listSessionsForCollab as listSessions,
	updateSessionHealth,
} from "../storage/repositories/session-repository.js";
import {
	getThread,
	insertThread,
	listThreadsForCollab,
	markOnlyThreadActive,
	updateThreadState,
	updateThreadTurnIndex,
} from "../storage/repositories/thread-repository.js";
import {
	getWorkItem,
	insertWorkItem,
	listWorkItemsForThread,
	markWorkItemCompleted,
	markWorkItemDelivered,
	markWorkItemFailed,
	markWorkItemsRecoveryBlockedForCollab,
} from "../storage/repositories/work-item-repository.js";
import {
	getWorkItemCancellationRequestedAt,
	insertWorkItemCancellation,
} from "../storage/repositories/work-item-cancellation-repository.js";
import {
	insertRelayMonitor,
	updateRelayMonitorHeartbeat,
	isRelayMonitorConnected as queryIsRelayMonitorConnected,
} from "../storage/repositories/relay-monitor-repository.js";
import {
	appendRelayEvent as insertRelayEvent,
	pollRelayEvents as queryPollRelayEvents,
	type RelayEvent,
} from "../storage/repositories/relay-event-repository.js";
import {
	queryRelayTurnState,
	upsertRelayTurnState,
} from "../storage/repositories/relay-turn-state-repository.js";
import {
	insertCaptureDiagnostic,
	listCaptureDiagnosticsByCollab as queryListCaptureDiagnosticsByCollab,
	listCaptureDiagnosticsByCollabAndChain as queryListCaptureDiagnosticsByCollabAndChain,
	listCaptureDiagnosticsByHandoff as queryListCaptureDiagnosticsByHandoff,
	deleteCaptureDiagnosticsOlderThan,
	type RelayCaptureDiagnosticRecord,
	type CaptureDiagnosticsWorkflowFilter,
} from "../storage/repositories/relay-capture-diagnostics-repository.js";
import {
	insertEvaluatorDiagnostic,
	listEvaluatorDiagnosticsByCollab as queryListEvaluatorDiagnosticsByCollab,
	listEvaluatorDiagnosticsByCollabAndChain as queryListEvaluatorDiagnosticsByCollabAndChain,
	listEvaluatorDiagnosticsByHandoff as queryListEvaluatorDiagnosticsByHandoff,
	deleteEvaluatorDiagnosticsOlderThan,
	type RelayEvaluatorDiagnosticRecord,
	type EvaluatorDiagnosticsWorkflowFilter,
} from "../storage/repositories/relay-evaluator-diagnostics-repository.js";
import {
	insertTurnEventDiagnostic,
	listTurnEventDiagnosticsByCollab as queryListTurnEventDiagnosticsByCollab,
	deleteTurnEventDiagnosticsOlderThan,
	type RelayTurnEventDiagnosticRecord,
	type TurnEventAction,
	type TurnEventFidelityVerdict,
} from "../storage/repositories/relay-turn-event-diagnostics-repository.js";
import {
	createRelayHandoffTxn,
	acceptRelayHandoffTxn,
	deferRelayHandoffTxn,
	markRelayHandoffStaleTxn,
	declineRelayHandoffTxn,
	handoffBackRelayTxn,
	failRelayHandoffOnDisconnectTxn,
	queryRelayHandoff,
	queryLatestHandedBackHandoff,
	claimRelayHandoffForOrchestrationTxn,
	listRelayHandoffsPendingOrchestration,
	createLoopRelayHandoffTxn,
	resolveRelayChainTxn,
	markRelayChainEscalatedTxn,
	markRelayChainAbandonedTxn,
	cleanupOrchestrationOnShutdownTxn,
	listRelayHandoffs as listRelayHandoffsRepo,
	type RelayHandoffLogRow,
	type RelayHandoffWorkflowFilter,
} from "../storage/repositories/relay-handoff-repository.js";
import {
	listActiveCollabSummaries as listActiveCollabSummariesRepo,
	listAllWorkflowSummaries as listAllWorkflowSummariesRepo,
	listRunCostRows as listRunCostRowsRepo,
	listWorkflowsForCollab as listWorkflowsForCollabRepo,
	type CollabSummary,
	type RunCostRow,
	type WorkflowSummaryRow,
} from "../storage/repositories/dashboard-repository.js";
import { createWorkflowControl } from "./workflow-control.js";
import type { BrokerEventBus } from "../runtime/broker-event-bus.js";

function normalizeTimestampForEventId(timestamp: string): string {
	return timestamp.replace(/[^0-9]/g, "");
}

function buildEventId(
	kind: string,
	subjectId: string,
	timestamp: string,
): string {
	return `evt_${kind}_${subjectId}_${normalizeTimestampForEventId(timestamp)}`;
}

export function createControlService(db: Database.Database, events: BrokerEventBus) {
	// Resolve a workflow's collab workspace root, then snapshot/diff it. Both hooks
	// are synchronous so pause/resume control methods persist their result before
	// returning (no race with an immediate resume). Resolved via `db` directly to
	// avoid a circular reference on `workflowControl` (constructed just below).
	const resolveWorkspaceRoot = (workflowId: string): string | null => {
		const wf = getWorkflowById(db, workflowId);
		if (!wf) return null;
		return getCollab(db, wf.collabId)?.workspaceRoot ?? null;
	};
	const workflowControl = createWorkflowControl({
		db,
		events,
		captureSnapshotRef: (workflowId: string) => {
			const root = resolveWorkspaceRoot(workflowId);
			return root ? captureWorkspaceSnapshotSync(root) : null;
		},
		diffChangedFilesSinceSnapshot: (workflowId: string, sinceRef: string) => {
			const root = resolveWorkspaceRoot(workflowId);
			return root ? diffChangedFilesSince(root, sinceRef) : [];
		},
	});

	// The single delivery chokepoint: true when a handoff belongs to a paused
	// workflow. Legacy / non-workflow handoffs are never suspended (keep flowing
	// exactly as today). Defined as a local const so the claim/accept wrappers and
	// the exported method share one implementation without `this`-binding fragility.
	const isWorkflowDeliverySuspended = (handoffId: string): boolean => {
		const meta = workflowControl.getHandoffWithWorkflowMeta(handoffId);
		if (!meta?.workflowId) return false;
		return workflowControl.getWorkflow(meta.workflowId)?.status === "paused";
	};

	return Object.assign({
		isWorkflowDeliverySuspended,
		startCollab(input: {
			collabId: string;
			workspaceRoot: string;
			displayName: string;
			orchestratorEnabled?: boolean;
			orchestratorMaxRounds?: number;
			now: string;
		}) {
			const collab = collabSchema.parse({
				version: 1,
				collabId: input.collabId,
				workspaceRoot: input.workspaceRoot,
				displayName: input.displayName,
				status: "active",
				createdAt: input.now,
				updatedAt: input.now,
				orchestratorEnabled: input.orchestratorEnabled ?? false,
				orchestratorMaxRounds: input.orchestratorMaxRounds ?? 3,
			});

			insertCollab(db, collab);

			upsertRelayTurnState(db, {
				collabId: collab.collabId,
				turnOwner: "none",
				waitingAgent: null,
				unresolvedHandoffId: null,
				handoffState: "idle",
				updatedAt: input.now,
				orchestratorEnabled: collab.orchestratorEnabled,
				currentRound: 0,
				maxRounds: collab.orchestratorMaxRounds,
				chainStatus: "done",
			});

			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId("collab_started", collab.collabId, input.now),
				eventType: "collab.started",
				collabId: collab.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.now,
				payload: { status: "started" },
			});

			return collab;
		},
		getCollab(collabId: string) {
			return getCollab(db, collabId);
		},
		registerSession(input: {
			sessionId: string;
			collabId: string;
			agentType: AgentType;
			capabilities: Record<string, unknown>;
			now: string;
		}) {
			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			const session = sessionSchema.parse({
				version: 1,
				sessionId: input.sessionId,
				collabId: input.collabId,
				agentType: input.agentType,
				registrationState: "registered",
				healthState: "healthy",
				capabilities: input.capabilities,
				registeredAt: input.now,
				lastSeenAt: input.now,
			});

			insertSession(db, session);

			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId("session_registered", input.sessionId, input.now),
				eventType: "session.registered",
				collabId: input.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.now,
				payload: { status: "registered" },
			});

			return session;
		},
		createThread(input: {
			threadId: string;
			collabId: string;
			title: string;
			createdBySessionId: string;
			now: string;
		}) {
			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			const thread = threadSchema.parse({
				version: 1,
				threadId: input.threadId,
				collabId: input.collabId,
				title: input.title,
				threadState: "in_progress",
				baseContextRef: null,
				currentTurnIndex: 0,
				active: true,
				createdBySessionId: input.createdBySessionId,
				createdAt: input.now,
				updatedAt: input.now,
			});

			const txn = db.transaction(() => {
				markOnlyThreadActive(db, input.collabId, null);
				insertThread(db, thread);
				markOnlyThreadActive(db, input.collabId, thread.threadId);

				appendEvent(db, {
					version: brokerSchemaVersion,
					eventId: buildEventId("thread_created", input.threadId, input.now),
					eventType: "thread.created",
					collabId: input.collabId,
					workspaceRoot: collab.workspaceRoot,
					timestamp: input.now,
					payload: { status: "created" },
				});
			});

			// IMMEDIATE: take the write lock at BEGIN so concurrent writers on
			// the shared state.db wait (busy_timeout) instead of failing with
			// SQLITE_BUSY_SNAPSHOT on the read->write upgrade.
			txn.immediate();
			return thread;
		},
		enqueueWorkItem(input: {
			workItemId: string;
			threadId: string;
			collabId: string;
			senderSessionId: string;
			targetSessionId: string;
			requestedAction:
				| "review_plan"
				| "implement_plan"
				| "review_diff"
				| "validate_against_plan"
				| "answer_question"
				| "request_clarification";
			instruction: string;
			contextPacket: Record<string, unknown>;
			artifactManifestIds?: string[];
			now: string;
		}) {
			const thread = getThread(db, input.threadId);

			if (!thread) {
				throw new Error(`Unknown thread: ${input.threadId}`);
			}

			const nextTurn = thread.currentTurnIndex + 1;
			const workItem = workItemSchema.parse({
				version: 1,
				workItemId: input.workItemId,
				threadId: input.threadId,
				collabId: input.collabId,
				turnIndex: nextTurn,
				senderSessionId: input.senderSessionId,
				targetSessionId: input.targetSessionId,
				requestedAction: input.requestedAction,
				instruction: input.instruction,
				contextPacket: input.contextPacket,
				deliveryState: "queued",
				artifactManifestIds: input.artifactManifestIds ?? [],
				createdAt: input.now,
				deliveredAt: null,
				completedAt: null,
			});

			if (workItem.contextPacket.kind === "delta" && !thread.baseContextRef) {
				throw new Error(
					"Delta context requires an existing thread base context",
				);
			}

			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			insertWorkItem(db, workItem);
			updateThreadTurnIndex(
				db,
				input.threadId,
				nextTurn,
				workItem.contextPacket.kind === "full"
					? workItem.workItemId
					: thread.baseContextRef,
				input.now,
			);

			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId("workitem_queued", input.workItemId, input.now),
				eventType: "workitem.queued",
				collabId: input.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.now,
				payload: { status: "queued" },
			});

			return workItem;
		},
		ackWorkItemDelivered(input: { workItemId: string; deliveredAt: string }) {
			const workItem = getWorkItem(db, input.workItemId);

			if (!workItem) {
				throw new Error(`Unknown work item: ${input.workItemId}`);
			}

			const collab = getCollab(db, workItem.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${workItem.collabId}`);
			}

			markWorkItemDelivered(db, input.workItemId, input.deliveredAt);

			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId(
					"workitem_delivered",
					input.workItemId,
					input.deliveredAt,
				),
				eventType: "workitem.delivered",
				collabId: workItem.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.deliveredAt,
				payload: { status: "delivered" },
			});
		},
		requestWorkItemCancellation(input: {
			workItemId: string;
			requestedAt: string;
		}) {
			const workItem = getWorkItem(db, input.workItemId);

			if (!workItem) {
				throw new Error(`Unknown work item: ${input.workItemId}`);
			}

			if (
				workItem.deliveryState === "completed" ||
				workItem.deliveryState === "failed" ||
				workItem.deliveryState === "recovery_blocked"
			) {
				return;
			}

			insertWorkItemCancellation(db, input);

			if (workItem.deliveryState !== "queued") {
				return;
			}

			const thread = getThread(db, workItem.threadId);
			if (!thread) {
				throw new Error(`Unknown thread: ${workItem.threadId}`);
			}

			const collab = getCollab(db, workItem.collabId);
			if (!collab) {
				throw new Error(`Unknown collab: ${workItem.collabId}`);
			}

			const existingReply = listRepliesForThread(db, workItem.threadId).find(
				(reply) => reply.workItemId === workItem.workItemId,
			);
			if (existingReply) {
				return;
			}

			const reply = replySchema.parse({
				version: 1,
				replyId: `reply_cancel_${workItem.workItemId}_${normalizeTimestampForEventId(input.requestedAt)}`,
				threadId: workItem.threadId,
				collabId: workItem.collabId,
				workItemId: workItem.workItemId,
				sourceSessionId: workItem.targetSessionId,
				turnIndex: thread.currentTurnIndex,
				kind: "failure",
				content: "Relay work cancelled by user",
				transitionIntent: "failed",
				artifactManifestIds: [],
				createdAt: input.requestedAt,
			});

			insertReply(db, reply);
			markWorkItemFailed(db, input.workItemId, input.requestedAt);
			updateThreadState(db, workItem.threadId, "failed", input.requestedAt);
			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId("thread_transition", reply.replyId, input.requestedAt),
				eventType: "thread.transitioned",
				collabId: workItem.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.requestedAt,
				payload: { status: "failed" },
			});
			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId("reply_posted", reply.replyId, input.requestedAt),
				eventType: "reply.posted",
				collabId: workItem.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.requestedAt,
				payload: { status: "failure" },
			});
		},
		isWorkItemCancellationRequested(workItemId: string) {
			return getWorkItemCancellationRequestedAt(db, workItemId) !== null;
		},
		postReply(input: {
			replyId: string;
			threadId: string;
			collabId: string;
			workItemId: string;
			sourceSessionId: string;
			kind: "answer" | "review" | "clarification" | "failure";
			content: string;
			transitionIntent:
				| "in_progress"
				| "awaiting_user"
				| "completed"
				| "failed"
				| null;
			artifactManifestIds: string[];
			now: string;
		}) {
			const thread = getThread(db, input.threadId);

			if (!thread) {
				throw new Error(`Unknown thread: ${input.threadId}`);
			}

			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			const workItem = getWorkItem(db, input.workItemId);

			if (!workItem) {
				throw new Error(`Unknown work item: ${input.workItemId}`);
			}

			if (
				workItem.threadId !== input.threadId ||
				workItem.collabId !== input.collabId
			) {
				throw new Error(
					`Work item ${input.workItemId} does not belong to thread ${input.threadId} / collab ${input.collabId}`,
				);
			}

			const reply = replySchema.parse({
				version: 1,
				replyId: input.replyId,
				threadId: input.threadId,
				collabId: input.collabId,
				workItemId: input.workItemId,
				sourceSessionId: input.sourceSessionId,
				turnIndex: thread.currentTurnIndex,
				kind: input.kind,
				content: input.content,
				transitionIntent: input.transitionIntent,
				artifactManifestIds: input.artifactManifestIds,
				createdAt: input.now,
			});

			insertReply(db, reply);

			if (reply.kind === "failure") {
				markWorkItemFailed(db, input.workItemId, input.now);
			} else {
				markWorkItemCompleted(db, input.workItemId, input.now);
			}

			if (reply.transitionIntent) {
				updateThreadState(
					db,
					input.threadId,
					reply.transitionIntent,
					input.now,
				);
				appendEvent(db, {
					version: brokerSchemaVersion,
					eventId: buildEventId("thread_transition", input.replyId, input.now),
					eventType: "thread.transitioned",
					collabId: input.collabId,
					workspaceRoot: collab.workspaceRoot,
					timestamp: input.now,
					payload: { status: reply.transitionIntent },
				});
			}

			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId("reply_posted", input.replyId, input.now),
				eventType: "reply.posted",
				collabId: input.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.now,
				payload: { status: reply.kind },
			});

			return reply;
		},
		attachArtifactManifest(input: {
			artifactManifestId: string;
			threadId: string;
			collabId: string;
			producedBySessionId: string;
			artifactCategory: "file_ref" | "diff" | "design_doc" | "plan_doc";
			entries: Array<{ path: string; kind: "file" | "diff" }>;
			summary: string;
			ownerType: "thread" | "work_item" | "reply";
			ownerId: string;
			now: string;
		}) {
			const manifest = artifactManifestSchema.parse({
				version: 1,
				artifactManifestId: input.artifactManifestId,
				threadId: input.threadId,
				collabId: input.collabId,
				producedBySessionId: input.producedBySessionId,
				artifactCategory: input.artifactCategory,
				entries: input.entries,
				summary: input.summary,
				createdAt: input.now,
			});

			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			insertArtifactManifest(db, manifest, {
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				attachedAt: input.now,
			});

			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId(
					"manifest_attached",
					input.artifactManifestId,
					input.now,
				),
				eventType: "artifact.manifest_attached",
				collabId: input.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.now,
				payload: { status: "attached" },
			});

			return manifest;
		},
		registerCompanion(input: {
			collabId: string;
			sessionId: string;
			provider: {
				providerId: string;
				toolFamily: string;
				providerVersion: string;
			};
			capabilities: {
				supportsDirectPackets: boolean;
				supportsNormalization: boolean;
				supportsRelayInterception: boolean;
				supportsLocalBuffering: boolean;
				supportsLaunchHooks: boolean;
				extensions: Record<string, unknown>;
			};
			now: string;
		}) {
			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			const sessions = listSessions(db, input.collabId);
			if (!sessions.some((s) => s.sessionId === input.sessionId)) {
				throw new Error(
					`Unknown session: ${input.sessionId} in collab ${input.collabId}`,
				);
			}

			companionRegistrationSchema.parse({
				version: 1,
				collabId: input.collabId,
				sessionId: input.sessionId,
				provider: providerIdentitySchema.parse(input.provider),
				capabilities: providerCapabilitiesSchema.parse(input.capabilities),
				registeredAt: input.now,
			});

			const existing = getCompanionSession(db, input.collabId, input.sessionId);
			if (existing) {
				return createCompanionAck({
					collabId: input.collabId,
					sessionId: input.sessionId,
					sessionSecret: existing.sessionSecret,
					acceptedAt: input.now,
				});
			}

			const sessionSecret = nanoid(24);

			insertCompanionSession(db, {
				collabId: input.collabId,
				sessionId: input.sessionId,
				providerJson: JSON.stringify(input.provider),
				capabilitiesJson: JSON.stringify(input.capabilities),
				sessionSecret,
				registeredAt: input.now,
			});

			return createCompanionAck({
				collabId: input.collabId,
				sessionId: input.sessionId,
				sessionSecret,
				acceptedAt: input.now,
			});
		},
		pollQueuedWorkItem(input: {
			collabId: string;
			sessionId: string;
			sessionSecret: string;
		}) {
			const registration = getCompanionSession(
				db,
				input.collabId,
				input.sessionId,
			);

			if (!registration || registration.sessionSecret !== input.sessionSecret) {
				throw new Error("Invalid companion session secret");
			}

			this.assertActiveBinding({
				collabId: input.collabId,
				sessionId: input.sessionId,
			});

			const threadRows = listThreadsForCollab(db, input.collabId);

			for (const thread of threadRows) {
				const workItems = listWorkItemsForThread(db, thread.threadId);
				const next = workItems.find(
					(workItem) =>
						workItem.targetSessionId === input.sessionId &&
						workItem.deliveryState === "queued",
				);

				if (next) {
					return next;
				}
			}

			return null;
		},
		recordCompanionHeartbeat(input: {
			collabId: string;
			sessionId: string;
			sessionSecret: string;
			healthState: "healthy" | "degraded" | "offline";
			now: string;
		}) {
			const registration = getCompanionSession(
				db,
				input.collabId,
				input.sessionId,
			);

			if (!registration || registration.sessionSecret !== input.sessionSecret) {
				throw new Error("Invalid companion session secret");
			}

			updateCompanionHeartbeat(db, {
				collabId: input.collabId,
				sessionId: input.sessionId,
				healthState: input.healthState,
				sentAt: input.now,
			});

			updateSessionHealth(db, input.sessionId, input.healthState, input.now);
		},
		getThread(threadId: string) {
			return getThread(db, threadId);
		},
		getWorkItem(workItemId: string) {
			return getWorkItem(db, workItemId);
		},
		listThreads(collabId: string) {
			return listThreadsForCollab(db, collabId);
		},
		listReplies(threadId: string) {
			return listRepliesForThread(db, threadId);
		},
		listUnconsumedReplies(input: {
			collabId: string;
			threadId: string;
			forSessionId: string;
		}) {
			return listUnconsumedRepliesForSession(db, input);
		},
		markRepliesConsumed(input: {
			replyIds: string[];
			consumedBySessionId: string;
		}) {
			markRepliesConsumedInDb(db, input);
		},
		listWorkItems(threadId: string) {
			return listWorkItemsForThread(db, threadId);
		},
		listSessions(collabId: string) {
			return listSessions(db, collabId);
		},
		listEventsForCollab(collabId: string) {
			return listEventsForCollab(db, collabId);
		},
		issueAttachClaim(input: {
			collabId: string;
			agentType: AgentType;
			mode: "attach" | "rebind" | "reconnect";
			targetMode?: "snippet_shell" | "adopt_current_tty" | "explicit_tty" | "mount_current_tty";
			targetTtyPath?: string | null;
			now: string;
			expiresAt: string;
		}) {
			const collab = getCollab(db, input.collabId);
			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			const claimId = `claim_${nanoid(16)}`;
			const secret = crypto.randomBytes(16).toString("hex");

			const claim = attachClaimSchema.parse({
				version: 1,
				claimId,
				collabId: input.collabId,
				agentType: input.agentType,
				mode: input.mode,
				targetMode: input.targetMode ?? "snippet_shell",
				targetTtyPath: input.targetTtyPath ?? null,
				secret,
				status: "pending",
				createdAt: input.now,
				expiresAt: input.expiresAt,
				consumedAt: null,
			});

			const txn = db.transaction(() => {
				// If there is already a pending claim on the binding, mark it replaced
				const existing = getSessionBinding(db, input.collabId, input.agentType);
				if (existing?.pendingClaimId) {
					markAttachClaimReplaced(db, existing.pendingClaimId);
				}

				insertAttachClaim(db, claim);

				// If rebind mode, preserve the existing active session but enter pending_attach state
				const existingSessionId = existing?.activeSessionId ?? null;
				const existingSource = existing?.bindingSource ?? null;

				upsertSessionBinding(
					db,
					sessionBindingSchema.parse({
						version: 1,
						collabId: input.collabId,
						agentType: input.agentType,
						bindingState: "pending_attach",
						activeSessionId: existingSessionId,
						bindingSource: existingSource,
						pendingClaimId: claimId,
						pendingClaimExpiresAt: input.expiresAt,
						updatedAt: input.now,
					}),
				);
			});

			txn.immediate();

			return claim;
		},
		completeAttachClaim(input: {
			claimId: string;
			secret: string;
			sessionId: string;
			provider: ProviderIdentity;
			capabilities: ProviderCapabilities;
			now: string;
			bindingSource: "launched" | "attached" | "adopted" | "mounted";
		}) {
			const claim = getAttachClaim(db, input.claimId);
			if (!claim) {
				throw new Error(`Unknown attach claim: ${input.claimId}`);
			}
			if (claim.status !== "pending") {
				throw new Error(
					`Attach claim ${input.claimId} has already been consumed (status: ${claim.status})`,
				);
			}
			if (input.now > claim.expiresAt) {
				throw new Error(`Attach claim ${input.claimId} has expired`);
			}
			if (claim.secret !== input.secret) {
				throw new Error("Invalid attach claim secret");
			}

			// Validate provider payload before mutating any state (finding 3 fix).
			const validatedProvider = providerIdentitySchema.parse(input.provider);
			const validatedCapabilities = providerCapabilitiesSchema.parse(input.capabilities);

			const txn = db.transaction(() => {
				// Register the session if it doesn't exist yet, or verify it belongs
				// to the same collab and agent role (finding 2 fix).
				const existing = getSession(db, input.sessionId);
				if (!existing) {
					const session = sessionSchema.parse({
						version: 1,
						sessionId: input.sessionId,
						collabId: claim.collabId,
						agentType: claim.agentType,
						registrationState: "registered",
						healthState: "healthy",
						capabilities: input.capabilities,
						registeredAt: input.now,
						lastSeenAt: input.now,
					});
					insertSession(db, session);
				} else {
					if (existing.collabId !== claim.collabId || existing.agentType !== claim.agentType) {
						throw new Error(
							`Session ${input.sessionId} belongs to collab ${existing.collabId} / ${existing.agentType}, ` +
							`not collab ${claim.collabId} / ${claim.agentType}.`,
						);
					}
				}

				// Update the binding to bound state
				upsertSessionBinding(
					db,
					sessionBindingSchema.parse({
						version: 1,
						collabId: claim.collabId,
						agentType: claim.agentType,
						bindingState: "bound",
						activeSessionId: input.sessionId,
						bindingSource: input.bindingSource,
						targetTtyPath: claim.targetTtyPath ?? null,
						pendingClaimId: null,
						pendingClaimExpiresAt: null,
						updatedAt: input.now,
					}),
				);

				// Mark the claim consumed
				markAttachClaimConsumed(db, input.claimId, input.now);
			});

			txn.immediate();

			return {
				sessionId: input.sessionId,
				collabId: claim.collabId,
				agentType: claim.agentType,
				provider: validatedProvider,
				capabilities: validatedCapabilities,
			};
		},
		listSessionBindings(collabId: string) {
			return listSessionBindingsForCollab(db, collabId);
		},
		listSessionAttachments(collabId: string): SessionAttachmentRecord[] {
			return listSessionAttachmentsByCollab(db, collabId);
		},
		resolveBoundSession(collabId: string, agentType: AgentType): string {
			const binding = getSessionBinding(db, collabId, agentType);
			// Accept both 'bound' and 'pending_attach' states if there is an active session.
			// During a rebind the old session remains authoritative until the claim is completed.
			if (!binding || !binding.activeSessionId) {
				throw new Error(
					`No bound session for collab ${collabId} / agentType ${agentType}`,
				);
			}
			return binding.activeSessionId;
		},
		setSessionBinding(input: {
			collabId: string;
			agentType: AgentType;
			sessionId: string;
			bindingSource: "launched" | "attached" | "adopted" | "mounted";
			targetTtyPath?: string | null;
			now: string;
		}) {
			upsertSessionBinding(
				db,
				sessionBindingSchema.parse({
					version: 1,
					collabId: input.collabId,
					agentType: input.agentType,
					bindingState: "bound",
					activeSessionId: input.sessionId,
					bindingSource: input.bindingSource,
					targetTtyPath: input.targetTtyPath ?? null,
					pendingClaimId: null,
					pendingClaimExpiresAt: null,
					updatedAt: input.now,
				}),
			);
		},
		prepareCollabRecovery(input: { collabId: string; now: string }) {
			db.transaction(() => {
				const bindings = listSessionBindingsForCollab(db, input.collabId);
				for (const binding of bindings) {
					if (binding.activeSessionId) {
						updateSessionHealth(db, binding.activeSessionId, "degraded", input.now);
					}
				}
				deleteCompanionSessionsForCollab(db, input.collabId);
				markWorkItemsRecoveryBlockedForCollab(db, input.collabId, input.now);
			}).immediate();

			return {
				bindings: listSessionBindingsForCollab(db, input.collabId),
			};
		},
		markSessionDegraded(input: { sessionId: string; now: string }) {
			updateSessionHealth(db, input.sessionId, "degraded", input.now);
		},
		assertActiveBinding(input: { collabId: string; sessionId: string }) {
			const session = getSession(db, input.sessionId);
			if (!session || session.collabId !== input.collabId) {
				throw new Error(
					`Unknown session: ${input.sessionId} in collab ${input.collabId}.`,
				);
			}

			const binding = getSessionBinding(db, input.collabId, session.agentType);
			// Accept both "bound" and "pending_attach" when this session is still activeSessionId.
			// During a rebind-in-flight, the old session remains authoritative until the new session
			// completes the claim.
			if (!binding || binding.activeSessionId !== input.sessionId) {
				throw new Error(
					`Session ${input.sessionId} is no longer the active binding for collab ${input.collabId}.`,
				);
			}
		},
		registerRelayMonitor(input: {
			collabId: string;
			monitorId: string;
			now: string;
		}) {
			const collab = getCollab(db, input.collabId);
			if (!collab) throw new Error(`Unknown collab: ${input.collabId}`);
			insertRelayMonitor(db, input);
		},
		heartbeatRelayMonitor(input: {
			collabId: string;
			monitorId: string;
			now: string;
		}) {
			const collab = getCollab(db, input.collabId);
			if (!collab) throw new Error(`Unknown collab: ${input.collabId}`);
			const changes = updateRelayMonitorHeartbeat(db, input);
			if (changes === 0) throw new Error(`Unknown relay monitor: ${input.monitorId}`);
		},
		isRelayMonitorConnected(collabId: string, now?: string): boolean {
			return queryIsRelayMonitorConnected(db, collabId, now);
		},
		appendRelayEvent(input: {
			collabId: string;
			eventType: RelayEvent["eventType"];
			senderAgent: string | null;
			receiverAgent: string | null;
			content: string;
			now: string;
		}) {
			insertRelayEvent(db, input);
		},
		pollRelayEvents(collabId: string, afterId: number): RelayEvent[] {
			return queryPollRelayEvents(db, collabId, afterId);
		},
		listRelayHandoffs(
			collabId: string,
			limit?: number,
			opts?: { workflowFilter?: RelayHandoffWorkflowFilter },
		): RelayHandoffLogRow[] {
			return listRelayHandoffsRepo(db, {
				collabId,
				...(typeof limit === "number" ? { limit } : {}),
				...(opts?.workflowFilter !== undefined
					? { workflowFilter: opts.workflowFilter }
					: {}),
			});
		},
		listActiveCollabSummaries(sinceMs: number, now?: string): CollabSummary[] {
			return listActiveCollabSummariesRepo(db, {
				sinceMs,
				...(now !== undefined ? { now } : {}),
			});
		},
		listAllWorkflowSummaries(sinceMs: number, now?: string): CollabSummary[] {
			return listAllWorkflowSummariesRepo(db, {
				sinceMs,
				...(now !== undefined ? { now } : {}),
			});
		},
		listRunCostRows(collabId: string, workflowId: string | null): RunCostRow[] {
			return listRunCostRowsRepo(db, { collabId, workflowId });
		},
		listWorkflowsForCollab(collabId: string): WorkflowSummaryRow[] {
			return listWorkflowsForCollabRepo(db, collabId);
		},
		getRelayTurnState(collabId: string, now?: string) {
			return queryRelayTurnState(db, collabId, now);
		},
		createRelayHandoff(input: {
			handoffId: string;
			collabId: string;
			senderAgent: AgentType;
			targetAgent: AgentType;
			requestText: string;
			now: string;
		}) {
			return createRelayHandoffTxn(db, input);
		},
		acceptRelayHandoff(input: { handoffId: string; acceptedAt: string }) {
			if (isWorkflowDeliverySuspended(input.handoffId)) return; // refuse delivery while paused
			return acceptRelayHandoffTxn(db, input);
		},
		deferRelayHandoff(input: { handoffId: string; deferredAt: string }) {
			return deferRelayHandoffTxn(db, input);
		},
		declineRelayHandoff(input: { handoffId: string; now: string }) {
			return declineRelayHandoffTxn(db, input);
		},
		markRelayHandoffStale(input: { handoffId: string; now: string }) {
			return markRelayHandoffStaleTxn(db, input);
		},
		handoffBackRelay(input: {
			handoffId: string;
			nextHandoffId?: string;
			senderAgent: AgentType;
			targetAgent: AgentType;
			requestText: string;
			captureStatus?: "ok" | "no_response_captured_confidently" | "no_response_captured" | null;
			now: string;
		}) {
			// Recording ALWAYS proceeds (spec §3): an in-flight turn's handback must be
			// persisted even while paused so the workflow can reach the quiesce boundary.
			const result = handoffBackRelayTxn(db, input);
			// If this completed the last in-flight turn of a paused workflow, we are now
			// at the quiesce boundary → capture the snapshot synchronously (durable before
			// return, so a resume right after still sees the ref). Orchestration of this
			// handback stays deferred because the pending list excludes paused workflows.
			const meta = workflowControl.getHandoffWithWorkflowMeta(input.handoffId);
			if (meta?.workflowId && workflowControl.getWorkflow(meta.workflowId)?.status === "paused") {
				workflowControl.maybeCaptureQuiesceSnapshot({ workflowId: meta.workflowId, now: input.now });
			}
			return result;
		},
		failRelayHandoffOnDisconnect(input: { handoffId: string; now: string }) {
			return failRelayHandoffOnDisconnectTxn(db, input);
		},
		getRelayHandoff(handoffId: string) {
			return queryRelayHandoff(db, handoffId);
		},
		getLatestHandedBackHandoff(collabId: string) {
			return queryLatestHandedBackHandoff(db, collabId);
		},
		claimRelayHandoffForOrchestration(input: { handoffId: string; claimedAt: string }) {
			// Re-check inside the wrapper so the list→claim race is closed even if a
			// workflow is paused between the orchestrator's list and its claim.
			if (isWorkflowDeliverySuspended(input.handoffId)) return null;
			return claimRelayHandoffForOrchestrationTxn(db, input);
		},
		listRelayHandoffsPendingOrchestration(collabId: string) {
			return listRelayHandoffsPendingOrchestration(db, collabId);
		},
		createLoopRelayHandoff(input: {
			handoffId: string;
			nextHandoffId: string;
			requestText: string;
			reason: string;
			now: string;
		}) {
			return createLoopRelayHandoffTxn(db, input);
		},
		resolveRelayChain(input: { handoffId: string; reason: string; evaluatedAt: string }) {
			return resolveRelayChainTxn(db, input);
		},
		markRelayChainEscalated(input: { handoffId: string; reason: string; evaluatedAt: string }) {
			return markRelayChainEscalatedTxn(db, input);
		},
		markRelayChainAbandoned(input: { handoffId: string; reason: string; evaluatedAt: string }) {
			return markRelayChainAbandonedTxn(db, input);
		},
		recordCaptureDiagnostic(input: {
			handoffId: string;
			collabId: string;
			chainId: string | null;
			workflowId: string | null;
			targetProvider: AgentType;
			captureStatus: "ok" | "no_response_captured_confidently" | "no_response_captured";
			clipLen: number;
			turnLen: number;
			turnConfidence: "high" | "low";
			jaccardScore: number | null;
			containmentScore: number | null;
			clipSample: string | null;
			turnSample: string | null;
			abortedByRaceGuard: boolean;
			interferenceDetected?: boolean;
			now: string;
		}): { captureId: string } {
			const captureId = `capture_${input.now.replace(/[^0-9]/g, "")}_${input.handoffId.slice(-8)}`;
			insertCaptureDiagnostic(db, {
				captureId,
				handoffId: input.handoffId,
				collabId: input.collabId,
				chainId: input.chainId,
				workflowId: input.workflowId,
				targetProvider: input.targetProvider,
				captureStatus: input.captureStatus,
				clipLen: input.clipLen,
				turnLen: input.turnLen,
				turnConfidence: input.turnConfidence,
				jaccardScore: input.jaccardScore,
				containmentScore: input.containmentScore,
				clipSample: input.clipSample,
				turnSample: input.turnSample,
				abortedByRaceGuard: input.abortedByRaceGuard,
				interferenceDetected: input.interferenceDetected ?? false,
				createdAt: input.now,
			});
			return { captureId };
		},
		listCaptureDiagnosticsByCollab(
			collabId: string,
			limit: number | null,
			opts?: { workflowFilter?: CaptureDiagnosticsWorkflowFilter },
		): RelayCaptureDiagnosticRecord[] {
			return queryListCaptureDiagnosticsByCollab(db, collabId, limit, opts);
		},
		listCaptureDiagnosticsByCollabAndChain(
			collabId: string,
			chainId: string,
			limit: number | null,
		): RelayCaptureDiagnosticRecord[] {
			return queryListCaptureDiagnosticsByCollabAndChain(db, collabId, chainId, limit);
		},
		listCaptureDiagnosticsByHandoff(
			handoffId: string,
		): RelayCaptureDiagnosticRecord[] {
			return queryListCaptureDiagnosticsByHandoff(db, handoffId);
		},
		sweepCaptureDiagnostics(input: { cutoffIso: string }): number {
			return deleteCaptureDiagnosticsOlderThan(db, input.cutoffIso);
		},
		recordEvaluatorDiagnostic(input: {
			handoffId: string;
			collabId: string;
			chainId: string | null;
			workflowId: string | null;
			phaseRunId: string | null;
			evaluatorBranch: "legacy" | "review" | "delivered" | "execution";
			evaluatorPromptKey: "review-loop" | "ralph-loop" | "execution-gate" | "deliberation-loop" | null;
			handoffStep: "review" | "fix" | "implement" | "execute" | null;
			attemptKind: "primary" | "fallback";
			callGroupId: string;
			provider: "anthropic" | "ollama" | "openai" | "agent-cli";
			outcome: "ok" | "parse_error" | "validation_error" | "provider_unavailable" | "unknown_error";
			verdict: string | null;
			confidence: number | null;
			reason: string | null;
			followUpMessageLen: number | null;
			latencyMs: number;
			errorMessage: string | null;
			inputTokens: number | null;
			outputTokens: number | null;
			promptSample: string | null;
			responseSample: string | null;
			now: string;
		}): { evaluatorId: string } {
			const randomSuffix = crypto.randomUUID().slice(0, 8);
			const evaluatorId = `eval_${input.now.replace(/[^0-9]/g, "")}_${randomSuffix}`;
			insertEvaluatorDiagnostic(db, {
				evaluatorId,
				handoffId: input.handoffId,
				collabId: input.collabId,
				chainId: input.chainId,
				workflowId: input.workflowId,
				phaseRunId: input.phaseRunId,
				evaluatorBranch: input.evaluatorBranch,
				evaluatorPromptKey: input.evaluatorPromptKey,
				handoffStep: input.handoffStep,
				attemptKind: input.attemptKind,
				callGroupId: input.callGroupId,
				provider: input.provider,
				outcome: input.outcome,
				verdict: input.verdict,
				confidence: input.confidence,
				reason: input.reason,
				followUpMessageLen: input.followUpMessageLen,
				latencyMs: input.latencyMs,
				errorMessage: input.errorMessage,
				inputTokens: input.inputTokens,
				outputTokens: input.outputTokens,
				promptSample: input.promptSample,
				responseSample: input.responseSample,
				createdAt: input.now,
			});
			return { evaluatorId };
		},
		listEvaluatorDiagnosticsByCollab(
			collabId: string,
			limit: number | null,
			opts?: { workflowFilter?: EvaluatorDiagnosticsWorkflowFilter },
		): RelayEvaluatorDiagnosticRecord[] {
			return queryListEvaluatorDiagnosticsByCollab(db, collabId, limit, opts);
		},
		listEvaluatorDiagnosticsByCollabAndChain(
			collabId: string,
			chainId: string,
			limit: number | null,
		): RelayEvaluatorDiagnosticRecord[] {
			return queryListEvaluatorDiagnosticsByCollabAndChain(db, collabId, chainId, limit);
		},
		listEvaluatorDiagnosticsByHandoff(handoffId: string): RelayEvaluatorDiagnosticRecord[] {
			return queryListEvaluatorDiagnosticsByHandoff(db, handoffId);
		},
		sweepEvaluatorDiagnostics(input: { cutoffIso: string }): number {
			return deleteEvaluatorDiagnosticsOlderThan(db, input.cutoffIso);
		},
		recordTurnEventDiagnostic(input: {
			receivedAt: string;
			provider: AgentType;
			workspaceId: string;
			cwd: string;
			sessionOrThreadId: string | null;
			turnId: string | null;
			workflowActive: boolean;
			collabId: string | null;
			workflowId: string | null;
			chainId: string | null;
			handoffId: string | null;
			inputCorrelated: boolean | null;
			containmentScore: number | null;
			fidelityVerdict: TurnEventFidelityVerdict;
			deferCount: number;
			action: TurnEventAction;
			messageLen: number;
			messageSample: string | null;
		}): { eventId: string } {
			return insertTurnEventDiagnostic(db, input);
		},
		listTurnEventDiagnosticsByCollab(
			collabId: string,
			limit: number | null,
		): RelayTurnEventDiagnosticRecord[] {
			return queryListTurnEventDiagnosticsByCollab(db, collabId, limit);
		},
		sweepTurnEventDiagnostics(input: { cutoffIso: string }): number {
			return deleteTurnEventDiagnosticsOlderThan(db, input.cutoffIso);
		},
		cleanupOrchestration(input: { collabId: string; reason: string; now: string }) {
			return cleanupOrchestrationOnShutdownTxn(db, input);
		},
	}, workflowControl);
}
