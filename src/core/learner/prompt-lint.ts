/**
 * Heuristics for a vague open prompt (2026-11) — what the card writer and the tutor are told not to write, as a check:
 * two asks in one ("X, and Y?" / two question marks), an unbounded opener ("what happens to…", "what do you know about…",
 * "explain…"). Cheap and blunt on purpose: it finds the sure cases (a baseline, and a regression check on a rewrite), it
 * does not judge the merely open ones.
 */
export type VagueFlag = "two-asks" | "unbounded";

export function lintPrompt(prompt: string): VagueFlag[] {
	const p = prompt.trim(), out: VagueFlag[] = [];
	if ((p.match(/\?/g) ?? []).length > 1 || /,?\s+and\s+(what|how|why|which|where|when)\b/i.test(p) || /\band why\s*\?\s*$/i.test(p)) out.push("two-asks");
	if (/\bwhat happens to\b/i.test(p) || /what do you know about/i.test(p) || /^(explain|describe|discuss|tell me)\b/i.test(p)) out.push("unbounded");
	return out;
}

/** The open faces of a card (recall, why, discriminate, apply — not the word-for-word ones: produce, cloze). */
export function openPrompts(card: { recall?: { prompt?: string }; why?: { prompt?: string }; discriminate?: { prompt?: string }; apply?: { prompt?: string }[] }): { mode: string; prompt: string }[] {
	const out: { mode: string; prompt: string }[] = [];
	for (const m of ["recall", "why", "discriminate"] as const) { const f = card[m]; if (f?.prompt) out.push({ mode: m, prompt: f.prompt }); }
	for (const a of card.apply ?? []) if (a?.prompt) out.push({ mode: "apply", prompt: a.prompt });
	return out;
}
