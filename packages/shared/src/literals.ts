export const brokerHealthStates = ["healthy", "degraded", "offline"] as const;
export const eventTypes = [
	"broker.started",
	"broker.stopped",
	"collab.started",
	"session.registered",
	"thread.created",
	"workitem.queued",
	"workitem.delivered",
	"reply.posted",
	"thread.transitioned",
	"artifact.manifest_attached",
] as const;
export const threadStates = [
	"created",
	"in_progress",
	"awaiting_user",
	"completed",
	"failed",
] as const;
export const collabStates = ["active", "stopped"] as const;
export const agentTypes = ["codex", "claude", "ezio", "agy", "cursor"] as const;
export type AgentType = (typeof agentTypes)[number];
export const sessionRegistrationStates = ["registered"] as const;
export const workItemStates = [
	"queued",
	"delivered",
	"completed",
	"failed",
	"recovery_blocked",
] as const;
export const requestedActions = [
	"review_plan",
	"implement_plan",
	"review_diff",
	"validate_against_plan",
	"answer_question",
	"request_clarification",
] as const;
export const replyKinds = [
	"answer",
	"review",
	"clarification",
	"failure",
] as const;
export const transitionIntents = [
	"in_progress",
	"awaiting_user",
	"completed",
	"failed",
] as const;
export const artifactCategories = [
	"file_ref",
	"diff",
	"design_doc",
	"plan_doc",
] as const;
export const bindingSources = ["launched", "attached", "adopted", "mounted"] as const;
export const attachTargetModes = [
	"snippet_shell",
	"adopt_current_tty",
	"explicit_tty",
	"mount_current_tty",
] as const;
