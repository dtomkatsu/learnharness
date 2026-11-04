import { glossary } from "@/src/core";
import { learnerEngine, learnerState, readCards, stores, tidySoon } from "@/src/server";

/** The glossary: every term taught or asked about (or one lesson's, or ?deck= one deck's), its meaning, status and where it was taught. Opening it tidies terms not yet looked at, in the background. */
export async function GET(req: Request) {
	const q = new URL(req.url).searchParams;
	const chatId = q.get("chatId") ?? undefined, deck = q.get("deck") ?? undefined;
	const state = learnerState(stores), cards = readCards();
	const titles = new Map(stores.chatStore.listChats().map((c) => [c.id, c.title]));
	tidySoon(stores, learnerEngine(true));
	return Response.json({
		terms: glossary(state, chatId, deck).map((g) => ({ ...g, meaning: g.meaning || cards[g.itemId]?.meaning || "", lessons: g.lessons.map((id) => ({ id, title: titles.get(id) ?? "" })) })),
	});
}
