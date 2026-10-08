import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { budgetSchema, taskCategorySchema, taskMetaSchema, taskShapeSchema, type TaskMeta } from "./types.ts";

export const TASK_LAYOUT_RULES: readonly string[] = [
	"task.md has an H1 title and the sections ## Task, ## Scope (bullet list of file paths), ## Acceptance criteria",
	"meta.json declares { category: feature|bugfix|refactor, shape: quick-task|spec-driven-development }",
	"budget.json declares { wallClockSeconds, tokenCap } as positive integers",
	"quick-task tasks ship approach.md; spec-driven-development tasks must not",
	"grade/ exists and holds at least one *.grade.test.ts; nothing named grade/ exists under fixture/",
	"fixture/ has no node_modules (the runner links the shared toolchain)",
	"no fixture file, task.md, or approach.md references eval/tasks or a grade/ path (held-out leak)",
	"fixture/ contains no symbolic links (a link could alias grade/ or the repo; the copy drops them anyway)",
	"task.md has no sections beyond Task/Scope/Acceptance criteria; Scope holds only single-bare-path bullets (annotations belong in ## Task)",
];

const LEAK_RE = /eval\/tasks|\bgrade\//;

/** Any symlink under fixture/ is a leak vector (it can alias grade/ or the repo), regardless of target. */
function symlinksUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isSymbolicLink()) { out.push(p); continue; }
		if (entry.isDirectory() && entry.name !== "node_modules") out.push(...symlinksUnder(p));
	}
	return out;
}

function leakingFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isSymbolicLink()) continue; // reported by symlinksUnder; never followed
		if (entry.isDirectory()) { if (entry.name !== "node_modules") out.push(...leakingFiles(p)); continue; }
		if (!/\.(ts|tsx|js|mjs|cjs|json|md|txt|yml|yaml)$/.test(entry.name)) continue;
		if (LEAK_RE.test(readFileSync(p, "utf8"))) out.push(p);
	}
	return out;
}

function section(lines: string[], name: string): string | null {
	const re = new RegExp(`^#{2,3}\\s+${name}\\s*$`, "i");
	const start = lines.findIndex((l) => re.test(l.trim()));
	if (start === -1) return null;
	const body: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		if (/^#{1,3}\s+/.test(lines[i] ?? "")) break;
		body.push(lines[i] ?? "");
	}
	const text = body.join("\n").trim();
	return text.length > 0 ? text : null;
}

function scopeBulletsFrom(text: string, violations: string[]): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		if (raw.trim() === "") continue;
		const m = /^\s*[-*]\s+(.+)$/.exec(raw);
		if (!m) { violations.push("Scope must contain only bullets"); continue; }
		const text = (m[1] ?? "").trim();
		const bare = /^`([^`\s]+)`$/.exec(text)?.[1] ?? (/^[^`\s]+$/.test(text) ? text : null);
		if (bare === null) { violations.push(`Scope bullet must be a single bare path: ${text}`); continue; }
		out.push(bare);
	}
	return out;
}

const ALLOWED_SECTIONS = new Set(["task", "scope", "acceptance criteria"]);

export function parseTaskMd(content: string): { title: string; taskSection: string; scopeBullets: string[]; acceptanceSection: string } {
	const lines = content.split(/\r?\n/);
	const titleLine = lines.find((l) => /^#\s+/.test(l));
	const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : "";
	const taskSection = section(lines, "Task");
	const scope = section(lines, "Scope");
	const acceptanceSection = section(lines, "Acceptance criteria");
	const missing: string[] = [];
	if (!title) missing.push("H1 title");
	if (!taskSection) missing.push("## Task");
	if (!scope) missing.push("## Scope");
	if (!acceptanceSection) missing.push("## Acceptance criteria");
	const scopeBullets = scope ? scopeBulletsFrom(scope, missing) : [];
	if (scope && scopeBullets.length === 0 && missing.length === 0) missing.push("## Scope bullets");
	for (const l of lines) {
		const h = /^#{2,3}\s+(.+?)\s*$/.exec(l.trim());
		if (h && !ALLOWED_SECTIONS.has((h[1] ?? "").toLowerCase())) missing.push(`unexpected section: ${h[1]}`);
	}
	if (missing.length > 0) throw new Error(`task.md is invalid: ${missing.join(", ")}`);
	return { title, taskSection: taskSection as string, scopeBullets, acceptanceSection: acceptanceSection as string };
}

function hasGradeDirUnder(dir: string): boolean {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue; // never follow links
		if (entry.name === "node_modules") continue;
		if (entry.name === "grade") return true;
		if (hasGradeDirUnder(join(dir, entry.name))) return true;
	}
	return false;
}

export function gradeDirFor(taskDir: string): string {
	return join(taskDir, "grade");
}

export function loadTask(dir: string): TaskMeta {
	const violations: string[] = [];
	const slug = basename(dir);
	const read = (name: string): string | null => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);

	const taskMd = read("task.md");
	let parsed: ReturnType<typeof parseTaskMd> | null = null;
	if (taskMd === null) violations.push("task.md missing");
	else {
		try { parsed = parseTaskMd(taskMd); } catch (e) { violations.push((e as Error).message); }
	}

	const metaRaw = read("meta.json");
	let category: unknown; let shape: unknown;
	if (metaRaw === null) violations.push("meta.json missing");
	else {
		const meta = JSON.parse(metaRaw) as { category?: unknown; shape?: unknown };
		category = meta.category; shape = meta.shape;
		if (!taskCategorySchema.safeParse(category).success) violations.push("meta.json category must be feature|bugfix|refactor");
		if (!taskShapeSchema.safeParse(shape).success) violations.push("meta.json shape must be quick-task|spec-driven-development");
	}

	const budgetRaw = read("budget.json");
	const budget = budgetRaw === null ? null : budgetSchema.safeParse(JSON.parse(budgetRaw));
	if (budget === null) violations.push("budget.json missing");
	else if (!budget.success) violations.push("budget.json must be { wallClockSeconds, tokenCap } positive integers");

	const approach = read("approach.md");
	if (shape === "quick-task" && approach === null) violations.push("quick-task tasks must ship approach.md");
	if (shape === "spec-driven-development" && approach !== null) violations.push("spec-driven-development tasks must not ship approach.md (the spec is the approved artifact)");

	const fixture = join(dir, "fixture");
	if (!existsSync(fixture) || !statSync(fixture).isDirectory()) violations.push("fixture/ missing");
	else {
		if (existsSync(join(fixture, "node_modules"))) violations.push("fixture/node_modules must not exist");
		if (hasGradeDirUnder(fixture)) violations.push("grade/ content is reachable inside fixture/");
		for (const f of leakingFiles(fixture)) violations.push(`held-out leak: ${f} references eval/tasks or grade/`);
		for (const f of symlinksUnder(fixture)) violations.push(`held-out leak: ${f} is a symbolic link (fixtures may not contain links)`);
	}
	for (const name of ["task.md", "approach.md"]) {
		const text = read(name);
		if (text !== null && LEAK_RE.test(text)) violations.push(`held-out leak: ${name} references eval/tasks or grade/`);
	}
	const grade = gradeDirFor(dir);
	if (!existsSync(grade) || !readdirSync(grade).some((f) => f.endsWith(".grade.test.ts"))) violations.push("grade/ must hold at least one *.grade.test.ts");

	if (violations.length > 0) throw new Error(`task ${slug} is invalid:\n  - ${violations.join("\n  - ")}`);
	return taskMetaSchema.parse({
		slug, category, shape, dir, title: parsed!.title, taskSection: parsed!.taskSection,
		scopeBullets: parsed!.scopeBullets, acceptanceSection: parsed!.acceptanceSection,
		approach, budget: (budget as { success: true; data: TaskMeta["budget"] }).data,
	});
}

export function discoverTasks(tasksRoot: string): TaskMeta[] {
	return readdirSync(tasksRoot, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort()
		.map((slug) => loadTask(join(tasksRoot, slug)));
}
