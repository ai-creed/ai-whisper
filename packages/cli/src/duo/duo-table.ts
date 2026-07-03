/** Cosmetic-only flavor for a rolled character's assignment; carries no
 * behavioral meaning beyond what is printed in the mount banner and persona
 * text. Deliberately metaphorical ("he got the brain, I got the body, the
 * face, and the hair") rather than "reviewer"/"implementer", so the duo
 * flavor can never be confused with the workflow's REAL role bindings. The
 * body is the sidekick/doer and always goes to the FIRST mount; the brain to
 * the second. */
export type DuoRole = "body" | "brain";

/** One movie-duo character: the identity, its fixed body/brain role, its
 * summon banner text, its catchphrase, and the bundled ASCII art file that
 * draws it. */
export interface DuoCharacter {
	id: string;
	role: DuoRole;
	displayName: string;
	summonName: string;
	punchline: string;
	artFile: string;
}

/** A movie duo — always exactly two characters. */
export interface Duo {
	id: string;
	characters: [DuoCharacter, DuoCharacter];
}

/**
 * The complete, bundled duo registry — seven duos, fourteen characters.
 * Authoritative data from the mount-duo-art design spec; punchlines are
 * byte-exact quotes and must not be edited casually.
 */
export const DUOS: readonly Duo[] = [
	{
		id: "sherlock-watson",
		characters: [
			{
				id: "sherlock",
				role: "brain",
				displayName: "Sherlock",
				summonName: "SHERLOCK",
				punchline: "Elementary, my dear Watson.",
				artFile: "sherlock.txt",
			},
			{
				id: "watson",
				role: "body",
				displayName: "Watson",
				summonName: "WATSON",
				punchline: "By Jove, Holmes — it works!",
				artFile: "watson.txt",
			},
		],
	},
	{
		id: "frankenstein-igor",
		characters: [
			{
				id: "frankenstein",
				role: "brain",
				displayName: "Frankenstein",
				summonName: "FRANKENSTEIN",
				punchline: "It's alive! IT'S ALIVE!",
				artFile: "frankenstein.txt",
			},
			{
				id: "igor",
				role: "body",
				displayName: "Igor",
				summonName: "IGOR",
				punchline: "It's pronounced 'eye-gor'.",
				artFile: "igor.txt",
			},
		],
	},
	{
		id: "quixote-sancho",
		characters: [
			{
				id: "quixote",
				role: "brain",
				displayName: "Don Quixote",
				summonName: "DON QUIXOTE",
				punchline: "Those are not windmills — they are giants!",
				artFile: "quixote.txt",
			},
			{
				id: "sancho",
				role: "body",
				displayName: "Sancho Panza",
				summonName: "SANCHO PANZA",
				punchline: "Señor... those are windmills.",
				artFile: "sancho.txt",
			},
		],
	},
	{
		id: "c3po-r2d2",
		characters: [
			{
				id: "c3po",
				role: "body",
				displayName: "C-3PO",
				summonName: "C-3PO",
				punchline: "We're doomed!",
				artFile: "c3po.txt",
			},
			{
				id: "r2d2",
				role: "brain",
				displayName: "R2-D2",
				summonName: "R2-D2",
				punchline: "Beep boop bee-boop.",
				artFile: "r2d2.txt",
			},
		],
	},
	{
		id: "batman-robin",
		characters: [
			{
				id: "batman",
				role: "brain",
				displayName: "Batman",
				summonName: "BATMAN",
				punchline: "I'm Batman.",
				artFile: "batman.txt",
			},
			{
				id: "robin",
				role: "body",
				displayName: "Robin",
				summonName: "ROBIN",
				punchline: "Holy merge conflict, Batman!",
				artFile: "robin.txt",
			},
		],
	},
	{
		id: "rocket-groot",
		characters: [
			{
				id: "rocket",
				role: "brain",
				displayName: "Rocket",
				summonName: "ROCKET",
				punchline: "Ain't no thing like me, 'cept me!",
				artFile: "rocket.txt",
			},
			{
				id: "groot",
				role: "body",
				displayName: "Groot",
				summonName: "GROOT",
				punchline: "I am Groot.",
				artFile: "groot.txt",
			},
		],
	},
	{
		id: "walter-jesse",
		characters: [
			{
				id: "walter",
				role: "brain",
				displayName: "Walter White",
				summonName: "HEISENBERG",
				punchline: "I am the one who knocks.",
				artFile: "walter.txt",
			},
			{
				id: "jesse",
				role: "body",
				displayName: "Jesse Pinkman",
				summonName: "JESSE",
				punchline: "That's science, b*tch!",
				artFile: "jesse.txt",
			},
		],
	},
] as const;

/**
 * The metaphorical flavor phrase for a role — the Georgie Cooper split ("he
 * got the brain, I got the body, the face, and the hair"). Shared by the
 * summon banner and the persona brief so every surface phrases the roles
 * identically.
 */
export function duoRoleFlavor(role: DuoRole): string {
	return role === "brain"
		? "the brain of this operation"
		: "the body, the face, and the hair";
}

/**
 * Look up a duo by id. Unknown ids return `undefined` (this module never
 * throws on a bad lookup — callers decide how to handle a miss).
 */
export function getDuo(duoId: string): Duo | undefined {
	return DUOS.find((duo) => duo.id === duoId);
}

/**
 * Look up a character within a duo by (duoId, characterId). Unknown ids
 * return `undefined`, matching {@link getDuo}'s non-throwing style.
 */
export function getCharacter(
	duoId: string,
	characterId: string,
): DuoCharacter | undefined {
	return getDuo(duoId)?.characters.find(
		(character) => character.id === characterId,
	);
}
