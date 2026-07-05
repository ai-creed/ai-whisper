/**
 * Resolve whether the duo character banner + persona are enabled for a mount.
 *
 * Duo is **default OFF** — a plain `whisper collab mount` summons nothing. It is
 * an opt-in feature, enabled per environment rather than per flag:
 * - `duoFlag === false` (from commander's `--no-duo`) always disables, even when
 *   the env would enable — the negative flag is the per-mount kill switch.
 * - Else duo is enabled ONLY when `AI_WHISPER_DUO` is one of `on`, `1`, `true`,
 *   `yes` (case-insensitive, trimmed).
 * - Every other value — unset, unrecognized (e.g. `banana`), or a legacy disable
 *   word (`off`, `0`, `false`, `none`) — resolves to disabled (default OFF).
 *
 * Note: there is no positive `--duo` flag — commander's `--no-duo` yields
 * `opts.duo === true` by default and `false` only when the user passes it. A
 * `true` value therefore neither enables on its own (the env opt-in is required)
 * nor blocks an enabling env; this is intentional (only a negative flag exists).
 */
export function resolveDuoEnabled(duoFlag: boolean | undefined): boolean {
	if (duoFlag === false) return false;
	const raw = process.env["AI_WHISPER_DUO"];
	if (raw === undefined) return false;
	const normalized = raw.trim().toLowerCase();
	return (
		normalized === "on" ||
		normalized === "1" ||
		normalized === "true" ||
		normalized === "yes"
	);
}
