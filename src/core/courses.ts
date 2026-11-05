/**
 * Courses (2026-11, docs/course-roadmap-scope.md): a goal broken into units of
 * sized lessons — a roadmap the learner can see and move through day by day,
 * instead of one lesson chat that runs on for days. Pure: the record's shape,
 * lesson status, what comes next, and the vocabulary order across lessons.
 * Lessons stay chats (ChatRecord.course = { id, lessonId }); inside a lesson,
 * plan_init still draws its own step map, seeded from the course lesson.
 */
import { normTerm } from "./vocabulary.ts";
import { studyDay } from "./learner/fsrs.ts";

export type LessonKind = "teach" | "checkpoint";
export type LessonState = "locked" | "next" | "in-progress" | "done" | "held" | "skipped";

export interface CourseLesson {
	id: string;
	title: string;
	/** "By the end you can …" — 2–4 checkable outcomes. */
	objectives: string[];
	/** The steps it teaches (seed for its plan map). */
	steps: string[];
	introduces: string[];
	needs: string[];
	minutes: number;
	kind: LessonKind;
	/** The lesson's chat, once started. */
	chatId?: string;
	/** Taught already in a chat from before the course (converted): that chat and its plan nodes. */
	adopted?: { chatId: string; nodes: string[] };
	skipped?: { at: string };
	/** Set when its objectives were confirmed (from the chat's progress), and when it was finished. */
	doneAt?: string;
}

export interface CourseUnit { id: string; title: string; why: string; lessons: CourseLesson[] }

export interface Course {
	id: string;
	title: string;
	goal: string;
	level: string;
	status: "draft" | "active";
	units: CourseUnit[];
	createdAt: string;
	updatedAt: string;
	history: { at: string; why: string }[];
}

export const lessonsOf = (c: Course): (CourseLesson & { unit: CourseUnit; n: number })[] =>
	c.units.flatMap((u) => u.lessons.map((l) => ({ ...l, unit: u }))).map((l, i) => ({ ...l, n: i + 1 }));

export const slug = (s: string, taken: Set<string>): string => {
	const base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "lesson";
	let id = base, k = 2;
	while (taken.has(id)) id = `${base}-${k++}`;
	taken.add(id);
	return id;
};

/**
 * A lesson's state. `progress` gives, per lesson with a chat (or adopted nodes), how many of its steps are confirmed
 * and held; a lesson is done when all its plan steps are confirmed, held when all are also held a day later. The
 * first lesson not done or skipped is next; after it, locked (a gate, not a wall: it can be started anyway).
 */
export function lessonStates(c: Course, progress: (l: CourseLesson) => { steps: number; confirmed: number; held: number } | null): Map<string, LessonState> {
	const out = new Map<string, LessonState>();
	let nextGiven = false;
	for (const l of lessonsOf(c)) {
		if (l.skipped) { out.set(l.id, "skipped"); continue; }
		const p = progress(l);
		if (p && p.steps > 0 && p.confirmed >= p.steps) { out.set(l.id, p.held >= p.steps ? "held" : "done"); continue; }
		if (l.doneAt && (!p || p.steps === 0)) { out.set(l.id, "done"); continue; }
		// a lesson from before the course counts as begun only when something in it was confirmed
		if (l.chatId || (l.adopted && p && p.confirmed > 0)) { out.set(l.id, "in-progress"); if (!nextGiven) nextGiven = true; continue; }
		out.set(l.id, nextGiven ? "locked" : "next");
		nextGiven = true;
	}
	return out;
}

/** Terms used before the lesson that introduces them (or never introduced, and not known at the start). */
export function courseVocabularyProblems(units: Pick<CourseUnit, "lessons">[], known: string[] = []): string[] {
	const held = new Set(known.map(normTerm)), problems: string[] = [];
	const later = new Map<string, string>();
	const ls = units.flatMap((u) => u.lessons);
	ls.forEach((l) => l.introduces.forEach((t) => { if (!later.has(normTerm(t))) later.set(normTerm(t), l.title); }));
	for (const l of ls) {
		for (const t of l.needs) {
			const k = normTerm(t);
			if (held.has(k)) continue;
			const where = later.get(k);
			problems.push(where ? `"${l.title}" needs "${t}", which is only introduced later, in "${where}"` : `"${l.title}" needs "${t}", which no lesson introduces and he does not hold`);
		}
		l.introduces.forEach((t) => held.add(normTerm(t)));
	}
	return problems;
}

/** A lesson a day: when the last one was finished today, the next is suggested for tomorrow at 4 am (it can start anyway). */
export function nextSuggestedAt(c: Course, now: number): string | null {
	const finished = lessonsOf(c).map((l) => l.doneAt).filter((x): x is string => !!x).sort();
	const last = finished[finished.length - 1];
	if (!last || studyDay(Date.parse(last)) !== studyDay(now)) return null;
	const t = new Date(now); if (t.getHours() >= 4) t.setDate(t.getDate() + 1); t.setHours(4, 0, 0, 0);
	return t.toISOString();
}
