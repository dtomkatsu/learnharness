import { learnerEngine, notesMarkdown, notesView, stores, writeLessonNotes } from "@/src/server";

/** A lesson's notes: every step in plan order, its status, its note when written. ?format=md — the notes as Markdown. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const view = notesView(stores, id);
	if (!view) return Response.json({ error: "Not found" }, { status: 404 });
	if (new URL(req.url).searchParams.get("format") === "md") return new Response(notesMarkdown(view), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `inline; filename="${id}.md"` } });
	return Response.json(view);
}

/** Write the notes of finished steps that have none (or are out of date) now — the learner's own request. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const engine = learnerEngine(false);
	if (!engine) return Response.json({ error: "No model is set for the cheap slot." }, { status: 503 });
	const r = await writeLessonNotes(stores, id, engine, 40);
	return Response.json({ ...r, ...notesView(stores, id) });
}
