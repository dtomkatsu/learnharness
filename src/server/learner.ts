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
	deriveLearner, effectiveRetrievability, lessonProgress, nodeItem, profileText, relatedItems, reviewQueue, termItem, uncheckedBefore,
	type ItemId, type ItemState, type LearnerEvent, type LearnerState, type ReviewMode,
} from "../core/learner/model.ts";
import { appendEvidence, hasCardMode, readCards, readEvidence, writeCards, type Card, type CardFace } from "../store/learner.ts";
import type { Rating } from "../core/learner/fsrs.ts";

export interface LearnerDeps {
	chatStore: ChatStore;
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
}

const QUESTIONS = new Set<string>(QUESTION_TOOLS);

export function learnerState(deps: LearnerDeps, now = Date.now()): LearnerState {
	const lessonTitles = new Map(deps.chatStore.listChats().map((c) => [c.id, c.title]));
	return deriveLearner(readEvidence(), { nodes: deps.graphStore.readNodes(), chains: deps.graphStore.readChains(), lessonTitles }, now);
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

Plain words; one idea per card; no answer may be guessable from its prompt. Reply with JSON only:
{"cards":[{"id":"…","meaning":"…","recall":{"prompt":"…","answer":"…"},"produce":{…}?,"why":{…}?,"cloze":{…}?,"discriminate":{"prompt":"…","answer":"…","with":"…"}?,"elaboration":"…"?,"hook":"…"?}]}`;

function jsonOf(text: string): any {
	const m = /\{[\s\S]*\}/.exec(text); if (!m) return null;
	try { return JSON.parse(m[0]); } catch { return null; }
}
const face = (x: any): CardFace | undefined => (x && typeof x.prompt === "string" && typeof x.answer === "string" && x.prompt.trim() && x.answer.trim() ? { prompt: x.prompt.trim(), answer: x.answer.trim() } : undefined);

/** The card an item can always be asked with, model or not. */
export function fallbackCard(it: ItemState): Card {
	const meaning = it.meaning || "(no meaning recorded yet)";
	return {
		itemId: it.id, meaning,
		recall: { prompt: it.kind === "term" ? `What does “${it.label}” mean?` : `What do you know about: ${it.label}?`, answer: meaning },
		...(it.kind === "term" && it.meaning ? { produce: { prompt: it.meaning, answer: it.label } } : {}),
		lapsesAt: it.lapses, generatedAt: new Date(0).toISOString(),
	};
}

/** Cards that need (re)writing: none yet, or more lapses than when written (elaboration at 2, hook at 3). */
export function cardsNeeded(state: LearnerState, ids: readonly ItemId[], cards = readCards()): ItemId[] {
	return ids.filter((id) => {
		const it = state.items.get(id); if (!it) return false;
		const c = cards[id];
		if (!c || c.generatedAt === new Date(0).toISOString()) return true;
		return (it.lapses >= 2 && !c.elaboration) || (it.lapses >= 3 && !c.hook) || (it.misconceptions.length > 0 && !c.discriminate);
	});
}

export async function generateCards(deps: LearnerDeps, state: LearnerState, ids: readonly ItemId[], engine: PiEngine, context: (it: ItemState) => string = () => ""): Promise<ItemId[]> {
	const items = ids.map((id) => state.items.get(id)).filter((x): x is ItemState => !!x).slice(0, 10);
	if (!items.length) return [];
	const lines = items.map((it) => JSON.stringify({
		id: it.id, kind: it.kind, label: it.label, meaning: it.meaning,
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
export function recordReview(itemId: ItemId, mode: ReviewMode, rating: Rating, graded: "model" | "self", extra: { response?: string; reason?: string; belief?: string; overrules?: string; chatId?: string } = {}): LearnerEvent[] {
	const ev: Omit<LearnerEvent, "id" | "at">[] = [{ kind: "review", itemId, mode, rating, graded, ...(extra.response ? { response: extra.response.slice(0, 2000) } : {}), ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.overrules ? { overrules: extra.overrules } : {}) } as never];
	if (extra.belief && rating <= 2) ev.push({ kind: "misconception", items: [itemId], belief: extra.belief, chatId: extra.chatId ?? "" } as never);
	return appendEvidence(ev as never);
}

// ─── what the queue and the views read ──────────────────────────────────────

export function itemView(state: LearnerState, it: ItemState, cards: Record<ItemId, Card> = readCards()) {
	const c = cards[it.id];
	return {
		id: it.id, kind: it.kind, label: it.label, meaning: c?.meaning || it.meaning, status: it.status,
		retrievability: it.retrievability, effective: effectiveRetrievability(it),
		weakestPremise: it.weakestPremise ? { ...it.weakestPremise, label: state.items.get(it.weakestPremise.id)?.label ?? "" } : null,
		due: it.schedule.state ? new Date(it.schedule.due).toISOString() : null,
		stabilityDays: it.schedule.state ? Math.round(it.schedule.stability * 10) / 10 : null,
		reps: it.schedule.reps, lapses: it.lapses, lessons: it.lessons, asked: it.asked, usedEarly: it.usedEarly,
		misconceptions: it.misconceptions, drift: it.drift, lastSeen: it.lastSeen,
	};
}

export function queueView(state: LearnerState, opts: { limit?: number; only?: Set<ItemId>; newPerDay?: number } = {}) {
	const cards = readCards();
	return reviewQueue(state, { ...opts, hasMode: hasCardMode(cards) }).map((q) => {
		const it = state.items.get(q.itemId)!;
		const c = cards[q.itemId] ?? fallbackCard(it);
		const f = (c[q.mode] as CardFace | undefined) ?? c.recall;
		return {
			...q, mode: c[q.mode] ? q.mode : "recall", label: it.label, kind: it.kind, prompt: f.prompt, answer: f.answer,
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

export interface LearnerNotes { sections: string[]; mark: { profiled?: boolean; leeches?: string[]; unchecked?: string[]; drift?: string[]; dueTurn?: number } }

/**
 * The learner-model sections of a turn's lesson notes: the profile (once per
 * lesson, at its first learner turn — the prober's included), due items
 * related to the lesson (every 4th teaching turn, ≤3), leeches from this
 * lesson, earlier plan nodes never checked (once per node reached), and term
 * drift. `mark` is what the caller records on the ledger once the notes are on disk.
 */
export function learnerNotes(state: LearnerState, record: ChatRecord, teaching: boolean): LearnerNotes {
	const v = record.vocabulary, sections: string[] = [], mark: LearnerNotes["mark"] = {};
	const topic = `${record.title} ${firstUserText(record)}`;
	if (!v?.profiled) {
		const p = profileText(state, topic, record.id);
		if (p) sections.push(p);
		mark.profiled = true;
	}
	if (!teaching) return { sections, mark };
	const turn = (v?.noteTurns ?? 0) + 1; mark.dueTurn = turn;
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
