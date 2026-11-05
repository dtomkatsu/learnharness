import { courseView, readCourse, redrawCourse, setSkipped, startLesson, stores, strongEngine, writeCourse } from "@/src/server";

/** One course: units, lessons with their state and progress, what is next. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const c = readCourse((await params).id);
	return c ? Response.json(courseView(stores, c)) : Response.json({ error: "Not found" }, { status: 404 });
}

/**
 * POST { action }:
 *   approve                 — the roadmap is his; lessons can start
 *   redraw { request }      — plan the rest again from what he asks (done lessons stay)
 *   start { lessonId? }     — the lesson's chat (created with its course context), the next one by default
 *   skip / unskip { lessonId } — he knows it already (the next lesson checks it briefly)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const c = readCourse((await params).id);
	if (!c) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => ({}))) as { action?: unknown; request?: unknown; lessonId?: unknown };
	try {
		if (body.action === "approve") {
			if (c.status === "draft") { c.status = "active"; c.history.push({ at: new Date().toISOString(), why: "approved" }); writeCourse(c); }
			return Response.json(courseView(stores, c));
		}
		if (body.action === "redraw") {
			if (typeof body.request !== "string" || !body.request.trim()) return Response.json({ error: "request (text) wanted" }, { status: 400 });
			const engine = strongEngine();
			if (!engine) return Response.json({ error: "No model is set for the strong slot." }, { status: 503 });
			return Response.json(courseView(stores, await redrawCourse(stores, c, body.request.trim().slice(0, 1000), engine)));
		}
		if (body.action === "start") {
			const v = courseView(stores, c);
			const lessonId = typeof body.lessonId === "string" ? body.lessonId : v.next?.id;
			if (!lessonId) return Response.json({ error: "every lesson is done" }, { status: 409 });
			const r = startLesson(stores, c, lessonId);
			return Response.json({ ...r, course: courseView(stores, c) });
		}
		if ((body.action === "skip" || body.action === "unskip") && typeof body.lessonId === "string") {
			setSkipped(c, body.lessonId, body.action === "skip");
			return Response.json(courseView(stores, c));
		}
		return Response.json({ error: "action: approve | redraw | start | skip | unskip" }, { status: 400 });
	} catch (err) {
		return Response.json({ error: String((err as Error).message ?? err) }, { status: 502 });
	}
}
