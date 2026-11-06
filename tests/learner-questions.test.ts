/**
 * SHARPER FREE-FORM QUESTIONS (2026-11): a review card's open prompts carry `shape` (the form of the answer) and `looksFor`
 * (its 1–3 key points) and the version of the prompt that wrote them; an older card is rewritten when next needed; the grader
 * marks against `looksFor` and says which points were hit; the queue hands both to the page; "Too vague" records the complaint
 * and rewrites that item's cards narrower, telling the card writer which prompts were complained about.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProvider, createFauxCore, fauxAssistantMessage, fauxText, type StreamFunction } from "@earendil-works/pi-ai";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-questions-"));
const originalEnv = process.env;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), ANTHROPIC_API_KEY: "" } as NodeJS.ProcessEnv;
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");

const store = await import("../src/store/learner.ts");
const server = await import("../src/server/index.ts");
const learner = await import("../src/server/learner.ts");
const review = await import("../app/api/learner/review/route.ts");
const vague = await import("../app/api/learner/vague/route.ts");
const { piModels } = await import("../src/agent/models.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { lintPrompt, openPrompts } = await import("../src/core/learner/prompt-lint.ts");

after(() => { process.env = originalEnv; fs.rmSync(directory, { recursive: true, force: true }); });
const post = (url: string, body: unknown) => new Request("http://x" + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const seen: string[] = [];
const faux = createFauxCore({});
const PID = "questions-fixture";
const entry = { ...faux.getModel(), provider: PID, id: "m" };
const stream: StreamFunction = (m, c, o) => { seen.push(JSON.stringify(c.messages) + JSON.stringify((c as { systemPrompt?: string }).systemPrompt ?? "")); return faux.streamSimple(m, c, o); };
const engine = { model: entry as never, streamFn: stream };
const reply = (o: unknown) => faux.setResponses([fauxAssistantMessage([fauxText(JSON.stringify(o))])]);

const lesson = "chat_q";
store.appendEvidence([
	{ kind: "taught", itemId: "term:softmax", term: "softmax", gloss: "turns scores into weights that add to 1", chatId: lesson } as never,
	{ kind: "taught", itemId: "term:asing", term: "asing", gloss: "foreign", chatId: lesson, lang: "id" } as never,
]);

describe("open prompts carry their shape and key points", () => {
	it("a card written now keeps shape, looksFor (≤ 4, trimmed) and the prompt version", async () => {
		reply({ cards: [{ id: "term:softmax", meaning: "turns scores into weights", recall: { prompt: "What does softmax do to a list of raw scores?", answer: "Turns them into weights that add to 1.", shape: "One sentence", looksFor: ["makes them positive", " they add to 1 ", "", "keeps the order", "a", "b"] }, apply: [] }] });
		const state = server.learnerState(server.stores);
		const written = await learner.generateCards(server.stores, state, ["term:softmax"], engine as never);
		assert.deepEqual(written, ["term:softmax"]);
		const c = store.readCards()["term:softmax"]!;
		assert.equal(c.promptVersion, learner.CARD_PROMPT_VERSION);
		assert.equal(c.recall.shape, "One sentence");
		assert.deepEqual(c.recall.looksFor, ["makes them positive", "they add to 1", "keeps the order", "a"]);
	});
	it("a card without a version is needed again (a word of a language is not), the current one is not", () => {
		const cards = store.readCards();
		cards["term:old"] = { itemId: "term:old", meaning: "m", recall: { prompt: "p", answer: "a" }, apply: [], lapsesAt: 0, generatedAt: "2026-11-01" } as never;
		store.writeCards(cards);
		store.appendEvidence([{ kind: "taught", itemId: "term:old", term: "old", gloss: "m", chatId: lesson } as never]);
		const state = server.learnerState(server.stores);
		assert.deepEqual(learner.cardsNeeded(state, ["term:old", "term:softmax"], store.readCards()), ["term:old"]);
	});
	it("the queue hands the page the shape and the points", () => {
		const q = learner.queueView(server.learnerState(server.stores), { limit: 20, only: new Set(["term:softmax"]) });
		const row = q.find((x) => x.itemId === "term:softmax")!;
		assert.equal(row.shape, "One sentence");
		assert.equal(row.looksFor?.length, 4);
	});
});

describe("grading against the key points", () => {
	it("the grader is given the numbered points and its `hit` is kept only for points that exist", async () => {
		reply({ rating: 3, reason: "You said they add to 1 but not that they are positive.", hit: [1, 7, 1, -1, "x"] });
		const face = { prompt: "What does softmax do?", answer: "…", looksFor: ["makes them positive", "they add to 1"] };
		const g = await learner.gradeAnswer(face, "the scores become shares that sum to one", engine as never);
		assert.deepEqual(g.hit, [1]);
		assert.equal(g.rating, 3);
		const sent = seen[seen.length - 1]!;
		assert.match(sent, /LOOKS FOR:\\n0\. makes them positive\\n1\. they add to 1/);
	});
	it("a card with no points is graded as before: no LOOKS FOR, no hit", async () => {
		reply({ rating: 4, reason: "Right." });
		const g = await learner.gradeAnswer({ prompt: "p", answer: "a" }, "a", engine as never);
		assert.equal(g.hit, undefined);
		assert.doesNotMatch(seen[seen.length - 1]!, /LOOKS FOR:\\n/);
	});
	it("the review route answers with the points and which were hit", async () => {
		piModels().setProvider(createProvider({ id: PID, models: [entry as never], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
		writeSettings({ version: 1, graph: { enabled: false }, models: { cheap: { model: { provider: PID, id: "m" } } } } as never);
		reply({ rating: 3, reason: "Missing: positive.", hit: [1] });
		const res = await review.POST(post("/api/learner/review", { itemId: "term:softmax", mode: "recall", response: "they sum to one" }));
		const j = await res.json();
		assert.equal(res.status, 200, JSON.stringify(j));
		assert.deepEqual(j.looksFor, ["makes them positive", "they add to 1", "keeps the order", "a"]);
		assert.deepEqual(j.hit, [1]);
	});
});

describe("Too vague", () => {
	it("a review card's complaint is recorded, the card is rewritten with the complaint passed on, and the new face comes back", async () => {
		reply({ cards: [{ id: "term:softmax", meaning: "m", recall: { prompt: "Raw scores (2, 0) go through softmax. Which one gets the larger weight?", answer: "The 2.", shape: "One word", looksFor: ["the score 2"] }, apply: [] }] });
		const res = await vague.POST(post("/api/learner/vague", { itemId: "term:softmax", mode: "recall" }));
		const j = await res.json();
		assert.equal(res.status, 200, JSON.stringify(j));
		assert.equal(j.rewritten, true);
		assert.match(j.prompt, /Raw scores \(2, 0\)/);
		assert.equal(j.shape, "One word");
		assert.deepEqual(j.looksFor, ["the score 2"]);
		const ev = store.readEvidence().filter((e: any) => e.kind === "vague");
		assert.equal(ev.length, 1);
		assert.equal((ev[0] as any).itemId, "term:softmax");
		assert.match((ev[0] as any).prompt, /What does softmax do to a list of raw scores/);
		const asked = seen[seen.length - 1]!;
		assert.match(asked, /tooVague[^\]]*What does softmax do to a list of raw scores/);
	});
	it("a tutor question's complaint is only recorded; the wrong shapes are refused", async () => {
		const ok = await vague.POST(post("/api/learner/vague", { chatId: "c1", toolCallId: "t1", question: "Explain gradients." }));
		assert.equal(ok.status, 200);
		assert.ok(store.readEvidence().some((e: any) => e.kind === "vague" && e.toolCallId === "t1" && e.prompt === "Explain gradients."));
		assert.equal((await vague.POST(post("/api/learner/vague", { mode: "recall" }))).status, 400);
		assert.equal((await vague.POST(post("/api/learner/vague", { itemId: "term:nope" }))).status, 404);
	});
});

describe("the vague-prompt lint", () => {
	it("flags two asks in one and unbounded openers, and passes a bounded single ask", () => {
		assert.deepEqual(lintPrompt("What does softmax do to a list of raw scores, and what properties does the result have?"), ["two-asks"]);
		assert.deepEqual(lintPrompt("p = 1. What is the loss, and why?"), ["two-asks"]);
		assert.deepEqual(lintPrompt("What does it mean? And how is it used?"), ["two-asks"]);
		assert.deepEqual(lintPrompt("What happens to the meaning of a word like 'bank' as the other words change?"), ["unbounded"]);
		assert.deepEqual(lintPrompt("Explain gradient descent."), ["unbounded"]);
		assert.deepEqual(lintPrompt("A model raises the probability of the true word from 0.1 to 0.5. Does the loss on that word go up or down?"), []);
		assert.deepEqual(lintPrompt("What is a bank and a loan?"), [], "'and' alone is not two asks");
	});
	it("looks only at the open faces of a card", () => {
		const open = openPrompts({ recall: { prompt: "a" }, why: { prompt: "b" }, apply: [{ prompt: "c" }, { prompt: "d" }], produce: { prompt: "never" } } as never);
		assert.deepEqual(open.map((o) => o.mode + o.prompt), ["recalla", "whyb", "applyc", "applyd"]);
	});
});
