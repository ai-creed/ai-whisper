import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import globals from "globals";
import tseslint from "typescript-eslint";

const typedConfigs = tseslint.configs.recommendedTypeChecked.map((config) => ({
	...config,
	files: ["**/*.ts"],
}));

export default tseslint.config(
	{
		ignores: [
			"**/dist/**",
			"**/coverage/**",
			"**/node_modules/**",
			"**/.worktrees/**",
			"**/deprecated/**",
			"docs/**",
			"scripts/**",
			// Bundled skill content synced verbatim from ai-skills (SKILL.md +
			// eval fixtures under */evals/**). These `.ts` fixtures are skill eval
			// inputs, not project source, and belong to no tsconfig — so the typed
			// lint's project service can't parse them. Treat the whole bundle tree
			// as non-source, like docs/ and scripts/ above.
			"packages/cli/skills/**",
		],
	},
	js.configs.recommended,
	{
		files: ["**/*.{ts,js,mjs,cjs}"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		plugins: {
			"@stylistic": stylistic,
		},
		rules: {
			"no-var": "error",
			"no-eval": "error",
			"no-trailing-spaces": "error",
			"no-multiple-empty-lines": ["error", { max: 1, maxEOF: 1 }],
			"@stylistic/quotes": ["error", "double", { avoidEscape: true }],
			"@stylistic/semi": ["error", "always"],
			"@stylistic/comma-dangle": ["error", "always-multiline"],
		},
	},
	...typedConfigs,
	{
		files: ["**/*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	{
		// Test files routinely define mock methods that satisfy an async-returning
		// interface contract without actually awaiting anything.
		files: ["test/**/*.ts"],
		rules: {
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/await-thenable": "off",
		},
	},
);
