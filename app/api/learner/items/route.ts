import { normTerm } from "@/src/core";
import { itemView, learnerEngine, learnerState, stores } from "@/src/server";

const ORDER = ["misconceived", "fragile", "leech", "learning", "solid", "new", "suspended"];

/** "What I know": every item with evidence (or reviewable), filterable by status, kind, text. */
export async function GET(req: Request) {
	const q = new URL(req.url).searchParams;
	const status = q.get("status"), kind = q.get("kind"), text = normTerm(q.get("q") ?? "");
	const state = learnerState(stores);
	const items = [...state.items.values()]
		.filter((it) => it.reviewable || it.ratings.length || it.misconceptions.length)
		.filter((it) => (!status || it.status === status) && (!kind || it.kind === kind) && (!text || normTerm(it.label + " " + it.meaning).includes(text)))
		.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.label.localeCompare(b.label))
		.slice(0, 500)
		.map((it) => itemView(state, it));
	return Response.json({ items });
}
