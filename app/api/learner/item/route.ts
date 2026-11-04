import { appendEvidence, itemView, learnerState, readCards, stores } from "@/src/server";

/** One item: its state, the evidence behind it, its card. */
export async function GET(req: Request) {
	const id = new URL(req.url).searchParams.get("id") ?? "";
	const state = learnerState(stores);
	const it = state.items.get(state.aliases.get(id) ?? id);
	if (!it) return Response.json({ error: "No such item" }, { status: 404 });
	const merged = new Set([it.id, ...[...state.aliases].filter(([, into]) => into === it.id).map(([from]) => from)]);
	const evidence = state.events.filter((e) => ("itemId" in e && merged.has(e.itemId as string)) || ("items" in e && (e.items as string[]).some((x) => merged.has(x))) || it.ratings.some((r) => r.eventId === e.id));
	return Response.json({ item: itemView(state, it), card: readCards()[it.id] ?? null, evidence });
}

/**
 * Changes the learner makes to an item, each recorded as evidence:
 * { id, suspend: boolean } — out of review, or back;
 * { id, known: boolean } — "I already knew this" (held, first review in ~3 months), or take it back;
 * { id, retire: boolean } — not a real term: out of the glossary and review;
 * { id, meaning: string } — the meaning in the learner's own words.
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { id?: unknown; suspend?: unknown; known?: unknown; retire?: unknown; meaning?: unknown };
	if (typeof body.id !== "string") return Response.json({ error: "id wanted" }, { status: 400 });
	const id = body.id;
	if (typeof body.suspend === "boolean") appendEvidence([{ kind: "suspend", itemId: id, on: body.suspend } as never]);
	else if (typeof body.known === "boolean") appendEvidence([{ kind: "known", itemId: id, on: body.known } as never]);
	else if (typeof body.retire === "boolean") appendEvidence([{ kind: "retire", itemId: id, on: body.retire, reason: "by the learner" } as never]);
	else if (typeof body.meaning === "string" && body.meaning.trim()) appendEvidence([{ kind: "meaning", itemId: id, meaning: body.meaning.trim().slice(0, 600), source: "learner" } as never]);
	else return Response.json({ error: "suspend, known, retire (boolean) or meaning (text) wanted" }, { status: 400 });
	const state = learnerState(stores);
	const it = state.items.get(state.aliases.get(id) ?? id);
	return Response.json({ ok: true, ...(it ? { item: itemView(state, it) } : {}) });
}
