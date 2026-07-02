import { DUOS, type DuoRole } from "./duo-table.js";

/** One rolled character's slot in the duo: which character, and which
 * cosmetic role it was assigned for this roll. */
export interface RolledSlot {
	characterId: string;
	characterName: string;
	role: DuoRole;
}

/** The outcome of {@link rollDuo}: a duo id and its two character slots. */
export interface RolledDuo {
	duoId: string;
	slots: [RolledSlot, RolledSlot];
}

/**
 * Roll a random duo from {@link DUOS} and assign complementary reviewer /
 * implementer roles to its two characters (one of each, chosen randomly).
 *
 * `rng` is injected for deterministic tests and must behave like
 * `Math.random` — return a value in `[0, 1)` — which is also the default.
 */
export function rollDuo(rng: () => number = Math.random): RolledDuo {
	const duo = DUOS[Math.floor(rng() * DUOS.length)]!;
	const reviewerIndex = Math.floor(rng() * 2);

	const slots = duo.characters.map((character, index) => ({
		characterId: character.id,
		characterName: character.displayName,
		role: (index === reviewerIndex
			? "reviewer"
			: "implementer") satisfies DuoRole,
	})) as [RolledSlot, RolledSlot];

	return { duoId: duo.id, slots };
}
