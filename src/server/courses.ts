/**
 * Courses, the service (2026-11, docs/course-roadmap-scope.md): the roadmap
 * planner (the strong model, from the goal and what the learner model says he
 * holds), approve and redraw, starting a lesson as a chat that begins knowing
 * where it sits in the course, skipping a lesson he already knows, lesson
 * status from the lessons' own progress, and turning a lesson from before
 * courses into one. Records in data/courses/<id>.json.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import type { PiEngine } from "../agent/models.ts";
import type { ChatRecord } from "../core/contracts.ts";
import { newLessonNotesMessage } from "../core/native-messages.ts";
import { courseVocabularyProblems, lessonStates, lessonsOf, nextSuggestedAt, slug, type Course, type CourseLesson, type CourseUnit } from "../core/courses.ts";
import { deckProfile, effectiveRetrievability, lessonProgress, profileText, type LearnerState } from "../core/learner/model.ts";
import { learnerState, type LearnerDeps } from "./learner.ts";
import { notesMarkdown, notesView } from "./notes.ts";

// ─── the store ──────────────────────────────────────────────────────────────

const DIR = path.join(PATHS.data, "courses");
const file = (id: string) => path.join(DIR, id.replace(/[^\w-]/g, "_") + ".json");
export function readCourse(id: string): Course | null { try { return JSON.parse(fs.readFileSync(file(id), "utf-8")) as Course; } catch { return null; } }
export function writeCourse(c: Course): void {
	fs.mkdirSync(DIR, { recursive: true });
	c.updatedAt = new Date().toISOString();
	const f = file(c.id), tmp = f + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(c, null, "\t"), "utf-8");
	fs.renameSync(tmp, f);
}
export function listCourses(): Course[] {
	let names: string[] = [];
	try { names = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
	return names.map((f) => readCourse(f.slice(0, -5))).filter((c): c is Course => !!c).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// ─── the planner ────────────────────────────────────────────────────────────

const COURSE_PROMPT = `You plan a COURSE: a learner's goal broken into an ordered sequence of sized lessons he will take one a day on a tablet, with a tutor who teaches each lesson step by step and checks every step.

Shape:
- 3–6 units, each a coherent idea; 2–5 lessons per unit; usually 8–20 lessons in all — as many as the goal genuinely needs, no padding.
- A lesson is 20–30 minutes: 3–6 steps, each one reasoning step from what he already holds. One new idea at a time; nothing he already holds is re-taught; nothing off the path to the goal.
- Order by what rests on what: a lesson may only NEED terms he already knows or that an EARLIER lesson introduces.
- Every 3–4 teaching lessons, a short "checkpoint" lesson: no new material — mixed retrieval over the lessons so far (its steps name what it revisits; introduces nothing).
- Objectives: 2–4 per lesson, each something he can be checked on ("compute…", "explain why…", "say … in Indonesian"), not "understand X".

You get the goal, what the app's record says he already holds (may be empty), and — when redrawing — the current course with each lesson's state and the learner's request. Lessons marked FIXED (done, in progress, skipped) must be kept exactly as given, with their ids, in their order, at the start; plan only the rest.

Reply with JSON only:
{"title":"…","goal":"…","level":"one line: where he starts","units":[{"title":"…","why":"one line","lessons":[{"id":"…"?,"title":"…","objectives":["…"],"steps":["…"],"introduces":["term"],"needs":["term"],"minutes":25,"kind":"teach"|"checkpoint"}]}]}`;

function jsonOf(text: string): any { const m = /\{[\s\S]*\}/.exec(text); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }
const strs = (x: unknown, max = 12) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()).slice(0, max) : []);

/** The planner's reply as units (ids given to lessons that have none; fixed lessons put back as they were). */
function unitsFrom(j: any, fixed: CourseLesson[]): CourseUnit[] {
	const taken = new Set<string>(fixed.map((l) => l.id)), seen = new Set<string>(), unitIds = new Set<string>();
	const units: CourseUnit[] = (Array.isArray(j?.units) ? j.units : []).map((u: any) => ({
		id: "u-" + slug(String(u?.title ?? "unit"), unitIds), title: String(u?.title ?? "").trim() || "Unit", why: String(u?.why ?? "").trim(),
		lessons: (Array.isArray(u?.lessons) ? u.lessons : []).map((l: any): CourseLesson | null => {
			const keep = typeof l?.id === "string" ? fixed.find((f) => f.id === l.id) : undefined;
			if (keep) { seen.add(keep.id); return keep; }
			const title = String(l?.title ?? "").trim(); if (!title) return null;
			return { id: slug(title, taken), title, objectives: strs(l.objectives, 4), steps: strs(l.steps, 8), introduces: strs(l.introduces, 12), needs: strs(l.needs, 12), minutes: Math.max(10, Math.min(45, Number(l.minutes) || 25)), kind: l.kind === "checkpoint" ? "checkpoint" : "teach" };
		}).filter(Boolean),
	})).filter((u: CourseUnit) => u.lessons.length);
	const lost = fixed.filter((f) => !seen.has(f.id));
	if (lost.length) {
		if (units[0]) units[0].lessons.unshift(...lost); else units.push({ id: slug("done", taken), title: "So far", why: "", lessons: lost });
	}
	return units;
}

/** What the learner model says he holds, for planning (and the converted chat's plan, when there is one). */
function holdsText(state: LearnerState, goal: string): string {
	return [profileText(state, goal), deckProfile(state, goal)].filter(Boolean).join("\n\n") || "(nothing recorded yet)";
}

async function plan(state: LearnerState, engine: PiEngine, input: string, fixed: CourseLesson[]): Promise<{ title: string; goal: string; level: string; units: CourseUnit[] }> {
	let prompt = input, last: any = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		const { text } = await runSubagent([], { role: "researcher", engine, systemPrompt: COURSE_PROMPT, prompt, maxTurns: 1 });
		const j = jsonOf(text);
		const units = unitsFrom(j, fixed);
		if (!units.length) { prompt = input + "\n\nYour last reply could not be read as the JSON asked for. Reply with the JSON only."; continue; }
		last = { title: String(j.title ?? "").trim(), goal: String(j.goal ?? "").trim(), level: String(j.level ?? "").trim(), units };
		const problems = courseVocabularyProblems(units, []).slice(0, 12);
		if (!problems.length || attempt === 1) break;
		prompt = input + "\n\nYour last plan used terms before any lesson introduced them. Fix the order (or add the introduction to an earlier lesson):\n- " + problems.join("\n- ");
	}
	if (!last) throw new Error("the planner's reply could not be read");
	return last;
}

const newId = () => "course_" + Date.now().toString(36) + "_" + crypto.randomUUID().slice(0, 6);

/** A new course from a goal: drafted, waiting for his approval. */
export async function createCourse(deps: LearnerDeps, goal: string, engine: PiEngine): Promise<Course> {
	const state = learnerState(deps);
	const p = await plan(state, engine, `GOAL: ${goal}\n\nWHAT HE ALREADY HOLDS (the app's record):\n${holdsText(state, goal)}`, []);
	const now = new Date().toISOString();
	const c: Course = { id: newId(), title: p.title || goal.slice(0, 60), goal: p.goal || goal, level: p.level, status: "draft", units: p.units, createdAt: now, updatedAt: now, history: [{ at: now, why: "drafted from the goal" }] };
	writeCourse(c);
	return c;
}

/** Redraw from his request: what is done, in progress or skipped stays; the rest is planned again. */
export async function redrawCourse(deps: LearnerDeps, c: Course, request: string, engine: PiEngine): Promise<Course> {
	const state = learnerState(deps);
	const states = lessonStates(c, (l) => lessonProgressOf(deps, state, l));
	const fixed = lessonsOf(c).filter((l) => ["done", "held", "in-progress", "skipped"].includes(states.get(l.id)!)).map(({ unit: _u, n: _n, ...l }) => l as CourseLesson);
	const current = c.units.map((u) => ({ title: u.title, lessons: u.lessons.map((l) => ({ id: l.id, title: l.title, objectives: l.objectives, steps: l.steps, introduces: l.introduces, needs: l.needs, kind: l.kind, state: states.get(l.id), ...(fixed.some((f) => f.id === l.id) ? { FIXED: true } : {}) })) }));
	const p = await plan(state, engine, `GOAL: ${c.goal}\n\nWHAT HE ALREADY HOLDS (the app's record):\n${holdsText(state, c.goal)}\n\nTHE CURRENT COURSE:\n${JSON.stringify(current)}\n\nHIS REQUEST: ${request}`, fixed);
	c.units = p.units; if (p.title) c.title = p.title;
	c.history.push({ at: new Date().toISOString(), why: request.slice(0, 300) });
	writeCourse(c);
	return c;
}

/** A lesson from before courses, turned into one: its taught steps become the first lessons, the rest is planned to the goal. */
export async function courseFromChat(deps: LearnerDeps, chatId: string, engine: PiEngine): Promise<Course> {
	const r = deps.chatStore.getChat(chatId);
	if (!r?.tree?.nodes.length) throw new Error("that lesson has no plan to build a course from");
	const state = learnerState(deps);
	const prog = lessonProgress(state, chatId, r.tree);
	const first = ((r.messages as { role?: string; content?: unknown }[]).find((m) => m.role === "user")?.content ?? "") as unknown;
	const goal = (typeof first === "string" ? first : Array.isArray(first) ? first.map((b: any) => b?.text ?? "").join(" ") : "").trim().slice(0, 600) || r.title;
	const steps = prog.nodes.map((n) => ({ nodeId: n.id, title: n.title, state: n.held ? "held a day later" : n.status === "checked" || n.status === "repaired" ? "confirmed" : n.status === "missed" ? "missed" : "not checked" }));
	const ADOPT = `\n\nTHIS COURSE CONTINUES AN EXISTING LESSON. Its plan steps, in the order taught, with their state:\n${JSON.stringify(steps)}\n\nGroup ALL of these steps, in order, into the first lessons (3–6 steps each, in units); give each such lesson "fromNodes": [the nodeIds it covers]. Steps not confirmed still belong to their lesson (it is in progress). Then plan the remaining lessons from where the lesson stands to the goal (no fromNodes), with checkpoints.`;
	const { text } = await runSubagent([], { role: "researcher", engine, systemPrompt: COURSE_PROMPT + ADOPT, prompt: `GOAL: ${goal}\n\nWHAT HE ALREADY HOLDS (the app's record):\n${holdsText(state, goal)}`, maxTurns: 1 });
	const j = jsonOf(text);
	const units = unitsFrom(j, []);
	if (!units.length) throw new Error("the planner's reply could not be read");
	// attach the taught nodes (each node to one lesson; any left over to the lesson before the first new one)
	const all = new Set(prog.nodes.map((n) => n.id)), used = new Set<string>();
	const raw = (Array.isArray(j.units) ? j.units : []).flatMap((u: any) => (Array.isArray(u?.lessons) ? u.lessons : []));
	const ls = units.flatMap((u) => u.lessons);
	ls.forEach((l, i) => {
		const nodes = strs(raw[i]?.fromNodes, 12).filter((n) => all.has(n) && !used.has(n));
		if (nodes.length) { nodes.forEach((n) => used.add(n)); l.adopted = { chatId, nodes }; }
	});
	const rest = [...all].filter((n) => !used.has(n));
	const lastAdopted = [...ls].reverse().find((l) => l.adopted);
	if (rest.length && lastAdopted) lastAdopted.adopted!.nodes.push(...rest);
	const now = new Date().toISOString();
	const c: Course = { id: newId(), title: String(j.title ?? "").trim() || r.title, goal: String(j.goal ?? "").trim() || goal, level: String(j.level ?? "").trim(), status: "draft", units, createdAt: now, updatedAt: now, history: [{ at: now, why: `built from the lesson "${r.title}"` }] };
	writeCourse(c);
	return c;
}

// ─── progress ───────────────────────────────────────────────────────────────

/** A lesson's steps confirmed and held, from its own chat's plan — or the adopted nodes of the chat it came from. */
export function lessonProgressOf(deps: LearnerDeps, state: LearnerState, l: CourseLesson): { steps: number; confirmed: number; held: number } | null {
	const chatId = l.chatId ?? l.adopted?.chatId;
	if (!chatId) return null;
	const r = deps.chatStore.getChat(chatId);
	if (!r?.tree) return { steps: 0, confirmed: 0, held: 0 };
	const nodes = lessonProgress(state, chatId, r.tree).nodes.filter((n) => !l.adopted || l.chatId || l.adopted.nodes.includes(n.id));
	return { steps: nodes.length, confirmed: nodes.filter((n) => n.status === "checked" || n.status === "repaired").length, held: nodes.filter((n) => n.held).length };
}

/** The course as the screens show it; a lesson whose steps are all confirmed is stamped done (once). */
export function courseView(deps: LearnerDeps, c: Course, now = Date.now()) {
	const state = learnerState(deps, now);
	const prog = new Map(lessonsOf(c).map((l) => [l.id, lessonProgressOf(deps, state, l)]));
	const states = lessonStates(c, (l) => prog.get(l.id) ?? null);
	let changed = false;
	for (const u of c.units) for (const l of u.lessons) if ((states.get(l.id) === "done" || states.get(l.id) === "held") && !l.doneAt) { l.doneAt = new Date(now).toISOString(); changed = true; }
	if (changed) writeCourse(c);
	const all = lessonsOf(c);
	const next = all.find((l) => states.get(l.id) === "in-progress") ?? all.find((l) => states.get(l.id) === "next") ?? null;
	return {
		id: c.id, title: c.title, goal: c.goal, level: c.level, status: c.status, updatedAt: c.updatedAt, history: c.history,
		done: all.filter((l) => ["done", "held", "skipped"].includes(states.get(l.id)!)).length, total: all.length,
		next: next ? { id: next.id, n: next.n, title: next.title, minutes: next.minutes, state: states.get(next.id), chatId: next.chatId ?? next.adopted?.chatId ?? null } : null,
		nextSuggestedAt: nextSuggestedAt(c, now),
		units: c.units.map((u) => ({ id: u.id, title: u.title, why: u.why, lessons: u.lessons.map((l) => ({ ...l, n: all.find((x) => x.id === l.id)!.n, state: states.get(l.id), progress: prog.get(l.id) ?? null })) })),
	};
}

// ─── running a lesson ───────────────────────────────────────────────────────

/** What a lesson's chat starts with (model-only): where it sits, what it is for, what came before and comes next. */
export function lessonContext(deps: LearnerDeps, c: Course, lessonId: string, state: LearnerState = learnerState(deps)): string {
	const all = lessonsOf(c), i = all.findIndex((l) => l.id === lessonId), l = all[i]!;
	const before = all.slice(0, i), after = all.slice(i + 1, i + 3);
	const courseChats = new Set(all.flatMap((x) => [x.chatId, x.adopted?.chatId].filter((y): y is string => !!y)));
	const items = [...state.items.values()].filter((it) => !it.retired && it.lessons.some((ch) => courseChats.has(ch)));
	const weak = items.filter((it) => it.status === "fragile" || it.status === "misconceived" || it.status === "leech" || (it.schedule.state !== 0 && (effectiveRetrievability(it) ?? 1) < 0.7)).slice(0, 10);
	const solid = items.filter((it) => it.status === "solid").slice(0, 20).map((it) => it.label);
	const skipped = before.filter((x) => x.skipped);
	const lines = [
		`[Course context] — this session is lesson ${l.n} of ${all.length} in the course "${c.title}" (goal: ${c.goal}). The learner sees none of this note.`,
		`This lesson: "${l.title}" (unit "${l.unit.title}"), about ${l.minutes} minutes.`,
		"Its objectives — by the end he can: " + l.objectives.map((o) => `(${l.objectives.indexOf(o) + 1}) ${o}`).join(" "),
		l.kind === "checkpoint"
			? `This is a CHECKPOINT: no new material. Ask 6–10 mixed retrieval questions over these earlier lessons — ${l.steps.join("; ")} — interleaved, at least a third in his own words and some that use an idea on a fresh case. For each miss, name the gap and repair it briefly. End with what is held and what needs more work.`
			: `Its steps (seed your plan_init with these, refined as you see fit, slugs your own): ${l.steps.join(" → ")}.` + (l.introduces.length ? ` It introduces: ${l.introduces.join(", ")}.` : "") + (l.needs.length ? ` It needs: ${l.needs.join(", ")}.` : ""),
		before.length ? `Earlier lessons: ${before.map((x) => `${x.n}. ${x.title}${x.skipped ? " (skipped — he said he knows it)" : ""}`).join("; ")}. Build on them; do not re-teach them.` : "This is the first lesson of the course.",
		skipped.length ? `He skipped ${skipped.map((x) => `"${x.title}"`).join(", ")} as already known: in your opening check, ask one quick question on ${skipped.length > 1 ? "their" : "its"} objectives (${skipped.flatMap((x) => x.objectives).slice(0, 4).join("; ")}); if he misses, teach that first.` : "",
		solid.length ? `Held from earlier lessons: ${solid.join(", ")}.` : "",
		weak.length ? `Weak from earlier lessons (repair before building on them, if this lesson rests on them): ${weak.map((it) => it.label).join(", ")}.` : "",
		after.length ? `Coming next (do NOT teach it now): ${after.map((x) => `${x.n}. ${x.title}`).join("; ")}.` : "This is the last lesson of the course.",
		"Keep the opening check to a question or two on what this lesson rests on. When every objective is confirmed, close the lesson: a three-line recap of what he can now do, and tell him the lesson is done and what the next one is. Do not start the next lesson's material in this session.",
	];
	return lines.filter(Boolean).join("\n");
}

/** Start (or continue) a lesson: its chat, created with the course context as its first message. */
export function startLesson(deps: LearnerDeps, c: Course, lessonId: string): { chatId: string; created: boolean } {
	const all = lessonsOf(c), l = all.find((x) => x.id === lessonId);
	if (!l) throw new Error("no such lesson");
	if (l.chatId) return { chatId: l.chatId, created: false };
	if (l.adopted) return { chatId: l.adopted.chatId, created: false };   // taught before the course: it goes on in that chat
	if (c.status === "draft") { c.status = "active"; c.history.push({ at: new Date().toISOString(), why: "approved (started a lesson)" }); }
	const chat = deps.chatStore.createChat(`Lesson ${l.n} · ${l.title}`, undefined, undefined, { course: { id: c.id, lessonId: l.id } });
	deps.chatStore.saveMessages(chat.id, [newLessonNotesMessage(lessonContext(deps, c, l.id), { courseContext: c.id }) as never]);
	for (const u of c.units) for (const x of u.lessons) if (x.id === l.id) x.chatId = chat.id;
	writeCourse(c);
	return { chatId: chat.id, created: true };
}

export function setSkipped(c: Course, lessonId: string, on: boolean): void {
	for (const u of c.units) for (const l of u.lessons) if (l.id === lessonId) { if (on) l.skipped = { at: new Date().toISOString() }; else delete l.skipped; }
	c.history.push({ at: new Date().toISOString(), why: (on ? "skipped " : "un-skipped ") + lessonId });
	writeCourse(c);
}

/** The course's notes as one Markdown document, lesson by lesson. */
export function courseNotesMarkdown(deps: LearnerDeps, c: Course): string {
	const out = [`# ${c.title}`, "", c.goal, ""];
	for (const l of lessonsOf(c)) {
		const chatId = l.chatId ?? l.adopted?.chatId; if (!chatId) continue;
		const v = notesView(deps, chatId); if (!v) continue;
		const steps = v.steps.filter((s) => s.note && (l.chatId || !l.adopted || l.adopted.nodes.includes(s.nodeId)));
		if (!steps.length) continue;
		out.push(notesMarkdown({ ...v, title: `Lesson ${l.n} · ${l.title}`, steps }).replace(/^# /, "## ").replace(/\n## /g, "\n### "), "");
	}
	return out.join("\n");
}

export type { Course };
export const courseOfChat = (r: ChatRecord) => (r.course ? readCourse(r.course.id) : null);
