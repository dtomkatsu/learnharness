/**
 * COURSES (2026-11, docs/course-roadmap-scope.md): a goal as units of sized
 * lessons — planned (strong model), approved, redrawn; each lesson its own
 * chat that starts knowing where it sits; done when its steps are confirmed;
 * one a day; skippable; a lesson from before courses turned into one.
 * Isolated LH_DATA_DIR and process.env.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-"));
const originalEnv = process.env;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json") };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");

const C = await import("../src/core/courses.ts");
const S = await import("../src/server/courses.ts");
const store = await import("../src/store/learner.ts");
const { chatStore } = await import("../src/store/chats.ts");
after(() => { process.env = originalEnv; fs.rmSync(directory, { recursive: true, force: true }); });

const deps = { chatStore, graphStore: { readNodes: () => [], readChains: () => [] } };
const engineOf = (...replies: unknown[]) => {
	const faux = createFauxCore({});
	faux.setResponses(replies.map((r) => fauxAssistantMessage([fauxText(typeof r === "string" ? r : JSON.stringify(r))])));
	const seen: string[] = [];
	return { engine: { model: faux.getModel(), streamFn: (m: any, c: any, o: any) => { seen.push(JSON.stringify(c.messages)); return faux.streamSimple(m, c, o); } } as never, seen };
};
const lesson = (title: string, extra: Record<string, unknown> = {}) => ({ title, objectives: ["do " + title], steps: ["a", "b", "c"], introduces: [] as string[], needs: [] as string[], minutes: 25, kind: "teach", ...extra });
const PLAN = { title: "How LLMs work", goal: "understand transformers", level: "knows algebra", units: [
	{ title: "Vectors", why: "the material", lessons: [lesson("Vectors", { introduces: ["vector"] }), lesson("Dot product", { introduces: ["dot product"], needs: ["vector"] })] },
	{ title: "Attention", why: "the core", lessons: [lesson("Checkpoint 1", { kind: "checkpoint", steps: ["vectors", "dot product"] }), lesson("Attention", { introduces: ["attention"], needs: ["dot product"] })] },
] };

describe("the course model", () => {
	it("finds a term needed before a lesson introduces it, or never introduced", () => {
		const units = [{ lessons: [lesson("A", { needs: ["softmax"] }), lesson("B", { introduces: ["softmax"] }), lesson("C", { needs: ["loss"] })] }] as never;
		assert.deepEqual(C.courseVocabularyProblems(units, []), ['"A" needs "softmax", which is only introduced later, in "B"', '"C" needs "loss", which no lesson introduces and he does not hold']);
		assert.deepEqual(C.courseVocabularyProblems(units, ["softmax", "loss"]), []);
	});
	it("lesson states: done when all steps are confirmed, held when held too; the first open one is next, the rest locked", () => {
		const c = { units: [{ lessons: [{ id: "a" }, { id: "b" }, { id: "c", skipped: { at: "x" } }, { id: "d" }, { id: "e" }] }] } as never;
		const prog: Record<string, { steps: number; confirmed: number; held: number } | null> = { a: { steps: 3, confirmed: 3, held: 3 }, b: { steps: 4, confirmed: 4, held: 1 }, d: null, e: null };
		const st = C.lessonStates(c, (l) => prog[l.id] ?? null);
		assert.deepEqual([...st], [["a", "held"], ["b", "done"], ["c", "skipped"], ["d", "next"], ["e", "locked"]]);
	});
	it("a lesson a day: finished today, the next is suggested for tomorrow at 4", () => {
		const now = Date.parse("2026-11-04T20:00:00");
		const c = { units: [{ lessons: [{ id: "a", doneAt: new Date(now - 3600000).toISOString() }] }] } as never;
		const at = new Date(C.nextSuggestedAt(c, now)!);
		assert.deepEqual([at.getDate(), at.getHours()], [5, 4]);
		assert.equal(C.nextSuggestedAt({ units: [{ lessons: [{ id: "a", doneAt: new Date(now - 30 * 3600000).toISOString() }] }] } as never, now), null);
	});
});

describe("planning, running and changing a course", () => {
	it("drafts from the goal with what he holds; a plan that uses a term too early is sent back once", async () => {
		const bad = { ...PLAN, units: [{ title: "U", why: "", lessons: [lesson("Dot product", { needs: ["vector"] }), lesson("Vectors", { introduces: ["vector"] })] }] };
		const { engine, seen } = engineOf(bad, PLAN);
		const c = await S.createCourse(deps, "understand transformers", engine);
		assert.equal(c.status, "draft");
		assert.deepEqual(C.lessonsOf(c).map((l) => [l.id, l.kind]), [["vectors", "teach"], ["dot-product", "teach"], ["checkpoint-1", "checkpoint"], ["attention", "teach"]]);
		assert.match(seen[1]!, /used terms before any lesson introduced them[\s\S]*Dot product\\" needs \\"vector\\"/);
		assert.ok(S.readCourse(c.id));
	});
	it("starting a lesson makes its chat, with the course context first; done when its plan is confirmed; then a lesson a day", async () => {
		const { engine } = engineOf(PLAN);
		const c = await S.createCourse(deps, "understand transformers", engine);
		const r = S.startLesson(deps, c, "dot-product");
		const chat = chatStore.getChat(r.chatId)!;
		assert.deepEqual(chat.course, { id: c.id, lessonId: "dot-product" });
		assert.equal(chat.title, "Lesson 2 · Dot product");
		const ctx = (chat.messages[0] as any).content as string;
		assert.match(ctx, /^\[Course context\] — this session is lesson 2 of 4 in the course "How LLMs work"/);
		assert.match(ctx, /seed your plan_init with these[\s\S]*It needs: vector/);
		assert.match(ctx, /Earlier lessons: 1\. Vectors[\s\S]*Coming next \(do NOT teach it now\): 3\. Checkpoint 1; 4\. Attention/);
		assert.equal(S.readCourse(c.id)!.status, "active", "starting a lesson approves the draft");
		assert.deepEqual(S.startLesson(deps, S.readCourse(c.id)!, "dot-product"), { chatId: r.chatId, created: false });
		let v = S.courseView(deps, S.readCourse(c.id)!);
		assert.deepEqual(v.units.flatMap((u) => u.lessons.map((l) => l.state)), ["next", "in-progress", "locked", "locked"]);
		chatStore.saveTree(r.chatId, { version: 1, nodes: [{ id: "x", title: "X" }], edges: [] } as never);
		store.appendEvidence([{ kind: "answer", chatId: r.chatId, messageId: "m", toolCallId: "q", tool: "quiz", question: "q", outcome: "correct", planNode: "x", items: [] }] as never);
		v = S.courseView(deps, S.readCourse(c.id)!);
		assert.equal(v.units[0]!.lessons[1]!.state, "done");
		assert.ok(S.readCourse(c.id)!.units[0]!.lessons[1]!.doneAt, "stamped done");
		assert.ok(v.nextSuggestedAt, "finished today: the next tomorrow");
		assert.equal(v.next!.title, "Vectors", "the first lesson not done is next");
	});
	it("a checkpoint's context asks for mixed retrieval; a skipped lesson is checked briefly in the next", async () => {
		const { engine } = engineOf(PLAN);
		const c = await S.createCourse(deps, "goal", engine);
		S.setSkipped(c, "vectors", true);
		const ctx2 = S.lessonContext(deps, S.readCourse(c.id)!, "dot-product");
		assert.match(ctx2, /He skipped "Vectors" as already known: in your opening check, ask one quick question on its objectives \(do Vectors\)/);
		assert.match(S.lessonContext(deps, S.readCourse(c.id)!, "checkpoint-1"), /CHECKPOINT: no new material[\s\S]*vectors; dot product/);
		assert.equal(S.courseView(deps, S.readCourse(c.id)!).next!.title, "Dot product");
	});
	it("a redraw keeps what is done, in progress or skipped, and plans the rest from his request", async () => {
		const { engine } = engineOf(PLAN);
		const c = await S.createCourse(deps, "goal", engine);
		S.startLesson(deps, c, "vectors");
		const cur = S.readCourse(c.id)!;
		const startedChat = C.lessonsOf(cur)[0]!.chatId;
		const { engine: e2, seen } = engineOf({ title: "How LLMs work", units: [{ title: "Only attention", why: "", lessons: [lesson("Attention, slowly")] }] });
		const re = await S.redrawCourse(deps, cur, "less maths, more attention", e2);
		assert.match(seen[0]!, /HIS REQUEST: less maths, more attention/);
		assert.match(seen[0]!, /\\"id\\":\\"vectors\\"[^}]*\\"FIXED\\":true/);
		assert.deepEqual(C.lessonsOf(re).map((l) => l.title), ["Vectors", "Attention, slowly"], "the started lesson was put back first");
		assert.equal(C.lessonsOf(re)[0]!.chatId, startedChat);
		assert.equal(re.history.at(-1)!.why, "less maths, more attention");
	});
	it("a lesson from before courses: its taught steps become the first lessons, continued in that chat", async () => {
		const old = chatStore.createChat("LLMs");
		chatStore.saveMessages(old.id, [{ id: "u", role: "user", content: [{ type: "text", text: "teach me how LLMs work" }], timestamp: 1 }] as never);
		chatStore.saveTree(old.id, { version: 1, nodes: [{ id: "v", title: "Vectors" }, { id: "d", title: "Dot" }, { id: "s", title: "Softmax" }], edges: [] } as never);
		store.appendEvidence([{ kind: "answer", chatId: old.id, messageId: "m", toolCallId: "q1", tool: "quiz", question: "q", outcome: "correct", planNode: "v", items: [] }, { kind: "answer", chatId: old.id, messageId: "m", toolCallId: "q2", tool: "quiz", question: "q", outcome: "correct", planNode: "d", items: [] }] as never);
		const { engine, seen } = engineOf({ title: "How LLMs work", goal: "transformers", units: [{ title: "Basics", why: "", lessons: [{ ...lesson("Vectors and dots"), fromNodes: ["v", "d"] }, { ...lesson("Softmax"), fromNodes: ["s"] }, lesson("Attention")] }] });
		const c = await S.courseFromChat(deps, old.id, engine);
		assert.match(seen[0]!, /THIS COURSE CONTINUES AN EXISTING LESSON[\s\S]*\\"title\\":\\"Vectors\\",\\"state\\":\\"confirmed\\"/);
		const ls = C.lessonsOf(c);
		assert.deepEqual(ls.map((l) => l.adopted?.nodes ?? null), [["v", "d"], ["s"], null]);
		const v = S.courseView(deps, c);
		assert.deepEqual(v.units[0]!.lessons.map((l) => l.state), ["done", "in-progress", "locked"]);
		assert.equal(v.next!.chatId, old.id, "the unfinished adopted lesson goes on in its chat");
		assert.deepEqual(S.startLesson(deps, c, ls[1]!.id), { chatId: old.id, created: false });
	});
});
