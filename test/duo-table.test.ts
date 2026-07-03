import { describe, expect, it } from "vitest";
import {
	DUOS,
	getCharacter,
	getDuo,
} from "../packages/cli/src/duo/duo-table.ts";
import { rollDuo } from "../packages/cli/src/duo/roll-duo.ts";

// Authoritative table from the design spec — duoId order and character order
// within each duo mirror the spec exactly. Each character carries its fixed
// body/brain role: the body (sidekick/doer) is claimed by the first mount,
// the brain by the second.
const EXPECTED_CHARACTERS = [
	{
		duoId: "sherlock-watson",
		id: "sherlock",
		role: "brain",
		displayName: "Sherlock",
		summonName: "SHERLOCK",
		punchline: "Elementary, my dear Watson.",
		artFile: "sherlock.txt",
	},
	{
		duoId: "sherlock-watson",
		id: "watson",
		role: "body",
		displayName: "Watson",
		summonName: "WATSON",
		punchline: "By Jove, Holmes — it works!",
		artFile: "watson.txt",
	},
	{
		duoId: "frankenstein-igor",
		id: "frankenstein",
		role: "brain",
		displayName: "Frankenstein",
		summonName: "FRANKENSTEIN",
		punchline: "It's alive! IT'S ALIVE!",
		artFile: "frankenstein.txt",
	},
	{
		duoId: "frankenstein-igor",
		id: "igor",
		role: "body",
		displayName: "Igor",
		summonName: "IGOR",
		punchline: "It's pronounced 'eye-gor'.",
		artFile: "igor.txt",
	},
	{
		duoId: "quixote-sancho",
		id: "quixote",
		role: "brain",
		displayName: "Don Quixote",
		summonName: "DON QUIXOTE",
		punchline: "Those are not windmills — they are giants!",
		artFile: "quixote.txt",
	},
	{
		duoId: "quixote-sancho",
		id: "sancho",
		role: "body",
		displayName: "Sancho Panza",
		summonName: "SANCHO PANZA",
		punchline: "Señor... those are windmills.",
		artFile: "sancho.txt",
	},
	{
		duoId: "c3po-r2d2",
		id: "c3po",
		role: "body",
		displayName: "C-3PO",
		summonName: "C-3PO",
		punchline: "We're doomed!",
		artFile: "c3po.txt",
	},
	{
		duoId: "c3po-r2d2",
		id: "r2d2",
		role: "brain",
		displayName: "R2-D2",
		summonName: "R2-D2",
		punchline: "Beep boop bee-boop.",
		artFile: "r2d2.txt",
	},
	{
		duoId: "batman-robin",
		id: "batman",
		role: "brain",
		displayName: "Batman",
		summonName: "BATMAN",
		punchline: "I'm Batman.",
		artFile: "batman.txt",
	},
	{
		duoId: "batman-robin",
		id: "robin",
		role: "body",
		displayName: "Robin",
		summonName: "ROBIN",
		punchline: "Holy merge conflict, Batman!",
		artFile: "robin.txt",
	},
	{
		duoId: "rocket-groot",
		id: "rocket",
		role: "brain",
		displayName: "Rocket",
		summonName: "ROCKET",
		punchline: "Ain't no thing like me, 'cept me!",
		artFile: "rocket.txt",
	},
	{
		duoId: "rocket-groot",
		id: "groot",
		role: "body",
		displayName: "Groot",
		summonName: "GROOT",
		punchline: "I am Groot.",
		artFile: "groot.txt",
	},
	{
		duoId: "walter-jesse",
		id: "walter",
		role: "brain",
		displayName: "Walter White",
		summonName: "HEISENBERG",
		punchline: "I am the one who knocks.",
		artFile: "walter.txt",
	},
	{
		duoId: "walter-jesse",
		id: "jesse",
		role: "body",
		displayName: "Jesse Pinkman",
		summonName: "JESSE",
		punchline: "That's science, b*tch!",
		artFile: "jesse.txt",
	},
] as const;

const EXPECTED_DUO_IDS = [
	"sherlock-watson",
	"frankenstein-igor",
	"quixote-sancho",
	"c3po-r2d2",
	"batman-robin",
	"rocket-groot",
	"walter-jesse",
];

/** Build a stub rng that returns a fixed queue of values, repeating the last
 * value once exhausted (so a test can under-supply a queue without crashing). */
function seqRng(values: number[]): () => number {
	let i = 0;
	return () => {
		const v = values[Math.min(i, values.length - 1)] ?? 0;
		i += 1;
		return v;
	};
}

describe("DUOS data table", () => {
	it("has exactly 7 duos and 14 characters", () => {
		expect(DUOS).toHaveLength(7);
		expect(DUOS.flatMap((duo) => duo.characters)).toHaveLength(14);
	});

	it("has unique duo ids", () => {
		const ids = DUOS.map((duo) => duo.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("has unique character ids and displayNames across all duos", () => {
		const characters = DUOS.flatMap((duo) => duo.characters);
		expect(new Set(characters.map((c) => c.id)).size).toBe(characters.length);
		expect(new Set(characters.map((c) => c.displayName)).size).toBe(
			characters.length,
		);
	});

	it("matches the exact duo/character data from the design spec, punchlines byte-exact", () => {
		const actual = DUOS.flatMap((duo) =>
			duo.characters.map((character) => ({ duoId: duo.id, ...character })),
		);
		expect(actual).toEqual(EXPECTED_CHARACTERS);
	});

	it("gives every duo exactly one body and one brain", () => {
		for (const duo of DUOS) {
			expect(duo.characters.map((c) => c.role).sort()).toEqual([
				"body",
				"brain",
			]);
		}
	});
});

describe("getDuo / getCharacter", () => {
	it("returns the duo for a known id and undefined for an unknown id", () => {
		expect(getDuo("batman-robin")?.id).toBe("batman-robin");
		expect(getDuo("nonexistent-duo")).toBeUndefined();
	});

	it("returns the character for known duo/character ids and undefined otherwise", () => {
		expect(getCharacter("batman-robin", "batman")?.displayName).toBe("Batman");
		expect(getCharacter("batman-robin", "nonexistent")).toBeUndefined();
		expect(getCharacter("nonexistent-duo", "batman")).toBeUndefined();
	});
});

describe("rollDuo", () => {
	it("is deterministic given a stubbed rng", () => {
		const first = rollDuo(seqRng([0.4, 0.9]));
		const second = rollDuo(seqRng([0.4, 0.9]));
		expect(second).toEqual(first);
	});

	it("can produce every duo across the rng seed space", () => {
		const seen = new Set<string>();
		for (let i = 0; i < DUOS.length; i++) {
			// (i + 0.5) / length lands safely inside the i-th bucket regardless of
			// float rounding at the bucket edges.
			const rolled = rollDuo(seqRng([(i + 0.5) / DUOS.length, 0.25]));
			seen.add(rolled.duoId);
		}
		expect([...seen].sort()).toEqual([...EXPECTED_DUO_IDS].sort());
	});

	it("orders slots body-first with the table's fixed character roles (slot 0 = first claim)", () => {
		for (let i = 0; i < DUOS.length; i++) {
			const rolled = rollDuo(seqRng([(i + 0.5) / DUOS.length]));
			const duo = getDuo(rolled.duoId);
			expect(duo).toBeDefined();

			expect(rolled.slots).toHaveLength(2);
			const [bodySlot, brainSlot] = rolled.slots;
			expect(bodySlot.role).toBe("body");
			expect(brainSlot.role).toBe("brain");
			expect(bodySlot.characterId).not.toBe(brainSlot.characterId);
			for (const slot of rolled.slots) {
				const character = getCharacter(rolled.duoId, slot.characterId);
				expect(character).toBeDefined();
				expect(slot.role).toBe(character!.role);
				expect(slot.characterName).toBe(character!.displayName);
			}
		}
	});
});
