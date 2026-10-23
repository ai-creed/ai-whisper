export type VersionCheckContext = "show" | "reply" | "turn-done";

export function checkCliBrokerVersion(input: {
	cliVersion: string;
	brokerVersion: string | null;
	context: VersionCheckContext;
}): { ok: true } | { ok: false; message: string } {
	if (input.brokerVersion === input.cliVersion) return { ok: true };
	const head = `ai-whisper CLI ${input.cliVersion} does not match the running broker ${input.brokerVersion ?? "unknown"}.`;
	const tail = "Do not read ~/.ai-whisper/state.db directly.";
	const action =
		input.context === "reply"
			? "Your reply was not recorded. End your turn with your complete handback as your final message; ai-whisper will capture it."
			: "Stop here and end your turn; ai-whisper will resend this handoff.";
	return { ok: false, message: `${head} ${action} ${tail}` };
}
