import type { ReviewMode } from "@/src/core";
import { appendEvidence, cardContext, cardFace, fallbackCard, generateCards, learnerEngine, learnerState, readCards, readEvidence, stores } from "@/src/server";

/**
 * "Too vague" (2026-11): the learner's complaint about a question, recorded as evidence.
 *  { itemId, mode } — a review card's prompt: the item's cards are rewritten at once, narrower (the prompts already
 *    complained about go to the card writer as `tooVague`), and the answer is the new face for that mode;
 *  { chatId, toolCallId, question } — a tutor's question in a lesson: only recorded (the page tells the tutor in the lesson itself).
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { itemId?: unknown; mode?: unknown; chatId?: unknown; toolCallId?: unknown; question?: unknown };
	if (typeof body.itemId !== "string") {
		if (typeof body.chatId !== "string" || typeof body.toolCallId !== "string") return Response.json({ error: "itemId + mode, or chatId + toolCallId + question, wanted" }, { status: 400 });
		appendEvidence([{ kind: "vague", prompt: typeof body.question === "string" ? body.question.slice(0, 600) : "", chatId: body.chatId, toolCallId: body.toolCallId } as never]);
		return Response.json({ ok: true });
	}
	const mode = (["recall", "produce", "why", "cloze", "discriminate", "listen", "apply"].includes(String(body.mode)) ? body.mode : "recall") as ReviewMode;
	let state = learnerState(stores);
	const it = state.items.get(state.aliases.get(body.itemId) ?? body.itemId);
	if (!it) return Response.json({ error: "No such item" }, { status: 404 });
	const before = cardFace(readCards()[it.id] ?? fallbackCard(it), mode, it);
	appendEvidence([{ kind: "vague", prompt: before.prompt.slice(0, 600), itemId: it.id, mode } as never]);
	const engine = learnerEngine(false);
	if (!engine) return Response.json({ ok: true, rewritten: false, error: "No model is set for writing cards (the cheap slot)." });
	const complained = readEvidence().flatMap((e) => (e.kind === "vague" && e.itemId === it.id ? [e.prompt] : []));
	try { await generateCards(stores, state, [it.id], engine, cardContext(stores, state), { [it.id]: complained }); }
	catch (err) { console.error("[learner] rewriting a vague card failed:", err); return Response.json({ ok: true, rewritten: false, error: String((err as Error).message ?? err) }); }
	state = learnerState(stores);
	const now = state.items.get(it.id)!;
	const f = cardFace(readCards()[it.id] ?? fallbackCard(now), mode, now);
	return Response.json({ ok: true, rewritten: f.prompt !== before.prompt, mode: f.mode, prompt: f.prompt, answer: f.answer, ...(f.shape ? { shape: f.shape } : {}), ...(f.looksFor?.length ? { looksFor: f.looksFor } : {}) });
}
