import { learnerEngine, readEvidence, recordReview, stores } from "@/src/server";

/** POST { eventId, rating } — the learner overrules a grade; the new rating replaces the old in the replay. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { eventId?: unknown; rating?: unknown };
	const old = readEvidence().find((e) => e.id === body.eventId);
	const rating = Number(body.rating);
	if (!old || old.kind !== "review" || ![1, 2, 3, 4].includes(rating)) return Response.json({ error: "a review eventId and a rating 1–4 wanted" }, { status: 400 });
	const [ev] = recordReview(old.itemId, old.mode, rating as 1 | 2 | 3 | 4, "self", { response: old.response, reason: "overruled by the learner", overrules: old.id });
	return Response.json({ ok: true, eventId: ev!.id });
}
