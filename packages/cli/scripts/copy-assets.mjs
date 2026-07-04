#!/usr/bin/env node
import { cp, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
	const out = { src: null, dest: null };
	for (let i = 0; i < argv.length; i += 2) {
		if (argv[i] === "--src") out.src = argv[i + 1];
		else if (argv[i] === "--dest") out.dest = argv[i + 1];
	}
	if (!out.src || !out.dest) {
		// Defaults relative to this script's location:
		//   <pkg>/scripts/copy-assets.mjs → <pkg>/assets/ + <pkg>/dist/assets/
		const here = path.dirname(fileURLToPath(import.meta.url));
		const pkgRoot = path.resolve(here, "..");
		out.src = out.src ?? path.join(pkgRoot, "assets");
		out.dest = out.dest ?? path.join(pkgRoot, "dist", "assets");
	}
	return out;
}

const { src, dest } = parseArgs(process.argv.slice(2));
try {
	await stat(src);
} catch {
	console.error(`copy-assets: source directory not found at ${src}`);
	process.exit(1);
}
await cp(src, dest, { recursive: true });
console.log(`copy-assets: ${src} → ${dest}`);
