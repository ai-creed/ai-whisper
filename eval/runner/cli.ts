import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseArms, parseNonNegativeInt, parsePositiveInt, UsageError, parseBilling } from "./cli-args.ts";
import { cmdGrade, cmdInit, cmdReport, cmdRun, cmdSlice, cmdStatus, cmdValidateTasks } from "./commands.ts";
import { DriftError } from "./pins.ts";
import { runDryRun } from "./dry-run.ts";
import { DEFAULT_TOOLCHAIN_ROOT, ensureToolchain } from "./toolchain.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const USAGE = `usage: pnpm eval -- <toolchain|init|status|run|slice|grade|report|validate-tasks|dry-run> [options]
  --campaign <id>           campaign id under eval/results (default: default)
  --trials <n>              trials per task×arm at init (default: 2)
  --seed <n>                run-order seed at init (default: random, printed)
  --implementer-model <m>   pinned implementer model (init)
  --reviewer-model <m>      pinned reviewer model (init)
  --billing <mode>          who pays for the claude seats (init): subscription (default; claude.ai login) or api (ANTHROPIC_API_KEY)
  --arm <A|B|C>             restrict a slice (repeatable)
  --task <slug>             restrict a slice (repeatable)
  --limit <n>               max runs in this slice
  --parallel-solo <n>       concurrent solo runs (default: 2); pair runs are always serial
  --key <task/arm/trial>    one run (run, grade)
  --green                   validate-tasks: also run each fixture's hygiene gate and held-out tests
  --dry-run                 slice/run: fake models, no API spend
  --workspace-root <dir>    where agent workspaces are created; MUST be outside this repo (default ~/.ai-whisper-eval/workspaces)
  --toolchain-root <dir>    where the fixture toolchain is installed; MUST be outside this repo (default ~/.ai-whisper-eval/toolchain)`;

async function run(): Promise<number> {
	// `pnpm eval -- <args>` forwards the literal `--`, which would turn every option into a positional.
	const argv = process.argv.slice(2);
	if (argv[0] === "--") argv.shift();
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			campaign: { type: "string", default: "default" }, trials: { type: "string" }, seed: { type: "string" },
			"implementer-model": { type: "string" }, "reviewer-model": { type: "string" }, billing: { type: "string" },
			arm: { type: "string", multiple: true }, task: { type: "string", multiple: true }, limit: { type: "string" },
			"parallel-solo": { type: "string", default: "2" }, key: { type: "string" }, green: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false },
			"workspace-root": { type: "string", default: join(homedir(), ".ai-whisper-eval", "workspaces") },
			"toolchain-root": { type: "string", default: DEFAULT_TOOLCHAIN_ROOT },
		},
	});
	const cmd = positionals[0];
	const arms = parseArms(values.arm);
	const billing = parseBilling(values.billing);
	const limit = values.limit === undefined ? undefined : parsePositiveInt("--limit", values.limit);
	const parallelSolo = parsePositiveInt("--parallel-solo", values["parallel-solo"], 2);
	const trials = parsePositiveInt("--trials", values.trials, 2);
	const seedFlag = values.seed === undefined ? undefined : parseNonNegativeInt("--seed", values.seed);
	const campaignDir = join(repoRoot, "eval", "results", values.campaign ?? "default");
	const tasksRoot = join(repoRoot, "eval", "tasks");
	const toolchainRoot = values["toolchain-root"];
	// Resolved lazily: init/status/report must work without a toolchain install.
	const needsToolchain = ["toolchain", "slice", "run", "grade", "validate-tasks", "dry-run"].includes(cmd ?? "");
	const toolchainNodeModules = needsToolchain ? ensureToolchain({ repoRoot, toolchainRoot }) : "";
	const whisperCli = join(repoRoot, "packages", "cli", "dist", "bin", "whisper.js");
	const sourceStateRoot = process.env.AI_WHISPER_STATE_ROOT ?? join(process.env.HOME ?? "", ".ai-whisper");
	const sliceOpts = { campaignDir, tasksRoot, toolchainNodeModules, whisperCli, workspaceRoot: values["workspace-root"], ...(arms ? { arms } : {}), ...(values.task ? { tasks: values.task } : {}), ...(limit !== undefined ? { limit } : {}), parallelSolo };
	try {
		switch (cmd) {
			case "toolchain": console.log(toolchainNodeModules); return 0;
			case "init": {
				if (!values["implementer-model"] || !values["reviewer-model"]) { console.error("init needs --implementer-model and --reviewer-model"); return 1; }
				const seed = seedFlag ?? Math.floor(Math.random() * 2 ** 31);
				const m = cmdInit({ campaignDir, tasksRoot, trials, seed, implementerModel: values["implementer-model"], reviewerModel: values["reviewer-model"], billing, sourceStateRoot });
				console.log(`initialized ${m.campaignId}: ${m.runs.length} runs, seed ${m.seed}`);
				return 0;
			}
			case "status": console.log(cmdStatus({ campaignDir })); return 0;
			case "slice": {
				const dry = values["dry-run"] ? await runDryRun.prepareSliceDryRun(repoRoot) : undefined;
				const r = await cmdSlice({ ...sliceOpts, ...(dry ? { dryRun: dry } : {}) });
				console.log(`slice finished: ${r.done} done, ${r.failed} failed`);
				return r.failed > 0 ? 2 : 0;
			}
			case "run": {
				if (!values.key) { console.error("run needs --key"); return 1; }
				const dry = values["dry-run"] ? await runDryRun.prepareSliceDryRun(repoRoot) : undefined;
				const s = await cmdRun({ ...sliceOpts, key: values.key, ...(dry ? { dryRun: dry } : {}) });
				console.log(`${values.key}: ${s}`);
				return s === "done" ? 0 : 2;
			}
			case "grade": { if (!values.key) { console.error("grade needs --key"); return 1; } cmdGrade({ campaignDir, tasksRoot, toolchainNodeModules, key: values.key }); return 0; }
			case "report": { cmdReport({ campaignDir }); console.log(`wrote ${join(campaignDir, "report.md")}`); return 0; }
			case "validate-tasks": {
				const v = cmdValidateTasks({ tasksRoot, toolchainNodeModules, green: values.green });
				if (v.length === 0) { console.log("task suite OK"); return 0; }
				console.error(v.map((x) => `- ${x}`).join("\n")); return 2;
			}
			case "dry-run": return (await runDryRun.full(repoRoot)) ? 0 : 2;
			default: console.error(USAGE); return 1;
		}
	} catch (e) {
		if (e instanceof DriftError) { console.error(e.message); return 3; }
		throw e;
	}
}

async function main(): Promise<number> {
	try {
		return await run();
	} catch (e) {
		if (e instanceof UsageError) { console.error(e.message); return 1; }
		throw e;
	}
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
