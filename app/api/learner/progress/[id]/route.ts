import { lessonProgress, vocabularyHealth } from "@/src/core";
import { learnerEngine, learnerState, lessonRecall, queueView, stores } from "@/src/server";

/** A lesson's progress: plan nodes checked / repaired / missed / open, what it established, its recall card. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const record = stores.chatStore.getChat(id);
	if (!record) return Response.json({ error: "Not found" }, { status: 404 });
	const state = learnerState(stores);
	const recall = lessonRecall(state, record);
	return Response.json({ progress: lessonProgress(state, id, record.tree), vocabulary: vocabularyHealth(state, id), recall, recallCards: recall.length ? queueView(state, { only: new Set(recall), limit: 3 }) : [] });
}
