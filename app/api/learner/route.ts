import { digest, dueCount } from "@/src/core";
import { backfillEvidence, learnerEngine, learnerState, stores } from "@/src/server";

/** The learner model at a glance (2026-11): due counts, calibration, the week's digest. */
export async function GET(req: Request) {
	const days = Math.max(1, Math.min(90, Number(new URL(req.url).searchParams.get("days")) || 7));
	const backfilled = backfillEvidence(stores);
	const state = learnerState(stores);
	return Response.json({ backfilled, due: dueCount(state), calibration: state.calibration, digest: digest(state, days), engine: !!learnerEngine(false) });
}
