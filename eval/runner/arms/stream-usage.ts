import { ZERO_USAGE, addUsage, type UsageTotals } from "../types.ts";

type RawUsage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };

function toUsage(u: RawUsage | undefined): UsageTotals {
	const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	return { inputTokens: n(u?.input_tokens), outputTokens: n(u?.output_tokens), cacheWriteTokens: n(u?.cache_creation_input_tokens), cacheReadTokens: n(u?.cache_read_input_tokens) };
}

export class StreamUsageAccumulator {
	private readonly byMessage = new Map<string, UsageTotals>();
	private anonymous: UsageTotals = ZERO_USAGE;
	resultUsage: UsageTotals | null = null;
	resultCostUsd: number | null = null;
	/** The final result event's text, kept apart from assistant texts: only the CLI itself writes it. */
	resultText: string | null = null;
	resultSubtype: string | null = null;
	numTurns: number | null = null;
	sawResult = false;
	readonly texts: string[] = [];

	feed(line: string): void {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) return;
		let ev: { type?: string; subtype?: string; result?: string; message?: { id?: string; usage?: RawUsage; content?: Array<{ type?: string; text?: string }> }; usage?: RawUsage; total_cost_usd?: number; num_turns?: number };
		try { ev = JSON.parse(trimmed) as typeof ev; } catch { return; }
		if (ev.type === "assistant") {
			for (const block of ev.message?.content ?? []) if (block.type === "text" && typeof block.text === "string") this.texts.push(block.text);
			if (ev.message?.usage) {
				const u = toUsage(ev.message.usage);
				if (typeof ev.message.id === "string") this.byMessage.set(ev.message.id, u);
				else this.anonymous = addUsage(this.anonymous, u);
			}
		} else if (ev.type === "result") {
			if (typeof ev.result === "string" && ev.result.trim() !== (this.texts[this.texts.length - 1] ?? "").trim()) this.texts.push(ev.result);
			this.sawResult = true;
			this.resultText = typeof ev.result === "string" ? ev.result : null;
			this.resultSubtype = typeof ev.subtype === "string" ? ev.subtype : null;
			this.resultUsage = ev.usage ? toUsage(ev.usage) : null;
			this.resultCostUsd = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null;
			this.numTurns = typeof ev.num_turns === "number" ? ev.num_turns : null;
		}
	}

	get usage(): UsageTotals {
		let total = this.anonymous;
		for (const u of this.byMessage.values()) total = addUsage(total, u);
		return total;
	}

	finalUsage(): UsageTotals {
		return this.resultUsage ?? this.usage;
	}
}
