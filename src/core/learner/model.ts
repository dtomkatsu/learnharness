/**
 * The learner model (2026-11) — what the learner knows, derived from evidence.
 *
 * One append-only evidence log (data/learner/evidence.jsonl, written by code
 * wherever a signal already exists) and everything else COMPUTED ON READ, the
 * vision's "understanding is derived" rule: replaying the log through FSRS-6
 * gives, per item, its schedule, the probability it comes to mind now, and a
 * status; plus misconceptions, calibration, per-lesson progress, a digest and
 * the glossary. Pure — no clock, no I/O: callers pass `now` and the graph.
 *
 * Items are terms ("term:<normalized>", from lesson vocabularies) and graph
 * propositions ("node:<id>"). An answer names the terms of the plan node it
 * checked; graph propositions are joined at read time by provenance (a node
 * whose provenance includes the question's message), and practice problems
 * name their target propositions directly.
 *
 * Compared with the events ledger removed on 2026-09-27 (quiz outcomes +
 * one-word understanding notes, never derived into a state, never scheduled,
 * never read back into teaching): see docs/learner-model-scope.md
 * "What this replaces".
 */
import { createSchedule, isDue, rate, retrievability, studyDay, type Rating, type Schedule } from "./fsrs.ts";
import { normTerm } from "../vocabulary.ts";

// ─── evidence ────────────────────────────────────────────────────────────────

export type ItemId = string;
export const termItem = (term: string): ItemId => "term:" + normTerm(term);
export const nodeItem = (id: string): ItemId => "node:" + id;

/** listen: the prompt is the word spoken (language words). */
export type ReviewMode = "recall" | "produce" | "why" | "cloze" | "discriminate" | "listen";

interface EventBase { id: string; at: string }

export type LearnerEvent =
	/** A question answered in a lesson (probe, check, prediction) — from the record, by code. */
	| (EventBase & {
		kind: "answer";
		chatId: string;
		/** The assistant message that asked it (provenance join key). */
		messageId: string;
		toolCallId: string;
		/** probe · recall · quiz · explain. */
		tool: string;
		questionType?: string;
		question: string;
		/** unknown = an explain answer, graded by the tutor in prose: a later verdict decides. */
		outcome: "correct" | "miss" | "dontknow" | "unknown";
		/** 0–100, quiz answers only. */
		confidence?: number;
		thinking?: string;
		planNode?: string;
		items: ItemId[];
		/** The assistant messages since the previous answer — the teaching this question checks. Graph
		 *  propositions extracted from any of them are what the answer is evidence about. */
		context?: string[];
	})
	/** The vocabulary check's judgment of an explain answer, read from the tutor's reply. */
	| (EventBase & { kind: "verdict"; toolCallId: string; outcome: "correct" | "miss" })
	/** A practice problem concluded — its targets are graph propositions. */
	| (EventBase & { kind: "practice"; chatId: string; toolCallId: string; items: ItemId[]; outcome: string; rung?: string | null; missClass?: string | null })
	/** A review in the review queue. `overrules` names a review whose rating this one replaces.
	 *  `confidence` (0–100) is how sure the learner said they were before seeing the answer. */
	| (EventBase & { kind: "review"; itemId: ItemId; mode: ReviewMode; rating: Rating; graded: "model" | "self"; response?: string; reason?: string; overrules?: string; confidence?: number })
	/** The lesson taught a term (vocabulary check). `lang`: BCP-47 code when it is a word of a language being learned. */
	| (EventBase & { kind: "taught"; itemId: ItemId; term: string; gloss: string; chatId: string; messageId?: string; lang?: string; example?: string; exampleEn?: string })
	/** Two items are one thing (glossary tidy): `from`'s evidence counts for `into` from now on. */
	| (EventBase & { kind: "merge"; from: ItemId; into: ItemId })
	/** Not a real term (an everyday word or a fragment the check picked up) — out of the glossary and review. */
	| (EventBase & { kind: "retire"; itemId: ItemId; on: boolean; reason?: string })
	/** A meaning for an item the lesson never explained (glossary tidy), or the learner's own wording. */
	| (EventBase & { kind: "meaning"; itemId: ItemId; meaning: string; source: "model" | "learner" })
	/** The learner already knew it before it came up — or takes that back. */
	| (EventBase & { kind: "known"; itemId: ItemId; on: boolean })
	/** The lesson used a term before teaching it. */
	| (EventBase & { kind: "used-early"; itemId: ItemId; term: string; chatId: string; messageId?: string })
	/** The learner opened a side question about a term. */
	| (EventBase & { kind: "asked"; itemId: ItemId; term: string; chatId: string; sideChatId: string })
	/** The learner used a held term in their own words — rightly or not. */
	| (EventBase & { kind: "use"; itemId: ItemId; term: string; correct: boolean; chatId: string; how?: string })
	/** A wrong answer's thinking stated a specific wrong belief. */
	| (EventBase & { kind: "misconception"; items: ItemId[]; belief: string; chatId: string; toolCallId?: string })
	/** A term used with a different meaning than the one taught. */
	| (EventBase & { kind: "drift"; itemId: ItemId; term: string; taughtAs: string; nowAs: string; chatId: string })
	/** The learner took an item out of review (or put it back). */
	| (EventBase & { kind: "suspend"; itemId: ItemId; on: boolean });

export type LearnerEventKind = LearnerEvent["kind"];

// ─── derived state ───────────────────────────────────────────────────────────

export type ItemStatus = "new" | "learning" | "solid" | "fragile" | "misconceived" | "leech" | "suspended";

export interface Misconception { belief: string; at: string; chatId: string; resolvedAt?: string }

export interface ItemState {
	id: ItemId;
	kind: "term" | "node";
	label: string;
	/** The meaning as taught (term gloss) or the proposition's statement. */
	meaning: string;
	schedule: Schedule;
	/** The produce direction's own schedule, once recall is stable. */
	produce?: Schedule;
	/** Probability it comes to mind now (null before the first retrieval). */
	retrievability: number | null;
	/** For propositions: the weakest premise's retrievability (one level down). */
	weakestPremise?: { id: ItemId; retrievability: number } | null;
	status: ItemStatus;
	ratings: { at: string; rating: Rating; source: LearnerEventKind | "deck"; eventId: string; produce?: boolean }[];
	lapses: number;
	misconceptions: Misconception[];
	/** Lessons that taught or asked about it. */
	lessons: string[];
	firstSeen: string;
	lastSeen: string;
	/** Whether it may enter the review queue (taught, asked, used early, or a proposition). */
	reviewable: boolean;
	/** Origin weight for the order new items are introduced in. */
	priority: number;
	usedEarly: number;
	asked: number;
	drift: { taughtAs: string; nowAs: string; at: string; chatId: string }[];
	/** When it last became solid (stability ≥ 21 days in review); absent while not solid. */
	solidSince?: string;
	/** Premises (graph) for "why" cards. */
	premises: ItemId[];
	/** Other labels folded into this item (merges). */
	aliases: string[];
	/** BCP-47 code of the language it is a word of, when it is one being learned. */
	lang?: string;
	/** An example sentence using it (and its translation), for language words. */
	example?: string;
	exampleEn?: string;
	/** The deck it came from when it lives in another app's flashcards (e.g. "bahasa"), with that deck's tags and audio. */
	deck?: string;
	tags?: string[];
	audio?: string;
	/** The learner said they already knew it. */
	known?: boolean;
	/** Retired from the glossary and review (not a real term). */
	retired?: boolean;
	/** Where the meaning came from when the lesson never gave one. */
	meaningSource?: "model" | "learner" | "deck";
}

/** An item that lives in another app's flashcard deck, with that app's schedule (FSRS state as it keeps it). */
export interface ExternalItem {
	term: string;
	gloss: string;
	deck: string;
	lang?: string;
	tags?: string[];
	example?: string;
	exampleEn?: string;
	audio?: string;
	schedule?: { stability: number; difficulty: number; due: number; lastReview: number; reps: number } | null;
}

export interface Calibration {
	/** Quiz answers and reviews with a confidence. */
	answers: number;
	/** Mean confidence (0–100) vs. accuracy (0–100). */
	meanConfidence: number | null;
	accuracy: number | null;
	/** Of answers at confidence ≥ 75: the share that were wrong. */
	sureAndWrong: number | null;
	sureCount: number;
}

/** One confident-or-not judgment: an in-lesson quiz answer or a review, with what it was about. */
export interface ConfidencePoint { at: string; confidence: number; correct: boolean; chatId?: string; itemId?: ItemId }

export interface LearnerState {
	now: number;
	lessonTitles: Map<string, string>;
	items: Map<ItemId, ItemState>;
	calibration: Calibration;
	confidence: ConfidencePoint[];
	/** merged-away id → the id it now counts for. */
	aliases: Map<ItemId, ItemId>;
	/** Answer events by chat — progress reads these. */
	answersByChat: Map<string, Extract<LearnerEvent, { kind: "answer" }>[]>;
	events: LearnerEvent[];
}

export interface GraphContext {
	/** Lesson titles by chat id — an item from a lesson on a similar topic is related to it. */
	lessonTitles?: Map<string, string>;
	nodes: { id: string; name: string; statement: string; provenance: { chatId: string; messageId: string }[]; createdAt?: string }[];
	chains: { premises: string[]; conclusion: string }[];
	/** Items from other apps' decks (data/learner/external/*.json). */
	external?: readonly ExternalItem[];
}

/** An external deck's schedule as this model's FSRS schedule. */
function externalSchedule(s: NonNullable<ExternalItem["schedule"]>): Schedule {
	const day = 86400000;
	const reviewed = s.reps > 0 && s.stability >= 1;
	return {
		due: s.due, stability: s.stability, difficulty: s.difficulty, elapsed_days: 0,
		scheduled_days: Math.max(0, Math.round((s.due - s.lastReview) / day)), reps: Math.max(1, s.reps), lapses: 0, learning_steps: 0,
		state: reviewed ? 2 : 1, last_review: s.lastReview,
	};
}

/** Rewrites an event's item references through the merge map. */
function canonEvent(e: LearnerEvent, canon: (id: ItemId) => ItemId): LearnerEvent {
	const x = e as LearnerEvent & { itemId?: ItemId; items?: ItemId[] };
	if (x.kind === "merge") return e;
	if (typeof x.itemId === "string" && canon(x.itemId) !== x.itemId) return { ...x, itemId: canon(x.itemId) } as LearnerEvent;
	if (Array.isArray(x.items) && x.items.some((i) => canon(i) !== i)) return { ...x, items: [...new Set(x.items.map(canon))] } as LearnerEvent;
	return e;
}

const SOLID_STABILITY = 21;
const LEECH_LAPSES = 6;

/** Rating an in-lesson answer is worth, or null when it says nothing about memory. */
function answerRating(e: Extract<LearnerEvent, { kind: "answer" }>, outcome: "correct" | "miss" | "dontknow"): Rating | null {
	const predict = e.questionType === "predict";
	const probing = e.tool === "probe" || e.tool === "recall";
	if (outcome === "correct") return e.confidence != null && e.confidence < 50 ? 2 : 3;
	// A missed prediction or probe is about what was not yet taught — not a lapse.
	if (predict || probing) return null;
	return 1;
}

function practiceRating(outcome: string, rung?: string | null): Rating | null {
	if (outcome === "solved") return !rung || rung === "R0" ? 3 : 2;
	if (outcome === "solvedWithHints") return rung === "R3" || rung === "R4" || rung === "R5" ? 1 : 2;
	if (outcome === "surrendered" || outcome === "movedOn") return 1;
	return null;
}

/** Replays the evidence into the learner state. Events may arrive in any order; they are sorted by time. */
export function deriveLearner(rawEvents: readonly LearnerEvent[], graph: GraphContext, now: number): LearnerState {
	const sorted = [...rawEvents].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	// merges first: every reference to a merged-away item counts for the one it went into
	const aliases = new Map<ItemId, ItemId>();
	for (const e of sorted) if (e.kind === "merge" && e.from !== e.into) aliases.set(e.from, e.into);
	const canon = (id: ItemId): ItemId => { let x = id; for (let i = 0; i < 10 && aliases.has(x); i++) x = aliases.get(x)!; return x; };
	const events = aliases.size ? sorted.map((e) => canonEvent(e, canon)) : sorted;
	const overruled = new Set(events.flatMap((e) => (e.kind === "review" && e.overrules ? [e.overrules] : [])));
	const items = new Map<ItemId, ItemState>();
	const premisesOf = new Map<string, string[]>();
	for (const c of graph.chains) premisesOf.set(c.conclusion, [...new Set([...(premisesOf.get(c.conclusion) ?? []), ...c.premises])]);
	const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
	const nodesByMessage = new Map<string, string[]>();
	for (const n of graph.nodes) for (const p of n.provenance) if (p.messageId) (nodesByMessage.get(p.messageId) ?? nodesByMessage.set(p.messageId, []).get(p.messageId)!).push(n.id);

	const item = (id: ItemId, at: string): ItemState => {
		let it = items.get(id);
		if (!it) {
			const node = id.startsWith("node:") ? nodeById.get(id.slice(5)) : undefined;
			it = {
				id, kind: id.startsWith("node:") ? "node" : "term",
				label: node ? node.name : id.slice(5), meaning: node ? node.statement : "",
				schedule: createSchedule(Date.parse(at) || now), retrievability: null, status: "new",
				ratings: [], lapses: 0, misconceptions: [], lessons: [], firstSeen: at, lastSeen: at,
				reviewable: !!node, priority: node ? 1 : 0, usedEarly: 0, asked: 0, drift: [],
				premises: node ? (premisesOf.get(node.id) ?? []).map(nodeItem) : [], aliases: [],
			};
			items.set(id, it);
		}
		if (at > it.lastSeen) it.lastSeen = at;
		if (at < it.firstSeen) it.firstSeen = at;
		return it;
	};
	const lesson = (it: ItemState, chatId: string) => { if (chatId && !it.lessons.includes(chatId)) it.lessons.push(chatId); };
	const markSolid = (it: ItemState, before: Schedule, next: Schedule, at: string) => {
		const wasSolid = before.state === 2 && before.stability >= SOLID_STABILITY;
		const isSolid = next.state === 2 && next.stability >= SOLID_STABILITY;
		if (isSolid && !wasSolid) it.solidSince = at; else if (!isSolid) delete it.solidSince;
	};
	const apply = (it: ItemState, rating: Rating, at: string, source: LearnerEventKind, eventId: string, key: "schedule" | "produce" = "schedule") => {
		const t = Date.parse(at) || now;
		it.reviewable = true;
		const before = it[key] ?? createSchedule(t);
		const next = rate(before, rating, t);
		if (key === "schedule") { markSolid(it, before, next, at); it.schedule = next; it.lapses = next.lapses; }
		else it.produce = next;
		it.ratings.push({ at, rating, source, eventId, ...(key === "produce" ? { produce: true } : {}) });
		if (rating >= 3) for (const m of it.misconceptions) if (!m.resolvedAt && m.at < at) m.resolvedAt = at;
	};
	const answers = new Map<string, Extract<LearnerEvent, { kind: "answer" }>>();
	const answersByChat = new Map<string, Extract<LearnerEvent, { kind: "answer" }>[]>();
	const suspended = new Set<ItemId>();
	const confidence: ConfidencePoint[] = [];

	const answerItems = (e: Extract<LearnerEvent, { kind: "answer" }>) => {
		const nodes = new Set<string>(nodesByMessage.get(e.messageId) ?? []);
		// the teaching before the question, nearest first, at most 4 propositions in all
		for (const m of [...(e.context ?? [])].reverse()) { if (nodes.size >= 4) break; for (const id of nodesByMessage.get(m) ?? []) if (nodes.size < 4) nodes.add(id); }
		return [...new Set([...e.items.map(canon), ...[...nodes].map(nodeItem)])];
	};
	const rateAnswer = (e: Extract<LearnerEvent, { kind: "answer" }>, outcome: "correct" | "miss" | "dontknow", at: string, eventId: string) => {
		const r = answerRating(e, outcome);
		for (const id of answerItems(e)) { const it = item(id, at); it.reviewable = true; lesson(it, e.chatId); if (r) apply(it, r, at, "answer", eventId); }
	};

	for (const e of events) {
		switch (e.kind) {
			case "answer": {
				answers.set(e.toolCallId, e);
				(answersByChat.get(e.chatId) ?? answersByChat.set(e.chatId, []).get(e.chatId)!).push(e);
				if (e.outcome !== "unknown") rateAnswer(e, e.outcome, e.at, e.id);
				else for (const id of answerItems(e)) { const it = item(id, e.at); it.reviewable = true; lesson(it, e.chatId); }
				if (e.confidence != null && e.outcome !== "unknown") confidence.push({ at: e.at, confidence: e.confidence, correct: e.outcome === "correct", chatId: e.chatId });
				break;
			}
			case "verdict": {
				const a = answers.get(e.toolCallId);
				if (a && a.outcome === "unknown") { a.outcome = e.outcome; rateAnswer(a, e.outcome, e.at, e.id); }
				break;
			}
			case "practice": {
				const r = practiceRating(e.outcome, e.rung);
				for (const id of e.items) { const it = item(id, e.at); it.reviewable = true; lesson(it, e.chatId); if (r) apply(it, r, e.at, "practice", e.id); }
				break;
			}
			case "review": {
				if (overruled.has(e.id)) break;
				const it = item(e.itemId, e.at);
				apply(it, e.rating, e.at, "review", e.id, e.mode === "produce" ? "produce" : "schedule");
				if (e.confidence != null) confidence.push({ at: e.at, confidence: e.confidence, correct: e.rating >= 3, itemId: e.itemId });
				break;
			}
			case "taught": {
				const it = item(e.itemId, e.at);
				it.reviewable = true; it.priority = Math.max(it.priority, 1); lesson(it, e.chatId);
				if (e.term) it.label = e.term;
				if (e.gloss && it.meaningSource !== "learner") { it.meaning = e.gloss; delete it.meaningSource; }
				if (e.lang) it.lang = e.lang;
				if (e.example) { it.example = e.example; if (e.exampleEn) it.exampleEn = e.exampleEn; }
				break;
			}
			case "used-early": {
				const it = item(e.itemId, e.at);
				it.reviewable = true; it.usedEarly++; it.priority = Math.max(it.priority, 2); lesson(it, e.chatId);
				if (!it.label || it.label === e.itemId.slice(5)) it.label = e.term;
				break;
			}
			case "asked": {
				const it = item(e.itemId, e.at);
				it.reviewable = true; it.asked++; it.priority = 3; lesson(it, e.chatId);
				if (!it.label || it.label === e.itemId.slice(5)) it.label = e.term;
				break;
			}
			case "use": {
				const it = item(e.itemId, e.at);
				// A use counts as a retrieval only when it was one: the item had been
				// learned and had begun to fade. A misuse of a learned item is a lapse.
				if (it.schedule.state !== 0) {
					const r = retrievability(it.schedule, Date.parse(e.at));
					if (!e.correct) apply(it, 1, e.at, "use", e.id);
					else if (r != null && r < 0.9) apply(it, 3, e.at, "use", e.id);
				}
				break;
			}
			case "misconception": {
				for (const id of e.items) { const it = item(id, e.at); it.reviewable = true; it.misconceptions.push({ belief: e.belief, at: e.at, chatId: e.chatId }); lesson(it, e.chatId); }
				break;
			}
			case "drift": {
				const it = item(e.itemId, e.at);
				it.drift.push({ taughtAs: e.taughtAs, nowAs: e.nowAs, at: e.at, chatId: e.chatId });
				break;
			}
			case "suspend": {
				if (e.on) suspended.add(e.itemId); else suspended.delete(e.itemId);
				break;
			}
			case "merge": {
				// the merged-away item's evidence already counts for `into` (canon); keep its name
				const into = canon(e.into);
				const it = item(into, e.at);
				const name = e.from.slice(5);
				if (name && name !== it.label && !it.aliases.includes(name)) it.aliases.push(name);
				break;
			}
			case "retire": {
				const it = item(e.itemId, e.at);
				if (e.on) it.retired = true; else delete it.retired;
				break;
			}
			case "meaning": {
				const it = item(e.itemId, e.at);
				// a model's meaning only fills a gap; the learner's own wording always stands
				if (e.source === "learner" || !it.meaning) { it.meaning = e.meaning; it.meaningSource = e.source; }
				break;
			}
			case "known": {
				const it = item(e.itemId, e.at);
				if (e.on) {
					const t = Date.parse(e.at) || now;
					const before = it.schedule;
					const next: Schedule = { ...before, state: 2, stability: Math.max(before.stability, 90), difficulty: Math.min(before.difficulty || 3, 3), due: t + 90 * 86400000, scheduled_days: 90, elapsed_days: 0, learning_steps: 0, reps: before.reps + 1, last_review: t };
					markSolid(it, before, next, e.at);
					it.schedule = next; it.known = true; it.reviewable = true;
					it.ratings.push({ at: e.at, rating: 4, source: "known", eventId: e.id });
				} else delete it.known;
				break;
			}
		}
	}

	// every graph proposition is an item (new until retrieved)
	for (const n of graph.nodes) item(nodeItem(n.id), n.createdAt ?? new Date(now).toISOString());

	// items from other apps' decks: their schedule is the baseline, this app's later reviews go on top
	for (const x of graph.external ?? []) {
		if (!x.term) continue;
		const s = x.schedule && x.schedule.lastReview > 0 ? x.schedule : null;
		const seenAt = new Date(s ? s.lastReview : now).toISOString();
		const it = item(canon(termItem(x.term)), seenAt);
		if (it.label === it.id.slice(5)) it.label = x.term;
		if (!it.meaning && x.gloss) { it.meaning = x.gloss; it.meaningSource = "deck"; }
		it.deck = x.deck; it.reviewable = true;
		if (x.lang) it.lang = x.lang;
		if (x.tags?.length) it.tags = x.tags;
		if (x.example && !it.example) { it.example = x.example; if (x.exampleEn) it.exampleEn = x.exampleEn; }
		if (x.audio) it.audio = x.audio;
		if (!s) continue;
		const base = externalSchedule(s);
		const mine = it.ratings.filter((r) => !r.produce);
		const later = mine.filter((r) => (Date.parse(r.at) || 0) > s.lastReview);
		let sched = base;
		for (const r of later) { const next = rate(sched, r.rating, Date.parse(r.at) || now); sched = next; }
		if (later.length || !mine.length || Date.parse(mine[mine.length - 1]!.at) <= s.lastReview) {
			it.schedule = sched; it.lapses = sched.lapses;
			if (sched.state === 2 && sched.stability >= SOLID_STABILITY) it.solidSince ??= new Date(s.lastReview).toISOString(); else delete it.solidSince;
		}
		it.ratings.push({ at: seenAt, rating: 3, source: "deck", eventId: "deck:" + x.deck });
		it.ratings.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	}

	for (const it of items.values()) {
		it.retrievability = retrievability(it.schedule, now);
		if (it.retired) it.reviewable = false;
		const last3 = it.ratings.slice(-3);
		const openMisc = it.misconceptions.some((m) => !m.resolvedAt);
		it.status = suspended.has(it.id) ? "suspended"
			: it.lapses >= LEECH_LAPSES ? "leech"
			: openMisc ? "misconceived"
			: it.ratings.length === 0 ? "new"
			: last3.length >= 2 && last3.filter((r) => r.rating === 1).length >= 2 ? "fragile"
			: it.schedule.state === 2 && it.schedule.stability >= SOLID_STABILITY ? "solid"
			: "learning";
	}
	for (const it of items.values()) {
		if (it.kind !== "node" || it.premises.length === 0) continue;
		let weakest: { id: ItemId; retrievability: number } | null = null;
		for (const p of it.premises) {
			const r = items.get(p)?.retrievability;
			if (r != null && (!weakest || r < weakest.retrievability)) weakest = { id: p, retrievability: r };
		}
		it.weakestPremise = weakest;
	}
	return {
		now, items, events, lessonTitles: graph.lessonTitles ?? new Map(),
		answersByChat, confidence, aliases,
		calibration: calibrationOf(confidence),
	};
}

/** Calibration over a set of confidence judgments. */
export function calibrationOf(points: readonly ConfidencePoint[]): Calibration {
	const n = points.length, sure = points.filter((p) => p.confidence >= 75);
	return {
		answers: n,
		meanConfidence: n ? Math.round(points.reduce((s, p) => s + p.confidence, 0) / n) : null,
		accuracy: n ? Math.round((100 * points.filter((p) => p.correct).length) / n) : null,
		sureAndWrong: sure.length ? Math.round((100 * sure.filter((p) => !p.correct).length) / sure.length) : null,
		sureCount: sure.length,
	};
}

/** Calibration per topic — a lesson (by its title) or a deck — weakest (most often sure and wrong) first. */
export function calibrationByTopic(state: LearnerState): ({ topic: string } & Calibration)[] {
	const groups = new Map<string, ConfidencePoint[]>();
	for (const p of state.confidence) {
		const it = p.itemId ? state.items.get(p.itemId) : undefined;
		const chat = p.chatId ?? it?.lessons[0];
		const topic = chat ? state.lessonTitles.get(chat) || "A lesson" : it?.deck ? `${it.deck[0]!.toUpperCase()}${it.deck.slice(1)} flashcards` : "Other";
		(groups.get(topic) ?? groups.set(topic, []).get(topic)!).push(p);
	}
	return [...groups].map(([topic, ps]) => ({ topic, ...calibrationOf(ps) }))
		.sort((a, b) => (b.sureAndWrong ?? -1) - (a.sureAndWrong ?? -1) || b.answers - a.answers);
}

/** Retrievability with the dependency rule: a proposition is only as available as its weakest premise. */
export function effectiveRetrievability(it: ItemState): number | null {
	const r = it.retrievability;
	if (r == null) return null;
	return it.weakestPremise ? Math.min(r, it.weakestPremise.retrievability) : r;
}

// ─── the review queue ────────────────────────────────────────────────────────

export interface QueueEntry { itemId: ItemId; mode: ReviewMode; reason: "learning" | "due" | "new" | "lesson" }

export interface QueueOptions {
	/** New items introduced per study day. Default 20. */
	newPerDay?: number;
	limit?: number;
	/** Only these items (a lesson's recall card, a glossary pick). */
	only?: ReadonlySet<ItemId>;
	/** Whether a "why" / "cloze" / "discriminate" card exists for an item. */
	hasMode?: (id: ItemId, mode: ReviewMode) => boolean;
	/** Only this deck's items (e.g. "bahasa"). Without it, items that live only in a deck stay out —
	 *  a deck's backlog never floods the lesson queue; a deck word a lesson taught is in both. */
	deck?: string;
}

/** Whether an item belongs in a queue for `deck` (undefined = the lessons' queue). */
export function inDeck(it: ItemState, deck?: string): boolean {
	return deck ? it.deck === deck : !it.deck || it.lessons.length > 0;
}

/** Which way to ask an item next. */
export function modeFor(it: ItemState, now: number, hasMode: (id: ItemId, mode: ReviewMode) => boolean = () => false): ReviewMode {
	const n = it.ratings.filter((r) => r.source === "review").length;
	if (it.produce && isDue(it.produce, now)) return "produce";
	if (it.lang) {
		// a word of a language: both directions from the first stable state, and by ear
		if (!it.produce && it.schedule.state === 2) return "produce";
		const turn = (["recall", "listen", "cloze"] as const)[n % 3]!;
		return turn === "cloze" && !hasMode(it.id, "cloze") ? "recall" : turn;
	}
	if (it.kind === "term" && !it.produce && it.schedule.state === 2 && it.schedule.stability >= 7) return "produce";
	if (it.misconceptions.length && hasMode(it.id, "discriminate") && n % 2 === 1) return "discriminate";
	if (it.kind === "node" && it.premises.length && hasMode(it.id, "why") && n % 3 === 2) return "why";
	if (hasMode(it.id, "cloze") && n % 3 === 1) return "cloze";
	return "recall";
}

export function reviewQueue(state: LearnerState, opts: QueueOptions = {}): QueueEntry[] {
	const now = state.now, limit = opts.limit ?? 50, newPerDay = opts.newPerDay ?? 20, has = opts.hasMode ?? (() => false);
	const today = studyDay(now);
	const out: QueueEntry[] = [];
	const pool = [...state.items.values()].filter((it) => it.reviewable && it.status !== "leech" && it.status !== "suspended" && (opts.only ? opts.only.has(it.id) : inDeck(it, opts.deck)));
	const learning = pool.filter((it) => (it.schedule.state === 1 || it.schedule.state === 3) && it.schedule.due <= now).sort((a, b) => a.schedule.due - b.schedule.due);
	const due = pool.filter((it) => it.schedule.state === 2 && (isDue(it.schedule, now) || (it.produce && isDue(it.produce, now))))
		.sort((a, b) => (effectiveRetrievability(a) ?? 1) - (effectiveRetrievability(b) ?? 1));
	const introducedToday = new Set(state.events.filter((e) => e.kind === "review" && studyDay(Date.parse(e.at)) === today).map((e) => (e as { itemId: string }).itemId));
	const freshToday = [...state.items.values()].filter((it) => it.ratings[0] && studyDay(Date.parse(it.ratings[0].at)) === today && introducedToday.has(it.id)).length;
	const fresh = pool.filter((it) => it.schedule.state === 0)
		.sort((a, b) => b.priority - a.priority || (b.misconceptions.length - a.misconceptions.length) || (a.firstSeen < b.firstSeen ? -1 : 1))
		.slice(0, opts.only ? undefined : Math.max(0, newPerDay - freshToday));
	for (const it of learning) out.push({ itemId: it.id, mode: modeFor(it, now, has), reason: "learning" });
	for (const it of due) out.push({ itemId: it.id, mode: modeFor(it, now, has), reason: "due" });
	for (const it of fresh) out.push({ itemId: it.id, mode: "recall", reason: opts.only ? "lesson" : "new" });
	return out.slice(0, limit);
}

/** How many are due now (the shelf's count). */
export function dueCount(state: LearnerState, newPerDay = 20, deck?: string): { due: number; learning: number; fresh: number } {
	const q = reviewQueue(state, { newPerDay, limit: 10000, deck });
	return { due: q.filter((e) => e.reason === "due").length, learning: q.filter((e) => e.reason === "learning").length, fresh: q.filter((e) => e.reason === "new").length };
}

// ─── lesson progress ─────────────────────────────────────────────────────────

export type NodeProgress = "checked" | "repaired" | "missed" | "open";

export interface LessonProgress {
	nodes: { id: string; title: string; status: NodeProgress; checks: number }[];
	checked: number; repaired: number; missed: number; open: number;
	/** Items this lesson moved: established (rated good+), still shaky, added to review. */
	established: string[];
	shaky: string[];
	added: string[];
	/** Open nodes whose prerequisites are all checked/repaired — the next sensible step. */
	frontier: string[];
}

export function lessonProgress(state: LearnerState, chatId: string, tree: { nodes: { id: string; title: string }[]; edges: { from: string; to: string }[] } | undefined): LessonProgress {
	const answers = (state.answersByChat.get(chatId) ?? []).filter((a) => a.planNode && a.questionType !== "predict" && a.tool !== "probe" && a.tool !== "recall");
	const byNode = new Map<string, ("correct" | "miss" | "dontknow" | "unknown")[]>();
	for (const a of answers) (byNode.get(a.planNode!) ?? byNode.set(a.planNode!, []).get(a.planNode!)!).push(a.outcome);
	const statusOf = (o: ("correct" | "miss" | "dontknow" | "unknown")[] | undefined): NodeProgress => {
		const known = (o ?? []).filter((x) => x !== "unknown");
		if (!known.length) return "open";
		const last = known[known.length - 1];
		if (last !== "correct") return "missed";
		return known.some((x) => x !== "correct") ? "repaired" : "checked";
	};
	const nodes = (tree?.nodes ?? []).map((n) => ({ id: n.id, title: n.title, status: statusOf(byNode.get(n.id)), checks: (byNode.get(n.id) ?? []).length }));
	const st = new Map(nodes.map((n) => [n.id, n.status]));
	const parents = new Map<string, string[]>();
	for (const e of tree?.edges ?? []) (parents.get(e.to) ?? parents.set(e.to, []).get(e.to)!).push(e.from);
	const frontier = nodes.filter((n) => n.status === "open" && (parents.get(n.id) ?? []).every((p) => st.get(p) === "checked" || st.get(p) === "repaired")).map((n) => n.id);
	const mine = [...state.items.values()].filter((it) => it.lessons.includes(chatId));
	const ratedHere = (it: ItemState) => it.ratings.filter((r) => state.events.some((e) => e.id === r.eventId && "chatId" in e && (e as { chatId?: string }).chatId === chatId));
	return {
		nodes,
		checked: nodes.filter((n) => n.status === "checked").length,
		repaired: nodes.filter((n) => n.status === "repaired").length,
		missed: nodes.filter((n) => n.status === "missed").length,
		open: nodes.filter((n) => n.status === "open").length,
		established: mine.filter((it) => { const r = ratedHere(it); return r.length > 0 && r[r.length - 1]!.rating >= 3; }).map((it) => it.label),
		shaky: mine.filter((it) => it.status === "fragile" || it.status === "misconceived" || (ratedHere(it).slice(-1)[0]?.rating ?? 3) < 3).map((it) => it.label),
		added: mine.filter((it) => it.reviewable && it.kind === "term").map((it) => it.label),
		frontier,
	};
}

/** Plan nodes before `current` (its ancestors) that were never checked, or were missed and never repaired. */
export function uncheckedBefore(progress: LessonProgress, edges: { from: string; to: string }[], current: string): string[] {
	const parents = new Map<string, string[]>();
	for (const e of edges) (parents.get(e.to) ?? parents.set(e.to, []).get(e.to)!).push(e.from);
	const seen = new Set<string>(), stack = [...(parents.get(current) ?? [])];
	while (stack.length) { const p = stack.pop()!; if (seen.has(p)) continue; seen.add(p); stack.push(...(parents.get(p) ?? [])); }
	return progress.nodes.filter((n) => seen.has(n.id) && (n.status === "open" || n.status === "missed")).map((n) => n.id);
}

// ─── the digest ──────────────────────────────────────────────────────────────

export interface Digest {
	days: number;
	newlySolid: string[];
	slipping: string[];
	misconceptionsFixed: string[];
	openMisconceptions: { label: string; belief: string }[];
	answers: number;
	reviews: number;
	accuracy: number | null;
	counts: Record<ItemStatus, number>;
}

export function digest(state: LearnerState, days = 7): Digest {
	const since = new Date(state.now - days * 86400000).toISOString();
	const counts: Record<ItemStatus, number> = { new: 0, learning: 0, solid: 0, fragile: 0, misconceived: 0, leech: 0, suspended: 0 };
	const newlySolid: string[] = [], slipping: string[] = [], fixed: string[] = [], open: { label: string; belief: string }[] = [];
	for (const it of state.items.values()) {
		// the lessons' week: a deck's own backlog (words only another app taught) has its own row
		if (!inDeck(it) || it.retired) continue;
		if (it.reviewable || it.ratings.length) counts[it.status]++;
		if (it.status === "solid" && it.solidSince && it.solidSince >= since) newlySolid.push(it.label);
		const r = effectiveRetrievability(it);
		if (r != null && r < 0.7 && it.status !== "leech" && it.status !== "suspended") slipping.push(it.label);
		for (const m of it.misconceptions) {
			if (m.resolvedAt && m.resolvedAt >= since) fixed.push(it.label);
			if (!m.resolvedAt) open.push({ label: it.label, belief: m.belief });
		}
	}
	const recent = state.events.filter((e) => e.at >= since);
	const ans = recent.filter((e): e is Extract<LearnerEvent, { kind: "answer" }> => e.kind === "answer" && e.outcome !== "unknown");
	return {
		days, newlySolid, slipping, misconceptionsFixed: [...new Set(fixed)], openMisconceptions: open,
		answers: ans.length, reviews: recent.filter((e) => e.kind === "review").length,
		accuracy: ans.length ? Math.round((100 * ans.filter((a) => a.outcome === "correct").length) / ans.length) : null,
		counts,
	};
}

// ─── the glossary ────────────────────────────────────────────────────────────

export interface GlossaryEntry {
	itemId: ItemId; term: string; meaning: string; status: ItemStatus; retrievability: number | null;
	lessons: string[]; asked: number; drift: ItemState["drift"]; misconceptions: Misconception[];
	aliases: string[]; usedEarly: number; meaningSource?: ItemState["meaningSource"]; lang?: string; deck?: string; known?: boolean;
}

/** Terms taught or asked about (or one lesson's, or one deck's). Retired terms are not in it. */
export function glossary(state: LearnerState, chatId?: string, deck?: string): GlossaryEntry[] {
	return [...state.items.values()]
		.filter((it) => it.kind === "term" && it.reviewable && !it.retired && (chatId ? it.lessons.includes(chatId) : inDeck(it, deck)))
		.map((it) => ({ itemId: it.id, term: it.label, meaning: it.meaning, status: it.status, retrievability: it.retrievability, lessons: it.lessons, asked: it.asked, drift: it.drift, misconceptions: it.misconceptions,
			aliases: it.aliases, usedEarly: it.usedEarly, ...(it.meaningSource ? { meaningSource: it.meaningSource } : {}), ...(it.lang ? { lang: it.lang } : {}), ...(it.deck ? { deck: it.deck } : {}), ...(it.known ? { known: true } : {}) }))
		.sort((a, b) => a.term.localeCompare(b.term));
}

// ─── the profile a lesson starts with ───────────────────────────────────────

const words = (s: string) => new Set(normTerm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));

/** Items related to a topic: word overlap with the topic text, or taught in that lesson. */
export function relatedItems(state: LearnerState, topic: string, chatId?: string, max = 30): ItemState[] {
	const tw = words(topic);
	const overlap = (text: string) => { let s = 0; for (const w of words(text)) if (tw.has(w)) s++; return s; };
	const lessonScore = new Map([...state.lessonTitles].map(([id, title]) => [id, overlap(title)]));
	const score = (it: ItemState) => {
		if (chatId && it.lessons.includes(chatId)) return 10;
		// the label's words count most; one shared word in a long meaning alone is chance, not relatedness
		const own = overlap(it.label) * 3 + overlap(it.meaning);
		const viaLesson = Math.max(0, ...it.lessons.map((l) => lessonScore.get(l) ?? 0)) * 2;
		return own + viaLesson;
	};
	return [...state.items.values()].filter((it) => !it.retired && (it.ratings.length || it.misconceptions.length || it.asked || it.usedEarly || (it.reviewable && it.lessons.length)))
		.map((it) => [it, score(it)] as const).filter(([, s]) => s >= 2).sort((a, b) => b[1] - a[1]).slice(0, max).map(([it]) => it);
}

/** The [Learner profile] text for a lesson's first turn, or null when nothing relevant is known. */
export function profileText(state: LearnerState, topic: string, chatId?: string): string | null {
	const rel = relatedItems(state, topic, chatId, 40);
	const misc = [...state.items.values()].flatMap((it) => it.misconceptions.filter((m) => !m.resolvedAt).map((m) => ({ it, m }))).filter(({ it }) => rel.includes(it)).slice(0, 6);
	const pct = (r: number | null) => (r == null ? "" : ` (${Math.round(r * 100)}% recall now)`);
	const group = (s: ItemStatus[]) => rel.filter((it) => s.includes(it.status));
	const solid = group(["solid"]), learning = group(["learning"]), weak = group(["fragile", "leech"]);
	const met = rel.filter((it) => it.status === "new" && it.reviewable).slice(0, 15);
	const c = state.calibration;
	const deckPart = deckProfile(state, topic);
	if (!rel.length && !(c.sureCount >= 5) && !deckPart) return null;
	const lines = ["[Learner profile] — from the app's record of this learner's past answers and reviews, not from the learner:"];
	if (solid.length) lines.push("", "Solid (held reliably — do not re-teach or re-probe; build on it):", ...solid.map((it) => `- ${it.label}`));
	if (learning.length) lines.push("", "Learning (seen and partly held):", ...learning.map((it) => `- ${it.label}${pct(effectiveRetrievability(it))}`));
	if (weak.length) lines.push("", "Fragile (missed repeatedly — check before building on it):", ...weak.map((it) => `- ${it.label}${pct(effectiveRetrievability(it))}`));
	if (met.length) lines.push("", "Met in earlier lessons but never checked (treat as unknown until the learner shows it):", "- " + met.map((it) => it.label).join(", "));
	if (misc.length) lines.push("", "Believes, wrongly (repair explicitly — name the belief and show why it fails):", ...misc.map(({ it, m }) => `- ${it.label}: "${m.belief}"`));
	if (c.sureCount >= 5 && c.sureAndWrong != null) {
		lines.push("", `Calibration: ${c.sureAndWrong}% of answers given at ≥75% confidence were wrong (${c.sureCount} such answers; overall ${c.accuracy}% right at a mean ${c.meanConfidence}% confidence).` +
			(c.sureAndWrong >= 25 ? " The learner is often sure and wrong — ask for the reason behind an answer, not only the answer." : ""));
	}
	if (deckPart) lines.push("", deckPart);
	return lines.join("\n");
}

/** Words that name a language in a lesson's topic, by BCP-47 code. */
const LANGUAGE_WORDS: Record<string, string[]> = { id: ["indonesia", "indonesian", "bahasa"] };

/** What the learner holds from another app's deck in the topic's language — for a language lesson's profile. */
export function deckProfile(state: LearnerState, topic: string): string | null {
	const t = normTerm(topic);
	const langs = Object.entries(LANGUAGE_WORDS).filter(([, ws]) => ws.some((w) => t.includes(w))).map(([l]) => l);
	if (!langs.length) return null;
	const deck = [...state.items.values()].filter((it) => it.deck && it.lang && langs.includes(it.lang) && !it.retired);
	if (!deck.length) return null;
	const seen = deck.filter((it) => it.schedule.state !== 0);
	const solid = seen.filter((it) => it.status === "solid" || (effectiveRetrievability(it) ?? 0) >= 0.9);
	const fading = seen.filter((it) => !solid.includes(it)).sort((a, b) => (effectiveRetrievability(a) ?? 0) - (effectiveRetrievability(b) ?? 0));
	const names = [...new Set(deck.map((it) => it.deck!))].join(", ");
	return [
		`From the learner's ${names} flashcards (${deck.length} words, ${seen.length} studied):`,
		solid.length ? `- Held well (use freely, no need to gloss): ${solid.slice(0, 60).map((it) => it.label).join(", ")}` : "",
		fading.length ? `- Studied but fading (gloss on first use, or check recall): ${fading.slice(0, 30).map((it) => it.label).join(", ")}` : "",
		`- ${deck.length - seen.length} deck words never studied — treat as unknown.`,
	].filter(Boolean).join("\n");
}

// ─── vocabulary health: terms used before they were taught ──────────────────

export interface VocabularyHealth {
	taught: number;
	usedEarly: number;
	/** Share of new terms that were used before they were taught (0–100), null with none. */
	rate: number | null;
	/** Week by week (Monday starts), oldest first — is the gate working. */
	weeks: { week: string; taught: number; usedEarly: number; rate: number | null }[];
}

export function vocabularyHealth(state: LearnerState, chatId?: string, weeks = 6): VocabularyHealth {
	const evs = state.events.filter((e): e is Extract<LearnerEvent, { kind: "taught" | "used-early" }> => (e.kind === "taught" || e.kind === "used-early") && (!chatId || e.chatId === chatId));
	const rateOf = (t: number, u: number) => (t + u ? Math.round((100 * u) / (t + u)) : null);
	const monday = (ms: number) => { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
	const out: VocabularyHealth["weeks"] = [];
	for (let i = weeks - 1; i >= 0; i--) {
		const w = monday(state.now - i * 7 * 86400000);
		const inWeek = evs.filter((e) => monday(Date.parse(e.at)) === w);
		const t = inWeek.filter((e) => e.kind === "taught").length, u = inWeek.length - t;
		out.push({ week: w, taught: t, usedEarly: u, rate: rateOf(t, u) });
	}
	const taught = evs.filter((e) => e.kind === "taught").length, usedEarly = evs.length - taught;
	return { taught, usedEarly, rate: rateOf(taught, usedEarly), weeks: out };
}

/** A term the check should never have kept: a lone letter or symbol, a number. */
export function isJunkTerm(term: string): boolean {
	const t = normTerm(term).replace(/[()]/g, "").trim();
	if (!t) return true;
	if (/^[\p{N}\s.,]+$/u.test(t)) return true;
	return [...t.replace(/[^\p{L}]/gu, "")].length <= 1 && !/[\^_=+*\/×·√∑∫-]/.test(t);
}

// ─── the question mix: options vs. his own words ────────────────────────────

export interface QuestionMix {
	/** Teach-phase checks and predictions answered: with options (quiz) and in his own words (explain). */
	choice: number;
	own: number;
	/** Share in his own words (0–100), null with none. */
	ownShare: number | null;
	weeks: { week: string; choice: number; own: number }[];
}

/** How the lessons ask (fork 2026-11): a lesson of only options never shows he can produce an idea himself. */
export function questionMix(state: LearnerState, weeks = 6): QuestionMix {
	const ans = state.events.filter((e): e is Extract<LearnerEvent, { kind: "answer" }> => e.kind === "answer" && (e.tool === "quiz" || e.tool === "explain"));
	const monday = (ms: number) => { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
	const out: QuestionMix["weeks"] = [];
	for (let i = weeks - 1; i >= 0; i--) {
		const w = monday(state.now - i * 7 * 86400000);
		const inWeek = ans.filter((e) => monday(Date.parse(e.at)) === w);
		out.push({ week: w, choice: inWeek.filter((e) => e.tool === "quiz").length, own: inWeek.filter((e) => e.tool === "explain").length });
	}
	const choice = ans.filter((e) => e.tool === "quiz").length, own = ans.length - choice;
	return { choice, own, ownShare: ans.length ? Math.round((100 * own) / ans.length) : null, weeks: out };
}
