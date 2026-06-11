import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

describe("README public contract", () => {
	const readme = read("README.md");

	it("opens with concise positioning, not phase/history framing", () => {
		// First non-title line should describe what the tool is.
		const firstPara = readme.split("\n").find((l) => l.trim() && !l.startsWith("#"));
		expect(firstPara).toMatch(/terminal-native|hand work back and forth|baton/i);
		// The rewrite drops phase-history framing from the README.
		expect(readme).not.toContain("Phase 7 is complete");
		expect(readme).not.toContain("## Phase Roadmap");
	});

	it("shows the magic-moment example with the real mount + workflow commands", () => {
		expect(readme).toContain("whisper collab mount claude");
		expect(readme).toContain("whisper collab mount codex");
		expect(readme).toContain("Run spec-driven-development using docs/spec.md");
	});

	it("explains implementer/reviewer, autonomy, review loops, resumability, deliverables", () => {
		expect(readme).toMatch(/implementer/i);
		expect(readme).toMatch(/reviewer/i);
		expect(readme).toMatch(/autonomous/i);
		expect(readme).toMatch(/review loop/i);
		expect(readme).toMatch(/resumab/i);
		expect(readme).toMatch(/deliverable/i);
	});

	it("includes a visual-proof section: poster image linking to the hosted demo page", () => {
		expect(readme).toMatch(/## Visual proof/);
		// Poster image (relative path — images render inline on GitHub) linking to the
		// ai-creed project page, where the demo video autoplays. The mp4 itself is hosted
		// on ai-creed, not committed here. NOT a <video> tag (GitHub strips those).
		expect(readme).toMatch(/\[!\[[^\]]*\]\(docs\/assets\/workflow-demo-poster\.png\)\]\(https:\/\/ai-creed\.dev\/projects\/ai-whisper\/?\)/);
		expect(readme).not.toMatch(/<video\b/);
		// The fabricate-nothing placeholder must be gone now that a real asset exists.
		expect(readme).not.toMatch(/TODO: add a real terminal screenshot or GIF/);
	});

	it("states who the project is for and who it is not for", () => {
		expect(readme).toMatch(/## Who this is for/);
		expect(readme).toMatch(/not\b/i);
		expect(readme).toMatch(/vibe coding/i);
	});

	it("has a minimal quickstart", () => {
		expect(readme).toMatch(/## Quickstart/);
		expect(readme).toContain("pnpm install");
		expect(readme).toContain("pnpm build");
		expect(readme).toContain("whisper skill install");
		expect(readme).toContain("whisper collab dashboard");
	});

	it("names the bundled code-review skill IN the required-skills section", () => {
		// Isolate the bundled-skills paragraph: from its intro sentence up to the
		// `whisper skill install` command. The skill name lives in that intro
		// sentence, so a stray mention elsewhere in the README cannot satisfy this.
		const sectionStart = readme.indexOf("Install the bundled agent skills");
		expect(sectionStart).toBeGreaterThan(-1);
		const installIdx = readme.indexOf("whisper skill install", sectionStart);
		expect(installIdx).toBeGreaterThan(sectionStart);
		const section = readme.slice(sectionStart, installIdx);
		expect(section).toContain("ai-whisper-code-review");
		expect(section).toContain("ai-whisper-plan-execution");
	});

	it("lists prerequisites (CLIs, Node, evaluator) with tmux marked optional", () => {
		expect(readme).toMatch(/## Prerequisites/);
		expect(readme).toMatch(/Claude Code CLI/);
		expect(readme).toMatch(/Codex CLI/);
		expect(readme).toMatch(/Node\.js 22/);
		// tmux must be present but explicitly optional (mount mode does not need it).
		expect(readme).toMatch(/tmux\b.*\*\(optional\)\*/);
	});

	it("surfaces the full-autonomy permissions note up front, naming the flags", () => {
		expect(readme).toMatch(/## Safety & permissions/);
		expect(readme).toContain("--dangerously-skip-permissions");
		expect(readme).toContain("--dangerously-bypass-approvals-and-sandbox");
		// Safety must appear BEFORE the Quickstart mount commands, not buried later.
		expect(readme.indexOf("## Safety & permissions")).toBeLessThan(readme.indexOf("## Quickstart"));
	});

	it("reassures that escalation is normal, not failure", () => {
		expect(readme).toMatch(/## What happens if it fails\?/);
		expect(readme).toMatch(/escalat/i);
		expect(readme).toContain("whisper workflow resume");
	});

	it("covers the required capability claims", () => {
		expect(readme).toMatch(/terminal-native/i);
		expect(readme).toMatch(/Claude/);
		expect(readme).toMatch(/Codex/);
		expect(readme).toMatch(/provider-agnostic/i);
	});

	it("routes deep detail to docs instead of embedding it", () => {
		expect(readme).toContain("docs/workflows.md");
		expect(readme).toContain("docs/concepts.md");
		expect(readme).toContain("docs/relay-handoff-flows.md");
		expect(readme).toContain("docs/evaluator-configuration.md");
		// Deep internals must not be embedded in the README anymore.
		expect(readme).not.toContain("## Capture status");
		expect(readme).not.toContain("Owner controls inside mounted tab");
	});
});

describe("docs and assets routed from the README exist", () => {
	it.each([
		"docs/workflows.md",
		"docs/concepts.md",
		"docs/relay-handoff-flows.md",
		"docs/evaluator-configuration.md",
		"docs/legacy-attach.md",
		"docs/assets/workflow-demo-poster.png",
	])("%s is present", (rel) => {
		expect(existsSync(resolve(root, rel))).toBe(true);
	});
});

describe("concepts doc contract", () => {
	const concepts = read("docs/concepts.md");

	it("explains the core mental-model points", () => {
		expect(concepts).toMatch(/not a swarm/i);
		expect(concepts).toMatch(/baton/i);
		expect(concepts).toMatch(/one owner at a time/i);
		expect(concepts).toMatch(/source of truth/i);
		expect(concepts).toMatch(/inspectable|supervised/i);
		expect(concepts).toMatch(/resumab/i);
		expect(concepts).toMatch(/workflow/i);
	});
});
