import { courseNotesMarkdown, readCourse, stores } from "@/src/server";

/** The course's notes, lesson by lesson, as one Markdown document. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const c = readCourse((await params).id);
	if (!c) return Response.json({ error: "Not found" }, { status: 404 });
	return new Response(courseNotesMarkdown(stores, c), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
