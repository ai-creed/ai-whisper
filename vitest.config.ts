import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: { jsx: "automatic", jsxImportSource: "react" },
	resolve: {
		alias: {
			"@ai-whisper/shared": resolve(__dirname, "packages/shared/src/index.ts"),
			"@ai-whisper/broker": resolve(__dirname, "packages/broker/src/index.ts"),
			"@ai-whisper/companion-core": resolve(
				__dirname,
				"packages/companion-core/src/index.ts",
			),
			"ai-whisper": resolve(__dirname, "packages/cli/src/index.ts"),
			"@ai-whisper/adapter-codex": resolve(
				__dirname,
				"packages/adapter-codex/src/index.ts",
			),
			"@ai-whisper/adapter-ai-ezio": resolve(
				__dirname,
				"packages/adapter-ai-ezio/src/index.ts",
			),
			"@ai-whisper/adapter-claude": resolve(
				__dirname,
				"packages/adapter-claude/src/index.ts",
			),
			"@ai-ezio/harness": resolve(
				__dirname,
				"../ai-ezio/packages/harness/dist/index.js",
			),
			"@ai-ezio/protocol": resolve(
				__dirname,
				"../ai-ezio/packages/protocol/dist/index.js",
			),
			"@ai-ezio/mcp-host": resolve(
				__dirname,
				"../ai-ezio/packages/mcp-host/dist/index.js",
			),
			"@ai-ezio/surface": resolve(
				__dirname,
				"../ai-ezio/packages/surface/dist/index.js",
			),
		},
	},
	test: {
		environment: "node",
		include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
		setupFiles: ["test/setup-color.ts"],
		// Several integration tests spawn processes / poll real DBs and brokers.
		// The 5s default flakes for them under full-suite parallel contention
		// (they pass in isolation), so raise the ceiling while staying low enough
		// to surface genuine hangs.
		testTimeout: 15_000,
		hookTimeout: 15_000,
		// Absorb environmental flakes in the spawn/poll-heavy integration tests
		// (e.g. collab-mount-auto-create's waitForBrokerReady poll can be starved
		// under full-suite CPU contention — reproducible on a clean baseline). A
		// genuinely broken test still fails on every retry; this only rescues a
		// run that passes on a re-attempt.
		retry: 2,
	},
});
