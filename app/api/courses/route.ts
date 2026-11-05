import { courseFromChat, courseView, createCourse, listCourses, stores, strongEngine } from "@/src/server";

/** Every course with its progress and next lesson. */
export async function GET() {
	return Response.json({ courses: listCourses().map((c) => { const v = courseView(stores, c); return { id: v.id, title: v.title, goal: v.goal, status: v.status, done: v.done, total: v.total, next: v.next, nextSuggestedAt: v.nextSuggestedAt, updatedAt: v.updatedAt }; }) });
}

/** POST { goal } — draft a course for a goal; { fromChat } — turn a lesson from before courses into one. Drafts wait for approval. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { goal?: unknown; fromChat?: unknown };
	const engine = strongEngine();
	if (!engine) return Response.json({ error: "No model is set for the strong slot." }, { status: 503 });
	try {
		const c = typeof body.fromChat === "string" ? await courseFromChat(stores, body.fromChat, engine)
			: typeof body.goal === "string" && body.goal.trim() ? await createCourse(stores, body.goal.trim().slice(0, 1000), engine)
			: null;
		if (!c) return Response.json({ error: "goal (text) or fromChat (a lesson id) wanted" }, { status: 400 });
		return Response.json(courseView(stores, c));
	} catch (err) {
		return Response.json({ error: String((err as Error).message ?? err) }, { status: 502 });
	}
}
