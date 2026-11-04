import { calibrationByTopic, DECK_LIMITS, digest, dueCount, questionMix, vocabularyHealth } from "@/src/core";
import { backfillEvidence, learnerEngine, learnerState, stores } from "@/src/server";

/** The learner model at a glance (2026-11): due counts (the lessons' queue and each deck's), calibration overall and by topic, the week's digest, how often terms are used before they are taught. */
export async function GET(req: Request) {
	const days = Math.max(1, Math.min(90, Number(new URL(req.url).searchParams.get("days")) || 7));
	const backfilled = backfillEvidence(stores);
	const state = learnerState(stores);
	const decks = [...new Set([...state.items.values()].flatMap((it) => (it.deck ? [it.deck] : [])))];
	return Response.json({
		backfilled, due: dueCount(state),
		decks: Object.fromEntries(decks.map((d) => [d, { ...dueCount(state, DECK_LIMITS.newPerDay, d, DECK_LIMITS.dueCap), words: [...state.items.values()].filter((it) => it.deck === d).length }])),
		calibration: state.calibration, calibrationByTopic: calibrationByTopic(state),
		digest: digest(state, days), vocabulary: vocabularyHealth(state), questions: questionMix(state), engine: !!learnerEngine(false),
	});
}
