import { DUOS, type DuoCharacter, type DuoRole } from "./duo-table.js";

/** One rolled character's slot in the duo: which character, and which
 * cosmetic role it carries for this roll. */
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
 * Roll a random duo from {@link DUOS}. Roles are NOT random: each character
 * carries its fixed body/brain role from the duo table, and the slots are
 * ordered body-first because slot order IS claim order — the broker hands
 * slot 0 to the first claimant (`claimDuoCharacter`), so the first mount
 * always gets the body and the second mount the brain.
 *
 * `rng` is injected for deterministic tests and must behave like
 * `Math.random` — return a value in `[0, 1)` — which is also the default.
 */
export function rollDuo(rng: () => number = Math.random): RolledDuo {
	const duo = DUOS[Math.floor(rng() * DUOS.length)]!;
	const body = duo.characters.find((character) => character.role === "body")!;
	const brain = duo.characters.find((character) => character.role === "brain")!;

	const toSlot = (character: DuoCharacter): RolledSlot => ({
		characterId: character.id,
		characterName: character.displayName,
		role: character.role,
	});

	return { duoId: duo.id, slots: [toSlot(body), toSlot(brain)] };
}
