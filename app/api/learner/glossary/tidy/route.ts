import { learnerEngine, stores, tidyGlossary } from "@/src/server";

/** POST { all? } — tidy the glossary now (retire everyday words, merge duplicates, give never-explained terms a meaning). */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { all?: unknown };
	const engine = learnerEngine(false);
	if (!engine) return Response.json({ error: "No model is set for the cheap slot." }, { status: 503 });
	return Response.json(await tidyGlossary(stores, engine, { all: body.all === true }));
}
