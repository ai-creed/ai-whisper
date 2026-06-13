import { describe, expect, it } from "vitest";
import { injectedWrite } from "../packages/cli/src/runtime/injected-input.ts";

describe("injectedWrite (injected/relayed input path)", () => {
	it("submits the value as a turn and NEVER consults the operator slash-command seam", () => {
		const calls = {
			submits: [] as string[],
			consumed: [] as string[],
		};
		const session = {
			writeUserInput(data: string) {
				calls.submits.push(data);
			},
			// Spied — must remain untouched by the injected path. A relayed line that
			// starts with `/` is real turn content, not an operator command.
			tryConsumeLocalCommand(line: string): Promise<boolean> {
				calls.consumed.push(line);
				return Promise.resolve(true);
			},
		};

		// A relayed/injected line that LOOKS like a slash command.
		injectedWrite(session, "/help");

		expect(calls.submits).toEqual(["/help"]);
		// The guard: injected input must never route through tryConsumeLocalCommand.
		// If a future change wires the injected path through the seam, this fails.
		expect(calls.consumed).toEqual([]);
	});
});
