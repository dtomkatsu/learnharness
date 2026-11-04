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

export type ReviewMode = "recall" | "produce" | "why" | "cloze" | "discriminate";

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
	/** A review in the review queue. `overrules` names a review whose rating this one replaces. */
	| (EventBase & { kind: "review"; itemId: ItemId; mode: ReviewMode; rating: Rating; graded: "model" | "self"; response?: string; reason?: string; overrules?: string })
	/** The lesson taught a term (vocabulary check). */
	| (EventBase & { kind: "taught"; itemId: ItemId; term: string; gloss: string; chatId: string; messageId?: string })
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
	ratings: { at: string; rating: Rating; source: LearnerEventKind; eventId: string }[];
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
}

export interface Calibration {
	/** Quiz answers with a confidence. */
	answers: number;
	/** Mean confidence (0–100) vs. accuracy (0–100). */
	meanConfidence: number | null;
	accuracy: number | null;
	/** Of answers at confidence ≥ 75: the share that were wrong. */
	sureAndWrong: number | null;
	sureCount: number;
}

export interface LearnerState {
	now: number;
	lessonTitles: Map<string, string>;
	items: Map<ItemId, ItemState>;
	calibration: Calibration;
	/** Answer events by chat — progress reads these. */
	answersByChat: Map<string, Extract<LearnerEvent, { kind: "answer" }>[]>;
	events: LearnerEvent[];
}

export interface GraphContext {
	/** Lesson titles by chat id — an item from a lesson on a similar topic is related to it. */
	lessonTitles?: Map<string, string>;
	nodes: { id: string; name: string; statement: string; provenance: { chatId: string; messageId: string }[]; createdAt?: string }[];
	chains: { premises: string[]; conclusion: string }[];
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
	const events = [...rawEvents].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
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
				premises: node ? (premisesOf.get(node.id) ?? []).map(nodeItem) : [],
			};
			items.set(id, it);
		}
		if (at > it.lastSeen) it.lastSeen = at;
		return it;
	};
	const lesson = (it: ItemState, chatId: string) => { if (chatId && !it.lessons.includes(chatId)) it.lessons.push(chatId); };
	const apply = (it: ItemState, rating: Rating, at: string, source: LearnerEventKind, eventId: string, key: "schedule" | "produce" = "schedule") => {
		const t = Date.parse(at) || now;
		it.reviewable = true;
		const before = it[key] ?? createSchedule(t);
		const next = rate(before, rating, t);
		if (key === "schedule") {
			const wasSolid = it.schedule.state === 2 && it.schedule.stability >= SOLID_STABILITY;
			const isSolid = next.state === 2 && next.stability >= SOLID_STABILITY;
			if (isSolid && !wasSolid) it.solidSince = at; else if (!isSolid) delete it.solidSince;
			it.schedule = next; it.lapses = next.lapses;
		} else it.produce = next;
		it.ratings.push({ at, rating, source, eventId });
		if (rating >= 3) for (const m of it.misconceptions) if (!m.resolvedAt && m.at < at) m.resolvedAt = at;
	};
	const answers = new Map<string, Extract<LearnerEvent, { kind: "answer" }>>();
	const answersByChat = new Map<string, Extract<LearnerEvent, { kind: "answer" }>[]>();
	const suspended = new Set<ItemId>();
	const cal = { n: 0, conf: 0, right: 0, sure: 0, sureWrong: 0 };

	const answerItems = (e: Extract<LearnerEvent, { kind: "answer" }>) => {
		const nodes = new Set<string>(nodesByMessage.get(e.messageId) ?? []);
		// the teaching before the question, nearest first, at most 4 propositions in all
		for (const m of [...(e.context ?? [])].reverse()) { if (nodes.size >= 4) break; for (const id of nodesByMessage.get(m) ?? []) if (nodes.size < 4) nodes.add(id); }
		return [...new Set([...e.items, ...[...nodes].map(nodeItem)])];
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
				if (e.confidence != null && e.outcome !== "unknown") {
					cal.n++; cal.conf += e.confidence; if (e.outcome === "correct") cal.right++;
					if (e.confidence >= 75) { cal.sure++; if (e.outcome !== "correct") cal.sureWrong++; }
				}
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
				break;
			}
			case "taught": {
				const it = item(e.itemId, e.at);
				it.reviewable = true; it.priority = Math.max(it.priority, 1); lesson(it, e.chatId);
				if (e.term) it.label = e.term;
				if (e.gloss) it.meaning = e.gloss;
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
		}
	}

	// every graph proposition is an item (new until retrieved)
	for (const n of graph.nodes) item(nodeItem(n.id), n.createdAt ?? new Date(now).toISOString());

	for (const it of items.values()) {
		it.retrievability = retrievability(it.schedule, now);
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
		answersByChat,
		calibration: {
			answers: cal.n,
			meanConfidence: cal.n ? Math.round(cal.conf / cal.n) : null,
			accuracy: cal.n ? Math.round((100 * cal.right) / cal.n) : null,
			sureAndWrong: cal.sure ? Math.round((100 * cal.sureWrong) / cal.sure) : null,
			sureCount: cal.sure,
		},
	};
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
}

/** Which way to ask an item next. */
export function modeFor(it: ItemState, now: number, hasMode: (id: ItemId, mode: ReviewMode) => boolean = () => false): ReviewMode {
	const n = it.ratings.filter((r) => r.source === "review").length;
	if (it.produce && isDue(it.produce, now)) return "produce";
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
	const pool = [...state.items.values()].filter((it) => it.reviewable && it.status !== "leech" && it.status !== "suspended" && (!opts.only || opts.only.has(it.id)));
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
export function dueCount(state: LearnerState, newPerDay = 20): { due: number; learning: number; fresh: number } {
	const q = reviewQueue(state, { newPerDay, limit: 10000 });
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
}

export function glossary(state: LearnerState, chatId?: string): GlossaryEntry[] {
	return [...state.items.values()]
		.filter((it) => it.kind === "term" && it.reviewable && (!chatId || it.lessons.includes(chatId)))
		.map((it) => ({ itemId: it.id, term: it.label, meaning: it.meaning, status: it.status, retrievability: it.retrievability, lessons: it.lessons, asked: it.asked, drift: it.drift, misconceptions: it.misconceptions }))
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
	return [...state.items.values()].filter((it) => it.ratings.length || it.misconceptions.length || it.asked || it.usedEarly || (it.reviewable && it.lessons.length))
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
	if (!rel.length && !(c.sureCount >= 5)) return null;
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
	return lines.join("\n");
}
