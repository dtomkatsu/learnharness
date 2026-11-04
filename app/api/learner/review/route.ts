import { type ReviewMode, retrievability } from "@/src/core";
import { cardContext, cardFace, cardsNeeded, fallbackCard, generateCards, gradeAnswer, learnerEngine, learnerState, prefetchCards, queueView, readCards, recordReview, stores } from "@/src/server";

/**
 * The review queue (2026-11). GET ?limit=&only=<id,id>&deck= — the next cards (deck: one
 * deck's words, e.g. bahasa; without it the lessons' queue); the
 * first few without a written card are written now (cheap model, the
 * learner's own request), the rest ahead of time in the background.
 */
export async function GET(req: Request) {
	const q = new URL(req.url).searchParams;
	const limit = Math.max(1, Math.min(100, Number(q.get("limit")) || 20));
	const only = q.get("only") ? new Set(q.get("only")!.split(",").filter(Boolean)) : undefined;
	const deck = q.get("deck") || undefined;
	let state = learnerState(stores);
	let queue = queueView(state, { limit, only, deck });
	const need = cardsNeeded(state, queue.slice(0, 5).map((e) => e.itemId));
	const engine = learnerEngine(false);
	if (need.length && engine) {
		try { await generateCards(stores, state, need, engine, cardContext(stores, state)); }
		catch (err) { console.error("[learner] card writing failed:", err); }
		state = learnerState(stores);
		queue = queueView(state, { limit, only, deck });
	}
	prefetchCards(stores, learnerEngine(true), queueView(state, { limit: 40, only, deck }).map((e) => e.itemId));
	return Response.json({ queue });
}

/**
 * POST { itemId, mode, response?, rating?, chatId?, confidence? }: with `rating` the learner
 * graded themselves; with `response` the cheap model grades it against the
 * card. Answers with the rating, the reason, the expected answer and the
 * item's next due date.
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { itemId?: unknown; mode?: unknown; response?: unknown; rating?: unknown; chatId?: unknown; confidence?: unknown };
	const itemId = typeof body.itemId === "string" ? body.itemId : "";
	const mode = (["recall", "produce", "why", "cloze", "discriminate", "listen"].includes(String(body.mode)) ? body.mode : "recall") as ReviewMode;
	const state = learnerState(stores);
	const it = state.items.get(itemId);
	if (!it) return Response.json({ error: "No such item" }, { status: 404 });
	const card = readCards()[itemId] ?? fallbackCard(it);
	const face = cardFace(card, mode, it);
	const response = typeof body.response === "string" ? body.response : "";
	let rating = Number(body.rating), reason = "", belief: string | undefined, graded: "model" | "self" = "self";
	if (![1, 2, 3, 4].includes(rating)) {
		const engine = learnerEngine(false);
		if (!engine) return Response.json({ error: "No model is set for grading (the cheap slot) — grade it yourself.", answer: face.answer }, { status: 503 });
		try { const g = await gradeAnswer(face, response, engine); rating = g.rating; reason = g.reason; belief = g.belief; graded = "model"; }
		catch (err) { return Response.json({ error: String((err as Error).message ?? err), answer: face.answer }, { status: 502 }); }
	}
	const confidence = typeof body.confidence === "number" ? body.confidence : undefined;
	const [ev] = recordReview(itemId, mode, rating as 1 | 2 | 3 | 4, graded, { response, reason, belief, confidence, chatId: typeof body.chatId === "string" ? body.chatId : undefined });
	const after = learnerState(stores).items.get(itemId)!;
	const sched = mode === "produce" && after.produce ? after.produce : after.schedule;
	return Response.json({
		eventId: ev!.id, rating, graded, reason, answer: face.answer, ...(belief && rating <= 2 ? { belief } : {}),
		next: { due: new Date(sched.due).toISOString(), days: Math.max(0, Math.round((sched.due - Date.now()) / 86400000)), retrievability: retrievability(sched, Date.now()) },
		status: after.status,
		...(after.lapses >= 2 && card.elaboration ? { elaboration: card.elaboration } : {}),
		...(after.lapses >= 3 && card.hook ? { hook: card.hook } : {}),
	});
}
