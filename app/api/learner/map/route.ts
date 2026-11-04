import { knowledgeMap, learnerState, stores } from "@/src/server";

/** The knowledge map: each lesson's plan as steps (checked / repaired / missed / open, with their terms), what rests on what, and what is ready next. */
export async function GET() {
	return Response.json(knowledgeMap(stores, learnerState(stores)));
}
