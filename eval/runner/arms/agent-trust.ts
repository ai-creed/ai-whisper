import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Both CLIs show a first-run "trust this folder?" dialog for a directory they have never seen, and a
 * mounted session that receives a relay handoff while that dialog is up exits (claude) or stalls (codex).
 * Every eval workspace is brand new, so the runner grants trust before mounting and releases it after.
 */
export interface TrustGrant {
	release(): void;
}

export interface TrustConfig {
	claudeJson: string; // default ~/.claude.json
	codexToml: string; // default ~/.codex/config.toml
}

export const DEFAULT_TRUST_CONFIG: TrustConfig = {
	claudeJson: join(homedir(), ".claude.json"),
	codexToml: join(homedir(), ".codex", "config.toml"),
};

function writeAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.eval-tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

type ClaudeProjects = Record<string, Record<string, unknown>>;

/** claude: `projects["<path>"].hasTrustDialogAccepted = true`. Entries we add are removed on release; a pre-existing false flag is restored. */
export function trustWorkspaceForClaude(paths: readonly string[], configPath: string = DEFAULT_TRUST_CONFIG.claudeJson): TrustGrant {
	const read = (): Record<string, unknown> => (existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>) : {});
	const cfg = read();
	const projects = ((cfg.projects as ClaudeProjects | undefined) ?? {});
	const added: string[] = [];
	const restoreFalse: string[] = [];
	for (const p of paths) {
		const entry = projects[p];
		if (entry === undefined) { projects[p] = { hasTrustDialogAccepted: true }; added.push(p); continue; }
		if (entry.hasTrustDialogAccepted !== true) { entry.hasTrustDialogAccepted = true; restoreFalse.push(p); }
	}
	cfg.projects = projects;
	writeAtomic(configPath, JSON.stringify(cfg, null, 2) + "\n");
	return {
		release(): void {
			const again = read();
			const projs = (again.projects as ClaudeProjects | undefined) ?? {};
			for (const p of added) delete projs[p];
			for (const p of restoreFalse) if (projs[p]) projs[p].hasTrustDialogAccepted = false;
			again.projects = projs;
			writeAtomic(configPath, JSON.stringify(again, null, 2) + "\n");
		},
	};
}

/** codex: a `[projects."<path>"]` table with `trust_level = "trusted"`. Blocks we append are removed on release; existing tables are left alone. */
export function trustWorkspaceForCodex(paths: readonly string[], configPath: string = DEFAULT_TRUST_CONFIG.codexToml): TrustGrant {
	const read = (): string => (existsSync(configPath) ? readFileSync(configPath, "utf8") : "");
	let text = read();
	const appended: string[] = [];
	for (const p of paths) {
		const header = `[projects."${p}"]`;
		if (text.split("\n").some((l) => l.trim() === header)) continue;
		const block = `${header}\ntrust_level = "trusted"\n`;
		text = `${text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text}\n${block}`;
		appended.push(block);
	}
	if (appended.length > 0) writeAtomic(configPath, text);
	return {
		release(): void {
			if (appended.length === 0) return;
			let again = read();
			for (const block of appended) again = again.replace(`\n${block}`, "");
			writeAtomic(configPath, again);
		},
	};
}

/** Grant trust for every spelling of the workspace path the CLIs might see (as given and symlink-resolved). */
export function trustWorkspace(paths: readonly string[], config: TrustConfig = DEFAULT_TRUST_CONFIG): TrustGrant {
	const unique = [...new Set(paths)];
	const grants = [trustWorkspaceForClaude(unique, config.claudeJson), trustWorkspaceForCodex(unique, config.codexToml)];
	return { release: () => { for (const g of grants) { try { g.release(); } catch { /* best effort */ } } } };
}
