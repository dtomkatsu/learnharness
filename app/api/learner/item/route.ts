import { appendEvidence, itemView, learnerEngine, learnerState, readCards, stores } from "@/src/server";

/** One item: its state, the evidence behind it, its card. */
export async function GET(req: Request) {
	const id = new URL(req.url).searchParams.get("id") ?? "";
	const state = learnerState(stores);
	const it = state.items.get(id);
	if (!it) return Response.json({ error: "No such item" }, { status: 404 });
	const evidence = state.events.filter((e) => ("itemId" in e && e.itemId === id) || ("items" in e && (e.items as string[]).includes(id)) || it.ratings.some((r) => r.eventId === e.id));
	return Response.json({ item: itemView(state, it), card: readCards()[id] ?? null, evidence });
}

/** { id, suspend: boolean } — take an item out of review, or put it back. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { id?: unknown; suspend?: unknown };
	if (typeof body.id !== "string" || typeof body.suspend !== "boolean") return Response.json({ error: "id and suspend wanted" }, { status: 400 });
	appendEvidence([{ kind: "suspend", itemId: body.id, on: body.suspend } as never]);
	return Response.json({ ok: true });
}
