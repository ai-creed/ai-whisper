/**
 * Resolve whether the duo character banner + persona are enabled for a mount.
 *
 * Precedence mirrors {@link resolveTurnEvents} (flag > env > default ON):
 * - `duoFlag === false` (from commander's `--no-duo`) always disables.
 * - Else if `AI_WHISPER_DUO` is one of `off`, `0`, `false`, `none`
 *   (case-insensitive, trimmed) it disables.
 * - Else the feature is enabled (default ON; any unrecognized env value falls
 *   through to enabled).
 *
 * Note: there is no positive `--duo` flag — commander's `--no-duo` yields
 * `opts.duo === true` by default and `false` only when the user passes it. A
 * `true` value therefore cannot override a disabling env value; this is
 * intentional (only a negative flag exists).
 */
export function resolveDuoEnabled(duoFlag: boolean | undefined): boolean {
	if (duoFlag === false) return false;
	const raw = process.env["AI_WHISPER_DUO"];
	if (raw !== undefined) {
		const normalized = raw.trim().toLowerCase();
		if (
			normalized === "off" ||
			normalized === "0" ||
			normalized === "false" ||
			normalized === "none"
		) {
			return false;
		}
	}
	return true;
}
