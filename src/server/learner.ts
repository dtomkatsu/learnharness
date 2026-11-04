/**
 * The learner service (2026-11): writes evidence from lesson records, builds
 * the learner state for the routes and the turn handler, generates and grades
 * review cards with the cheap model, and composes the parts of the lesson
 * notes that come from the learner model. See core/learner/model.ts.
 */
import { runSubagent } from "../agent/subagents/pi-run.ts";
import type { PiEngine } from "../agent/models.ts";
import type { ChatRecord } from "../core/contracts.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { normTerm } from "../core/vocabulary.ts";
import { isDue } from "../core/learner/fsrs.ts";
import {
	deriveLearner, effectiveRetrievability, isJunkTerm, lessonProgress, nodeItem, profileText, relatedItems, reviewQueue, termItem, uncheckedBefore,
	type ItemId, type ItemState, type LearnerEvent, type LearnerState, type ReviewMode,
} from "../core/learner/model.ts";
import { appendEvidence, hasCardMode, readCards, readEvidence, readExternal, readTidied, writeCards, writeTidied, type Card, type CardFace } from "../store/learner.ts";
import type { Rating } from "../core/learner/fsrs.ts";

export interface LearnerDeps {
	chatStore: ChatStore;
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
}

const QUESTIONS = new Set<string>(QUESTION_TOOLS);

export function learnerState(deps: LearnerDeps, now = Date.now()): LearnerState {
	const lessonTitles = new Map(deps.chatStore.listChats().map((c) => [c.id, c.title]));
	return deriveLearner(readEvidence(), { nodes: deps.graphStore.readNodes(), chains: deps.graphStore.readChains(), lessonTitles, external: readExternal() }, now);
}

// ─── evidence from the record (deterministic) ────────────────────────────────

type Block = { type: string; id?: string; name?: string; arguments?: Record<string, unknown>; text?: string };

/** Logs every answered question and concluded practice problem in the record not logged yet. Idempotent by call id. */
export function logRecordEvidence(record: ChatRecord, known: ReadonlySet<string> = loggedCallIds()): LearnerEvent[] {
	const calls = new Map<string, { messageId: string; name: string; args: Record<string, unknown> }>();
	const out: Omit<LearnerEvent, "id" | "at">[] = [];
	const planned = record.vocabulary?.planned ?? {};
	const lessonTerms = (record.vocabulary?.terms ?? []).filter((t) => t.source === "taught");
	let activeProblem: string[] = [];
	let teaching: string[] = [];   // assistant messages since the previous answer
	for (const m of record.messages as LhMessage[]) {
		const x = m as unknown as { role: string; id: string; content: Block[]; toolCallId?: string; toolName?: string; details?: unknown; timestamp?: number; stopReason?: string };
		if (x.role === "assistant" && Array.isArray(x.content) && x.stopReason !== "error" && x.stopReason !== "aborted") {
			teaching.push(x.id);
			for (const b of x.content) if (b.type === "toolCall" && b.id && b.name) {
				calls.set(b.id, { messageId: x.id, name: b.name, args: (b.arguments ?? {}) as Record<string, unknown> });
				if (b.name === "problem") {
					const t = (b.arguments as { target?: unknown })?.target;
					activeProblem = Array.isArray(t) ? t.filter((s): s is string => typeof s === "string") : [];
				}
			}
			continue;
		}
		if (x.role !== "toolResult" || !x.toolCallId) continue;
		const isAnswer = !!x.toolName && QUESTIONS.has(x.toolName);
		const context = teaching.slice(-6);
		if (isAnswer) teaching = [];
		if (known.has(record.id + ":" + x.toolCallId)) continue;
		const call = calls.get(x.toolCallId);
		const at = x.timestamp ? new Date(x.timestamp).toISOString() : undefined;
		if (x.toolName === "conclude" && call) {
			const a = call.args as { outcome?: string; rung?: string | null; missClass?: string | null };
			if (a.outcome && a.outcome !== "dismissed" && activeProblem.length) {
				out.push({ kind: "practice", chatId: record.id, toolCallId: x.toolCallId, items: activeProblem.map(nodeItem), outcome: a.outcome, rung: a.rung ?? null, missClass: a.missClass ?? null, ...(at ? { at } : {}) } as never);
			}
			activeProblem = [];
			continue;
		}
		if (!x.toolName || !QUESTIONS.has(x.toolName) || x.toolName === "ask_user_question") continue;
		const d = x.details as { kind?: string; questionText?: string; questionType?: string; dontKnow?: boolean; correct?: boolean; confidence?: number; thinking?: string; note?: string; dismissed?: boolean } | null;
		if (!d || typeof d !== "object" || d.dismissed) continue;
		const planNode = typeof call?.args.nodeId === "string" ? (call.args.nodeId as string) : undefined;
		const question = String(d.questionText ?? call?.args.question ?? "");
		const terms = new Set<string>();
		if (planNode && planned[planNode]) for (const t of [...planned[planNode]!.introduces, ...planned[planNode]!.needs]) terms.add(normTerm(t));
		const ql = normTerm(question);
		for (const t of lessonTerms) { const k = normTerm(t.term); if (k.length > 2 && ql.includes(k)) terms.add(k); }
		const outcome = d.dontKnow ? "dontknow" : d.kind === "quiz" ? (d.correct ? "correct" : "miss") : "unknown";
		out.push({
			kind: "answer", chatId: record.id, messageId: call?.messageId ?? "", toolCallId: x.toolCallId, tool: x.toolName,
			...(d.questionType ? { questionType: d.questionType } : {}), question,
			outcome, ...(d.confidence != null ? { confidence: d.confidence } : {}),
			...((d.thinking ?? d.note) ? { thinking: String(d.thinking ?? d.note).slice(0, 2000) } : {}),
			...(planNode ? { planNode } : {}),
			items: [...terms].slice(0, 4).map((k) => "term:" + k),
			...(context.length ? { context } : {}),
			...(at ? { at } : {}),
		} as never);
	}
	return appendEvidence(out as never);
}

export function loggedCallIds(events: readonly LearnerEvent[] = readEvidence()): Set<string> {
	return new Set(events.flatMap((e) => (e.kind === "answer" || e.kind === "practice" ? [e.chatId + ":" + e.toolCallId] : [])));
}

/** Unjudged explain answers in a record: toolCallId → question + the learner's answer. */
export function unjudgedAnswers(record: ChatRecord, events: readonly LearnerEvent[] = readEvidence()): { toolCallId: string; question: string; answer: string; thinking?: string }[] {
	const judged = new Set(events.flatMap((e) => (e.kind === "verdict" ? [e.toolCallId] : [])));
	return events.filter((e): e is Extract<LearnerEvent, { kind: "answer" }> => e.kind === "answer" && e.chatId === record.id && e.outcome === "unknown" && !judged.has(e.toolCallId))
		.map((e) => {
			const r = (record.messages as LhMessage[]).find((m) => (m as { toolCallId?: string }).toolCallId === e.toolCallId) as { details?: { text?: string; answers?: { label: string }[] } } | undefined;
			return { toolCallId: e.toolCallId, question: e.question, answer: r?.details?.text ?? (r?.details?.answers ?? []).map((a) => a.label).join(", "), thinking: e.thinking };
		});
}

/** Missed answers with the learner's own reasoning — where a misconception can be read. */
export function missedWithThinking(chatId: string, since: string | undefined, events: readonly LearnerEvent[] = readEvidence()) {
	return events.filter((e): e is Extract<LearnerEvent, { kind: "answer" }> => e.kind === "answer" && e.chatId === chatId && (e.outcome === "miss") && !!e.thinking && (!since || e.at > since));
}

// ─── cards ───────────────────────────────────────────────────────────────────

const CARD_PROMPT = `You write review cards for a learner's spaced-repetition queue.

For each item you get its label, kind (term or proposition), the meaning as it was taught (may be empty — then write a correct, plain one-sentence meaning from the context given), its premises (propositions it follows from), any wrong beliefs the learner has held about it, and how often it has been forgotten.

Write, per item:
- "meaning": the meaning in one or two plain sentences (keep the taught meaning's sense; improve wording only).
- "recall": prompt = asks for the item's meaning or content WITHOUT giving it away (for a term: "What does X mean?" plus a cue of context; for a proposition: a question whose answer is the proposition); answer = the meaning.
- "produce": the reverse — prompt = the meaning or a small concrete situation where it applies; answer = the term or the proposition's name. Terms always; propositions when they have a recognizable name.
- "why": propositions with premises only — prompt = "Why is it true that …?"; answer = how it follows from the premises, in two or three sentences.
- "cloze": only when there is a formula, definition or exact phrase worth memorizing verbatim — prompt = the statement with the key part replaced by "____"; answer = the missing part.
- "discriminate": only when a wrong belief is listed — prompt = sets the item beside the thing it was confused with and asks what separates them; answer = the distinction; with = the confused-with thing in a few words.
- "elaboration": only when lapses ≥ 2 — re-derive it from something more basic the learner would accept, in the spirit of "how could I have discovered this?" (3–5 sentences).
- "hook": only when lapses ≥ 3 — one memory hook: a vivid image, a contrast pair, or an etymology that is TRUE. Never invent etymology.

An item with "lang" is a WORD OF A LANGUAGE the learner is learning (lang is its BCP-47 code; the learner's own language is English). For those:
- "recall": prompt = the word itself in that language, asking what it means in English (no translation in the prompt); answer = the English meaning, with usage notes if any (register, particle force).
- "produce": ALWAYS — prompt = "How do you say … ?" with the English meaning and, if helpful, a tiny situation; answer = the word in that language.
- "example": ALWAYS — a short natural sentence in that language using the word ("sentence") and its English translation ("translation"). Use the one given if there is one; otherwise write an everyday one.
- "cloze": the example sentence with the word replaced by "____" (prompt, followed by the English translation in brackets); answer = the word.

Plain words; one idea per card; no answer may be guessable from its prompt. Reply with JSON only:
{"cards":[{"id":"…","meaning":"…","recall":{"prompt":"…","answer":"…"},"produce":{…}?,"why":{…}?,"cloze":{…}?,"discriminate":{"prompt":"…","answer":"…","with":"…"}?,"elaboration":"…"?,"hook":"…"?,"example":{"sentence":"…","translation":"…"}?}]}`;

function jsonOf(text: string): any {
	const m = /\{[\s\S]*\}/.exec(text); if (!m) return null;
	try { return JSON.parse(m[0]); } catch { return null; }
}
const face = (x: any): CardFace | undefined => (x && typeof x.prompt === "string" && typeof x.answer === "string" && x.prompt.trim() && x.answer.trim() ? { prompt: x.prompt.trim(), answer: x.answer.trim() } : undefined);

/** The card an item can always be asked with, model or not. */
export function fallbackCard(it: ItemState): Card {
	const meaning = it.meaning || "(no meaning recorded yet)";
	const ex = it.example ? { sentence: it.example, translation: it.exampleEn ?? "" } : undefined;
	const blank = ex && it.lang ? blankOut(ex.sentence, it.label) : null;
	return {
		itemId: it.id, meaning,
		recall: { prompt: it.lang ? `${it.label} — what does it mean?` : it.kind === "term" ? `What does “${it.label}” mean?` : `What do you know about: ${it.label}?`, answer: meaning },
		...(it.kind === "term" && it.meaning ? { produce: { prompt: it.lang ? `How do you say “${it.meaning}”?` : it.meaning, answer: it.label } } : {}),
		...(blank ? { cloze: { prompt: `${blank}${ex!.translation ? ` (${ex!.translation})` : ""}`, answer: it.label } } : {}),
		...(ex ? { example: ex } : {}),
		lapsesAt: it.lapses, generatedAt: new Date(0).toISOString(),
	};
}

/** The sentence with the word replaced by ____, or null when the word is not in it as written. */
function blankOut(sentence: string, word: string): string | null {
	const i = sentence.toLowerCase().indexOf(word.toLowerCase());
	return i < 0 ? null : sentence.slice(0, i) + "____" + sentence.slice(i + word.length);
}

/** Cards that need (re)writing: none yet, or more lapses than when written (elaboration at 2, hook at 3). */
export function cardsNeeded(state: LearnerState, ids: readonly ItemId[], cards = readCards()): ItemId[] {
	return ids.filter((id) => {
		const it = state.items.get(id); if (!it) return false;
		const c = cards[id];
		if (!c || c.generatedAt === new Date(0).toISOString()) return true;
		if (it.lang && (!c.produce || !c.example)) return true;
		return (it.lapses >= 2 && !c.elaboration) || (it.lapses >= 3 && !c.hook) || (it.misconceptions.length > 0 && !c.discriminate);
	});
}

export async function generateCards(deps: LearnerDeps, state: LearnerState, ids: readonly ItemId[], engine: PiEngine, context: (it: ItemState) => string = () => ""): Promise<ItemId[]> {
	const items = ids.map((id) => state.items.get(id)).filter((x): x is ItemState => !!x).slice(0, 10);
	if (!items.length) return [];
	const lines = items.map((it) => JSON.stringify({
		id: it.id, kind: it.kind, label: it.label, meaning: it.meaning, ...(it.lang ? { lang: it.lang } : {}),
		...(it.example ? { example: { sentence: it.example, translation: it.exampleEn ?? "" } } : {}),
		premises: it.premises.map((p) => state.items.get(p)).filter(Boolean).map((p) => `${p!.label}: ${p!.meaning}`),
		wrongBeliefs: it.misconceptions.map((m) => m.belief), lapses: it.lapses,
		context: context(it).slice(0, 1500),
	}));
	const { text } = await runSubagent([], { role: "auditor", engine, systemPrompt: CARD_PROMPT, prompt: "ITEMS:\n" + lines.join("\n"), maxTurns: 1 });
	const j = jsonOf(text);
	const cards = readCards(), written: ItemId[] = [];
	for (const c of Array.isArray(j?.cards) ? j.cards : []) {
		const it = items.find((x) => x.id === c?.id); const recall = face(c?.recall);
		if (!it || !recall) continue;
		const disc = face(c.discriminate);
		cards[it.id] = {
			itemId: it.id, meaning: typeof c.meaning === "string" && c.meaning.trim() ? c.meaning.trim() : it.meaning, recall,
			...(face(c.produce) ? { produce: face(c.produce) } : {}),
			...(face(c.why) && it.premises.length ? { why: face(c.why) } : {}),
			...(face(c.cloze) ? { cloze: face(c.cloze) } : {}),
			...(disc && typeof c.discriminate.with === "string" ? { discriminate: { ...disc, with: c.discriminate.with } } : {}),
			...(typeof c.elaboration === "string" && c.elaboration.trim() ? { elaboration: c.elaboration.trim() } : cards[it.id]?.elaboration ? { elaboration: cards[it.id]!.elaboration } : {}),
			...(typeof c.hook === "string" && c.hook.trim() ? { hook: c.hook.trim() } : cards[it.id]?.hook ? { hook: cards[it.id]!.hook } : {}),
			...(c.example && typeof c.example.sentence === "string" && c.example.sentence.trim() ? { example: { sentence: c.example.sentence.trim(), translation: String(c.example.translation ?? "").trim() } } : it.example ? { example: { sentence: it.example, translation: it.exampleEn ?? "" } } : {}),
			lapsesAt: it.lapses, generatedAt: new Date().toISOString(),
		};
		written.push(it.id);
	}
	if (written.length) writeCards(cards);
	return written;
}

// ─── grading ─────────────────────────────────────────────────────────────────

const GRADE_PROMPT = `You grade one answer in a learner's spaced-repetition review.

You get the card's prompt, the expected answer, and what the learner wrote (their own words, possibly handwriting read by a machine — ignore spelling and recognition slips).

Rate it:
4 = right and complete, precise.
3 = right in substance, in their own words; small omissions fine.
2 = partly right — the core is there but something important is missing or muddled.
1 = wrong, empty, or "don't know".

If the answer states a SPECIFIC wrong belief (not just a blank or a vague answer), give it in "belief" as one short sentence in the learner's terms; otherwise omit "belief".

Reply with JSON only: {"rating":1|2|3|4,"reason":"one short sentence the learner will read","belief":"…"?}`;

export interface GradeResult { rating: Rating; reason: string; belief?: string }

export async function gradeAnswer(face: CardFace, response: string, engine: PiEngine): Promise<GradeResult> {
	if (!response.trim()) return { rating: 1, reason: "No answer given." };
	const { text } = await runSubagent([], {
		role: "auditor", engine, systemPrompt: GRADE_PROMPT, maxTurns: 1,
		prompt: `PROMPT: ${face.prompt}\nEXPECTED: ${face.answer}\nLEARNER WROTE: ${response.slice(0, 2000)}`,
	});
	const j = jsonOf(text);
	const r = Number(j?.rating);
	if (![1, 2, 3, 4].includes(r)) throw new Error("the grader's reply could not be read");
	return { rating: r as Rating, reason: String(j.reason ?? "").slice(0, 300), ...(typeof j.belief === "string" && j.belief.trim() ? { belief: j.belief.trim().slice(0, 300) } : {}) };
}

/** Records a review; a model belief becomes a misconception on the item. */
export function recordReview(itemId: ItemId, mode: ReviewMode, rating: Rating, graded: "model" | "self", extra: { response?: string; reason?: string; belief?: string; overrules?: string; chatId?: string; confidence?: number } = {}): LearnerEvent[] {
	const conf = extra.confidence != null && Number.isFinite(extra.confidence) ? Math.max(0, Math.min(100, Math.round(extra.confidence))) : undefined;
	const ev: Omit<LearnerEvent, "id" | "at">[] = [{ kind: "review", itemId, mode, rating, graded, ...(extra.response ? { response: extra.response.slice(0, 2000) } : {}), ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.overrules ? { overrules: extra.overrules } : {}), ...(conf != null ? { confidence: conf } : {}) } as never];
	if (extra.belief && rating <= 2) ev.push({ kind: "misconception", items: [itemId], belief: extra.belief, chatId: extra.chatId ?? "" } as never);
	return appendEvidence(ev as never);
}

// ─── what the queue and the views read ──────────────────────────────────────

/** The face a card is asked with in a mode (listen: the word is spoken, its meaning is the answer). */
export function cardFace(c: Card, mode: ReviewMode, it: ItemState): CardFace & { mode: ReviewMode; speak?: string } {
	if (mode === "listen") return { mode, prompt: "Listen — what does it mean?", answer: `${it.label} — ${c.recall.answer}`, speak: it.label };
	const f = (c as unknown as Record<string, CardFace | undefined>)[mode];
	return f && typeof f.prompt === "string" ? { mode, ...f } : { mode: "recall", ...c.recall };
}

export function itemView(state: LearnerState, it: ItemState, cards: Record<ItemId, Card> = readCards()) {
	const c = cards[it.id];
	const ex = c?.example ?? (it.example ? { sentence: it.example, translation: it.exampleEn ?? "" } : null);
	return {
		id: it.id, kind: it.kind, label: it.label, meaning: c?.meaning || it.meaning, status: it.status,
		retrievability: it.retrievability, effective: effectiveRetrievability(it),
		weakestPremise: it.weakestPremise ? { ...it.weakestPremise, label: state.items.get(it.weakestPremise.id)?.label ?? "" } : null,
		due: it.schedule.state ? new Date(it.schedule.due).toISOString() : null,
		stabilityDays: it.schedule.state ? Math.round(it.schedule.stability * 10) / 10 : null,
		reps: it.schedule.reps, lapses: it.lapses, lessons: it.lessons, asked: it.asked, usedEarly: it.usedEarly,
		misconceptions: it.misconceptions, drift: it.drift, lastSeen: it.lastSeen,
		aliases: it.aliases, ...(it.lang ? { lang: it.lang } : {}), ...(it.deck ? { deck: it.deck, tags: it.tags ?? [] } : {}),
		...(it.audio ? { audio: it.audio } : {}), ...(it.known ? { known: true } : {}), ...(it.meaningSource ? { meaningSource: it.meaningSource } : {}),
		...(ex ? { example: ex } : {}),
	};
}

export function queueView(state: LearnerState, opts: { limit?: number; only?: Set<ItemId>; newPerDay?: number; deck?: string } = {}) {
	const cards = readCards();
	return reviewQueue(state, { ...opts, hasMode: hasCardMode(cards) }).map((q) => {
		const it = state.items.get(q.itemId)!;
		const c = cards[q.itemId] ?? fallbackCard(it);
		const f = cardFace(c, q.mode, it);
		return {
			...q, mode: f.mode, label: it.label, kind: it.kind, prompt: f.prompt, answer: f.answer, ...(f.speak ? { speak: f.speak } : {}),
			...(it.lang ? { lang: it.lang } : {}), ...(it.audio ? { audio: it.audio } : {}), ...(it.deck ? { deck: it.deck } : {}),
			...(c.example ? { example: c.example } : {}),
			...(it.lapses >= 2 && c.elaboration ? { elaboration: c.elaboration } : {}),
			...(it.lapses >= 3 && c.hook ? { hook: c.hook } : {}),
			...(q.mode === "discriminate" && c.discriminate ? { with: c.discriminate.with } : {}),
			status: it.status, generated: !!cards[q.itemId],
		};
	});
}

// ─── lesson notes from the learner model ────────────────────────────────────

const firstUserText = (r: ChatRecord) => {
	const u = (r.messages as LhMessage[]).find((m) => (m as { role?: string }).role === "user") as { content?: Block[] | string } | undefined;
	const c = u?.content ?? [];
	return (typeof c === "string" ? c : c.filter((b) => b.type === "text").map((b) => b.text).join(" ")).slice(0, 600);
};

/** The plan node the lesson stands at: the latest tagged question call. */
export function currentPlanNode(r: ChatRecord): string | null {
	const ms = r.messages as LhMessage[];
	for (let i = ms.length - 1; i >= 0; i--) {
		const m = ms[i] as unknown as { role: string; content: Block[] };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (let j = m.content.length - 1; j >= 0; j--) { const b = m.content[j]!; if (b.type === "toolCall" && typeof b.arguments?.nodeId === "string") return b.arguments.nodeId as string; }
	}
	return null;
}

export interface LearnerNotes { sections: string[]; mark: { profiled?: boolean; leeches?: string[]; unchecked?: string[]; drift?: string[]; dueTurn?: number; returned?: string } }

/**
 * The learner-model sections of a turn's lesson notes: the profile (once per
 * lesson, at its first learner turn — the prober's included), due items
 * related to the lesson (every 4th teaching turn, ≤3), leeches from this
 * lesson, earlier plan nodes never checked (once per node reached), and term
 * drift. `mark` is what the caller records on the ledger once the notes are on disk.
 */
/** The question calls of the lesson so far (teach phase: quiz and explain), oldest first. */
export function questionKinds(record: ChatRecord): ("quiz" | "explain")[] {
	const out: ("quiz" | "explain")[] = [];
	for (const m of record.messages as LhMessage[]) {
		const x = m as unknown as { role?: string; content?: Block[] };
		if (x.role !== "assistant" || !Array.isArray(x.content)) continue;
		for (const b of x.content) if (b.type === "toolCall" && (b.name === "quiz" || b.name === "explain")) out.push(b.name);
	}
	return out;
}

/** The nudge when a lesson keeps asking with options (only when both tools are armed): a history of options-only is a strong pattern to copy. */
export function questionMixNote(record: ChatRecord): string | null {
	const ks = questionKinds(record), tail = ks.slice(-3);
	if (tail.length < 3 || tail.some((k) => k === "explain")) return null;
	const own = ks.filter((k) => k === "explain").length;
	return `[Question mix] The last ${tail.length} questions in this lesson all had options (${own} of ${ks.length} so far were in his own words). Make the next check an \`explain\`: a why, a meaning in his words, or something to work out and type (a number, a vector, a sentence) — not chosen from a list. Options only to tell named wrong models apart.`;
}

export function learnerNotes(state: LearnerState, record: ChatRecord, teaching: boolean, opts: { mixed?: boolean } = {}): LearnerNotes {
	const v = record.vocabulary, sections: string[] = [], mark: LearnerNotes["mark"] = {};
	const topic = `${record.title} ${firstUserText(record)}`;
	if (!v?.profiled) {
		const p = profileText(state, topic, record.id);
		if (p) sections.push(p);
		mark.profiled = true;
	} else {
		const back = returnNote(state, record);
		if (back) { sections.push(back.text); mark.returned = back.through; }
	}
	if (!teaching) return { sections, mark };
	const turn = (v?.noteTurns ?? 0) + 1; mark.dueTurn = turn;
	if (opts.mixed) { const mix = questionMixNote(record); if (mix) sections.push(mix); }
	if (turn % 4 === 0) {
		const due = relatedItems(state, topic, record.id).filter((it) => it.schedule.state === 2 && isDue(it.schedule, state.now) && it.status !== "leech" && it.status !== "suspended").slice(0, 3);
		if (due.length) sections.push(["[Due for review, and related to this lesson]", ...due.map((it) => `- ${it.label}`), "Where one fits naturally, use it as a quick retrieval check — ask before re-explaining. Never derail the lesson for it."].join("\n"));
	}
	const leeches = [...state.items.values()].filter((it) => it.status === "leech" && it.lessons.includes(record.id) && !(v?.notedLeeches ?? []).includes(it.id));
	if (leeches.length) {
		sections.push(["[Never stuck] — forgotten six or more times in review; likely resting on something missing:", ...leeches.map((it) => `- ${it.label}`), "Find what it rests on that the learner does not hold, and teach that."].join("\n"));
		mark.leeches = [...(v?.notedLeeches ?? []), ...leeches.map((it) => it.id)];
	}
	const cur = currentPlanNode(record);
	if (cur && record.tree && !(v?.notedUnchecked ?? []).includes(cur)) {
		const prog = lessonProgress(state, record.id, record.tree);
		const un = uncheckedBefore(prog, record.tree.edges, cur);
		if (un.length) {
			const title = (id: string) => record.tree!.nodes.find((n) => n.id === id)?.title ?? id;
			sections.push(`[Unchecked steps] — the lesson is at "${title(cur)}", but these earlier steps were never confirmed (no correct check, or missed and not repaired): ${un.map((id) => `"${title(id)}"`).join(", ")}. Check them before building further on them.`);
		}
		mark.unchecked = [...(v?.notedUnchecked ?? []), cur];
	}
	const drifts = state.events.filter((e): e is Extract<LearnerEvent, { kind: "drift" }> => e.kind === "drift" && e.chatId === record.id && !(v?.notedDrift ?? []).includes(e.id));
	if (drifts.length) {
		sections.push(["[Term drift] — these were taught with one meaning and are now being used with another:", ...drifts.map((d) => `- "${d.term}": taught as ${d.taughtAs}; now used as ${d.nowAs}`), "Name the shift out loud (both meanings, and which applies here) so they do not blur."].join("\n"));
		mark.drift = [...(v?.notedDrift ?? []), ...drifts.map((d) => d.id)];
	}
	return { sections, mark };
}

/** Due items related to a lesson — the recall card the tablet shows when the lesson opens. */
export function lessonRecall(state: LearnerState, record: ChatRecord, max = 3): ItemId[] {
	const topic = `${record.title} ${firstUserText(record)}`;
	return relatedItems(state, topic, record.id)
		.filter((it) => it.reviewable && it.schedule.state !== 0 && it.status !== "leech" && it.status !== "suspended" && (isDue(it.schedule, state.now) || (effectiveRetrievability(it) ?? 1) < 0.85))
		.slice(0, max).map((it) => it.id);
}

/** What a card writer is shown about an item: the side question's answer, or the passage that used it. */
export function cardContext(deps: LearnerDeps, state: LearnerState) {
	return (it: ItemState): string => {
		for (const e of [...state.events].reverse()) {
			if (e.kind === "asked" && e.itemId === it.id) {
				const side = deps.chatStore.getChat(e.sideChatId);
				const a = side?.messages.find((m) => (m as { role?: string }).role === "assistant") as { content?: Block[] } | undefined;
				const t = (a?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
				if (t) return "The learner asked about it; the answer they got:\n" + t;
			}
			if ((e.kind === "taught" || e.kind === "used-early") && e.itemId === it.id && e.messageId) {
				const r = deps.chatStore.getChat(e.chatId);
				const m = r?.messages.find((x) => x.id === e.messageId) as { content?: Block[] } | undefined;
				const t = (m?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
				const k = t.toLowerCase().indexOf(it.label.toLowerCase());
				if (t) return "The lesson passage:\n" + t.slice(Math.max(0, k - 600), k + 900);
			}
		}
		return "";
	};
}

let prefetching = false;
/** Writes cards ahead for the next items in the queue, ten at a time, in the background. */
export function prefetchCards(deps: LearnerDeps, engine: PiEngine | undefined, ids: readonly ItemId[]): void {
	if (!engine || prefetching || process.env.NODE_ENV === "test") return;
	const state = learnerState(deps);
	const need = cardsNeeded(state, ids).slice(0, 20);
	if (!need.length) return;
	prefetching = true;
	void (async () => {
		for (let i = 0; i < need.length; i += 10) await generateCards(deps, state, need.slice(i, i + 10), engine, cardContext(deps, state));
	})().catch((err) => console.error("[learner] card prefetch failed:", err)).finally(() => { prefetching = false; });
}

let backfilled = false;
/**
 * Rebuilds the evidence the lesson records already hold (2026-11): every
 * answered question and concluded practice problem in every session, at the
 * time it was answered. Idempotent by (chat, call), so it is safe on every
 * start; once per process. The removed events ledger's history was deleted
 * with it, but the transcripts never were — this is where it comes back.
 */
export function backfillEvidence(deps: LearnerDeps): number {
	if (backfilled) return 0;
	backfilled = true;
	const known = loggedCallIds();
	let n = 0;
	for (const c of deps.chatStore.listChats()) {
		const r = deps.chatStore.getChat(c.id);
		if (!r) continue;
		try { n += logRecordEvidence(r, known).length; }
		catch (err) { console.error(`[learner] backfill of ${c.id} failed:`, err); }
	}
	if (n) console.info(`[learner] backfilled ${n} evidence events from lesson records`);
	return n;
}

export { termItem, nodeItem };

// ─── the glossary tidy ──────────────────────────────────────────────────────

const TIDY_PROMPT = `You tidy a learner's glossary — the terms an app recorded from their lessons.

You get every term in the glossary (for context) and a list TO REVIEW, each with its id, the term, its meaning (may be empty), the lesson's title, and how often the lesson used it before teaching it.

For each term TO REVIEW decide:
- "retire" it when it is not a term worth remembering for that subject: an everyday word the recorder picked up ("shape", "shares", "neighbor" used in its plain sense), a lone variable or letter, or a fragment of a phrase. When in doubt, keep it.
- "merge" it into another glossary term when the two name the same thing (a synonym, an abbreviation, or a short form of the same name — "mask" and "causal mask" when both mean the causal mask). Merge into the clearer standard name. Never merge related-but-different ideas.
- give a "meaning" when its meaning is empty and it is kept: one plain, correct sentence for what it means in that lesson's subject.

Reply with JSON only: {"retire":[{"id":"…","reason":"…"}],"merge":[{"from":"…","into":"…"}],"meanings":[{"id":"…","meaning":"…"}]}`;

let tidying = false;

/**
 * Looks at glossary terms not looked at yet: lone letters and numbers are
 * retired by rule; the cheap model retires everyday words, merges duplicates
 * and gives the never-explained ones a meaning. Each judgment is evidence
 * (retire / merge / meaning), so it can be taken back. `all` re-reviews every term.
 */
export async function tidyGlossary(deps: LearnerDeps, engine: PiEngine | undefined, opts: { all?: boolean } = {}): Promise<{ reviewed: number; retired: number; merged: number; meanings: number }> {
	const out = { reviewed: 0, retired: 0, merged: 0, meanings: 0 };
	if (tidying) return out;
	tidying = true;
	try {
		const state = learnerState(deps);
		const tidied = opts.all ? new Set<ItemId>() : readTidied();
		const terms = [...state.items.values()].filter((it) => it.kind === "term" && it.reviewable && !it.retired && !it.deck);
		const todo = terms.filter((it) => !tidied.has(it.id));
		if (!todo.length) return out;
		const ev: Omit<LearnerEvent, "id" | "at">[] = [];
		const rest: ItemState[] = [];
		for (const it of todo) {
			if (isJunkTerm(it.label)) { ev.push({ kind: "retire", itemId: it.id, on: true, reason: "a lone letter or number" } as never); out.retired++; tidied.add(it.id); }
			else rest.push(it);
		}
		const known = new Set(terms.map((t) => t.id));
		for (let i = 0; engine && i < rest.length; i += 60) {
			const batch = rest.slice(i, i + 60);
			const title = (it: ItemState) => it.lessons.map((l) => state.lessonTitles.get(l) ?? "").filter(Boolean)[0] ?? "";
			const prompt = [
				"ALL GLOSSARY TERMS: " + terms.map((t) => t.label).join(", "),
				"",
				"TO REVIEW:",
				...batch.map((it) => JSON.stringify({ id: it.id, term: it.label, meaning: it.meaning, lesson: title(it).slice(0, 80), usedBeforeTaught: it.usedEarly })),
			].join("\n");
			const { text } = await runSubagent([], { role: "auditor", engine, systemPrompt: TIDY_PROMPT, prompt, maxTurns: 1 });
			const j = jsonOf(text);
			if (!j) continue;
			const inBatch = new Set(batch.map((b) => b.id));
			const gone = new Set<ItemId>();
			for (const r of Array.isArray(j.retire) ? j.retire : []) if (inBatch.has(r?.id)) { ev.push({ kind: "retire", itemId: r.id, on: true, ...(r.reason ? { reason: String(r.reason).slice(0, 200) } : {}) } as never); gone.add(r.id); out.retired++; }
			for (const m of Array.isArray(j.merge) ? j.merge : []) {
				if (!inBatch.has(m?.from) || !known.has(m?.into) || m.from === m.into || gone.has(m.from) || gone.has(m.into)) continue;
				ev.push({ kind: "merge", from: m.from, into: m.into } as never); gone.add(m.from); out.merged++;
			}
			for (const m of Array.isArray(j.meanings) ? j.meanings : []) {
				const it = state.items.get(m?.id);
				if (!it || !inBatch.has(it.id) || gone.has(it.id) || it.meaning || typeof m.meaning !== "string" || !m.meaning.trim()) continue;
				ev.push({ kind: "meaning", itemId: it.id, meaning: m.meaning.trim().slice(0, 400), source: "model" } as never); out.meanings++;
			}
			for (const b of batch) tidied.add(b.id);
			out.reviewed += batch.length;
		}
		appendEvidence(ev as never);
		writeTidied(tidied);
		return out;
	} finally { tidying = false; }
}

/** The tidy in the background (after a vocabulary check, or when the glossary is opened). */
export function tidySoon(deps: LearnerDeps, engine: PiEngine | undefined): void {
	if (process.env.NODE_ENV === "test" || !engine) return;
	void tidyGlossary(deps, engine).catch((err) => console.error("[learner] glossary tidy failed:", err));
}

// ─── starting a lesson: the warm-up and the recap ──────────────────────────

/** A lesson resumed after this long is a return: warm up, and recap where it was. */
export const RETURN_GAP_MS = 3 * 3600000;

const msgTime = (m: unknown) => Number((m as { timestamp?: number }).timestamp) || 0;
const lastStamp = (r: ChatRecord) => { for (let i = r.messages.length - 1; i >= 0; i--) { const t = msgTime(r.messages[i]); if (t) return { t, id: r.messages[i]!.id }; } return null; };

/** Warm-up items for opening a lesson: due or fading items related to it, else this lesson's own weakest. */
export function warmupItems(state: LearnerState, record: ChatRecord, max = 3): ItemId[] {
	const ids = lessonRecall(state, record, max);
	if (ids.length >= 2) return ids;
	const own = [...state.items.values()]
		.filter((it) => it.lessons.includes(record.id) && it.reviewable && !it.retired && it.schedule.state !== 0 && it.status !== "suspended" && it.status !== "leech" && !ids.includes(it.id))
		.filter((it) => (effectiveRetrievability(it) ?? 1) < 0.92)
		.sort((a, b) => (effectiveRetrievability(a) ?? 1) - (effectiveRetrievability(b) ?? 1));
	return [...ids, ...own.map((it) => it.id)].slice(0, max);
}

const RECAP_PROMPT = `You write the "where we left off" note a learner sees when they come back to a lesson after a break.

From the end of the lesson transcript given, write 2–3 plain sentences addressed to the learner as "you": what was just being worked on, the last thing they got right or wrong if it matters, and what comes next. Write it in your own words — never copy or continue the tutor's last message — and begin with "You were" or "You had". No greeting, no preamble, no praise. Reply with the sentences only.`;

const textOf = (m: unknown) => {
	const x = m as { role?: string; content?: Block[] | string };
	if (x.role !== "assistant" && x.role !== "user") return "";
	const c = x.content ?? [];
	return (typeof c === "string" ? c : c.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")).trim();
};

export interface LessonStart {
	returning: boolean;
	/** Hours since the lesson's last message. */
	gapHours: number | null;
	/** The last message when it was opened — what a "warmed up for this return" mark keys on. */
	through: string | null;
	warmup: ItemId[];
	recap: { lastStep: string | null; done: string[]; faded: string[]; summary: string | null } | null;
}

/** What opening a lesson shows: the warm-up, and after a break the recap (its summary written once by the cheap model, then kept). */
export async function lessonStart(deps: LearnerDeps, state: LearnerState, record: ChatRecord, engine: PiEngine | undefined): Promise<LessonStart> {
	const last = lastStamp(record);
	const gap = last ? state.now - last.t : null;
	const returning = gap != null && gap >= RETURN_GAP_MS;
	const warmup = record.kind === "practice" ? [] : warmupItems(state, record);
	if (!returning || !last) return { returning, gapHours: gap == null ? null : Math.round(gap / 360000) / 10, through: last?.id ?? null, warmup, recap: null };
	const cur = currentPlanNode(record);
	const title = (id: string) => record.tree?.nodes.find((n) => n.id === id)?.title ?? id;
	const prog = record.tree ? lessonProgress(state, record.id, record.tree) : null;
	const done = prog ? prog.nodes.filter((n) => n.status === "checked" || n.status === "repaired").map((n) => n.title).slice(-4) : [];
	const faded = [...state.items.values()].filter((it) => it.lessons.includes(record.id) && !it.retired && it.schedule.state !== 0 && (effectiveRetrievability(it) ?? 1) < 0.8)
		.sort((a, b) => (effectiveRetrievability(a) ?? 1) - (effectiveRetrievability(b) ?? 1)).slice(0, 6).map((it) => it.label);
	let summary = record.vocabulary?.recap?.through === last.id ? record.vocabulary.recap.text : null;
	if (!summary && engine) {
		const tail = (record.messages as LhMessage[]).map((m) => ({ role: (m as { role?: string }).role, t: textOf(m) })).filter((x) => x.t).slice(-12)
			.map((x) => `${x.role === "user" ? "LEARNER" : "TUTOR"}: ${x.t.length > 1500 ? x.t.slice(0, 400) + " […] " + x.t.slice(-1100) : x.t}`).join("\n\n");
		try {
			const { text } = await runSubagent([], { role: "auditor", engine, systemPrompt: RECAP_PROMPT, prompt: `LESSON: ${record.title}\n${cur ? `CURRENT STEP: ${title(cur)}\n` : ""}\n${tail}`, maxTurns: 1, chatId: record.id });
			summary = text.trim().slice(0, 800) || null;
			if (summary) deps.chatStore.updateVocabulary?.(record.id, (v) => { v.recap = { through: last.id, text: summary! }; });
		} catch (err) { console.error(`[chat ${record.id}] recap failed:`, err); }
	}
	return { returning, gapHours: Math.round(gap! / 360000) / 10, through: last.id, warmup, recap: { lastStep: cur ? title(cur) : null, done, faded, summary } };
}

/** The tutor's note for a learner coming back after a gap: where it stood, what faded, how the warm-up went. */
export function returnNote(state: LearnerState, record: ChatRecord): { text: string; through: string } | null {
	const last = lastStamp(record);
	if (!last || state.now - last.t < RETURN_GAP_MS || record.vocabulary?.notedReturn === last.id) return null;
	const gapH = (state.now - last.t) / 3600000;
	const away = gapH >= 48 ? `${Math.round(gapH / 24)} days` : `${Math.round(gapH)} hours`;
	const cur = currentPlanNode(record);
	const step = cur ? record.tree?.nodes.find((n) => n.id === cur)?.title ?? null : null;
	const mine = [...state.items.values()].filter((it) => it.lessons.includes(record.id) && !it.retired);
	const faded = mine.filter((it) => it.schedule.state !== 0 && (effectiveRetrievability(it) ?? 1) < 0.8).map((it) => it.label).slice(0, 8);
	const since = new Date(last.t).toISOString();
	const warm = state.events.filter((e): e is Extract<LearnerEvent, { kind: "review" }> => e.kind === "review" && e.at > since && mine.some((it) => it.id === e.itemId))
		.map((e) => `${state.items.get(e.itemId)?.label ?? e.itemId}: ${e.rating >= 3 ? "recalled" : "missed"}`);
	const lines = [`[Returning after ${away}] — the learner is coming back to this lesson after a break.`];
	if (step) lines.push(`It stood at the step "${step}".`);
	if (faded.length) lines.push(`Likely faded since (low recall now): ${faded.join(", ")}.`);
	if (warm.length) lines.push(`Warm-up just now: ${warm.join("; ")}.`);
	lines.push("Open by reconnecting in one or two sentences — where you were, and a quick check of anything faded that the next step rests on — before going on.");
	return { text: lines.join(" "), through: last.id };
}

// ─── the knowledge map ──────────────────────────────────────────────────────

export function knowledgeMap(deps: LearnerDeps, state: LearnerState) {
	const canon = (id: ItemId) => { let x = id; for (let i = 0; i < 10 && state.aliases.has(x); i++) x = state.aliases.get(x)!; return x; };
	const brief = (id: ItemId) => {
		const it = state.items.get(canon(id));
		return it && !it.retired ? { id: it.id, label: it.label, status: it.status, recall: effectiveRetrievability(it) } : null;
	};
	const lessons = deps.chatStore.listChats().map((c) => deps.chatStore.getChat(c.id)).filter((r): r is ChatRecord => !!r && !!r.tree?.nodes.length && r.kind !== "practice" && !r.parent)
		.map((r) => {
			const prog = lessonProgress(state, r.id, r.tree);
			const planned = r.vocabulary?.planned ?? {};
			const cur = currentPlanNode(r);
			return {
				id: r.id, title: r.title,
				steps: prog.nodes.map((n) => ({
					id: n.id, title: n.title, status: n.status, checks: n.checks, current: n.id === cur,
					terms: (planned[n.id]?.introduces ?? []).map((t) => brief(termItem(t))).filter(Boolean),
					needs: (planned[n.id]?.needs ?? []).map((t) => brief(termItem(t))).filter(Boolean),
				})),
				edges: r.tree!.edges,
				next: prog.frontier.map((id) => r.tree!.nodes.find((n) => n.id === id)?.title ?? id),
			};
		});
	const chains = deps.graphStore.readChains().map((c) => ({ premises: c.premises.map((p) => brief(nodeItem(p))).filter(Boolean), conclusion: brief(nodeItem(c.conclusion)) })).filter((c) => c.conclusion && c.premises.length);
	const held = (s: string | undefined) => s === "learning" || s === "solid";
	const ready = [...state.items.values()].filter((it) => it.kind === "node" && it.status === "new" && it.premises.length && it.premises.every((p) => held(state.items.get(p)?.status)))
		.slice(0, 12).map((it) => ({ id: it.id, label: it.label }));
	return { lessons, chains, ready };
}

// ─── a side question's view of its lesson ───────────────────────────────────

/**
 * What a side question is told about the lesson it was asked from (2026-11): the
 * lesson's step, its terms as taught, where the term was first used, and the
 * newest teaching — so the answer uses the lesson's own names, numbers and
 * examples. Before this the side thread saw one paragraph (or, from a glossary
 * page, nothing) and said so ("I can't see the lesson's earlier setup…").
 * Model-only: it rides the new chat as a lesson-notes marker.
 */
export function sideQuestionContext(parent: ChatRecord, term?: string, budget = 9000): string {
	const ms = parent.messages as LhMessage[];
	const said = (m: LhMessage) => {
		const x = m as unknown as { role?: string; content?: Block[] | string };
		if (x.role !== "assistant" || !Array.isArray(x.content)) return "";
		const out: string[] = [];
		for (const b of x.content) {
			if (b.type === "text" && b.text) out.push(b.text);
			else if (b.type === "toolCall" && b.name && QUESTIONS.has(b.name) && typeof b.arguments?.question === "string") out.push("(Question asked: " + b.arguments.question + ")");
		}
		return out.join("\n").trim();
	};
	const cur = currentPlanNode(parent);
	const step = cur ? parent.tree?.nodes.find((n) => n.id === cur)?.title : null;
	const held = (parent.vocabulary?.terms ?? []).filter((t) => t.gloss).slice(0, 40).map((t) => `${t.term} (${t.gloss})`);
	const lines = [`[Side question context] — this session is a side question from the lesson "${parent.title}". The learner sees none of this note; use it to answer in the lesson's own terms, names, numbers and examples, and do not say you cannot see the lesson.`];
	if (step) lines.push(`The lesson is at the step "${step}".`);
	if (held.length) lines.push("Terms the lesson has taught, with its meanings: " + held.join("; ") + ".");
	let room = budget;
	if (term) {
		const k = term.toLowerCase();
		const first = ms.find((m) => said(m).toLowerCase().includes(k));
		if (first) { const t = said(first), i = t.toLowerCase().indexOf(k); const cut = t.slice(Math.max(0, i - 700), i + 900); lines.push("", `Where the lesson first used "${term}":`, cut); room -= cut.length; }
	}
	const recent: string[] = [];
	for (let i = ms.length - 1; i >= 0 && room > 400; i--) {
		const t = said(ms[i]!); if (!t) continue;
		const piece = t.length > room ? "…" + t.slice(-room) : t;
		recent.unshift(piece); room -= piece.length;
		if (recent.length >= 8) break;
	}
	if (recent.length) lines.push("", "The lesson's newest teaching, oldest first:", recent.join("\n\n---\n\n"));
	return lines.join("\n");
}
