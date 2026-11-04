/**
 * THE LEARNER MODEL, second round (2026-11) — what came after the first build:
 *   - the glossary tidy: lone letters retired by rule; everyday words retired,
 *     duplicates merged and never-explained terms given a meaning by the cheap
 *     model — each as evidence (retire / merge / meaning), so it can be undone
 *   - "I already knew this" (known), and confidence on review cards, with
 *     calibration per topic
 *   - language words: both directions, by ear, and from an example sentence
 *   - another app's deck (the Bahasa flashcards) as items with that app's
 *     schedule, kept out of the lessons' queue, in a language lesson's profile
 *   - opening a lesson: the warm-up, the recap after a break, the tutor's note
 *   - the knowledge map, and how often terms are used before they are taught
 *   - tests never write to the real data folder
 * Isolated LH_DATA_DIR and process.env.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner2-"));
const originalEnv = process.env;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json") };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");

const M = await import("../src/core/learner/model.ts");
const { chatStore } = await import("../src/store/chats.ts");
const store = await import("../src/store/learner.ts");
const L = await import("../src/server/learner.ts");
const { runVocabularyCheck } = await import("../src/server/vocabulary-check.ts");

after(() => { process.env = originalEnv; fs.rmSync(directory, { recursive: true, force: true }); });

const DAY = 86400000, HOUR = 3600000;
const T0 = Date.parse("2026-10-01T12:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
let n = 0;
const ev = (e: Record<string, unknown>, t: number) => ({ id: `e${++n}`, at: iso(t), ...e }) as never;
const taught = (term: string, t: number, extra: Record<string, unknown> = {}) => ev({ kind: "taught", itemId: M.termItem(term), term, gloss: "g:" + term, chatId: "c1", ...extra }, t);
const review = (itemId: string, rating: number, t: number, extra: Record<string, unknown> = {}) => ev({ kind: "review", itemId, mode: "recall", rating, graded: "self", ...extra }, t);
const G0 = { nodes: [], chains: [] };
const deps = { chatStore, graphStore: { readNodes: () => [], readChains: () => [] } };
const engineOf = (reply: unknown, seen?: { text: string }) => {
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxText(typeof reply === "string" ? reply : JSON.stringify(reply))])]);
	return { model: faux.getModel(), streamFn: (m: any, c: any, o: any) => { if (seen) seen.text = JSON.stringify(c.messages); return faux.streamSimple(m, c, o); } } as never;
};

describe("tests never touch the real data folder", () => {
	it("under NODE_ENV=test with no LH_DATA_DIR, the data folder is a scratch one", () => {
		const env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test" } as NodeJS.ProcessEnv;
		const r = spawnSync(process.execPath, ["--import", "tsx", "-e", "import('./config.ts').then((c) => console.log(c.PATHS.data))"], { cwd: process.cwd(), env, encoding: "utf8", timeout: 20000 });
		const where = r.stdout.trim();
		assert.ok(where.includes("lh-test-data-"), `got ${where} ${r.stderr}`);
		assert.notEqual(where, path.join(process.cwd(), "data"));
	});
});

describe("the glossary tidy", () => {
	it("merge, retire, meaning and known are evidence: a merged item's history counts for the one it went into", () => {
		const st = M.deriveLearner([
			taught("mask", T0), taught("causal mask", T0 + 1), taught("shape", T0 + 2), ev({ kind: "used-early", itemId: "term:heads", term: "heads", chatId: "c1" }, T0 + 3),
			review("term:mask", 3, T0 + HOUR),
			ev({ kind: "merge", from: "term:mask", into: "term:causal mask" }, T0 + 2 * HOUR),
			ev({ kind: "retire", itemId: "term:shape", on: true }, T0 + 2 * HOUR),
			ev({ kind: "meaning", itemId: "term:heads", meaning: "parallel attention computations", source: "model" }, T0 + 2 * HOUR),
		], G0, T0 + 3 * HOUR);
		const cm = st.items.get("term:causal mask")!;
		assert.equal(st.items.has("term:mask"), false, "merged away");
		assert.equal(cm.ratings.filter((r) => r.source === "review").length, 1, "the merged item's review counts here");
		assert.deepEqual(cm.aliases, ["mask"]);
		assert.equal(st.items.get("term:shape")!.retired, true);
		assert.equal(st.items.get("term:shape")!.reviewable, false);
		assert.equal(st.items.get("term:heads")!.meaning, "parallel attention computations");
		assert.equal(st.items.get("term:heads")!.meaningSource, "model");
		const g = M.glossary(st).map((x) => x.term);
		assert.ok(g.includes("causal mask") && !g.includes("shape") && !g.includes("mask"));
		assert.equal(M.reviewQueue(st).some((q) => q.itemId === "term:shape"), false);
	});
	it("a later taught gloss replaces a model's meaning; the learner's own wording is never replaced", () => {
		const st = M.deriveLearner([
			ev({ kind: "meaning", itemId: M.termItem("heads"), meaning: "guess", source: "model" }, T0),
			taught("heads", T0 + 1),
			ev({ kind: "meaning", itemId: "term:loss", meaning: "how wrong it is, in my words", source: "learner" }, T0 + 2),
			taught("loss", T0 + 3),
		], G0, T0 + 4);
		assert.equal(st.items.get(M.termItem("heads"))!.meaning, "g:heads");
		assert.equal(st.items.get("term:loss")!.meaning, "how wrong it is, in my words");
	});
	it("lone letters and numbers are junk by rule; notation and short words are not", () => {
		for (const t of ["p", "x", "3", "1.5", "(a)"]) assert.equal(M.isJunkTerm(t), true, t);
		for (const t of ["e^x", "-in", "Wv", "ln", "softmax", "-nya"]) assert.equal(M.isJunkTerm(t), false, t);
	});
	it("the tidy retires by rule and by the model, merges into an existing term, fills empty meanings — once per term", async () => {
		const id = chatStore.createChat("How LLMs work").id;
		store.appendEvidence([
			{ kind: "taught", itemId: "term:p", term: "p", gloss: "", chatId: id },
			{ kind: "taught", itemId: "term:mask", term: "mask", gloss: "blocks future words", chatId: id },
			{ kind: "taught", itemId: "term:causal mask", term: "causal mask", gloss: "blocks attention to later words", chatId: id },
			{ kind: "taught", itemId: "term:shape", term: "shape", gloss: "", chatId: id },
			{ kind: "used-early", itemId: "term:skip-gram", term: "skip-gram", chatId: id },
		] as never);
		const seen = { text: "" };
		const out = await L.tidyGlossary(deps, engineOf({ retire: [{ id: "term:shape", reason: "everyday word" }], merge: [{ from: "term:mask", into: "term:causal mask" }, { from: "term:skip-gram", into: "term:nowhere" }], meanings: [{ id: "term:skip-gram", meaning: "a word2vec training scheme" }, { id: "term:causal mask", meaning: "should not replace a taught one" }] }, seen));
		assert.deepEqual(out, { reviewed: 4, retired: 2, merged: 1, meanings: 1 });
		assert.doesNotMatch(seen.text, /"term":"p"/, "the lone letter never went to the model");
		const st = L.learnerState(deps);
		assert.equal(st.items.get("term:p")!.retired, true);
		assert.equal(st.items.get("term:shape")!.retired, true);
		assert.equal(st.aliases.get("term:mask"), "term:causal mask");
		assert.equal(st.items.get("term:skip-gram")!.meaning, "a word2vec training scheme");
		assert.equal(st.items.get("term:causal mask")!.meaning, "blocks attention to later words");
		const again = await L.tidyGlossary(deps, engineOf({ retire: [], merge: [], meanings: [] }));
		assert.equal(again.reviewed, 0, "terms already looked at are not sent again");
	});
	it("the term check gives an unexplained term a meaning and a language word its language and example", async () => {
		const c = chatStore.createChat("Bahasa basics");
		chatStore.saveMessages(c.id, [
			{ id: "u1", role: "user", content: [{ type: "text", text: "teach me casual Indonesian" }], timestamp: T0 },
			{ id: "a1", role: "assistant", content: [{ type: "text", text: "Add -in to make it casual: bantuin. Then -nya…" }], stopReason: "stop", api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: T0 + 1 },
		] as never);
		const ok = await runVocabularyCheck(c.id, { chatStore, engine: () => engineOf({ introduced: [{ term: "-in", gloss: "casual verb ending", lang: "id", example: "Bantuin aku, dong.", exampleEn: "Help me out, will you." }], unexplained: [{ term: "-nya", where: "end", meaning: "a suffix: his/her/its, or 'the'" }] }), canStart: () => true });
		assert.equal(ok, true);
		const st = L.learnerState(deps);
		const inn = st.items.get("term:-in")!;
		assert.deepEqual([inn.lang, inn.example, inn.exampleEn], ["id", "Bantuin aku, dong.", "Help me out, will you."]);
		assert.equal(st.items.get("term:-nya")!.meaning, "a suffix: his/her/its, or 'the'");
	});
});

describe("known, confidence, calibration by topic", () => {
	it("'I already knew this' makes an item held for months at once; taking it back keeps the schedule", () => {
		const st = M.deriveLearner([taught("vector", T0), ev({ kind: "known", itemId: "term:vector", on: true }, T0 + 1)], G0, T0 + 2);
		const it = st.items.get("term:vector")!;
		assert.equal(it.known, true); assert.equal(it.status, "solid");
		assert.ok(it.schedule.due - T0 > 80 * DAY);
		assert.equal(M.reviewQueue(st).some((q) => q.itemId === "term:vector"), false, "not asked again soon");
	});
	it("confidence on reviews joins calibration; by topic, the most often sure-and-wrong first", () => {
		const lessonTitles = new Map([["c1", "LLMs"], ["c2", "Bahasa"]]);
		const evs = [taught("vector", T0), taught("kan", T0, { chatId: "c2" })];
		for (let i = 0; i < 4; i++) evs.push(review("term:vector", i < 3 ? 1 : 3, T0 + (i + 1) * DAY, { confidence: 90 }));
		for (let i = 0; i < 4; i++) evs.push(review("term:kan", 3, T0 + (i + 1) * DAY, { confidence: 80 }));
		const st = M.deriveLearner(evs, { ...G0, lessonTitles }, T0 + 6 * DAY);
		assert.equal(st.calibration.answers, 8);
		assert.equal(st.calibration.sureAndWrong, 38);
		const by = M.calibrationByTopic(st);
		assert.deepEqual(by.map((b) => [b.topic, b.sureAndWrong]), [["LLMs", 75], ["Bahasa", 0]]);
	});
	it("a review records its confidence", () => {
		const [e] = L.recordReview("term:x", "recall", 3, "self", { confidence: 140 }) as any[];
		assert.equal(e.confidence, 100);
	});
});

describe("language words", () => {
	it("are asked both ways once stable, and by ear, and in a sentence when there is one", () => {
		const evs: never[] = [taught("sih", T0, { lang: "id", example: "Kenapa sih?", exampleEn: "Why, though?" })];
		const st0 = M.deriveLearner(evs, G0, T0 + 1);
		const has = (id: string, m: string) => m === "cloze";
		assert.equal(M.modeFor(st0.items.get("term:sih")!, T0 + 1, has), "recall");
		evs.push(review("term:sih", 3, T0 + 2));
		const st1 = M.deriveLearner(evs, G0, T0 + 3);
		assert.equal(M.modeFor(st1.items.get("term:sih")!, T0 + 3, has), "listen");
		evs.push(review("term:sih", 3, T0 + DAY), review("term:sih", 3, T0 + 4 * DAY));
		const st2 = M.deriveLearner(evs, G0, T0 + 20 * DAY);
		assert.equal(M.modeFor(st2.items.get("term:sih")!, T0 + 20 * DAY, has), "produce", "the other direction once it is held");
		const card = L.fallbackCard(st0.items.get("term:sih")!);
		assert.equal(card.cloze!.prompt, "Kenapa ____? (Why, though?)");
		assert.match(card.produce!.prompt, /How do you say/);
		const f = L.cardFace(card, "listen", st0.items.get("term:sih")!);
		assert.deepEqual([f.mode, f.speak], ["listen", "sih"]);
	});
});

describe("another app's deck", () => {
	const deck = (extra: Partial<Record<string, unknown>> = {}) => ({ term: "kan", gloss: "right? (tag)", deck: "bahasa", lang: "id", tags: ["particle"], example: "Sudah makan, kan?", exampleEn: "You've eaten, right?", audio: "https://x/kan.m4a", schedule: { stability: 30, difficulty: 5, due: T0 + 30 * DAY, lastReview: T0, reps: 4 }, ...extra });
	it("its words take that app's schedule; reviews here after it go on top; they stay out of the lessons' queue", () => {
		const st = M.deriveLearner([], { ...G0, external: [deck(), deck({ term: "dong", schedule: null })] as never }, T0 + 40 * DAY);
		const kan = st.items.get("term:kan")!;
		assert.equal(kan.status, "solid"); assert.equal(kan.deck, "bahasa"); assert.equal(kan.lang, "id"); assert.equal(kan.audio, "https://x/kan.m4a");
		assert.ok(kan.retrievability! < 0.9, "overdue: fading");
		assert.equal(st.items.get("term:dong")!.status, "new");
		assert.deepEqual(M.reviewQueue(st).map((q) => q.itemId), [], "the lessons' queue holds no deck-only words");
		assert.deepEqual(M.reviewQueue(st, { deck: "bahasa" }).map((q) => q.itemId), ["term:kan", "term:dong"]);
		const st2 = M.deriveLearner([review("term:kan", 1, T0 + 41 * DAY)], { ...G0, external: [deck()] as never }, T0 + 41 * DAY + 1);
		assert.equal(st2.items.get("term:kan")!.lapses, 1, "the review here lands on the deck's schedule");
		assert.equal(M.glossary(st).length, 0, "the glossary is the lessons' unless asked for a deck");
		assert.equal(M.glossary(st, undefined, "bahasa").length, 2);
		assert.deepEqual(M.digest(st).slipping, [], "a deck's backlog is not the lessons' week");
	});
	it("a deck word a lesson taught is in both; a language lesson's profile names what the deck holds", () => {
		const st = M.deriveLearner([taught("kan", T0 + DAY, { chatId: "c2" })], { ...G0, lessonTitles: new Map([["c2", "Bahasa indonesian"]]), external: [deck({ schedule: { stability: 60, difficulty: 4, due: T0 + 60 * DAY, lastReview: T0 + 20 * DAY, reps: 6 } }), deck({ term: "dong", schedule: null })] as never }, T0 + 21 * DAY);
		assert.ok(M.reviewQueue(st, { newPerDay: 0 }).length === 0 || M.inDeck(st.items.get("term:kan")!));
		assert.equal(M.inDeck(st.items.get("term:kan")!), true);
		const p = M.profileText(st, "Bahasa indonesian casual speech")!;
		assert.match(p, /bahasa flashcards \(2 words, 1 studied\)/);
		assert.match(p, /Held well[^\n]*kan/);
		assert.match(p, /1 deck words never studied/);
		assert.equal(M.deckProfile(st, "How LLMs work"), null);
	});
});

describe("opening a lesson, coming back to one", () => {
	function lesson(lastAt: number) {
		const c = chatStore.createChat("Attention");
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		chatStore.saveMessages(c.id, [
			{ id: "u1", role: "user", content: [{ type: "text", text: "teach me attention" }], timestamp: lastAt - 2000 },
			{ id: "a1", role: "assistant", content: [{ type: "text", text: "Each word scores the others." }, { type: "toolCall", id: "q1", name: "quiz", arguments: { nodeId: "scores", question: "?" } }], stopReason: "toolUse", api: "x", provider: "x", model: "x", usage, timestamp: lastAt - 1000 },
			{ id: "a2", role: "assistant", content: [{ type: "text", text: "Next: softmax turns scores into weights." }], stopReason: "stop", api: "x", provider: "x", model: "x", usage, timestamp: lastAt },
		] as never);
		chatStore.saveTree(c.id, { version: 1, nodes: [{ id: "scores", title: "Relevance scores" }, { id: "soft", title: "Softmax" }], edges: [{ from: "scores", to: "soft" }] } as never);
		store.appendEvidence([
			{ kind: "taught", itemId: "term:relevance score", term: "relevance score", gloss: "how much one word matters to another", chatId: c.id, at: iso(lastAt - 10 * DAY) },
			{ kind: "review", itemId: "term:relevance score", mode: "recall", rating: 3, graded: "self", at: iso(lastAt - 10 * DAY) },
		] as never);
		chatStore.updateVocabulary!(c.id, (v) => { v.profiled = true; });
		return c.id;
	}
	it("a lesson resumed after three hours gets a warm-up and a recap (its summary written once and kept)", async () => {
		const now = Date.now();
		const id = lesson(now - 2 * DAY);
		const seen = { text: "" };
		const s = await L.lessonStart(deps, L.learnerState(deps, now), chatStore.getChat(id)!, engineOf("You were scoring words against each other. Next is softmax.", seen));
		assert.equal(s.returning, true);
		assert.ok(s.gapHours! >= 47);
		assert.deepEqual(s.warmup, ["term:relevance score"]);
		assert.equal(s.recap!.lastStep, "Relevance scores");
		assert.deepEqual(s.recap!.faded, ["relevance score"]);
		assert.equal(s.recap!.summary, "You were scoring words against each other. Next is softmax.");
		assert.match(seen.text, /softmax turns scores into weights/);
		const again = await L.lessonStart(deps, L.learnerState(deps, now), chatStore.getChat(id)!, undefined);
		assert.equal(again.recap!.summary, "You were scoring words against each other. Next is softmax.", "kept, no second call");
		const fresh = await L.lessonStart(deps, L.learnerState(deps, now), chatStore.getChat(lesson(now - HOUR))!, undefined);
		assert.equal(fresh.returning, false); assert.equal(fresh.recap, null);
	});
	it("the tutor is told the learner is back, where it stood, what faded and how the warm-up went — once", () => {
		const now = Date.now();
		const id = lesson(now - 3 * DAY);
		store.appendEvidence([{ kind: "review", itemId: "term:relevance score", mode: "recall", rating: 1, graded: "model", at: iso(now - 60000) }] as never);
		const r = chatStore.getChat(id)!;
		const notes = L.learnerNotes(L.learnerState(deps, now), r, true);
		const text = notes.sections.join("\n");
		assert.match(text, /\[Returning after 3 days\]/);
		assert.match(text, /"Relevance scores"/);
		assert.match(text, /Warm-up just now: relevance score: missed/);
		assert.equal(notes.mark.returned, "a2");
		chatStore.updateVocabulary!(id, (v) => { v.notedReturn = notes.mark.returned; });
		assert.doesNotMatch(L.learnerNotes(L.learnerState(deps, now), chatStore.getChat(id)!, true).sections.join("\n"), /Returning/);
	});
});

describe("the map, and terms used before they were taught", () => {
	it("the map shows each lesson's steps with their status and terms, and what is next", () => {
		const now = Date.now();
		const c = chatStore.createChat("Map lesson");
		chatStore.saveTree(c.id, { version: 1, nodes: [{ id: "a", title: "Vectors" }, { id: "b", title: "Dot product" }], edges: [{ from: "a", to: "b" }] } as never);
		chatStore.updateVocabulary!(c.id, (v) => { v.planned = { a: { introduces: ["vector"], needs: [] }, b: { introduces: ["dot product"], needs: ["vector"] } }; });
		store.appendEvidence([
			{ kind: "taught", itemId: "term:vector", term: "vector", gloss: "a list of numbers", chatId: c.id },
			{ kind: "answer", chatId: c.id, messageId: "m", toolCallId: "qa", tool: "quiz", question: "?", outcome: "correct", planNode: "a", items: ["term:vector"] },
		] as never);
		const map = L.knowledgeMap(deps, L.learnerState(deps, now));
		const l = map.lessons.find((x) => x.id === c.id)!;
		assert.deepEqual(l.steps.map((s) => [s.title, s.status, s.terms.map((t: any) => t.label)]), [["Vectors", "checked", ["vector"]], ["Dot product", "open", []]]);
		assert.deepEqual(l.steps[1]!.needs.map((t: any) => t.label), ["vector"]);
		assert.deepEqual(l.next, ["Dot product"]);
	});
	it("vocabulary health: the share of new terms used before they were taught, week by week", () => {
		const now = T0 + 20 * DAY;
		const st = M.deriveLearner([
			taught("a", T0), taught("b", T0), ev({ kind: "used-early", itemId: "term:c", term: "c", chatId: "c1" }, T0), ev({ kind: "used-early", itemId: "term:d", term: "d", chatId: "c1" }, T0 + 1),
			taught("e", now - DAY), taught("f", now - DAY), taught("g", now - DAY), ev({ kind: "used-early", itemId: "term:h", term: "h", chatId: "c1" }, now - DAY),
		], G0, now);
		const h = M.vocabularyHealth(st);
		assert.deepEqual([h.taught, h.usedEarly, h.rate], [5, 3, 38]);
		assert.equal(h.weeks.length, 6);
		assert.deepEqual(h.weeks.at(-1)!.rate, 25);
		assert.equal(h.weeks.find((w) => w.taught === 2)!.rate, 50);
	});
});

describe("the question mix", () => {
	it("counts checks with options against answers in his own words, week by week", () => {
		const now = T0 + 20 * DAY;
		const a = (tool: string, t: number) => ev({ kind: "answer", chatId: "c1", messageId: "m", toolCallId: "x" + n, tool, question: "q", outcome: "correct", items: [] }, t);
		const st = M.deriveLearner([a("quiz", T0), a("quiz", T0 + 1), a("probe", T0 + 2), a("quiz", now - DAY), a("explain", now - DAY), a("explain", now - DAY)], G0, now);
		const q = M.questionMix(st);
		assert.deepEqual([q.choice, q.own, q.ownShare], [3, 2, 40], "the probe is not counted");
		assert.deepEqual([q.weeks.at(-1)!.choice, q.weeks.at(-1)!.own], [1, 2]);
	});
});

describe("the question-mix nudge", () => {
	it("after three option questions in a row the tutor is told to ask the next in his own words; an explain among them clears it", () => {
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const call = (id: string, name: string) => ({ id: "m" + id, role: "assistant", content: [{ type: "toolCall", id, name, arguments: { question: "q" } }], stopReason: "toolUse", api: "x", provider: "x", model: "x", usage, timestamp: 1 });
		const rec = (names: string[]) => ({ id: "c", title: "t", messages: names.map((n, i) => call("q" + i, n)) }) as never;
		assert.equal(L.questionMixNote(rec(["quiz", "quiz"])), null);
		assert.match(L.questionMixNote(rec(["explain", "quiz", "quiz", "quiz"]))!, /^\[Question mix\] The last 3 questions[\s\S]*1 of 4 so far[\s\S]*`explain`/);
		assert.equal(L.questionMixNote(rec(["quiz", "quiz", "explain"])), null);
	});
});

describe("memory: relearning, held later, use it, confident misses, a backlog", () => {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const ans = (node: string, outcome: string, t: number, extra: Record<string, unknown> = {}) => ev({ kind: "answer", chatId: "L", messageId: "m", toolCallId: "a" + n, tool: "quiz", questionType: "check", question: "q on " + node, outcome, planNode: node, items: ["term:" + node], ...extra }, t);
	const tree = { nodes: [{ id: "a", title: "Step A" }, { id: "b", title: "Step B" }, { id: "c", title: "Step C" }], edges: [] };
	it("a step right just after the teaching is confirmed; right again a day later it is held", () => {
		const st = M.deriveLearner([ans("a", "correct", T0), ans("b", "correct", T0), ans("a", "correct", T0 + DAY), review("term:b", 3, T0 + 2 * HOUR)], G0, T0 + 2 * DAY);
		const p = M.lessonProgress(st, "L", tree);
		assert.deepEqual(p.nodes.map((x) => [x.id, x.status, x.held]), [["a", "checked", true], ["b", "checked", false], ["c", "open", false]]);
		assert.equal(p.held, 1);
		const st2 = M.deriveLearner([ans("b", "correct", T0), review("term:b", 3, T0 + DAY)], G0, T0 + 2 * DAY);
		assert.equal(M.lessonProgress(st2, "L", tree).nodes[1]!.held, true, "a review of its term a day later counts");
	});
	it("the tutor is asked to re-check a step confirmed 20 minutes ago, once a day, not the current one", () => {
		const st = M.deriveLearner([ans("a", "correct", T0), ans("b", "correct", T0 + 25 * 60000)], G0, T0 + 30 * 60000);
		const rec = { id: "L", title: "t", tree, messages: [{ id: "m1", role: "assistant", content: [{ type: "toolCall", id: "x", name: "quiz", arguments: { nodeId: "b" } }], stopReason: "toolUse", api: "x", provider: "x", model: "x", usage, timestamp: 1 }] } as never;
		const note = L.recheckNote(st, rec)!;
		assert.equal(note.node, "a"); assert.match(note.text, /"Step A" was confirmed 30 minutes ago/);
		assert.equal(L.recheckNote(st, { ...(rec as object), vocabulary: { terms: [], flagged: [], sideQuestions: [], notedRecheck: { a: new Date(T0 + 29 * 60000).toISOString() } } } as never), null);
	});
	it("a confident wrong answer is named to the tutor once", () => {
		const st = M.deriveLearner([ans("a", "miss", T0, { confidence: 90, thinking: "bigger score means less weight" }), ans("b", "miss", T0, { confidence: 30 })], G0, T0 + 1);
		const rec = { id: "L", title: "t", messages: [] } as never;
		const n1 = L.confidentMissNote(st, rec)!;
		assert.equal(n1.ids.length, 1); assert.match(n1.text, /90% sure, and wrong \(his reasoning: "bigger score means less weight"\)/);
		assert.equal(L.confidentMissNote(st, { id: "L", title: "t", messages: [], vocabulary: { terms: [], flagged: [], sideQuestions: [], notedConfident: n1.ids } } as never), null);
	});
	it("every third review uses the idea on a fresh problem when the card has some, rotating through them", () => {
		const evs: never[] = [taught("softmax", T0)];
		for (let i = 0; i < 2; i++) evs.push(review("term:softmax", 3, T0 + (i + 1) * DAY));
		const st = M.deriveLearner(evs, G0, T0 + 3 * DAY);
		const it = st.items.get("term:softmax")!;
		assert.equal(M.modeFor(it, T0 + 3 * DAY, (_id, m) => m === "apply"), "apply");
		assert.equal(M.modeFor(it, T0 + 3 * DAY, () => false), "recall");
		const card = { itemId: it.id, meaning: "m", recall: { prompt: "p", answer: "a" }, apply: [{ prompt: "softmax of (0, ln 3)?", answer: "(1/4, 3/4)" }, { prompt: "two", answer: "2" }], lapsesAt: 0, generatedAt: "x" };
		assert.deepEqual(L.cardFace(card as never, "apply", it), { mode: "apply", prompt: "softmax of (0, ln 3)?", answer: "(1/4, 3/4)" }, "the first use-it ask: the first problem");
		const it5 = { ...it, ratings: [...it.ratings, ...Array.from({ length: 3 }, () => ({ at: "x", rating: 3, source: "review", eventId: "e" }))] };
		assert.equal(L.cardFace(card as never, "apply", it5 as never).prompt, "two", "the next use-it ask: the next problem");
		assert.equal(store.hasCardMode({ [it.id]: { ...card, apply: [] } } as never)(it.id, "apply"), false, "an empty list is no mode");
	});
	it("a deck backlog comes at most 40 a day, the most forgotten first, and says how big it is", () => {
		const ext = Array.from({ length: 60 }, (_, i) => ({ term: "w" + i, gloss: "g", deck: "bahasa", lang: "id", schedule: { stability: 5 + i, difficulty: 5, due: T0, lastReview: T0 - 10 * DAY, reps: 3 } }));
		const st = M.deriveLearner([], { ...G0, external: ext as never }, T0 + 30 * DAY);
		const q = M.reviewQueue(st, { deck: "bahasa", ...M.DECK_LIMITS, limit: 1000 });
		assert.equal(q.filter((e) => e.reason === "due").length, 40);
		assert.equal(q[0]!.itemId, "term:w0", "lowest recall first");
		const c = M.dueCount(st, M.DECK_LIMITS.newPerDay, "bahasa", M.DECK_LIMITS.dueCap);
		assert.deepEqual([c.due, c.backlog], [40, 60]);
		const later = M.deriveLearner(Array.from({ length: 10 }, (_, i) => review("term:w" + i, 3, T0 + 30 * DAY + i)) as never, { ...G0, external: ext as never }, T0 + 30 * DAY + 100);
		assert.equal(M.dueCount(later, 10, "bahasa", 40).due, 30, "the day's reviews count against the cap");
	});
});

