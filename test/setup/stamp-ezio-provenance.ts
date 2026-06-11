// Vitest globalSetup: regenerate the gitignored provenance module before the
// suite so test files that statically import it resolve. Runs once per run.
import { generate } from "../../packages/cli/scripts/stamp-ezio-provenance.mjs";

export default function setup(): void {
	generate();
}
