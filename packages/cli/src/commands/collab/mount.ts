import { mkdirSync } from "node:fs";
import type { AgentType } from "@ai-whisper/shared";
import { basename } from "node:path";
import {
	applyMigrations,
	createBrokerRuntime,
	openDatabase,
	upsertRecoveryState,
	upsertSessionAttachment,
	type DuoAssignmentRecord,
} from "@ai-whisper/broker";
import {
	assessBrokerDaemon,
	spawnBrokerDaemon,
} from "../../runtime/broker-daemon.js";
import {
	CollabResolverError,
	resolveCollab,
} from "../../runtime/collab-resolver.js";
import { resolveCurrentTty } from "../../runtime/current-tty.js";
import {
	createMountSessionRuntime,
	type DuoPersonaInput,
} from "../../runtime/mount-session-main.js";
import { isPortFree } from "../../runtime/port-utils.js";
import {
	getSharedSqlitePath,
	getStateRoot,
	getStateSocketsDir,
	getStateLogsDir,
} from "../../runtime/state-root.js";
import {
	formatTurnEventsStartupLine,
	resolveTurnEvents,
	unrecognizedTurnEventsTokens,
	type TurnEventsEnablement,
} from "../../runtime/turn-events-config.js";
import { waitForBrokerReady } from "../../runtime/wait-for-broker-ready.js";
import { runCollabRecover } from "./recover.js";
import { runCollabStart } from "./start.js";
import { agentDisplayName } from "../../runtime/agent-display.js";
import { resolveDuoEnabled } from "../../runtime/duo-config.js";
import { rollDuo } from "../../duo/roll-duo.js";
import { getCharacter } from "../../duo/duo-table.js";
import { loadCharacterArt } from "../../duo/art-assets.js";
import { renderDuoBanner, renderVendorBanner } from "../../duo/banner.js";

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH = no such process (dead). EPERM = exists but not signalable (alive).
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function recordMountedSession(input: {
	cwd: string;
	agentType: AgentType;
	ttyPath: string;
	pid: number;
	collabIdOverride?: string;
}): void {
	const db = openDatabase(getSharedSqlitePath());
	try {
		const r = resolveCollab({
			db,
			cwd: input.cwd,
			...(input.collabIdOverride !== undefined
				? { collabIdOverride: input.collabIdOverride }
				: {}),
		});
		upsertSessionAttachment(db, {
			collabId: r.collabId,
			agentType: input.agentType,
			attachmentKind: "mounted",
			sessionId: null,
			providerId: null,
			launchMode: null,
			ttyPath: input.ttyPath,
			pid: input.pid,
			windowLabel: null,
			attachedAt: new Date().toISOString(),
		});
	} finally {
		db.close();
	}
}

export async function runCollabMount(input: {
	workspaceRoot: string;
	collabIdOverride?: string;
	target: AgentType;
	/**
	 * Args forwarded after `--` to the visible agent binary spawn
	 * (e.g. `mount codex -- --full-auto --model gpt-5`). Threaded to
	 * createInteractiveSessionForTarget only — the relay/companion provider
	 * side is unaffected. Defaults to []. No shell escaping; the CLI relies
	 * on commander 13's variadic positional to yield a clean string[].
	 */
	passthroughArgs?: string[];
	/**
	 * Override value for AI_WHISPER_TURN_EVENTS (flag > env > default ON).
	 * Comma-separated provider names: "claude", "codex", or "claude,codex";
	 * "off"/"none"/empty disables the event path (revert to pure clipboard).
	 * When absent, falls through to the env var (then defaults to on for both).
	 */
	turnEventsFlag?: string;
	/**
	 * Duo banner enablement (flag > env > default ON). From commander's
	 * `--no-duo` this is `false`; `undefined` falls through to the env var
	 * (`AI_WHISPER_DUO`) then defaults ON. When disabled the pre-spawn banner is
	 * skipped and the mount's binding path releases any stale duo assignment row
	 * for this agent (see createMountSessionRuntime.duoDisabled).
	 */
	duoFlag?: boolean;
	now: string;
	resolveCurrentTty?: () => string;
	createRuntime?: typeof createMountSessionRuntime;
	assessBroker?: typeof assessBrokerDaemon;
	/**
	 * Test seam: override the auto-create call. Defaults to runCollabStart.
	 * Used in tests to simulate a parallel mount winning the create race.
	 */
	runStartFn?: typeof runCollabStart;
	/**
	 * Test seam: override the pid liveness check used when deciding whether a
	 * "bound" binding has a live owner. Defaults to defaultIsPidAlive.
	 */
	isPidAlive?: (pid: number) => boolean;
	/**
	 * Test seam: override the daemon-revive call used to transparently re-adopt
	 * an existing active collab whose daemon is dead. Defaults to runCollabRecover.
	 */
	runRecoverFn?: typeof runCollabRecover;
	/**
	 * Test seam: liveness probe for the resolved collab's DAEMON pid. The
	 * resolver treats any non-null pid as "live" (it does not call
	 * process.kill), so a stale non-null pid left behind by a crashed/restarted
	 * daemon would otherwise be reused as if healthy. mount probes the daemon
	 * pid here and, when dead, transparently re-adopts via recover. Defaults to
	 * defaultIsPidAlive. NOTE: distinct from `isPidAlive`, which probes the
	 * mounted session-attachment owner pid.
	 */
	isDaemonPidAlive?: (pid: number) => boolean;
	/**
	 * Test seam: the dramatic pause between drawing the duo banner and the
	 * scrollback push. Defaults to a real `setTimeout`-backed sleep; tests stub
	 * it to a no-op so the 2s pause does not slow the suite.
	 */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Test seam: the stream the pre-spawn duo banner is written to. Defaults to
	 * `process.stdout`; tests inject a fake capturing writes with fixed
	 * `columns`/`rows`. Never the child PTY — the banner is drawn strictly before
	 * `runtime.start()` spawns the provider.
	 */
	bannerOut?: NodeJS.WriteStream;
}) {
	// Ensure the shared SQLite file exists with all tables before any
	// resolve attempt. Without this, the initial resolveCollab in a
	// brand-new workspace throws SqliteError("no such table: collab")
	// instead of the expected CollabResolverError(NoCollabFoundForCwd),
	// which would skip the auto-create branch below.
	mkdirSync(getStateRoot(), { recursive: true });
	{
		const db = openDatabase(getSharedSqlitePath());
		try {
			applyMigrations(db);
		} finally {
			db.close();
		}
	}

	// Turn-events: resolve enablement (flag > env > default ON for claude/codex/agy); ensure dirs; startup log.
	const enablement: TurnEventsEnablement = resolveTurnEvents(input.turnEventsFlag);
	mkdirSync(getStateSocketsDir(), { recursive: true });
	mkdirSync(getStateLogsDir(), { recursive: true });
	console.error(formatTurnEventsStartupLine(enablement));
	// Loud guard against the typo footgun: an unrecognized token (e.g. "clade")
	// silently resolves a provider to OFF. Surface it next to the startup line
	// so a misconfigured flag/env is visible rather than passing unnoticed.
	const unknownTurnEventsTokens = unrecognizedTurnEventsTokens(input.turnEventsFlag);
	if (unknownTurnEventsTokens.length > 0) {
		console.error(
			`[ai-whisper] turn-events: ignoring unrecognized token(s) ${unknownTurnEventsTokens
				.map((t) => `"${t}"`)
				.join(", ")} — expected claude, codex, agy, off, or none`,
		);
	}

	const tryResolve = () => {
		const db = openDatabase(getSharedSqlitePath());
		try {
			return resolveCollab({
				db,
				cwd: input.workspaceRoot,
				...(input.collabIdOverride
					? { collabIdOverride: input.collabIdOverride }
					: {}),
				requireActive: true,
				requireDaemon: true,
			});
		} finally {
			db.close();
		}
	};

	const isDaemonAlive = input.isDaemonPidAlive ?? defaultIsPidAlive;

	// Single revive code path: bring the collab's daemon back through the
	// existing recover machinery (not a reimplementation), reset recovery_state
	// to "normal" (this mount re-binds the target agent now, replacing any
	// remembered binding, so the recovery gate below must not demand a separate
	// `whisper collab reconnect`), then re-resolve to the now-live daemon.
	const reviveViaRecover = async () => {
		await (input.runRecoverFn ?? runCollabRecover)({
			cwd: input.workspaceRoot,
			now: () => new Date().toISOString(),
			isPortFreeOs: (port: number) => isPortFree(port),
			spawnBroker: ({ collabId, host, port, sqlitePath }) =>
				spawnBrokerDaemon(sqlitePath, host, port, collabId),
			waitForReady: ({ host, port, collabId, timeoutMs }) =>
				waitForBrokerReady({ host, port, collabId, timeoutMs }),
			signalProcess: (pid, signal) => {
				try {
					process.kill(pid, signal);
				} catch {
					// ignore
				}
			},
		});
		const db = openDatabase(getSharedSqlitePath());
		try {
			const r = resolveCollab({ db, cwd: input.workspaceRoot });
			upsertRecoveryState(db, {
				collabId: r.collabId,
				state: "normal",
				idleAfterRecovery: false,
				recoveredAt: null,
			});
		} finally {
			db.close();
		}
		return tryResolve();
	};

	const resolveOrCreate = async () => {
		try {
			const resolved = tryResolve();
			// Stale non-null dead PID: the resolver reported a daemon (pid !== null)
			// but the recorded process is gone. Re-adopt by reviving, rather than
			// binding the agent into a dead daemon (the silent-hang failure). Only
			// for the cwd path — an explicit --collab override is left untouched.
			if (
				input.collabIdOverride === undefined &&
				resolved.daemon !== null &&
				!isDaemonAlive(resolved.daemon.pid)
			) {
				return await reviveViaRecover();
			}
			return resolved;
		} catch (err) {
			// Transparent re-adopt of a missing/null-pid daemon: an active collab
			// exists for this workspace but its daemon is dead (post-restart).
			// Revive through recover instead of erroring "Run `whisper collab
			// recover`".
			if (
				err instanceof CollabResolverError &&
				err.kind === "NoLiveDaemonForCollab" &&
				input.collabIdOverride === undefined
			) {
				return await reviveViaRecover();
			}
			// Auto-create a fresh collab when the workspace has none
			// (NoCollabFoundForCwd) OR when its only collab was already stopped
			// (CollabAlreadyStopped — e.g. after `whisper collab stop`; without
			// this the user could never re-mount in a workspace they'd stopped).
			// lookupByCwd prefers an active collab, so the new one wins on
			// re-resolve and the stopped row is harmlessly ignored.
			// WorkspaceUnreadable must still propagate: it is a real fs error.
			if (
				!(
					err instanceof CollabResolverError &&
					(err.kind === "NoCollabFoundForCwd" ||
						err.kind === "CollabAlreadyStopped")
				)
			) {
				throw err;
			}
			// Don't auto-create when caller passed an explicit collab id.
			if (input.collabIdOverride !== undefined) {
				throw err;
			}
		}

		try {
			await (input.runStartFn ?? runCollabStart)({
				cwd: input.workspaceRoot,
				displayName: basename(input.workspaceRoot),
				launchMode: "none",
				now: () => new Date().toISOString(),
				isPortFreeOs: (port: number) => isPortFree(port),
				spawnBroker: ({ collabId, host, port, sqlitePath }) =>
					spawnBrokerDaemon(sqlitePath, host, port, collabId),
				waitForReady: ({ host, port, collabId, timeoutMs }) =>
					waitForBrokerReady({ host, port, collabId, timeoutMs }),
				signalProcess: (pid, signal) => {
					try {
						process.kill(pid, signal);
					} catch {
						// ignore
					}
				},
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!/active collab .* already exists/.test(msg)) throw err;
		}

		return tryResolve();
	};

	const resolved = await resolveOrCreate();

	if (resolved.recovery.state === "recovery_required") {
		throw new Error(
			"Broker is unavailable for the current collab. Run `whisper collab recover`.",
		);
	}
	if (resolved.recovery.state === "recovered") {
		throw new Error(
			"Collab has been recovered and still needs reconnect. Run `whisper collab reconnect <codex|claude|ezio|agy>`.",
		);
	}

	// daemon is non-null because requireDaemon: true.
	const daemon = resolved.daemon as { host: string; port: number; pid: number };

	// Optional broker probe (callers in tests inject a mock).
	if (input.assessBroker) {
		const health = await input.assessBroker({
			host: daemon.host,
			port: daemon.port,
			pid: daemon.pid,
		});
		if (!health.ok) {
			throw new Error(
				"Broker is unavailable for the current collab. Run `whisper collab recover`.",
			);
		}
	}

	const ttyPath = (input.resolveCurrentTty ?? resolveCurrentTty)();
	const broker = createBrokerRuntime({
		sqlitePath: getSharedSqlitePath(),
		host: daemon.host,
		port: daemon.port,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
	let brokerHandedOff = false;
	try {
		const current = broker.control
			.listSessionBindings(resolved.collabId)
			.find((binding) => binding.agentType === input.target);
		if (current?.bindingState === "bound") {
			const isAlive = input.isPidAlive ?? defaultIsPidAlive;
			const liveOwner = broker.control
				.listSessionAttachments(resolved.collabId)
				.some(
					(a) =>
						a.agentType === input.target &&
						a.pid !== null &&
						isAlive(a.pid),
				);
			if (liveOwner) {
				throw new Error(
					`${agentDisplayName(input.target)} is already bound to a live session. Stop the existing mount tab and run \`whisper collab mount\` again.`,
				);
			}
			// No live owner — the previous mount session is gone but left the
			// binding "bound" (teardown marks degraded + deletes the attachment
			// but never unbinds; a crash skips teardown entirely). Reclaim it:
			// issueAttachClaim below overwrites bound → pending_attach → bound.
			console.error(
				`Reclaiming stale ${input.target} binding (previous mount session is gone).`,
			);
		}

		const claim = broker.control.issueAttachClaim({
			collabId: resolved.collabId,
			agentType: input.target,
			mode: "attach",
			targetMode: "mount_current_tty",
			targetTtyPath: ttyPath,
			now: input.now,
			expiresAt: new Date(Date.parse(input.now) + 5 * 60_000).toISOString(),
		});

		// Duo character banner (pre-spawn, cosmetic). Runs strictly AFTER the
		// attach claim above and BEFORE the provider spawn below. The claim is
		// additive and self-healing (a failed claimer leaves a dead-owner row that
		// inherit-if-dead reclaims), so it is safe here where the banner needs it.
		// A claim/render failure degrades to no banner and NEVER breaks the mount.
		// The opt-out RELEASE is deliberately NOT here — it runs post-binding in
		// createMountSessionRuntime (see `duoDisabled`) because deleting a stale
		// row is destructive with no self-heal and must only fire once bound.
		const duoEnabled = resolveDuoEnabled(input.duoFlag);
		// Persona-carry inputs (env stamps + session brief), populated only on the
		// has-assignment outcomes (claimed/existing/inherited) — NEVER fallback,
		// NEVER --no-duo. Declared outside the try block and captured BEFORE the
		// banner render below so a render-only failure (e.g. a bad art file write)
		// does not also suppress persona carry — the assignment is already
		// persisted by claimDuoCharacter regardless of banner outcome.
		let duoAssignmentForEnv: DuoAssignmentRecord | null = null;
		let duoRuntimeInput: DuoPersonaInput | undefined;
		if (duoEnabled) {
			try {
				const bannerOut = input.bannerOut ?? process.stdout;
				const sleep = input.sleep ?? defaultSleep;
				const result = broker.control.claimDuoCharacter({
					collabId: resolved.collabId,
					agentType: input.target,
					proposedRoll: rollDuo(),
				});
				const character =
					result.assignment !== null
						? getCharacter(
								result.assignment.duoId,
								result.assignment.characterId,
							)
						: undefined;

				if (result.assignment !== null) {
					duoAssignmentForEnv = result.assignment;
					const teammate = result.teammate;
					duoRuntimeInput = {
						character: character?.summonName ?? result.assignment.characterName,
						role: result.assignment.role,
						teammate:
							teammate === null
								? null
								: {
										agentType: teammate.agentType,
										character:
											getCharacter(teammate.duoId, teammate.characterId)
												?.summonName ?? teammate.characterName,
									},
					};
				}

				const banner =
					result.assignment !== null && character !== undefined
						? renderDuoBanner({
								summonName: character.summonName,
								role: result.assignment.role,
								punchline: character.punchline,
								art: loadCharacterArt(character.artFile),
								columns: bannerOut.columns ?? 80,
							})
						: renderVendorBanner({ agentType: input.target });
				bannerOut.write(banner);
				// Dramatic pause, then a scrollback push: pump `rows` newlines so the
				// art survives codex's first-frame viewport wipe (ESC[1;1H + ESC[J).
				// Harmless for claude; applied uniformly for all providers/outcomes.
				await sleep(2000);
				bannerOut.write("\n".repeat(bannerOut.rows ?? 40));
			} catch (err) {
				console.error(
					`[ai-whisper] duo: banner skipped (${
						err instanceof Error ? err.message : String(err)
					})`,
				);
			}
		}

		// Env stamps (Task 4): raw assignment fields, set BEFORE runtime.start()
		// so `baseEnv ?? process.env` inheritance in every adapter's PTY spawn
		// helper carries them into the child with zero adapter edits.
		if (duoAssignmentForEnv !== null) {
			process.env.AI_WHISPER_CHARACTER = duoAssignmentForEnv.characterName;
			process.env.AI_WHISPER_CHARACTER_ROLE = duoAssignmentForEnv.role;
		}

		const runtime = (input.createRuntime ?? createMountSessionRuntime)({
			target: input.target,
			ttyPath,
			workspaceRoot: input.workspaceRoot,
			claimId: claim.claimId,
			secret: claim.secret,
			broker,
			passthroughArgs: input.passthroughArgs ?? [],
			turnEventsEnablement: enablement,
			duoDisabled: !duoEnabled,
			...(duoRuntimeInput !== undefined ? { duo: duoRuntimeInput } : {}),
		});

		brokerHandedOff = true;
		await runtime.start();
	} finally {
		if (!brokerHandedOff) {
			await broker.stop();
		}
	}
}
