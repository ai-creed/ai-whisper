import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	getDuoAssignment,
	insertBrokerDaemon,
	insertDuoRoll,
	listDuoAssignments,
	openDatabase,
	upsertDuoAssignment,
	upsertRecoveryState,
	upsertSessionAttachment,
	upsertWorkspace,
} from "@ai-whisper/broker";
import { runCollabMount } from "../packages/cli/src/commands/collab/mount.ts";
import {
	createMountSessionRuntime,
	resolveTeammateCharacterFromAssignments,
} from "../packages/cli/src/runtime/mount-session-main.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import {
	canonicalWorkspaceRoot,
	workspaceIdFromPath,
} from "../packages/cli/src/runtime/workspace-id.ts";
import { getCharacter } from "../packages/cli/src/duo/duo-table.ts";
import { loadCharacterArt } from "../packages/cli/src/duo/art-assets.ts";

const RESET = "\x1b[0m";

function tempStateRoot(): string {
	return mkdtempSync(join(tmpdir(), "aiw-mount-duo-"));
}

/** Seed an active collab + broker_daemon + recovery row directly in the shared
 * DB so runCollabMount's tryResolve() succeeds without spawning a real daemon.
 * Mirrors test/collab-mount-passthrough-args.test.ts. */
function seedActiveCollab(workspaceRoot: string): string {
	const now = new Date().toISOString();
	const workspaceId = workspaceIdFromPath(workspaceRoot);
	const canonical = canonicalWorkspaceRoot(workspaceRoot);
	const collabId = `collab_${now.replace(/[^0-9]/g, "")}_seed`;
	const db = openDatabase(getSharedSqlitePath());
	try {
		applyMigrations(db);
		upsertWorkspace(db, { id: workspaceId, workspaceRoot: canonical, now });
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at, orchestrator_enabled, orchestrator_max_rounds) VALUES (?, ?, ?, 'active', ?, 'none', NULL, ?, ?, 1, 3)",
		).run(collabId, canonical, "ws-seed", workspaceId, now, now);
		insertBrokerDaemon(db, {
			collabId,
			host: "127.0.0.1",
			port: 4734,
			startedAt: now,
			lastHeartbeatAt: now,
		});
		db.prepare("UPDATE broker_daemon SET pid = ? WHERE collab_id = ?").run(
			process.pid,
			collabId,
		);
		upsertRecoveryState(db, {
			collabId,
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		});
	} finally {
		db.close();
	}
	return collabId;
}

/** Seed a "bound" session_binding for an agent (what completeAttachClaim leaves). */
function seedBoundBinding(collabId: string, agentType: string): void {
	const now = new Date().toISOString();
	const db = openDatabase(getSharedSqlitePath());
	try {
		db.prepare(
			`INSERT INTO session_binding
				(collab_id, agent_type, binding_state, active_session_id, binding_source,
				 target_tty_path, pending_claim_id, pending_claim_expires_at, updated_at)
			VALUES (?, ?, 'bound', ?, 'mounted', NULL, NULL, NULL, ?)`,
		).run(collabId, agentType, `session_${agentType}_seed`, now);
	} finally {
		db.close();
	}
}

/** Seed a mounted session_attachment for an agent with a chosen pid. */
function seedMountedAttachment(
	collabId: string,
	agentType: "claude" | "codex" | "ezio" | "agy",
	pid: number,
): void {
	const now = new Date().toISOString();
	const db = openDatabase(getSharedSqlitePath());
	try {
		upsertSessionAttachment(db, {
			collabId,
			agentType,
			attachmentKind: "mounted",
			sessionId: `session_${agentType}_seed`,
			providerId: null,
			launchMode: null,
			ttyPath: "/dev/ttys001",
			pid,
			windowLabel: null,
			attachedAt: now,
		});
	} finally {
		db.close();
	}
}

const okBroker = async () =>
	({ pidAlive: true, httpReachable: true, ok: true }) as never;

function fakeBannerOut(columns: number, rows: number): {
	stream: NodeJS.WriteStream;
	writes: string[];
} {
	const writes: string[] = [];
	const stream = {
		write: (chunk: string) => {
			writes.push(chunk);
			return true;
		},
		columns,
		rows,
	} as unknown as NodeJS.WriteStream;
	return { stream, writes };
}

describe("runCollabMount duo banner (pre-spawn claim)", () => {
	let prevStateRoot: string | undefined;
	let prevDuo: string | undefined;
	let prevCharacter: string | undefined;
	let prevCharacterRole: string | undefined;

	beforeEach(() => {
		prevStateRoot = process.env.AI_WHISPER_STATE_ROOT;
		prevDuo = process.env.AI_WHISPER_DUO;
		prevCharacter = process.env.AI_WHISPER_CHARACTER;
		prevCharacterRole = process.env.AI_WHISPER_CHARACTER_ROLE;
		delete process.env.AI_WHISPER_DUO;
		delete process.env.AI_WHISPER_CHARACTER;
		delete process.env.AI_WHISPER_CHARACTER_ROLE;
	});

	afterEach(() => {
		if (prevStateRoot === undefined) delete process.env.AI_WHISPER_STATE_ROOT;
		else process.env.AI_WHISPER_STATE_ROOT = prevStateRoot;
		if (prevDuo === undefined) delete process.env.AI_WHISPER_DUO;
		else process.env.AI_WHISPER_DUO = prevDuo;
		if (prevCharacter === undefined) delete process.env.AI_WHISPER_CHARACTER;
		else process.env.AI_WHISPER_CHARACTER = prevCharacter;
		if (prevCharacterRole === undefined) delete process.env.AI_WHISPER_CHARACTER_ROLE;
		else process.env.AI_WHISPER_CHARACTER_ROLE = prevCharacterRole;
	});

	it("duo-enabled mount draws the art banner, pushes exactly rows newlines, and claims a character", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws-enabled");
		mkdirSync(workspaceRoot, { recursive: true });
		const collabId = seedActiveCollab(workspaceRoot);

		const { stream, writes } = fakeBannerOut(1000, 5);
		let capturedCharacterEnv: string | undefined;
		let capturedCharacterRoleEnv: string | undefined;
		const fakeRuntime = {
			start: vi.fn(async () => {
				// Env stamps are documented to land BEFORE runtime.start() — capture
				// inside the stub so the assertion proves ordering, not just presence.
				capturedCharacterEnv = process.env.AI_WHISPER_CHARACTER;
				capturedCharacterRoleEnv = process.env.AI_WHISPER_CHARACTER_ROLE;
			}),
		};

		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: okBroker,
			sleep: async () => {},
			bannerOut: stream,
		});

		expect(fakeRuntime.start).toHaveBeenCalledTimes(1);

		const db = openDatabase(getSharedSqlitePath());
		let rows;
		try {
			rows = listDuoAssignments(db, collabId);
		} finally {
			db.close();
		}
		expect(rows.length).toBe(1);
		const assignment = rows[0]!;
		expect(assignment.agentType).toBe("codex");

		const character = getCharacter(assignment.duoId, assignment.characterId)!;
		const banner = writes[0]!;
		expect(banner).toContain(
			`⚡ Summoning ${character.summonName} as ${assignment.role}...`,
		);
		expect(banner).toContain(`"${character.punchline}"`);
		expect(banner).toContain(loadCharacterArt(character.artFile));
		expect(banner.endsWith(`${RESET}\n`)).toBe(true);
		// Scrollback push: exactly `rows` newlines written AFTER the banner.
		expect(writes[writes.length - 1]).toBe("\n".repeat(5));

		// Env stamps: raw assignment fields (characterName/role), set before start().
		expect(capturedCharacterEnv).toBe(assignment.characterName);
		expect(capturedCharacterRoleEnv).toBe(assignment.role);
	});

	it("--no-duo mount writes no banner and claims nothing", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws-noduo");
		mkdirSync(workspaceRoot, { recursive: true });
		const collabId = seedActiveCollab(workspaceRoot);

		const { stream, writes } = fakeBannerOut(1000, 5);
		let capturedCharacterEnv: string | undefined;
		let capturedCharacterRoleEnv: string | undefined;
		const fakeRuntime = {
			start: vi.fn(async () => {
				capturedCharacterEnv = process.env.AI_WHISPER_CHARACTER;
				capturedCharacterRoleEnv = process.env.AI_WHISPER_CHARACTER_ROLE;
			}),
		};

		await runCollabMount({
			workspaceRoot,
			target: "codex",
			duoFlag: false,
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: okBroker,
			sleep: async () => {},
			bannerOut: stream,
		});

		expect(fakeRuntime.start).toHaveBeenCalledTimes(1);
		expect(writes).toEqual([]);
		expect(capturedCharacterEnv).toBeUndefined();
		expect(capturedCharacterRoleEnv).toBeUndefined();

		const db = openDatabase(getSharedSqlitePath());
		try {
			expect(listDuoAssignments(db, collabId)).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("AI_WHISPER_DUO=off behaves like --no-duo", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		process.env.AI_WHISPER_DUO = "off";
		const workspaceRoot = join(stateRoot, "ws-envoff");
		mkdirSync(workspaceRoot, { recursive: true });
		const collabId = seedActiveCollab(workspaceRoot);

		const { stream, writes } = fakeBannerOut(1000, 5);
		const fakeRuntime = { start: vi.fn(async () => undefined) };

		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: okBroker,
			sleep: async () => {},
			bannerOut: stream,
		});

		expect(writes).toEqual([]);
		const db = openDatabase(getSharedSqlitePath());
		try {
			expect(listDuoAssignments(db, collabId)).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("fallback outcome (both slots live) draws the vendor banner and claims no new row", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws-fallback");
		mkdirSync(workspaceRoot, { recursive: true });
		const collabId = seedActiveCollab(workspaceRoot);

		// Pre-seed both slots claimed by codex + claude with LIVE owners so the
		// third mount (agy) can neither claim nor inherit -> vendor fallback.
		const now = new Date().toISOString();
		const db0 = openDatabase(getSharedSqlitePath());
		try {
			insertDuoRoll(db0, {
				collabId,
				duoId: "batman-robin",
				slots: [
					{ characterId: "batman", characterName: "Batman", role: "reviewer" },
					{ characterId: "robin", characterName: "Robin", role: "implementer" },
				],
				rolledAt: now,
			});
			upsertDuoAssignment(db0, {
				collabId,
				agentType: "codex",
				duoId: "batman-robin",
				characterId: "batman",
				characterName: "Batman",
				role: "reviewer",
				assignedAt: now,
			});
			upsertDuoAssignment(db0, {
				collabId,
				agentType: "claude",
				duoId: "batman-robin",
				characterId: "robin",
				characterName: "Robin",
				role: "implementer",
				assignedAt: now,
			});
		} finally {
			db0.close();
		}
		seedMountedAttachment(collabId, "codex", process.pid);
		seedMountedAttachment(collabId, "claude", process.pid);

		const { stream, writes } = fakeBannerOut(1000, 4);
		let capturedCharacterEnv: string | undefined;
		let capturedCharacterRoleEnv: string | undefined;
		const fakeRuntime = {
			start: vi.fn(async () => {
				capturedCharacterEnv = process.env.AI_WHISPER_CHARACTER;
				capturedCharacterRoleEnv = process.env.AI_WHISPER_CHARACTER_ROLE;
			}),
		};

		await runCollabMount({
			workspaceRoot,
			target: "agy",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: okBroker,
			sleep: async () => {},
			bannerOut: stream,
		});

		const banner = writes[0]!;
		expect(banner).toContain("⚡ Summoning Agy...");
		expect(banner).not.toContain(" as ");
		expect(banner.endsWith(`${RESET}\n`)).toBe(true);
		// Scrollback push still applied uniformly for the fallback banner.
		expect(writes[writes.length - 1]).toBe("\n".repeat(4));
		// Fallback (no assignment) must NOT stamp the persona env vars.
		expect(capturedCharacterEnv).toBeUndefined();
		expect(capturedCharacterRoleEnv).toBeUndefined();

		const db = openDatabase(getSharedSqlitePath());
		try {
			const rows = listDuoAssignments(db, collabId);
			expect(rows.map((r) => r.agentType).sort()).toEqual(["claude", "codex"]);
			expect(getDuoAssignment(db, collabId, "agy")).toBeNull();
		} finally {
			db.close();
		}
	});

	it("duo-enabled mount that fails before issueAttachClaim (live-owner conflict) claims nothing", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws-preclaim");
		mkdirSync(workspaceRoot, { recursive: true });
		const collabId = seedActiveCollab(workspaceRoot);
		seedBoundBinding(collabId, "codex");
		seedMountedAttachment(collabId, "codex", process.pid);

		const { stream, writes } = fakeBannerOut(1000, 5);
		const fakeRuntime = { start: vi.fn(async () => undefined) };

		await expect(
			runCollabMount({
				workspaceRoot,
				target: "codex",
				now: new Date().toISOString(),
				resolveCurrentTty: () => "/dev/null",
				createRuntime: () => fakeRuntime as never,
				assessBroker: okBroker,
				isPidAlive: () => true,
				sleep: async () => {},
				bannerOut: stream,
			}),
		).rejects.toThrow(/already bound/);

		expect(fakeRuntime.start).not.toHaveBeenCalled();
		expect(writes).toEqual([]);
		const db = openDatabase(getSharedSqlitePath());
		try {
			expect(listDuoAssignments(db, collabId)).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("--no-duo mount that fails before the attach claim leaves a pre-seeded assignment row untouched", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws-release-a");
		mkdirSync(workspaceRoot, { recursive: true });
		const collabId = seedActiveCollab(workspaceRoot);
		seedBoundBinding(collabId, "codex");
		seedMountedAttachment(collabId, "codex", process.pid);

		// A stale prior assignment for codex that must survive the aborted mount.
		const now = new Date().toISOString();
		const db0 = openDatabase(getSharedSqlitePath());
		try {
			upsertDuoAssignment(db0, {
				collabId,
				agentType: "codex",
				duoId: "walter-jesse",
				characterId: "walter",
				characterName: "Walter White",
				role: "reviewer",
				assignedAt: now,
			});
		} finally {
			db0.close();
		}

		const fakeRuntime = { start: vi.fn(async () => undefined) };
		await expect(
			runCollabMount({
				workspaceRoot,
				target: "codex",
				duoFlag: false,
				now: new Date().toISOString(),
				resolveCurrentTty: () => "/dev/null",
				createRuntime: () => fakeRuntime as never,
				assessBroker: okBroker,
				isPidAlive: () => true,
			}),
		).rejects.toThrow(/already bound/);

		expect(fakeRuntime.start).not.toHaveBeenCalled();
		const db = openDatabase(getSharedSqlitePath());
		try {
			expect(getDuoAssignment(db, collabId, "codex")).not.toBeNull();
		} finally {
			db.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Release timing (post-binding opt-out) exercised at the createMountSessionRuntime
// level per the brief's allowance — a stubbed liveSession + real (temp) shared DB.
// ---------------------------------------------------------------------------

function seedSharedMigrated(): void {
	const db = openDatabase(getSharedSqlitePath());
	try {
		applyMigrations(db);
	} finally {
		db.close();
	}
}

function baseRuntimeInput(overrides: {
	collabId: string;
	liveStart: () => Promise<void>;
	duoDisabled: boolean;
	/** Test seam: pick the visible-target provider (affects the persona-brief
	 *  submit strategy — "claude" is a fixed 75ms delay, "codex" defaults to a
	 *  per-character keystream, so tests use "claude" to stay fast). */
	target?: "codex" | "claude";
	/** Test seam: captures raw writeUserInput calls (persona-brief injection
	 *  writes the brief text then "\r" through this same seam). */
	writeUserInput?: (data: string) => void;
	/** Test seam: the session-start persona-carry input (Task 4). */
	duo?: {
		character: string;
		role: "reviewer" | "implementer";
		teammate: { agentType: string; character: string | null } | null;
	};
}) {
	return {
		target: overrides.target ?? ("codex" as const),
		ttyPath: "/dev/ttys031",
		workspaceRoot: "/tmp/workspace-duo-release",
		claimId: "claim_duo_release",
		secret: "secret_duo_release",
		duoDisabled: overrides.duoDisabled,
		duo: overrides.duo,
		broker: {
			control: {
				completeAttachClaim: vi.fn(() => ({
					collabId: overrides.collabId,
					sessionId: "session_codex_release",
					agentType: "codex",
				})),
				listSessionBindings: () => [],
				listSessions: () => [],
				markSessionDegraded: vi.fn(),
				getRelayTurnState: () => ({
					collabId: overrides.collabId,
					turnOwner: "none" as const,
					waitingAgent: null,
					unresolvedHandoffId: null,
					handoffState: "idle" as const,
					handoffAgeMs: null,
				}),
				getRelayHandoff: () => null,
			},
			stop: () => Promise.resolve(),
		} as never,
		createInteractiveSession: () => ({
			start: () => Promise.resolve(),
			stop: () => Promise.resolve(),
			writeUserInput: overrides.writeUserInput ?? (() => {}),
			sendLocalMessage() {},
			onExit() {},
		}),
		createLiveSession: () =>
			({ start: overrides.liveStart, stop: () => Promise.resolve() }) as never,
		createProvider: () => ({
			getIdentity: () => ({
				providerId: "codex-cli",
				toolFamily: "codex",
				providerVersion: "1.0.0",
			}),
			getCapabilities: () => ({
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			}),
			getHealthState: () => "healthy" as const,
			handleWork: () =>
				Promise.resolve({
					kind: "answer" as const,
					content: "ok",
					transitionIntent: null,
				}),
		}),
		runLoop: () => Promise.resolve(async () => {}),
	};
}

describe("createMountSessionRuntime duo opt-out release (post-binding)", () => {
	let prevStateRoot: string | undefined;

	beforeEach(() => {
		prevStateRoot = process.env.AI_WHISPER_STATE_ROOT;
	});

	afterEach(() => {
		if (prevStateRoot === undefined) delete process.env.AI_WHISPER_STATE_ROOT;
		else process.env.AI_WHISPER_STATE_ROOT = prevStateRoot;
	});

	it("(b) leaves the assignment row untouched when the live session never binds", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		seedSharedMigrated();
		const collabId = "collab_duo_release_b";
		const db0 = openDatabase(getSharedSqlitePath());
		try {
			upsertDuoAssignment(db0, {
				collabId,
				agentType: "codex",
				duoId: "walter-jesse",
				characterId: "walter",
				characterName: "Walter White",
				role: "reviewer",
				assignedAt: new Date().toISOString(),
			});
		} finally {
			db0.close();
		}

		const runtime = createMountSessionRuntime(
			baseRuntimeInput({
				collabId,
				duoDisabled: true,
				liveStart: () => Promise.reject(new Error("provider failed to launch")),
			}) as never,
		);

		await expect(runtime.start()).rejects.toThrow("provider failed to launch");

		const db = openDatabase(getSharedSqlitePath());
		try {
			expect(getDuoAssignment(db, collabId, "codex")).not.toBeNull();
		} finally {
			db.close();
		}
	});

	it("(c) deletes the assignment row once the mount is genuinely bound", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		seedSharedMigrated();
		const collabId = "collab_duo_release_c";
		const db0 = openDatabase(getSharedSqlitePath());
		try {
			upsertDuoAssignment(db0, {
				collabId,
				agentType: "codex",
				duoId: "walter-jesse",
				characterId: "walter",
				characterName: "Walter White",
				role: "reviewer",
				assignedAt: new Date().toISOString(),
			});
		} finally {
			db0.close();
		}

		const runtime = createMountSessionRuntime(
			baseRuntimeInput({
				collabId,
				duoDisabled: true,
				liveStart: () => Promise.resolve(),
			}) as never,
		);

		await runtime.start();

		const db = openDatabase(getSharedSqlitePath());
		try {
			expect(getDuoAssignment(db, collabId, "codex")).toBeNull();
		} finally {
			db.close();
		}
	});

	it("does NOT delete the assignment row for a duo-enabled (not disabled) bound mount", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		seedSharedMigrated();
		const collabId = "collab_duo_release_enabled";
		const db0 = openDatabase(getSharedSqlitePath());
		try {
			upsertDuoAssignment(db0, {
				collabId,
				agentType: "codex",
				duoId: "walter-jesse",
				characterId: "walter",
				characterName: "Walter White",
				role: "reviewer",
				assignedAt: new Date().toISOString(),
			});
		} finally {
			db0.close();
		}

		const runtime = createMountSessionRuntime(
			baseRuntimeInput({
				collabId,
				duoDisabled: false,
				liveStart: () => Promise.resolve(),
			}) as never,
		);

		await runtime.start();

		const db = openDatabase(getSharedSqlitePath());
		try {
			expect(getDuoAssignment(db, collabId, "codex")).not.toBeNull();
		} finally {
			db.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Session-start persona brief (Task 4). Injected exactly once, post-binding,
// via the runtime's existing injected-input machinery (writeUserInput on the
// stubbed interactive session — the same seam relay handoffs write through).
// ---------------------------------------------------------------------------

describe("createMountSessionRuntime duo persona brief (post-binding)", () => {
	let prevStateRoot: string | undefined;

	beforeEach(() => {
		prevStateRoot = process.env.AI_WHISPER_STATE_ROOT;
	});

	afterEach(() => {
		if (prevStateRoot === undefined) delete process.env.AI_WHISPER_STATE_ROOT;
		else process.env.AI_WHISPER_STATE_ROOT = prevStateRoot;
	});

	it("injects the pinned brief exactly once (write + submit), ≤ 3 lines", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		seedSharedMigrated();
		const collabId = "collab_duo_brief_a";
		const writeUserInput = vi.fn();

		const runtime = createMountSessionRuntime(
			baseRuntimeInput({
				collabId,
				duoDisabled: false,
				liveStart: () => Promise.resolve(),
				target: "claude",
				writeUserInput,
				duo: {
					character: "HEISENBERG",
					role: "implementer",
					teammate: { agentType: "claude", character: "JESSE" },
				},
			}) as never,
		);

		await runtime.start();

		// Claude's submit strategy is exactly two writes: full text, then "\r".
		// Exactly two calls total proves the brief is injected exactly once.
		expect(writeUserInput).toHaveBeenCalledTimes(2);
		const briefText = writeUserInput.mock.calls[0]?.[0] as string;
		expect(writeUserInput.mock.calls[1]?.[0]).toBe("\r");

		const lines = briefText.split("\n");
		expect(lines.length).toBeLessThanOrEqual(3);
		expect(lines[0]).toBe(
			"[ai-whisper duo] For this collab session you are HEISENBERG — the implementer of this duo. Your teammate claude is JESSE, the reviewer.",
		);
		expect(lines[1]).toBe(
			"Stay in character in conversational prose only — never in code, commit messages, PR text, or file contents, and never alter workflow verdict labels.",
		);
	});

	it("does NOT inject when duoDisabled is true", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		seedSharedMigrated();
		const collabId = "collab_duo_brief_b";
		const writeUserInput = vi.fn();

		const runtime = createMountSessionRuntime(
			baseRuntimeInput({
				collabId,
				duoDisabled: true,
				liveStart: () => Promise.resolve(),
				target: "claude",
				writeUserInput,
			}) as never,
		);

		await runtime.start();

		expect(writeUserInput).not.toHaveBeenCalled();
	});

	it("does NOT inject when neither duo nor duoDisabled is set", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		seedSharedMigrated();
		const collabId = "collab_duo_brief_c";
		const writeUserInput = vi.fn();

		const runtime = createMountSessionRuntime(
			baseRuntimeInput({
				collabId,
				duoDisabled: false,
				liveStart: () => Promise.resolve(),
				target: "claude",
				writeUserInput,
			}) as never,
		);

		await runtime.start();

		expect(writeUserInput).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Pure resolver used by the per-handoff teammate freshness re-read (Task 4):
// given a fresh list of duo_assignment rows, resolve the summonName claimed
// by a specific agentType, or null when that agent has not claimed one.
// ---------------------------------------------------------------------------

describe("resolveTeammateCharacterFromAssignments", () => {
	it("resolves the summonName for the matching agentType", () => {
		expect(
			resolveTeammateCharacterFromAssignments(
				[
					{
						collabId: "c1",
						agentType: "claude",
						duoId: "walter-jesse",
						characterId: "jesse",
						characterName: "Jesse Pinkman",
						role: "reviewer",
						assignedAt: "2026-07-02T00:00:00.000Z",
					},
				],
				"claude",
			),
		).toBe("JESSE");
	});

	it("returns null when no row matches the agentType", () => {
		expect(
			resolveTeammateCharacterFromAssignments(
				[
					{
						collabId: "c1",
						agentType: "codex",
						duoId: "walter-jesse",
						characterId: "walter",
						characterName: "Walter White",
						role: "implementer",
						assignedAt: "2026-07-02T00:00:00.000Z",
					},
				],
				"claude",
			),
		).toBeNull();
	});
});
