import { learnerEngine, learnerState, lessonStart, queueView, stores } from "@/src/server";

/** Opening a lesson: the warm-up cards and, after a break of three hours or more, where it left off. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Not found" }, { status: 404 });
	const state = learnerState(stores);
	const start = await lessonStart(stores, state, record, learnerEngine(false));
	return Response.json({ ...start, warmupCards: start.warmup.length ? queueView(state, { only: new Set(start.warmup), limit: 3 }) : [] });
}
