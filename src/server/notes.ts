/**
 * Lesson notes (2026-11): a short page per lesson, written step by step from
 * what was actually taught — the key idea, the worked example, the terms, and
 * the learner's own mistakes with their corrections. Written by the cheap
 * model once a step is finished (the lesson moved past it, or it was
 * confirmed), rewritten when a new mistake on it is recorded; kept in
 * data/learner/notes/<chatId>.json.
 *
 * Notes are a reference and the place to go straight after a miss in review
 * (restudy after a failed retrieval helps); rereading them is not a substitute
 * for retrieval, so they never replace the review queue.
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import type { PiEngine } from "../agent/models.ts";
import type { ChatRecord } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { normTerm } from "../core/vocabulary.ts";
import { lessonProgress, termItem, type LearnerState } from "../core/learner/model.ts";
import { learnerState, type LearnerDeps } from "./learner.ts";

export interface StepNote {
	nodeId: string;
	title: string;
	/** The key idea, as taught (markdown). */
	idea: string;
	/** The lesson's worked example, reduced to its lines (markdown), when it had one. */
	example?: string;
	terms: { term: string; gloss: string }[];
	mistakes: { question: string; yours: string; correction: string }[];
	/** The last message of the step's teaching when written, and how many mistakes it covered. */
	through: string;
	misses: number;
	at: string;
}
export interface LessonNotes { chatId: string; steps: Record<string, StepNote>; updatedAt: string }

const DIR = path.join(PATHS.data, "learner", "notes");
const file = (chatId: string) => path.join(DIR, chatId.replace(/[^\w-]/g, "_") + ".json");
export function readNotes(chatId: string): LessonNotes {
	try { return JSON.parse(fs.readFileSync(file(chatId), "utf-8")) as LessonNotes; } catch { return { chatId, steps: {}, updatedAt: "" }; }
}
function writeNotes(n: LessonNotes): void {
	fs.mkdirSync(DIR, { recursive: true });
	const f = file(n.chatId), tmp = f + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(n, null, "\t"), "utf-8");
	fs.renameSync(tmp, f);
}

type Block = { type: string; id?: string; name?: string; text?: string; arguments?: Record<string, unknown> };
export interface StepSegment { nodeId: string; teaching: string[]; through: string; calls: string[] }

/**
 * The lesson cut into its steps: the teaching before a question tagged with a plan node belongs to that node (the
 * teaching precedes its check), and so does the message that asks it — when the node is the step being taught, or a
 * new one. A question tagged with an EARLIER step in the middle of another (a re-check) does not take the teaching
 * around it: that stays with the step being taught (seen on the LLM lesson: matrices filed under "dot product").
 * Teaching after the last tagged question is not assigned yet — that step is still being taught.
 */
export function stepSegments(record: ChatRecord): Map<string, StepSegment> {
	const out = new Map<string, StepSegment>();
	let pending: string[] = [];
	let current = null as string | null;
	for (const m of record.messages as LhMessage[]) {
		const x = m as unknown as { role?: string; id: string; content?: Block[] };
		if (x.role !== "assistant" || !Array.isArray(x.content)) continue;
		const text = x.content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("\n").trim();
		const tagged = x.content.filter((b) => b.type === "toolCall" && typeof b.arguments?.nodeId === "string");
		if (text) pending.push(text);
		if (!tagged.length) continue;
		const tag = tagged[tagged.length - 1]!.arguments!.nodeId as string;
		// a re-check of an earlier step keeps the teaching with the step being taught
		const node: string = tag === current || !out.has(tag) || !current ? tag : current;
		current = node;
		const seg = out.get(node) ?? { nodeId: node, teaching: [], through: x.id, calls: [] };
		seg.teaching.push(...pending); seg.through = x.id; seg.calls.push(...tagged.map((b) => b.id!).filter(Boolean));
		out.set(node, seg); pending = [];
	}
	return out;
}

const MIN_TEACHING = 400;

/** A step is finished when it was confirmed, or the lesson has moved on to another step since. */
function finishedSteps(record: ChatRecord, state: LearnerState, segs: Map<string, StepSegment>): string[] {
	if (!record.tree) return [];
	const prog = lessonProgress(state, record.id, record.tree);
	const order = [...segs.keys()];
	const last = order[order.length - 1];
	// a step with almost no teaching of its own (known already, or only checked in passing) gets no note
	return prog.nodes.filter((n) => segs.has(n.id) && segs.get(n.id)!.teaching.join(" ").length >= MIN_TEACHING && (n.status === "checked" || n.status === "repaired" || n.id !== last)).map((n) => n.id);
}

/** The learner's misses on a step: the question, his answer as he gave it, and what was right. */
function missesOf(record: ChatRecord, state: LearnerState, nodeId: string) {
	const msgs = record.messages as LhMessage[];
	const calls = new Map<string, Record<string, unknown>>();
	for (const m of msgs) { const x = m as unknown as { role?: string; content?: Block[] }; if (x.role === "assistant" && Array.isArray(x.content)) for (const b of x.content) if (b.type === "toolCall" && b.id) calls.set(b.id, b.arguments ?? {}); }
	return (state.answersByChat.get(record.id) ?? []).filter((a) => a.planNode === nodeId && (a.outcome === "miss" || a.outcome === "dontknow") && a.questionType !== "predict").map((a) => {
		const r = msgs.find((m) => (m as { toolCallId?: string }).toolCallId === a.toolCallId) as { details?: { text?: string; answers?: { label: string }[]; dontKnow?: boolean } } | undefined;
		const d = r?.details ?? {};
		const yours = d.dontKnow ? "I don't know" : d.text || (d.answers ?? []).map((x) => x.label).join("; ") || "";
		const args = calls.get(a.toolCallId) ?? {};
		const opts = Array.isArray(args.options) ? (args.options as unknown[]).map((o) => (typeof o === "string" ? o : String((o as { label?: unknown })?.label ?? ""))) : [];
		const ca = args.correctAnswer;
		const right = typeof ca === "string" ? ca : Array.isArray(ca) ? ca.map((v) => (typeof v === "number" ? opts[v - 1] ?? String(v) : String(v))).join("; ") : typeof ca === "number" ? opts[ca - 1] ?? String(ca) : "";
		return { question: a.question, yours, right, explanation: typeof args.explanation === "string" ? args.explanation : "", thinking: a.thinking ?? "" };
	});
}

const NOTES_PROMPT = `You write a learner's study notes for steps of a lesson he has been taught — the page he will come back to after forgetting something.

For each step you get its title, the tutor's teaching for it, the terms it introduced, and the learner's mistakes on it (the question, his answer, the right answer, the explanation, his reasoning).

Per step write:
- "idea": the key idea in 2–4 plain sentences, as the lesson taught it — its own names, numbers and examples; nothing the lesson did not teach.
- "example": the lesson's worked example cut to its essential lines (markdown; keep the numbers and the steps), or omit it when the step had none.
- "mistakes": for each mistake (by its index "i"), "correction": one or two sentences to him ("you") — what was wrong in his answer and why the right one holds. Name the confusion, not just the answer.

If the teaching given does not actually cover the step, give that step an empty idea ("") — never write about missing teaching.

Use $…$ for maths. Reply with JSON only: {"steps":[{"nodeId":"…","idea":"…","example":"…"?,"mistakes":[{"i":0,"correction":"…"}]}]}`;

function jsonOf(text: string): any { const m = /\{[\s\S]*\}/.exec(text); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }

let writing = new Set<string>();

/**
 * Writes the notes of finished steps that have none, or whose teaching or mistakes changed since; at most `max`
 * steps, four to a model call. Returns how many were written.
 */
export async function writeLessonNotes(deps: LearnerDeps, chatId: string, engine: PiEngine, max = 6): Promise<{ written: number; pending: number }> {
	if (writing.has(chatId)) return { written: 0, pending: -1 };
	writing.add(chatId);
	try {
		const record = deps.chatStore.getChat(chatId);
		if (!record?.tree || record.kind === "practice") return { written: 0, pending: 0 };
		const state = learnerState(deps);
		const segs = stepSegments(record);
		const notes = readNotes(chatId);
		const title = (id: string) => record.tree!.nodes.find((n) => n.id === id)?.title ?? id;
		const held = new Map((record.vocabulary?.terms ?? []).filter((t) => t.gloss).map((t) => [normTerm(t.term), t]));
		const want = finishedSteps(record, state, segs).filter((id) => {
			const n = notes.steps[id], seg = segs.get(id)!;
			return !n || n.through !== seg.through || n.misses !== missesOf(record, state, id).length;
		});
		const todo = want.slice(0, max);
		let written = 0;
		for (let i = 0; i < todo.length; i += 4) {
			const batch = todo.slice(i, i + 4).map((id) => {
				const seg = segs.get(id)!, misses = missesOf(record, state, id);
				const planned = record.vocabulary?.planned?.[id]?.introduces ?? [];
				const terms = planned.map((t) => held.get(normTerm(t)) ?? null).filter(Boolean).map((t) => ({ term: t!.term, gloss: t!.gloss }));
				for (const t of planned) if (!terms.some((x) => normTerm(x.term) === normTerm(t))) { const it = state.items.get(termItem(t)); if (it?.meaning) terms.push({ term: it.label, gloss: it.meaning }); }
				const teaching = seg.teaching.join("\n\n---\n\n");
				return { id, seg, misses, terms, input: { nodeId: id, title: title(id), teaching: teaching.length > 6000 ? teaching.slice(0, 2000) + "\n[…]\n" + teaching.slice(-4000) : teaching, terms, mistakes: misses.map((m, k) => ({ i: k, question: m.question, his: m.yours, right: m.right, explanation: m.explanation, reasoning: m.thinking })) } };
			});
			const { text } = await runSubagent([], { role: "auditor", engine, systemPrompt: NOTES_PROMPT, prompt: "STEPS:\n" + batch.map((b) => JSON.stringify(b.input)).join("\n"), maxTurns: 1, chatId });
			const j = jsonOf(text);
			const now = new Date().toISOString();
			for (const s of Array.isArray(j?.steps) ? j.steps : []) {
				const b = batch.find((x) => x.id === s?.nodeId);
				if (!b || typeof s.idea !== "string" || !s.idea.trim()) continue;
				const corr = new Map((Array.isArray(s.mistakes) ? s.mistakes : []).map((m: any) => [Number(m?.i), String(m?.correction ?? "").trim()]));
				notes.steps[b.id] = {
					nodeId: b.id, title: title(b.id), idea: s.idea.trim(), ...(typeof s.example === "string" && s.example.trim() ? { example: s.example.trim() } : {}),
					terms: b.terms.slice(0, 12),
					mistakes: b.misses.map((m, k) => ({ question: m.question, yours: m.yours, correction: (corr.get(k) as string) || [m.right && `The right answer: ${m.right}.`, m.explanation].filter(Boolean).join(" ") })),
					through: b.seg.through, misses: b.misses.length, at: now,
				};
				written++;
			}
			notes.updatedAt = now;
			writeNotes(notes);
		}
		return { written, pending: Math.max(0, want.length - written) };
	} finally { writing.delete(chatId); }
}

/** After a teaching turn: the notes of a step just finished, in the background. */
export function notesSoon(deps: LearnerDeps, chatId: string, engine: PiEngine | undefined): void {
	if (process.env.NODE_ENV === "test" || !engine) return;
	void writeLessonNotes(deps, chatId, engine, 4).catch((err) => console.error(`[chat ${chatId}] lesson notes failed:`, err));
}

/** The notes as the tablet shows them: every step in plan order with its status, the note when there is one. */
export function notesView(deps: LearnerDeps, chatId: string) {
	const record = deps.chatStore.getChat(chatId);
	if (!record) return null;
	const state = learnerState(deps);
	const notes = readNotes(chatId);
	const prog = record.tree ? lessonProgress(state, chatId, record.tree) : null;
	const segs = stepSegments(record);
	const finished = new Set(finishedSteps(record, state, segs));
	return {
		chatId, title: record.title, updatedAt: notes.updatedAt,
		steps: (prog?.nodes ?? []).map((n) => ({ nodeId: n.id, title: n.title, status: n.status, held: n.held, taught: segs.has(n.id), finished: finished.has(n.id), note: notes.steps[n.id] ?? null })),
	};
}

/** The notes as Markdown (one file per lesson). */
export function notesMarkdown(view: NonNullable<ReturnType<typeof notesView>>): string {
	const mark = { checked: "✓", repaired: "↺", missed: "✗", open: "·" } as const;
	const out = [`# ${view.title}`, "", "Notes by step — ✓ confirmed, ✓✓ held a day later, ↺ after a miss, ✗ missed.", ""];
	for (const s of view.steps) {
		if (!s.note) continue;
		out.push(`## ${mark[s.status as keyof typeof mark] ?? ""}${s.held ? "✓" : ""} ${s.title}`, "", s.note.idea, "");
		if (s.note.example) out.push("**Example**", "", s.note.example, "");
		if (s.note.terms.length) out.push("**Terms:** " + s.note.terms.map((t) => `*${t.term}* — ${t.gloss}`).join("; "), "");
		if (s.note.mistakes.length) out.push("**Your mistakes**", "", ...s.note.mistakes.map((m) => `- ${m.question} — you said “${m.yours}”. ${m.correction}`), "");
	}
	return out.join("\n");
}
