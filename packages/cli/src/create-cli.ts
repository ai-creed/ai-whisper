import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { waitForBrokerReady } from "./runtime/wait-for-broker-ready.js";
import { runCollabMount } from "./commands/collab/mount.js";
import { runCollabInspect } from "./commands/collab/inspect.js";
import { runCollabRecover } from "./commands/collab/recover.js";
import { runCollabReconnect } from "./commands/collab/reconnect.js";
import { runCollabRelayMonitor } from "./commands/collab/relay-monitor.js";
import { runCollabDashboard } from "./commands/collab/dashboard.js";
import {
	recordLaunchedSessions,
	runCollabStart,
} from "./commands/collab/start.js";
import { runCollabStatus } from "./commands/collab/status.js";
import { runCollabStop } from "./commands/collab/stop.js";
import { runCollabTell } from "./commands/collab/tell.js";
import { spawnBrokerDaemon } from "./runtime/broker-daemon.js";
import {
	chooseLaunchMode,
	detectTmux,
	launchSessions,
} from "./runtime/launcher.js";
import { isPortFree } from "./runtime/port-utils.js";
import { getSharedSqlitePath } from "./runtime/state-root.js";
import { parseCallerAgent, runWorkflowStart } from "./commands/workflow/start.js";
import { runWorkflowList } from "./commands/workflow/list.js";
import { runWorkflowInspect } from "./commands/workflow/inspect.js";
import { runWorkflowResume } from "./commands/workflow/resume.js";
import { runWorkflowPause } from "./commands/workflow/pause.js";
import { runWorkflowCancel } from "./commands/workflow/cancel.js";
import { runWorkflowTypes } from "./commands/workflow/types.js";
import { runSkillInstall } from "./commands/skill/install.js";
import { connectToWorkspaceBroker } from "./runtime/broker-connect.js";
import { CollabResolverError } from "./runtime/collab-resolver.js";

interface WorkspaceOpts {
	workspace: string;
}

interface StartOpts extends WorkspaceOpts {
	tmux: boolean;
	launch: boolean;
	port?: number;
}

interface TellOpts {
	target: string;
	collab?: string;
	action?: string;
	artifact?: string[];
	title?: string;
}

function collectArtifact(value: string, previous: string[] = []): string[] {
	return [...previous, value];
}

// Resolve the published version from package.json. The path differs between
// the bundled binary (dist/bin/whisper.js → ../../package.json) and tests that
// import this module from source (packages/cli/src/ → ../package.json), so try
// both and key off the package name so a parent package.json can't shadow it.
export function resolveCliVersion(): string {
	for (const rel of ["../../package.json", "../package.json"]) {
		try {
			const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as {
				name?: string;
				version?: string;
			};
			if (pkg.name === "ai-whisper" && typeof pkg.version === "string") return pkg.version;
		} catch {
			// try the next candidate
		}
	}
	return "0.0.0-dev";
}

export function createCli(): Command {
	const cli = new Command()
		.name("whisper")
		.description("ai-whisper CLI")
		.version(resolveCliVersion(), "-v, --version", "output the version number");

	const collab = cli
		.command("collab")
		.description("Manage AI agent collaboration sessions");

	collab
		.command("start")
		.description("Start a new collaboration session")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.option("--no-tmux", "Disable tmux even if available")
		.option("--no-launch", "Start broker only, do not launch agent terminals")
		.option("--port <port>", "Explicit port to bind for the broker daemon", (v) =>
			Number.parseInt(v, 10),
		)
		.action(async (opts: StartOpts) => {
			const launchMode = chooseLaunchMode({
				tmuxAvailable: detectTmux(),
				forceNoTmux: !opts.tmux,
				forceNoLaunch: !opts.launch,
			});
			const attachTmux =
				launchMode === "tmux" &&
				Boolean(process.stdin.isTTY) &&
				Boolean(process.stdout.isTTY);
			const r = await runCollabStart({
				cwd: opts.workspace,
				displayName: "phase5",
				launchMode,
				...(opts.port !== undefined ? { explicitPort: opts.port } : {}),
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

			const sharedSqlitePath = getSharedSqlitePath();
			if (launchMode !== "none") {
				const launch = launchSessions({
					launchMode,
					...(attachTmux !== undefined ? { attachTmux } : {}),
					collabId: r.collabId,
					workspaceRoot: opts.workspace,
					brokerSqlitePath: sharedSqlitePath,
					brokerHost: r.host,
					brokerPort: r.port,
				});
				recordLaunchedSessions({
					collabId: r.collabId,
					launchMode,
					launch,
				});
			}

			console.log(
				`Collab started: ${r.collabId} (launch: ${launchMode})`,
			);
			if (launchMode === "none") {
				console.log("Collab started (no-launch mode).");
			}
			if (launchMode === "tmux" && !attachTmux) {
				const session = `whisper-${r.collabId}`;
				console.log(
					`\nNot attached (stdin/stdout is not a TTY). To view the tmux session, run:\n  tmux attach -t ${session}`,
				);
			}
		});

	collab
		.command("status")
		.description("Show current collaboration status")
		.option("--collab <id>", "Inspect a specific collab id (defaults to the active collab for cwd)")
		.option("--json", "Emit machine-readable JSON instead of text")
		.action((opts: { collab?: string; json?: boolean }) => {
			const output = runCollabStatus({
				cwd: process.cwd(),
				...(opts.collab ? { collabIdOverride: opts.collab } : {}),
				...(opts.json ? { json: true } : {}),
			});
			console.log(output);
		});

	collab
		.command("tell")
		.description("Send an instruction to an agent")
		.requiredOption("--target <agent>", "Target agent: codex or claude")
		.option("--collab <id>", "Send to a specific collab id (defaults to the active collab for cwd)")
		.option("--action <action>", "Explicit requested action")
		.option(
			"--artifact <path>",
			"Artifact file path. Repeat for multiple files.",
			collectArtifact,
			[],
		)
		.option("--title <title>", "Thread title")
		.argument("<instruction>", "The instruction to send")
		.action(async (instruction: string, opts: TellOpts) => {
			const tellInput: Parameters<typeof runCollabTell>[0] = {
				cwd: process.cwd(),
				target: opts.target as "codex" | "claude" | "ezio",
				instruction,
				artifactPaths: opts.artifact ?? [],
				now: new Date().toISOString(),
			};
			if (opts.collab) {
				tellInput.collabIdOverride = opts.collab;
			}
			if (opts.action) {
				tellInput.explicitAction = opts.action as NonNullable<
					typeof tellInput.explicitAction
				>;
			}
			if (opts.title) {
				tellInput.threadTitle = opts.title;
			}
			const reply = await runCollabTell(tellInput);
			if (reply) {
				console.log(`[${reply.kind}] ${reply.content}`);
			} else {
				console.log("No work items to process.");
			}
		});

	collab
		.command("recover")
		.description("Recover the current workspace collab after broker loss")
		.option("--collab <id>", "Recover a specific collab id (defaults to the active collab for cwd)")
		.option("--port <port>", "Explicit port to bind for the recovered daemon", (v) =>
			Number.parseInt(v, 10),
		)
		.action(async (opts: { collab?: string; port?: number }) => {
			const result = await runCollabRecover({
				cwd: process.cwd(),
				...(opts.collab ? { collabIdOverride: opts.collab } : {}),
				...(opts.port !== undefined ? { explicitPort: opts.port } : {}),
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
			console.log(
				`Collab recovered: ${result.collabId} (pid ${result.pid}, port ${result.port})`,
			);
		});

	collab
		.command("reconnect")
		.description("Reconnect a remembered role after broker recovery (mount mode)")
		.argument("<agent>", "Target agent: codex or claude")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.option("--collab <id>", "Target a specific collab id (defaults to the active collab for cwd)")
		.action(async (target: string, opts: WorkspaceOpts & { collab?: string }) => {
			await runCollabReconnect({
				workspaceRoot: opts.workspace,
				...(opts.collab ? { collabIdOverride: opts.collab } : {}),
				target: target as "codex" | "claude" | "ezio",
				now: new Date().toISOString(),
			});
		});

	collab
		.command("mount")
		.description("Mount the current terminal as the managed session surface for a role")
		.argument("<agent>", "Target agent: codex, claude, or ezio")
		.argument(
			"[passthroughArgs...]",
			"Args forwarded after `--` to the agent binary spawn (e.g. `mount codex -- --full-auto`)",
		)
		.option("--workspace <path>", "Workspace root", process.cwd())
		.option("--collab <id>", "Target a specific collab id (defaults to the active collab for cwd)")
		.action(
			async (
				target: "codex" | "claude" | "ezio",
				passthroughArgs: string[],
				opts: WorkspaceOpts & { collab?: string },
			) => {
				await runCollabMount({
					workspaceRoot: opts.workspace,
					...(opts.collab ? { collabIdOverride: opts.collab } : {}),
					target,
					passthroughArgs,
					now: new Date().toISOString(),
				});
			},
		);

	collab
		.command("inspect")
		.description("Inspect the active collab thread")
		.option("--collab <id>", "Inspect a specific collab id (defaults to the active collab for cwd)")
		.option("--watch", "Continuously redraw the active-thread operator view")
		.option(
			"--captures [chainId]",
			"Show recent capture-diagnostics rows. Pass a chain id to filter, or 'all' for the full history.",
		)
		.option(
			"--verdicts [chainId]",
			"Show recent evaluator-diagnostics rows. Pass a chain id to filter, or 'all' for the full history. Mutually exclusive with --captures.",
		)
		.action(
			async (
				opts: {
					collab?: string;
					watch?: boolean;
					captures?: boolean | string;
					verdicts?: boolean | string;
				},
			) => {
				const capturesArg: true | string | undefined =
					opts.captures === undefined || opts.captures === false
						? undefined
						: opts.captures === true
							? true
							: opts.captures;
				const verdictsArg: true | string | undefined =
					opts.verdicts === undefined || opts.verdicts === false
						? undefined
						: opts.verdicts === true
							? true
							: opts.verdicts;

				const output = await runCollabInspect({
					cwd: process.cwd(),
					...(opts.collab ? { collabIdOverride: opts.collab } : {}),
					now: new Date().toISOString(),
					watch: Boolean(opts.watch),
					...(capturesArg !== undefined ? { captures: capturesArg } : {}),
					...(verdictsArg !== undefined ? { verdicts: verdictsArg } : {}),
				});
				if (output) {
					process.stdout.write(output);
				}
			},
		);

	collab
		.command("relay-monitor")
		.description("Run the relay monitor in the current terminal (renders the relay conversation stream)")
		.option("--collab <id>", "Monitor a specific collab id (defaults to the active collab for cwd)")
		.action(async (opts: { collab?: string }) => {
			await runCollabRelayMonitor({
				cwd: process.cwd(),
				...(opts.collab ? { collabIdOverride: opts.collab } : {}),
			});
		});

	collab
		.command("dashboard")
		.description("Full-screen dashboard: live wall of recently-active runs + per-run inspector")
		.option(
			"--window <duration>",
			"Eligible-collab activity window. Accepts ms or Ns/Nm/Nh/Nd (e.g. 45s, 30m, 2h, 1d), or 'all' for no limit. Default: 30m.",
		)
		.action(async (opts: { window?: string }) => {
			const { parseDashboardWindow } = await import("./runtime/dashboard.js");
			const windowMs =
				opts.window != null ? parseDashboardWindow(opts.window) : null;
			if (opts.window != null && windowMs == null) {
				console.error(
					`Invalid --window value: ${JSON.stringify(opts.window)}. Use e.g. 30m, 2h, 1d, 1800000, or 'all'.`,
				);
				process.exit(2);
			}
			await runCollabDashboard(
				windowMs != null ? { windowMs } : undefined,
			);
		});

	collab
		.command("stop")
		.description("Stop the active collaboration session")
		.option(
			"--collab <id>",
			"Stop a specific collab id (defaults to the active collab for cwd)",
		)
		.action((opts: { collab?: string }) => {
			try {
				runCollabStop({
					cwd: process.cwd(),
					...(opts.collab ? { collabIdOverride: opts.collab } : {}),
					now: () => new Date().toISOString(),
					signalProcess: (pid, signal) => {
						try {
							process.kill(pid, signal);
						} catch {
							// process may already be dead
						}
					},
					execCommand: (cmd) => {
						try {
							execSync(cmd, { stdio: "ignore" });
						} catch {
							// session/window may already be gone
						}
					},
				});
				console.log("Collab stopped.");
			} catch (err) {
				if (err instanceof CollabResolverError) {
					if (err.kind === "NoCollabFoundForCwd") {
						console.log("No active collab.");
						return;
					}
					if (err.kind === "CollabAlreadyStopped") {
						console.log(err.message);
						return;
					}
				}
				throw err;
			}
		});

	const workflow = cli
		.command("workflow")
		.description("Manage AI agent workflows");

	workflow
		.command("start")
		.description("Start a new workflow")
		.requiredOption("--type <type>", "Workflow type (e.g. spec-driven-development)")
		.requiredOption("--spec <path>", "Spec file path")
		.option("--implementer <agent>", "Implementer agent: claude or codex (defaults to the workflow type's defaultImplementer)")
		.option("--reviewer <agent>", "Reviewer agent: claude or codex (defaults to the workflow type's defaultReviewer)")
		.option("--name <name>", "Optional workflow display name")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(
			async (opts: WorkspaceOpts & {
				type: string;
				spec: string;
				implementer?: "claude" | "codex";
				reviewer?: "claude" | "codex";
				name?: string;
			}) => {
				const { broker, collabId } = await connectToWorkspaceBroker({ cwd: opts.workspace });
				try {
					const result = await runWorkflowStart({
						broker,
						collabId,
						workflowType: opts.type,
						specPath: opts.spec,
						...(opts.implementer ? { implementer: opts.implementer } : {}),
						...(opts.reviewer ? { reviewer: opts.reviewer } : {}),
						...(opts.name ? { name: opts.name } : {}),
						callerAgent: parseCallerAgent(process.env.AI_WHISPER_AGENT),
						now: new Date().toISOString(),
					});
					// Warning goes to stderr so stdout stays the single parseable line
					// the kickoff skills read.
					if (result.roleWarning) console.error(result.roleWarning);
					console.log(`Workflow started: ${result.workflowId}`);
				} finally {
					await broker.stop();
				}
			},
		);

	workflow
		.command("list")
		.description("List workflows for the active collab")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (opts: WorkspaceOpts) => {
			const { broker, collabId } = await connectToWorkspaceBroker({ cwd: opts.workspace });
			try {
				const list = runWorkflowList({ broker, collabId });
				if (list.length === 0) {
					console.log("No workflows.");
				} else {
					for (const wf of list) {
						console.log(`${wf.workflowId}  ${wf.workflowType}  ${wf.status}`);
					}
				}
			} finally {
				await broker.stop();
			}
		});

	workflow
		.command("inspect")
		.description("Inspect a workflow and its phase runs")
		.argument("<workflowId>", "Workflow ID")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (workflowId: string, opts: WorkspaceOpts) => {
			const { broker } = await connectToWorkspaceBroker({ cwd: opts.workspace });
			try {
				const result = await runWorkflowInspect({ broker, workflowId });
				console.log(JSON.stringify(result, null, 2));
			} finally {
				await broker.stop();
			}
		});

	workflow
		.command("pause")
		.description("Pause a running workflow")
		.argument("<workflowId>", "Workflow ID")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (workflowId: string, opts: WorkspaceOpts) => {
			const { broker } = await connectToWorkspaceBroker({ cwd: opts.workspace });
			try {
				await runWorkflowPause({ broker, workflowId, now: new Date().toISOString() });
				console.log(`Workflow paused: ${workflowId}`);
			} finally {
				await broker.stop();
			}
		});

	workflow
		.command("resume")
		.description("Resume a paused or halted workflow")
		.argument("<workflowId>", "Workflow ID")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.option("--message <note>", "Operator note delivered to the agents on resume")
		.action(
			async (workflowId: string, opts: WorkspaceOpts & { message?: string }) => {
				const { broker } = await connectToWorkspaceBroker({ cwd: opts.workspace });
				try {
					await runWorkflowResume({
						broker,
						workflowId,
						now: new Date().toISOString(),
						...(opts.message !== undefined ? { message: opts.message } : {}),
					});
					console.log(`Workflow resumed: ${workflowId}`);
				} finally {
					await broker.stop();
				}
			},
		);

	workflow
		.command("cancel")
		.description("Cancel a running or halted workflow")
		.argument("<workflowId>", "Workflow ID")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (workflowId: string, opts: WorkspaceOpts) => {
			const { broker } = await connectToWorkspaceBroker({ cwd: opts.workspace });
			try {
				await runWorkflowCancel({ broker, workflowId, now: new Date().toISOString() });
				console.log(`Workflow canceled: ${workflowId}`);
			} finally {
				await broker.stop();
			}
		});

	workflow
		.command("types")
		.description("List registered workflow types")
		.action(async () => {
			const types = await runWorkflowTypes();
			for (const t of types) {
				console.log(t);
			}
		});

	const skill = cli.command("skill").description("Manage bundled agent skills");

	skill
		.command("install")
		.description(
			"Install the bundled ai-whisper skills into your agent skill directories",
		)
		.addOption(
			new Option("--target <target>", "Agent install target")
				.choices(["claude", "codex", "all"])
				.default("all"),
		)
		.option("--force", "Overwrite existing skill destinations")
		.action(
			async (opts: {
				target: "claude" | "codex" | "all";
				force?: boolean;
			}) => {
				const result = await runSkillInstall({
					target: opts.target,
					...(opts.force ? { force: true } : {}),
				});
				for (const p of result.installedAt) {
					console.log(`Installed: ${p}`);
				}
			},
		);

	return cli;
}
