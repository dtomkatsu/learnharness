/**
 * The lesson vocabulary (2026-11) — the remedy for concepts thrown at the
 * learner before they are taught. Pure helpers shared by plan_init (the
 * declared prerequisites), the after-turn vocabulary check (what was taught,
 * what was used too early), side-question creation, and the lesson-notes
 * marker that hands what was found back to the teacher.
 */
import type { LessonVocabulary, VocabFlag, VocabSideQuestion, VocabTerm } from "./contracts.ts";

/** A term as compared: case, spacing, quotes and a trailing plural "s" are not differences. */
export function normTerm(t: string): string {
	let s = String(t).toLowerCase().replace(/[“”"‘’`]/g, "").replace(/\s+/g, " ").trim();
	if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
	return s;
}

export function emptyVocabulary(): LessonVocabulary {
	return { terms: [], flagged: [], sideQuestions: [] };
}

/** The set of terms the learner can be assumed to hold now (taught or known). */
export function heldTerms(v: LessonVocabulary | undefined): Set<string> {
	return new Set((v?.terms ?? []).map((t) => normTerm(t.term)));
}

// ─── plan_init: declared prerequisites ──────────────────────────────────────

export interface PlanVocabularyInput {
	/** Terms the learner already holds (from the probe) — need no teaching. */
	known?: string[];
	/** Per node id: the terms it introduces, and the terms it needs already taught. */
	nodes: Record<string, { introduces?: string[]; needs?: string[] }>;
}

/**
 * Every term a node needs must be held before it: known, or introduced by a
 * node it (transitively) requires. Returns one problem line per violation —
 * empty when the plan is sound. `edges` are requires edges (from must be
 * understood before to).
 */
export function planVocabularyProblems(
	nodeIds: readonly string[],
	edges: readonly { from: string; to: string }[],
	vocab: PlanVocabularyInput,
): string[] {
	const problems: string[] = [];
	const ids = new Set(nodeIds);
	for (const id of Object.keys(vocab.nodes)) {
		if (!ids.has(id)) problems.push(`vocabulary names node "${id}", which is not in the map.`);
	}
	const parents = new Map<string, string[]>();
	for (const e of edges) (parents.get(e.to) ?? parents.set(e.to, []).get(e.to)!).push(e.from);
	const ancestors = (id: string): Set<string> => {
		const out = new Set<string>(), stack = [...(parents.get(id) ?? [])];
		while (stack.length) { const p = stack.pop()!; if (out.has(p)) continue; out.add(p); stack.push(...(parents.get(p) ?? [])); }
		return out;
	};
	const known = new Set((vocab.known ?? []).map(normTerm));
	const introducedBy = new Map<string, string[]>();
	for (const [id, n] of Object.entries(vocab.nodes)) for (const t of n.introduces ?? []) (introducedBy.get(normTerm(t)) ?? introducedBy.set(normTerm(t), []).get(normTerm(t))!).push(id);
	for (const id of nodeIds) {
		const n = vocab.nodes[id]; if (!n) continue;
		const before = ancestors(id);
		for (const t of n.needs ?? []) {
			const k = normTerm(t); if (!k || known.has(k)) continue;
			const by = introducedBy.get(k) ?? [];
			if (by.some((b) => before.has(b))) continue;
			problems.push(
				by.length
					? `node "${id}" needs "${t}", but it is introduced only by ${by.map((b) => `"${b}"`).join(", ")}, which ${by.length > 1 ? "do" : "does"} not come before "${id}" — add the edge, or move the term.`
					: `node "${id}" needs "${t}", but no node introduces it and it is not in known — add it to a prerequisite node\x27s introduces (or a new node), or to known if the learner already holds it.`,
			);
		}
	}
	return problems;
}

/** The plan declaration as stored on the ledger (normalized lists). */
export function plannedFrom(vocab: PlanVocabularyInput): Record<string, { introduces: string[]; needs: string[] }> {
	const out: Record<string, { introduces: string[]; needs: string[] }> = {};
	for (const [id, n] of Object.entries(vocab.nodes)) out[id] = { introduces: [...(n.introduces ?? [])], needs: [...(n.needs ?? [])] };
	return out;
}

/** Adds terms to the ledger, skipping any already there. */
export function addTerms(v: LessonVocabulary, terms: readonly VocabTerm[]): void {
	const have = heldTerms(v);
	for (const t of terms) {
		const k = normTerm(t.term); if (!k || have.has(k)) continue;
		have.add(k); v.terms.push(t);
	}
	// a term now held (taught since, or the learner turned out to know it) is no longer a gap waiting to be reported
	v.flagged = v.flagged.filter((f) => !have.has(normTerm(f.term)));
}

/** Flags terms used before teaching, once each (not if held or already waiting). */
export function addFlags(v: LessonVocabulary, flags: readonly VocabFlag[]): void {
	const held = heldTerms(v), waiting = new Set(v.flagged.map((f) => normTerm(f.term)));
	for (const f of flags) {
		const k = normTerm(f.term); if (!k || held.has(k) || waiting.has(k)) continue;
		waiting.add(k); v.flagged.push(f);
	}
}

// ─── the teacher\x27s side: briefs and notes ──────────────────────────────────

/** What a demo or figure brief carries so the builder (who never sees the
 *  lesson) uses only the words the learner has: empty when nothing is held. */
export function vocabularyBriefSuffix(v: LessonVocabulary | undefined): string {
	const terms = (v?.terms ?? []).map((t) => t.term);
	if (terms.length === 0) return "";
	return "\n\nVOCABULARY — the learner has been taught (or already knew) only these technical terms: " +
		terms.slice(-80).join(", ") +
		". Any label, caption or control name must use these or plain everyday words; if another technical term is unavoidable, define it in a few words on the artifact itself.";
}

/** The lesson-notes text for the teacher\x27s next turn, or null when there is nothing to say. */
export function lessonNotesText(flags: readonly VocabFlag[], side: readonly VocabSideQuestion[]): string | null {
	if (flags.length === 0 && side.length === 0) return null;
	// The bracket convention (graph-context\x27s PREAMBLE LAW): this arrives on the
	// user channel, so it says plainly that it is the app speaking, not the learner.
	const lines = ["[Lesson notes] — from the app\x27s vocabulary check, not from the learner:"];
	if (flags.length) {
		lines.push("", "Used before they were taught (the learner had no way to know them yet):",
			...flags.map((f) => `- "${f.term}" — ${f.where}`),
			"Before going further, repair each briefly: a plain one-sentence meaning built from what the learner already holds (or rephrase without it), and check it landed if it is load-bearing. Then continue the lesson.");
	}
	if (side.length) {
		lines.push("", "The learner opened a side question to ask what these mean:",
			...side.map((s) => `- "${s.term}"`),
			"Each is a gap in the foundation the lesson assumed. If it is load-bearing, make sure the lesson now covers it — add it to the map if the structure changed — and confirm it landed before building on it.");
	}
	return lines.join("\n");
}

// ─── the after-turn check ────────────────────────────────────────────────────

export const VOCABULARY_CHECK_PROMPT = `You audit one stretch of a tutor\x27s lesson for vocabulary.

You are given: the terms the learner already holds (taught earlier in the lesson, or known to them), terms the plan schedules for later, what the learner has written, and the tutor\x27s newest teaching.

Find every TECHNICAL term — jargon, notation, named concepts, acronyms — in the tutor\x27s newest teaching, and sort it:
- "introduced": the newest teaching itself teaches it — gives its meaning in plain words before or as it uses it. Give a one-line gloss.
- "unexplained": it is used as if the learner already knew it, but it is not in the held list, the learner has not used it themselves, and the teaching does not explain it where it is used. Say briefly where it appears.
- Ignore everyday words, terms in the held list, and terms the learner used first (put those in "learnerUsed").

Be strict about "unexplained" only for words a learner at this level could not be expected to know; when in doubt, leave it out. General school vocabulary (noun, verb, pronoun, prefix, suffix, particle, fraction, probability, average, function…) is NOT unexplained unless the learner showed they lack it; flag the subject's own terms, not the language used to talk about any subject.

Then, about the LEARNER (only from what they wrote):
- "usedCorrectly": HELD terms the learner used themselves, correctly, in their own words.
- "misused": HELD terms the learner used wrongly — {"term","how"}.
- "drift": HELD terms the TUTOR (or learner) now uses with a different meaning than the one in the held list — {"term","taughtAs","nowAs"}.
- "verdicts": for each UNGRADED ANSWER listed, whether the tutor's newest teaching judged it right — {"id","correct":true|false}. Omit any the teaching does not judge.
- "misconceptions": for each MISSED or ungraded-wrong answer whose reasoning states a SPECIFIC wrong belief — {"id","term"?,"belief"} (belief: one short sentence, in the learner's terms; term: the held term it is about, if one). Not for blanks or guesses.

Reply with JSON only, no prose:
{"introduced":[{"term":"…","gloss":"…"}],"unexplained":[{"term":"…","where":"…"}],"learnerUsed":["…"],"usedCorrectly":["…"],"misused":[{"term":"…","how":"…"}],"drift":[{"term":"…","taughtAs":"…","nowAs":"…"}],"verdicts":[{"id":"…","correct":true}],"misconceptions":[{"id":"…","term":"…","belief":"…"}]}`;

export interface VocabularyCheckReply {
	introduced: { term: string; gloss: string }[];
	unexplained: { term: string; where: string }[];
	learnerUsed: string[];
	usedCorrectly: string[];
	misused: { term: string; how: string }[];
	drift: { term: string; taughtAs: string; nowAs: string }[];
	verdicts: { id: string; correct: boolean }[];
	misconceptions: { id: string; term: string; belief: string }[];
}

/** The checker\x27s JSON, tolerant of a code fence or prose around it; null when unreadable. */
export function parseVocabularyReply(text: string): VocabularyCheckReply | null {
	const m = /\{[\s\S]*\}/.exec(String(text)); if (!m) return null;
	let o: any; try { o = JSON.parse(m[0]); } catch { return null; }
	const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
	const arr = (x: unknown) => (Array.isArray(x) ? x : []);
	return {
		introduced: arr(o.introduced).map((x: any) => ({ term: str(x?.term), gloss: str(x?.gloss) })).filter((x) => x.term).slice(0, 40),
		unexplained: arr(o.unexplained).map((x: any) => ({ term: str(x?.term), where: str(x?.where) })).filter((x) => x.term).slice(0, 20),
		learnerUsed: arr(o.learnerUsed).map(str).filter(Boolean).slice(0, 40),
		usedCorrectly: arr(o.usedCorrectly).map(str).filter(Boolean).slice(0, 40),
		misused: arr(o.misused).map((x: any) => ({ term: str(x?.term), how: str(x?.how) })).filter((x) => x.term).slice(0, 20),
		drift: arr(o.drift).map((x: any) => ({ term: str(x?.term), taughtAs: str(x?.taughtAs), nowAs: str(x?.nowAs) })).filter((x) => x.term && x.taughtAs && x.nowAs).slice(0, 10),
		verdicts: arr(o.verdicts).map((x: any) => ({ id: str(x?.id), correct: x?.correct === true })).filter((x) => x.id).slice(0, 20),
		misconceptions: arr(o.misconceptions).map((x: any) => ({ id: str(x?.id), term: str(x?.term), belief: str(x?.belief) })).filter((x) => x.belief).slice(0, 10),
	};
}

/** The user message for the checker: held terms, planned-later terms, the learner\x27s words, the newest teaching. */
export function vocabularyCheckInput(v: LessonVocabulary | undefined, learnerText: string, teaching: string, answers: readonly { id: string; question: string; answer: string; thinking?: string; graded: "ungraded" | "missed" }[] = []): string {
	const held = (v?.terms ?? []).map((t) => (t.gloss ? `${t.term} (${t.gloss})` : t.term));
	const heldSet = heldTerms(v);
	const later = Object.values(v?.planned ?? {}).flatMap((n) => n.introduces).filter((t) => !heldSet.has(normTerm(t)));
	return [
		"HELD (taught or known): " + (held.length ? held.join(", ") : "(nothing yet)"),
		"PLANNED FOR LATER IN THE LESSON (not yet held — using one now is unexplained unless the teaching explains it): " + (later.length ? [...new Set(later)].join(", ") : "(none)"),
		"",
		"WHAT THE LEARNER HAS WRITTEN (recent):",
		learnerText.trim() || "(nothing)",
		"",
		"LEARNER ANSWERS IN THIS STRETCH (ungraded = judge from the teaching; missed = already wrong, read the reasoning):",
		...(answers.length ? answers.map((a) => `- [${a.id}] (${a.graded}) Q: ${a.question} | answered: ${a.answer || "(nothing)"}${a.thinking ? ` | reasoning: ${a.thinking}` : ""}`) : ["(none)"]),
		"",
		"THE TUTOR\x27S NEWEST TEACHING:",
		teaching.trim(),
	].join("\n");
}
