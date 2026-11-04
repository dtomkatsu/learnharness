/**
 * THE LEARNER MODEL (2026-11) — what the learner knows, derived from evidence.
 *
 * Each describe block pins something the old events ledger (removed
 * 2026-09-27: quiz outcomes + one-word understanding notes, never derived,
 * never scheduled, never read back) could not do:
 *   - a state per item, replayed through FSRS-6 (retrievability, due, status)
 *   - answers that say nothing about memory (missed predictions/probes) don't count against it
 *   - explain answers judged later; practice outcomes with hint level
 *   - misconceptions kept verbatim and resolved by a later success
 *   - calibration (sure and wrong)
 *   - dependency-aware recall (a proposition is only as available as its weakest premise)
 *   - a review queue, lesson progress, a digest, a glossary
 *   - the evidence written from real records, idempotently; read back into lessons as notes
 * Isolated LH_DATA_DIR and process.env.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-"));
const originalEnv = process.env;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json") };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");

const F = await import("../src/core/learner/fsrs.ts");
const M = await import("../src/core/learner/model.ts");
const { chatStore } = await import("../src/store/chats.ts");
const store = await import("../src/store/learner.ts");
const L = await import("../src/server/learner.ts");
const { runVocabularyCheck } = await import("../src/server/vocabulary-check.ts");

after(() => { process.env = originalEnv; fs.rmSync(directory, { recursive: true, force: true }); });

const DAY = 86400000;
const T0 = Date.parse("2026-10-01T12:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
let n = 0;
const ev = (e: Record<string, unknown>, t: number) => ({ id: `e${++n}`, at: iso(t), ...e }) as never;
const answer = (o: Record<string, unknown>, t: number) => ev({ kind: "answer", chatId: "c1", messageId: "m" + n, toolCallId: "call" + (n + 1), tool: "quiz", question: "q", items: ["term:gradient"], ...o }, t);
const review = (itemId: string, rating: number, t: number, extra: Record<string, unknown> = {}) => ev({ kind: "review", itemId, mode: "recall", rating, graded: "self", ...extra }, t);
const G0 = { nodes: [], chains: [] };

describe("FSRS-6", () => {
	it("a new item goes to learning, then review with growing intervals; recall decays with time", () => {
		let s = F.createSchedule(T0);
		s = F.rate(s, 3, T0); assert.equal(s.state, 1);
		s = F.rate(s, 3, T0 + 10 * 60000); assert.equal(s.state, 2);
		const first = s.scheduled_days;
		s = F.rate(s, 3, s.due); assert.ok(s.scheduled_days > first, "the interval grows");
		const r1 = F.retrievability(s, s.last_review! + DAY)!, r2 = F.retrievability(s, s.last_review! + 30 * DAY)!;
		assert.ok(r1 > r2 && r1 <= 1 && r2 > 0);
		const lapsed = F.rate(s, 1, s.due); assert.equal(lapsed.lapses, 1); assert.equal(lapsed.state, 3);
	});
});

describe("deriving the state from evidence", () => {
	it("a missed prediction or probe is not held against the learner; a missed check is", () => {
		const st = M.deriveLearner([
			answer({ questionType: "predict", outcome: "miss" }, T0),
			answer({ tool: "probe", outcome: "miss", items: ["term:slope"] }, T0 + 1000),
		], G0, T0 + 2000);
		assert.equal(st.items.get("term:gradient")!.ratings.length, 0);
		assert.equal(st.items.get("term:slope")!.ratings.length, 0);
		const st2 = M.deriveLearner([answer({ outcome: "miss" }, T0)], G0, T0 + 1000);
		assert.equal(st2.items.get("term:gradient")!.ratings[0]!.rating, 1);
	});
	it("a right answer given unsure counts as hard; an explain answer waits for the tutor's verdict", () => {
		const st = M.deriveLearner([
			answer({ outcome: "correct", confidence: 30 }, T0),
			answer({ tool: "explain", outcome: "unknown", toolCallId: "x1", items: ["term:slope"] }, T0 + 1000),
		], G0, T0 + 2000);
		assert.equal(st.items.get("term:gradient")!.ratings[0]!.rating, 2);
		assert.equal(st.items.get("term:slope")!.ratings.length, 0);
		const st2 = M.deriveLearner([answer({ tool: "explain", outcome: "unknown", toolCallId: "x1", items: ["term:slope"] }, T0), ev({ kind: "verdict", toolCallId: "x1", outcome: "correct" }, T0 + 5000)], G0, T0 + 6000);
		assert.equal(st2.items.get("term:slope")!.ratings[0]!.rating, 3);
	});
	it("practice outcomes rate their target propositions by hint level", () => {
		const st = M.deriveLearner([
			ev({ kind: "practice", chatId: "p", toolCallId: "c", items: ["node:a"], outcome: "solved", rung: "R0" }, T0),
			ev({ kind: "practice", chatId: "p", toolCallId: "d", items: ["node:b"], outcome: "solvedWithHints", rung: "R4" }, T0),
		], G0, T0 + 1000);
		assert.equal(st.items.get("node:a")!.ratings[0]!.rating, 3);
		assert.equal(st.items.get("node:b")!.ratings[0]!.rating, 1);
	});
	it("a misconception is kept verbatim until a later success resolves it", () => {
		const evs = [answer({ outcome: "miss" }, T0), ev({ kind: "misconception", items: ["term:gradient"], belief: "the gradient points downhill", chatId: "c1" }, T0 + 1000)];
		const st = M.deriveLearner(evs, G0, T0 + 2000);
		assert.equal(st.items.get("term:gradient")!.status, "misconceived");
		assert.equal(st.items.get("term:gradient")!.misconceptions[0]!.belief, "the gradient points downhill");
		const st2 = M.deriveLearner([...evs, review("term:gradient", 3, T0 + DAY)], G0, T0 + DAY + 1);
		assert.notEqual(st2.items.get("term:gradient")!.status, "misconceived");
		assert.ok(st2.items.get("term:gradient")!.misconceptions[0]!.resolvedAt);
	});
	it("six lapses make a leech; a suspension takes an item out; good spaced reviews make it solid", () => {
		const evs: never[] = [review("term:x", 3, T0), review("term:x", 3, T0 + 600000)];
		let t = T0 + 600000, st = M.deriveLearner(evs, G0, t);
		for (let i = 0; i < 6; i++) { t = st.items.get("term:x")!.schedule.due + 1000; evs.push(review("term:x", 1, t)); t += 11 * 60000; evs.push(review("term:x", 3, t)); st = M.deriveLearner(evs, G0, t); }
		assert.equal(st.items.get("term:x")!.status, "leech");
		let good: never[] = [review("term:y", 3, T0), review("term:y", 3, T0 + 600000)]; let u = T0 + 600000;
		for (let i = 0; i < 6; i++) { const s = M.deriveLearner(good, G0, u).items.get("term:y")!.schedule; u = s.due + 1000; good = [...good, review("term:y", 3, u)]; }
		assert.equal(M.deriveLearner(good, G0, u).items.get("term:y")!.status, "solid");
		assert.equal(M.deriveLearner([...good, ev({ kind: "suspend", itemId: "term:y", on: true }, u + 1)], G0, u + 2).items.get("term:y")!.status, "suspended");
	});
	it("a correct use counts as a retrieval only once the item has begun to fade; a misuse is a lapse", () => {
		const base = [review("term:z", 3, T0), review("term:z", 3, T0 + 600000)];
		const fresh = M.deriveLearner([...base, ev({ kind: "use", itemId: "term:z", term: "z", correct: true, chatId: "c" }, T0 + 700000)], G0, T0 + 800000);
		assert.equal(fresh.items.get("term:z")!.ratings.length, 2, "not yet fading — just noted");
		const later = M.deriveLearner([...base, ev({ kind: "use", itemId: "term:z", term: "z", correct: true, chatId: "c" }, T0 + 20 * DAY)], G0, T0 + 20 * DAY + 1);
		assert.equal(later.items.get("term:z")!.ratings.length, 3);
		const wrong = M.deriveLearner([...base, ev({ kind: "use", itemId: "term:z", term: "z", correct: false, chatId: "c" }, T0 + DAY)], G0, T0 + DAY + 1);
		assert.equal(wrong.items.get("term:z")!.ratings.slice(-1)[0]!.rating, 1);
	});
	it("a graph proposition is joined to the question that asked about it, and is only as available as its weakest premise", () => {
		const g = { nodes: [
			{ id: "p", name: "Premise", statement: "P holds.", provenance: [{ chatId: "c1", messageId: "mq" }] },
			{ id: "q", name: "Conclusion", statement: "Q follows.", provenance: [] },
		], chains: [{ premises: ["p"], conclusion: "q" }] };
		const st = M.deriveLearner([
			ev({ kind: "answer", chatId: "c1", messageId: "mq", toolCallId: "k", tool: "quiz", question: "?", outcome: "miss", items: [] }, T0),
			review("node:q", 4, T0), review("node:q", 4, T0 + 600000),
		], g, T0 + 5 * DAY);
		assert.equal(st.items.get("node:p")!.ratings[0]!.rating, 1, "joined by provenance");
		const q = st.items.get("node:q")!;
		assert.equal(q.weakestPremise!.id, "node:p");
		assert.ok(M.effectiveRetrievability(q)! <= q.retrievability!);
	});
	it("calibration: how often a confident answer was wrong", () => {
		const st = M.deriveLearner([answer({ outcome: "miss", confidence: 90 }, T0), answer({ outcome: "correct", confidence: 80 }, T0 + 1), answer({ outcome: "correct", confidence: 40 }, T0 + 2)], G0, T0 + 3);
		assert.equal(st.calibration.sureCount, 2); assert.equal(st.calibration.sureAndWrong, 50); assert.equal(st.calibration.accuracy, 67);
	});
});

describe("the review queue", () => {
	it("learning first, then due by lowest recall, then new — asked terms before taught ones; leeches never; a daily cap on new", () => {
		const evs = [
			ev({ kind: "taught", itemId: "term:taught", term: "taught", gloss: "g", chatId: "c" }, T0),
			ev({ kind: "asked", itemId: "term:asked", term: "asked", chatId: "c", sideChatId: "s" }, T0 + 1),
			review("term:learn", 1, T0 + 2),
		];
		const q = M.reviewQueue(M.deriveLearner(evs, G0, T0 + DAY), { newPerDay: 20 });
		assert.deepEqual(q.map((e) => [e.itemId, e.reason]), [["term:learn", "learning"], ["term:asked", "new"], ["term:taught", "new"]]);
		assert.equal(M.reviewQueue(M.deriveLearner(evs, G0, T0 + DAY), { newPerDay: 1 }).filter((e) => e.reason === "new").length, 1);
		assert.deepEqual(M.reviewQueue(M.deriveLearner(evs, G0, T0 + DAY), { only: new Set(["term:taught"]) }).map((e) => e.itemId), ["term:taught"]);
	});
});

describe("lesson progress, digest, glossary, profile", () => {
	const tree = { nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "d" }] };
	it("nodes are checked, repaired, missed or open; the frontier is open nodes whose prerequisites are confirmed", () => {
		const st = M.deriveLearner([
			answer({ planNode: "a", outcome: "correct" }, T0), answer({ planNode: "b", outcome: "miss" }, T0 + 1), answer({ planNode: "b", outcome: "correct" }, T0 + 2),
			answer({ planNode: "c", questionType: "predict", outcome: "miss" }, T0 + 3),
		], G0, T0 + 10);
		const p = M.lessonProgress(st, "c1", tree);
		assert.deepEqual(p.nodes.map((x) => [x.id, x.status]), [["a", "checked"], ["b", "repaired"], ["c", "open"], ["d", "open"]]);
		assert.deepEqual(p.frontier, ["c", "d"]);
		assert.deepEqual(M.uncheckedBefore(p, tree.edges, "c"), []);
		const p2 = M.lessonProgress(M.deriveLearner([answer({ planNode: "b", outcome: "miss" }, T0)], G0, T0 + 1), "c1", tree);
		assert.deepEqual(M.uncheckedBefore(p2, tree.edges, "c").sort(), ["a", "b"]);
	});
	it("the digest finds open misconceptions and slipping items; the glossary lists taught and asked terms", () => {
		const evs = [
			ev({ kind: "taught", itemId: "term:slope", term: "slope", gloss: "rise over run", chatId: "c1" }, T0),
			review("term:slope", 3, T0), review("term:slope", 3, T0 + 600000),
			ev({ kind: "misconception", items: ["term:slope"], belief: "slope is the height", chatId: "c1" }, T0 + 700000),
			ev({ kind: "asked", itemId: "term:hessian", term: "Hessian", chatId: "c1", sideChatId: "s" }, T0 + 800000),
		];
		const st = M.deriveLearner(evs, G0, T0 + 60 * DAY);
		const d = M.digest(st, 90);
		assert.deepEqual(d.openMisconceptions, [{ label: "slope", belief: "slope is the height" }]);
		assert.ok(d.slipping.includes("slope"));
		assert.deepEqual(M.glossary(st).map((g) => [g.term, g.meaning]), [["Hessian", ""], ["slope", "rise over run"]]);
		assert.deepEqual(M.glossary(st, "other").length, 0);
	});
	it("the profile names solid, fragile and misbelieved items near the topic, and poor calibration", () => {
		const evs: never[] = [];
		for (let i = 0; i < 6; i++) evs.push(answer({ outcome: i < 3 ? "miss" : "correct", confidence: 90, items: ["term:gradient"] }, T0 + i));
		evs.push(ev({ kind: "misconception", items: ["term:gradient"], belief: "it points downhill", chatId: "c1" }, T0 + 10));
		const text = M.profileText(M.deriveLearner(evs, G0, T0 + 20), "gradient descent for beginners")!;
		assert.match(text, /^\[Learner profile\]/); assert.match(text, /gradient: "it points downhill"/); assert.match(text, /50% of answers given at ≥75% confidence were wrong/);
		assert.equal(M.profileText(M.deriveLearner([], G0, T0), "anything"), null);
	});
});

/** A teaching record with a planned vocabulary and an answered check on node "grad". */
function lessonRecord() {
	const c = chatStore.createChat("Gradient descent");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const asst = (id: string, content: unknown[]) => ({ id, role: "assistant", content, stopReason: content.some((b: any) => b.type === "toolCall") ? "toolUse" : "stop", api: "x", provider: "x", model: "x", usage, timestamp: 1 });
	chatStore.saveMessages(c.id, [
		{ id: "u1", role: "user", content: [{ type: "text", text: "teach me gradient descent" }], timestamp: 1 },
		asst("a1", [{ type: "toolCall", id: "pd", name: "probe_done", arguments: {} }]),
		{ id: "r1", role: "toolResult", toolCallId: "pd", toolName: "probe_done", content: [{ type: "text", text: "ok" }], details: { ok: true }, isError: false, timestamp: 2 },
		asst("a2", [{ type: "text", text: "The gradient points uphill." }, { type: "toolCall", id: "q1", name: "quiz", arguments: { nodeId: "grad", type: "check", question: "Which way does the gradient point?" } }]),
		{ id: "r2", role: "toolResult", toolCallId: "q1", toolName: "quiz", content: [{ type: "text", text: "{}" }], details: { kind: "quiz", questionText: "Which way does the gradient point?", questionType: "check", dontKnow: false, answers: [{ label: "Downhill", index: 1 }], correct: false, confidence: 85, thinking: "it goes down the slope" }, isError: false, timestamp: Date.parse("2026-11-01T10:00:00Z") },
		asst("a3", [{ type: "text", text: "Not quite — uphill. The Hessian measures curvature." }]),
	] as never);
	chatStore.updateVocabulary!(c.id, (v) => { v.planned = { grad: { introduces: ["gradient"], needs: [] } }; v.terms.push({ term: "gradient", gloss: "direction of steepest ascent", source: "taught", at: "t" }); });
	return c.id;
}

describe("evidence from real records", () => {
	it("an answered check becomes an answer event on the plan node's terms, once", () => {
		const id = lessonRecord();
		const out = L.logRecordEvidence(chatStore.getChat(id)!);
		assert.equal(out.length, 1);
		const a = out[0] as any;
		assert.deepEqual([a.kind, a.outcome, a.planNode, a.items, a.confidence, a.messageId], ["answer", "miss", "grad", ["term:gradient"], 85, "a2"]);
		assert.equal(L.logRecordEvidence(chatStore.getChat(id)!).length, 0, "idempotent");
	});
	it("a concluded practice problem becomes a practice event on its targets", () => {
		const c = chatStore.createChat("practice", "practice");
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		chatStore.saveMessages(c.id, [
			{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "pr", name: "problem", arguments: { statement: "s", target: ["n_1"] } }], stopReason: "toolUse", api: "x", provider: "x", model: "x", usage, timestamp: 1 },
			{ id: "r1", role: "toolResult", toolCallId: "pr", toolName: "problem", content: [{ type: "text", text: "ok" }], details: {}, isError: false, timestamp: 2 },
			{ id: "a2", role: "assistant", content: [{ type: "toolCall", id: "co", name: "conclude", arguments: { outcome: "solvedWithHints", verdict: "v", rung: "R2", missClass: null, retest: false } }], stopReason: "toolUse", api: "x", provider: "x", model: "x", usage, timestamp: 3 },
			{ id: "r2", role: "toolResult", toolCallId: "co", toolName: "conclude", content: [{ type: "text", text: "ok" }], details: {}, isError: false, timestamp: 4 },
		] as never);
		const out = L.logRecordEvidence(chatStore.getChat(c.id)!) as any[];
		assert.deepEqual(out.map((e) => [e.kind, e.items, e.outcome, e.rung]), [["practice", ["node:n_1"], "solvedWithHints", "R2"]]);
	});
	it("the after-turn check writes taught / used-early / use / drift / misconception events from the model's reply", async () => {
		const id = lessonRecord();
		L.logRecordEvidence(chatStore.getChat(id)!);
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText(JSON.stringify({
			introduced: [{ term: "uphill", gloss: "the direction of increase" }], unexplained: [{ term: "Hessian", where: "the curvature sentence" }], learnerUsed: [],
			usedCorrectly: [], misused: [{ term: "gradient", how: "said it points down" }], drift: [{ term: "gradient", taughtAs: "a direction", nowAs: "a number" }],
			verdicts: [], misconceptions: [{ id: "q1", term: "gradient", belief: "the gradient points downhill" }],
		}))])]);
		let seen = "";
		const ok = await runVocabularyCheck(id, { chatStore, engine: () => ({ model: faux.getModel(), streamFn: (m, c, o) => { seen = JSON.stringify(c.messages); return faux.streamSimple(m, c, o); } }), canStart: () => true });
		assert.equal(ok, true);
		assert.match(seen, /\[q1\] \(missed\)[\s\S]*it goes down the slope/, "the missed answer's reasoning went to the check");
		const mine = store.readEvidence().filter((e: any) => e.chatId === id);
		const kinds = mine.map((e) => e.kind).sort();
		assert.deepEqual(kinds, ["answer", "drift", "misconception", "taught", "use", "used-early"]);
		const st = L.learnerState({ chatStore, graphStore: { readNodes: () => [], readChains: () => [] } });
		assert.equal(st.items.get("term:gradient")!.status, "misconceived");
	});
});

describe("notes from the learner model", () => {
	it("the profile is offered once; unchecked earlier steps and drift are named once each", () => {
		const id = lessonRecord();
		L.logRecordEvidence(chatStore.getChat(id)!);
		store.appendEvidence([{ kind: "drift", itemId: "term:gradient", term: "gradient", taughtAs: "a direction", nowAs: "a number", chatId: id } as never]);
		chatStore.saveTree(id, { version: 1, nodes: [{ id: "grad", title: "Gradient" } as never, { id: "step", title: "Descent step" } as never], edges: [{ from: "grad", to: "step" }] } as never);
		const r = chatStore.getChat(id)!;
		(r.messages as any[]).push({ id: "a4", role: "assistant", content: [{ type: "toolCall", id: "q2", name: "quiz", arguments: { nodeId: "step" } }], stopReason: "toolUse", timestamp: 9 });
		const deps = { chatStore, graphStore: { readNodes: () => [], readChains: () => [] } };
		const notes = L.learnerNotes(L.learnerState(deps), r, true);
		const all = notes.sections.join("\n");
		assert.match(all, /\[Learner profile\][\s\S]*gradient/);
		assert.match(all, /\[Unchecked steps\][\s\S]*"Gradient"/);
		assert.match(all, /\[Term drift\][\s\S]*taught as a direction; now used as a number/);
		// (the record's stamps are from 1970: a return after a break is named once too — tests/learner-model-2 covers it)
		chatStore.updateVocabulary!(id, (v) => { v.profiled = true; v.notedUnchecked = notes.mark.unchecked; v.notedDrift = notes.mark.drift; v.notedReturn = "a4"; });
		const again = L.learnerNotes(L.learnerState(deps), { ...chatStore.getChat(id)!, messages: r.messages }, true);
		assert.deepEqual(again.sections, []);
	});
});
