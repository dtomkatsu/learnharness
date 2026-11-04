import { glossary } from "@/src/core";
import { learnerEngine, learnerState, readCards, stores } from "@/src/server";

/** The glossary: every term taught or asked about (or one lesson's), its meaning, status and where it was taught. */
export async function GET(req: Request) {
	const chatId = new URL(req.url).searchParams.get("chatId") ?? undefined;
	const state = learnerState(stores), cards = readCards();
	const titles = new Map(stores.chatStore.listChats().map((c) => [c.id, c.title]));
	return Response.json({
		terms: glossary(state, chatId).map((g) => ({ ...g, meaning: g.meaning || cards[g.itemId]?.meaning || "", lessons: g.lessons.map((id) => ({ id, title: titles.get(id) ?? "" })) })),
	});
}
