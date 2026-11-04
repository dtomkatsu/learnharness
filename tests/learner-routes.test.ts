/**
 * THE LEARNER ROUTES (2026-11): /api/learner (summary), /items, /item,
 * /review (queue + grading), /review/overrule, /progress/[id], /glossary; a
 * side question becomes evidence; a lesson's first learner turn carries the
 * [Learner profile] to the model. No model slot is configured for the cheap
 * tier here, so cards are the fallback ones and model grading says so (503).
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type, createProvider, createFauxCore, fauxAssistantMessage, fauxText, type StreamFunction } from "@earendil-works/pi-ai";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-routes-"));
const originalEnv = process.env;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), ANTHROPIC_API_KEY: "fixture" };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");

const store = await import("../src/store/learner.ts");
const { chatStore } = await import("../src/store/chats.ts");
const summary = await import("../app/api/learner/route.ts");
const items = await import("../app/api/learner/items/route.ts");
const item = await import("../app/api/learner/item/route.ts");
const review = await import("../app/api/learner/review/route.ts");
const overrule = await import("../app/api/learner/review/overrule/route.ts");
const progress = await import("../app/api/learner/progress/[id]/route.ts");
const gloss = await import("../app/api/learner/glossary/route.ts");
const chats = await import("../app/api/chats/route.ts");
const { piModels } = await import("../src/agent/models.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");

after(() => { process.env = originalEnv; fs.rmSync(directory, { recursive: true, force: true }); });

const get = (url: string) => new Request("http://x" + url);
const post = (url: string, body: unknown) => new Request("http://x" + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("the learner routes", () => {
	const lesson = chatStore.createChat("Gradient descent");
	store.appendEvidence([
		{ kind: "taught", itemId: "term:gradient", term: "gradient", gloss: "the direction of steepest ascent", chatId: lesson.id } as never,
		{ kind: "taught", itemId: "term:slope", term: "slope", gloss: "rise over run", chatId: lesson.id } as never,
	]);

	it("the queue serves new taught terms with a card, even with no model to write one", async () => {
		const r = await (await review.GET(get("/api/learner/review?limit=5"))).json();
		assert.deepEqual(r.queue.map((q: any) => [q.itemId, q.reason, q.mode]).sort(), [["term:gradient", "new", "recall"], ["term:slope", "new", "recall"]]);
		const g = r.queue.find((q: any) => q.itemId === "term:gradient");
		assert.equal(g.prompt, "What does “gradient” mean?"); assert.equal(g.answer, "the direction of steepest ascent");
	});
	it("self-grading records the review and schedules it; model grading without a model says so", async () => {
		const res = await review.POST(post("/api/learner/review", { itemId: "term:gradient", mode: "recall", rating: 3 }));
		const j = await res.json();
		assert.equal(res.status, 200); assert.equal(j.graded, "self"); assert.ok(j.next.due); assert.equal(j.answer, "the direction of steepest ascent");
		const none = await review.POST(post("/api/learner/review", { itemId: "term:slope", mode: "recall", response: "rise over run" }));
		assert.equal(none.status, 503); assert.equal((await none.json()).answer, "rise over run");
		// overrule: the again replaces the good
		const o = await overrule.POST(post("/api/learner/review/overrule", { eventId: j.eventId, rating: 1 }));
		assert.equal(o.status, 200);
		const it1 = (await (await item.GET(get("/api/learner/item?id=term:gradient"))).json());
		assert.deepEqual(it1.item.reps, 1); assert.equal(it1.evidence.filter((e: any) => e.kind === "review").length, 2);
	});
	it("items, summary and glossary read the same state", async () => {
		const list = (await (await items.GET(get("/api/learner/items"))).json()).items;
		assert.deepEqual(list.map((x: any) => x.label).sort(), ["gradient", "slope"]);
		const s = await (await summary.GET(get("/api/learner"))).json();
		assert.equal(typeof s.due.fresh, "number"); assert.equal(s.engine, false);
		const g = (await (await gloss.GET(get("/api/learner/glossary?chatId=" + lesson.id))).json()).terms;
		assert.deepEqual(g.map((t: any) => [t.term, t.meaning, t.lessons[0].title]), [["gradient", "the direction of steepest ascent", "Gradient descent"], ["slope", "rise over run", "Gradient descent"]]);
	});
	it("suspending takes an item out of the queue", async () => {
		await item.POST(post("/api/learner/item", { id: "term:slope", suspend: true }));
		const r = await (await review.GET(get("/api/learner/review?limit=5"))).json();
		assert.ok(!r.queue.some((q: any) => q.itemId === "term:slope"));
	});
	it("progress reads the lesson's plan", async () => {
		chatStore.saveTree(lesson.id, { version: 1, nodes: [{ id: "g", title: "Gradient" }], edges: [] } as never);
		const p = (await (await progress.GET(get("/x"), { params: Promise.resolve({ id: lesson.id }) })).json());
		assert.deepEqual(p.progress.nodes.map((n: any) => [n.id, n.status]), [["g", "open"]]);
	});
	it("a side question is evidence: the asked term enters review first", async () => {
		const res = await chats.POST(post("/api/chats", { title: "What is a Hessian?", parent: { id: lesson.id, term: "Hessian" } }));
		assert.equal(res.status, 200);
		assert.ok(store.readEvidence().some((e: any) => e.kind === "asked" && e.itemId === "term:hessian"));
		const r = await (await review.GET(get("/api/learner/review?limit=5"))).json();
		assert.equal(r.queue.find((q: any) => q.reason === "new")?.itemId, "term:hessian");
	});
});

describe("the profile reaches the lesson's first turn", () => {
	it("a new lesson on a topic the learner has history in opens with the profile, once", async () => {
		const pid = "learner-fixture";
		const faux = createFauxCore({});
		const entry = { ...faux.getModel(), provider: pid, id: "m" };
		const seen: string[] = [];
		const stream: StreamFunction = (m, c, o) => { seen.push(JSON.stringify(c.messages)); return faux.streamSimple(m, c, o); };
		piModels().setProvider(createProvider({ id: pid, models: [entry], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
		writeSettings({ version: 1, graph: { enabled: false }, models: { strong: { model: { provider: pid, id: "m" } } } });
		store.appendEvidence([{ kind: "misconception", items: ["term:gradient"], belief: "it points downhill", chatId: "old" } as never]);
		const c = chatStore.createChat("More on the gradient");
		const tools = { noop: { name: "noop", label: "noop", description: "fixture", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: {} }) } };
		for (const text of ["teach me about the gradient", "go on"]) {
			faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
			const res = await handleChatInput(c.id, { type: "text", text }, (o) => createTeacherAgent(undefined, { ...o, tools }));
			assert.equal(res.status, 200, await res.clone().text());
			const h = runningTurn(c.id); if (h) await new Response(h.subscribe()).text();
		}
		assert.match(seen[0]!, /\[Learner profile\][\s\S]*gradient: \\"it points downhill\\"/);
		const r = chatStore.getChat(c.id)!;
		assert.equal(r.messages.filter((m: any) => m.customType === "lesson-notes").length, 1, "once per lesson");
		assert.equal(r.vocabulary?.profiled, true);
		piModels().deleteProvider(pid);
	});
});
