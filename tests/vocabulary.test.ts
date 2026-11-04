/**
 * THE LESSON VOCABULARY (2026-11) — the remedy for concepts used before they
 * are taught, end to end:
 *   - plan_init's vocabulary gate (a node may only need terms known or
 *     introduced by a node before it) and what it records on the ledger
 *   - the ledger's dedupe rules, the brief suffix for demos/figures
 *   - the after-turn check (a scripted model's reply → taught / flagged /
 *     known, checkedThrough advanced)
 *   - the lesson-notes marker: flags and side questions reach the teacher on
 *     its next learner-driven turn, after the input, and are then cleared
 * Isolated LH_DATA_DIR and process.env, as cache-retention.test.ts.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type, createProvider, createFauxCore, fauxAssistantMessage, fauxText, type StreamFunction } from "@earendil-works/pi-ai";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vocabulary-"));
const originalEnv = process.env;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), ANTHROPIC_API_KEY: "fixture", OPENAI_API_KEY: "fixture", OPENROUTER_API_KEY: "fixture" };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");

const V = await import("../src/core/vocabulary.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { planTools } = await import("../src/agent/tools/plan.ts");
const { runVocabularyCheck } = await import("../src/server/vocabulary-check.ts");
const { piModels } = await import("../src/agent/models.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
const { projectView } = await import("../src/core/view.ts");

after(() => { process.env = originalEnv; fs.rmSync(directory, { recursive: true, force: true }); });

const MAP = "graph TD\n  slope[Slope] --> gradient[The gradient]\n  gradient --> descent[Descent step]\n";

describe("planVocabularyProblems", () => {
	const ids = ["slope", "gradient", "descent"], edges = [{ from: "slope", to: "gradient" }, { from: "gradient", to: "descent" }];
	it("passes when every needed term is known or introduced before (transitively)", () => {
		assert.deepEqual(V.planVocabularyProblems(ids, edges, { known: ["function"], nodes: { slope: { introduces: ["slope"], needs: ["function"] }, gradient: { introduces: ["gradient"] }, descent: { needs: ["slopes", "Gradient"] } } }), []);
	});
	it("refuses a term no node introduces", () => {
		const p = V.planVocabularyProblems(ids, edges, { nodes: { descent: { needs: ["learning rate"] } } });
		assert.equal(p.length, 1); assert.match(p[0]!, /"descent" needs "learning rate", but no node introduces it/);
	});
	it("refuses a term introduced only after (or beside) the node that needs it", () => {
		const p = V.planVocabularyProblems(ids, edges, { nodes: { slope: { needs: ["gradient"] }, gradient: { introduces: ["gradient"] } } });
		assert.equal(p.length, 1); assert.match(p[0]!, /introduced only by "gradient", which does not come before "slope"/);
	});
	it("names a vocabulary entry for a node that is not on the map", () => {
		assert.match(V.planVocabularyProblems(ids, edges, { nodes: { ghost: {} } })[0]!, /"ghost", which is not in the map/);
	});
});

describe("the ledger", () => {
	it("dedupes terms (case, quotes, plural) and clears a flag once its term is held", () => {
		const v = V.emptyVocabulary(), at = "t";
		V.addFlags(v, [{ term: "Gradient", where: "x", at }]);
		V.addFlags(v, [{ term: "gradients", where: "y", at }]);
		assert.equal(v.flagged.length, 1);
		V.addTerms(v, [{ term: "“gradient”", gloss: "g", source: "taught", at }, { term: "GRADIENT", gloss: "", source: "known", at }]);
		assert.equal(v.terms.length, 1); assert.equal(v.flagged.length, 0);
		V.addFlags(v, [{ term: "gradient", where: "z", at }]);
		assert.equal(v.flagged.length, 0, "a held term is never flagged");
	});
	it("the brief suffix lists the held terms (and is empty with none)", () => {
		assert.equal(V.vocabularyBriefSuffix(undefined), "");
		const v = V.emptyVocabulary(); V.addTerms(v, [{ term: "slope", gloss: "", source: "taught", at: "t" }]);
		assert.match(V.vocabularyBriefSuffix(v), /VOCABULARY — .*only these technical terms: slope\./);
	});
	it("notes say nothing with nothing waiting, and name flags and side questions", () => {
		assert.equal(V.lessonNotesText([], []), null);
		const t = V.lessonNotesText([{ term: "Hessian", where: "in the step about curvature", at: "t" }], [{ chatId: "c", term: "steepest ascent", at: "t" }])!;
		assert.match(t, /^\[Lesson notes\]/); assert.match(t, /"Hessian" — in the step about curvature/); assert.match(t, /"steepest ascent"/);
	});
	it("reads the checker's JSON through a code fence; refuses prose", () => {
		const r = V.parseVocabularyReply("```json\n{\"introduced\":[{\"term\":\"slope\",\"gloss\":\"rise over run\"}],\"unexplained\":[{\"term\":\"Hessian\",\"where\":\"p2\"}],\"learnerUsed\":[\"function\"]}\n```")!;
		assert.deepEqual(r.introduced, [{ term: "slope", gloss: "rise over run" }]); assert.equal(r.unexplained[0]!.term, "Hessian"); assert.deepEqual(r.learnerUsed, ["function"]);
		assert.equal(V.parseVocabularyReply("no json here"), null);
	});
	it("updateVocabulary writes the record and leaves updatedAt alone", () => {
		const c = chatStore.createChat("ledger");
		const before = chatStore.getChat(c.id)!.updatedAt;
		chatStore.updateVocabulary!(c.id, (v) => { v.sideQuestions.push({ chatId: "x", term: "t", at: "t" }); });
		const r = chatStore.getChat(c.id)!;
		assert.equal(r.vocabulary?.sideQuestions.length, 1); assert.equal(r.updatedAt, before);
		assert.equal(chatStore.updateVocabulary!("chat_nope", () => {}), null);
	});
});

describe("plan_init's vocabulary gate", () => {
	const exec = (chatId: string, input: unknown) => planTools({ chatId, chatStore }).plan_init!.execute("t", input as never);
	it("refuses a plan that needs an untaught term — nothing is saved", async () => {
		const c = chatStore.createChat("gate");
		const r = await exec(c.id, { mermaid: MAP, vocabulary: { nodes: { descent: { needs: ["learning rate"] } } } });
		assert.equal((r.details as { ok: boolean }).ok, false);
		assert.match((r.details as { error: string }).error, /uses terms before teaching them/);
		assert.equal(chatStore.getChat(c.id)!.tree, undefined);
	});
	it("a sound plan saves the tree, the planned vocabulary and the known terms", async () => {
		const c = chatStore.createChat("gate ok");
		const r = await exec(c.id, { mermaid: MAP, vocabulary: { known: ["function"], nodes: { gradient: { introduces: ["gradient"], needs: ["slope"] }, slope: { introduces: ["slope"] } } } });
		assert.equal((r.details as { ok: boolean }).ok, true);
		const v = chatStore.getChat(c.id)!.vocabulary!;
		assert.deepEqual(v.planned!.gradient, { introduces: ["gradient"], needs: ["slope"] });
		assert.deepEqual(v.terms.map((t) => [t.term, t.source]), [["function", "known"]]);
	});
	it("without a vocabulary the plan is accepted and the result says what was skipped", async () => {
		const c = chatStore.createChat("gate none");
		const r = await exec(c.id, { mermaid: MAP });
		assert.equal((r.details as { ok: boolean }).ok, true);
		assert.match((r.content[0] as { text: string }).text, /No vocabulary was given/);
	});
});

/** A record whose probe has concluded (so turns are teaching turns), with one taught reply. */
function teachingChat(title: string) {
	const c = chatStore.createChat(title);
	chatStore.saveMessages(c.id, [
		{ id: "u1", role: "user", content: [{ type: "text", text: "teach me gradient descent" }], timestamp: 1 },
		{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "pd1", name: "probe_done", arguments: {} }], stopReason: "toolUse", api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 2 },
		{ id: "r1", role: "toolResult", toolCallId: "pd1", toolName: "probe_done", content: [{ type: "text", text: "ok" }], details: { ok: true }, isError: false, timestamp: 3 },
		{ id: "a2", role: "assistant", content: [{ type: "text", text: "The slope is rise over run. Now the Hessian tells us the curvature." }], stopReason: "stop", api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 4 },
	] as never);
	return c.id;
}

describe("the after-turn check", () => {
	it("records what was taught, flags what was used too early, and moves its mark", async () => {
		const id = teachingChat("check");
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText("{\"introduced\":[{\"term\":\"slope\",\"gloss\":\"rise over run\"}],\"unexplained\":[{\"term\":\"Hessian\",\"where\":\"in the curvature sentence\"}],\"learnerUsed\":[\"gradient descent\"]}")])]);
		let prompt = "";
		const streamFn: StreamFunction = (m, c, o) => { prompt = JSON.stringify(c.messages); return faux.streamSimple(m, c, o); };
		const ok = await runVocabularyCheck(id, { chatStore, engine: () => ({ model: faux.getModel(), streamFn }), canStart: () => true });
		assert.equal(ok, true);
		assert.match(prompt, /THE TUTOR.S NEWEST TEACHING/); assert.match(prompt, /Hessian tells us/); assert.match(prompt, /teach me gradient descent/);
		const v = chatStore.getChat(id)!.vocabulary!;
		assert.deepEqual(v.terms.map((t) => [t.term, t.source]).sort(), [["gradient descent", "known"], ["slope", "taught"]]);
		assert.deepEqual(v.flagged.map((f) => f.term), ["Hessian"]);
		assert.equal(v.checkedThrough, "a2");
		// nothing new since → no model call
		const again = await runVocabularyCheck(id, { chatStore, engine: () => { throw new Error("must not be asked"); }, canStart: () => true });
		assert.equal(again, false);
	});
	it("skips with no model, or when background use is off", async () => {
		const id = teachingChat("check skip");
		assert.equal(await runVocabularyCheck(id, { chatStore, engine: () => undefined, canStart: () => true }), false);
		const faux = createFauxCore({});
		assert.equal(await runVocabularyCheck(id, { chatStore, engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }), canStart: () => false }), false);
		assert.equal(chatStore.getChat(id)!.vocabulary, undefined);
	});
});

describe("lesson notes reach the teacher on its next turn", () => {
	it("a learner's message carries the waiting flags and side questions after it, model-facing only, then they are cleared", async () => {
		const pid = "vocab-fixture";
		const faux = createFauxCore({});
		const entry = { ...faux.getModel(), provider: pid, id: "m" };
		let seen = "";
		const stream: StreamFunction = (m, c, o) => { seen = JSON.stringify(c.messages); return faux.streamSimple(m, c, o); };
		piModels().setProvider(createProvider({ id: pid, models: [entry], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
		writeSettings({ version: 1, graph: { enabled: false }, models: { strong: { model: { provider: pid, id: "m" } } } });
		const id = teachingChat("notes");
		chatStore.updateVocabulary!(id, (v) => {
			v.flagged.push({ term: "Hessian", where: "in the curvature sentence", at: "t" });
			v.sideQuestions.push({ chatId: "chat_side", term: "steepest ascent", at: "t" });
		});
		faux.setResponses([fauxAssistantMessage([fauxText("Fair — the Hessian is…")])]);
		const res = await handleChatInput(id, { type: "text", text: "what is the curvature?" }, (options) => createTeacherAgent(undefined, { ...options, tools: { noop: { name: "noop", label: "noop", description: "fixture", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }) } } }));
		assert.equal(res.status, 200, await res.clone().text());
		const handle = runningTurn(id); if (handle) await new Response(handle.subscribe()).text();
		const r = chatStore.getChat(id)!;
		const i = r.messages.findIndex((m) => (m as { customType?: string }).customType === "lesson-notes");
		assert.ok(i > 0, "the notes marker is in the record");
		assert.equal((r.messages[i - 1] as { role: string }).role, "user", "right after the learner's message");
		assert.match(seen, /\[Lesson notes\][\s\S]*Hessian[\s\S]*steepest ascent/, "the model saw the notes");
		assert.deepEqual(r.vocabulary!.flagged, []); assert.deepEqual(r.vocabulary!.sideQuestions, []);
		// the transcript never shows it; the model gets it as user text
		assert.ok(!JSON.stringify(projectView(r.messages)).includes("[Lesson notes]"));
		assert.ok(JSON.stringify(toLlmMessages(r.messages as never)).includes("[Lesson notes]"));
		piModels().deleteProvider(pid);
	});
});
