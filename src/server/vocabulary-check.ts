/**
 * The after-turn check (2026-11): after every turn settles, the lesson's new
 * evidence is logged for the learner model and, on teaching turns, one cheap
 * model call reads the new teaching.
 *
 *   1. Deterministic, every turn, no model: each answered question and each
 *      concluded practice problem becomes an evidence event (server/learner.ts).
 *   2. Teaching turns, one cheap call: the new teaching's terms are sorted —
 *      taught here (ledger + evidence), used before they were taught (flagged
 *      for the teacher's next turn), or the learner's own; explain answers get
 *      a verdict from the tutor's reply; a missed answer's reasoning that states
 *      a specific wrong belief becomes a misconception; the learner's own use of
 *      held terms (right or wrong) and drift in a term's meaning are recorded.
 *
 * Fire-and-forget like extraction: never blocks the turn, one run per chat at
 * a time, skipped under tests (tests call runAfterTurn / runVocabularyCheck).
 */
import { runSubagent } from "../agent/subagents/pi-run.ts";
import type { PiEngine } from "../agent/models.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { addFlags, addTerms, heldTerms, normTerm, parseVocabularyReply, VOCABULARY_CHECK_PROMPT, vocabularyCheckInput } from "../core/vocabulary.ts";
import { termItem, type LearnerEvent } from "../core/learner/model.ts";
import { appendEvidence, readEvidence } from "../store/learner.ts";
import { logRecordEvidence, loggedCallIds, missedWithThinking, tidySoon, unjudgedAnswers } from "./learner.ts";

export interface VocabularyCheckDeps {
	chatStore: ChatStore;
	/** The checker's engine (the auditor role's — the cheap slot); undefined = not configured. */
	engine: () => PiEngine | undefined;
	/** Whether a background call may go to this provider now (key present, background use allowed). */
	canStart: (provider: string) => boolean;
	graphStore?: Pick<GraphStore, "readNodes" | "readChains">;
}

const QUESTIONS = new Set<string>(QUESTION_TOOLS);
const running = new Set<string>();

type Block = { type: string; text?: string; name?: string; arguments?: unknown };

/** What an assistant message teaches, as text: its prose and its questions (stem, options, explanation). */
function teachingTextOf(m: LhMessage): string {
	const a = m as unknown as { role: string; content: Block[] | string; stopReason?: string };
	if (a.role !== "assistant" || a.stopReason === "error" || a.stopReason === "aborted" || !Array.isArray(a.content)) return "";
	const out: string[] = [];
	for (const b of a.content) {
		if (b.type === "text" && b.text) out.push(b.text);
		else if (b.type === "toolCall" && b.name && QUESTIONS.has(b.name)) {
			const args = (b.arguments ?? {}) as { question?: unknown; options?: unknown; explanation?: unknown };
			const opts = Array.isArray(args.options) ? args.options.map((o: any) => (typeof o === "string" ? o : o?.label)).filter(Boolean) : [];
			out.push(["Question: " + String(args.question ?? ""), opts.length ? "Options: " + opts.join(" | ") : "", args.explanation ? "Explanation: " + String(args.explanation) : ""].filter(Boolean).join("\n"));
		}
	}
	return out.join("\n\n");
}

/** What the learner wrote: their messages and their answers to questions. */
function learnerTextOf(m: LhMessage): string {
	const x = m as unknown as { role: string; content: Block[] | string; toolName?: string };
	const text = (c: Block[] | string) => (typeof c === "string" ? c : c.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n"));
	if (x.role === "user") return text(x.content);
	if (x.role === "toolResult" && x.toolName && QUESTIONS.has(x.toolName)) return text(x.content);
	return "";
}

export function triggerVocabularyCheck(chatId: string, deps: VocabularyCheckDeps, teaching = true): void {
	if (process.env.NODE_ENV === "test") return;
	if (running.has(chatId)) return;
	running.add(chatId);
	void runAfterTurn(chatId, deps, teaching)
		.catch((err) => console.error(`[chat ${chatId}] after-turn check failed:`, err))
		.finally(() => running.delete(chatId));
}

/** Both halves: log the turn's evidence, then (teaching turns) the model check. */
export async function runAfterTurn(chatId: string, deps: VocabularyCheckDeps, teaching: boolean): Promise<boolean> {
	const record = deps.chatStore.getChat(chatId);
	if (!record) return false;
	try { logRecordEvidence(record, loggedCallIds()); }
	catch (err) { console.error(`[chat ${chatId}] evidence logging failed:`, err); }
	if (!teaching || record.kind === "practice") return false;
	return runVocabularyCheck(chatId, deps);
}

/** One model check over the teaching since the last. Resolves true when the ledger took a reply. */
export async function runVocabularyCheck(chatId: string, deps: VocabularyCheckDeps): Promise<boolean> {
	const record = deps.chatStore.getChat(chatId);
	if (!record || !deps.chatStore.updateVocabulary) return false;
	const msgs = record.messages;
	const seen = record.vocabulary?.checkedThrough;
	const from = seen ? msgs.findIndex((m) => m.id === seen) + 1 : 0;
	const fresh = msgs.slice(from);
	const taught = fresh.filter((m) => teachingTextOf(m));
	const lastAssistant = [...fresh].reverse().find((m) => (m as { role?: string }).role === "assistant");
	if (!lastAssistant) return false;
	if (taught.length === 0) {
		deps.chatStore.updateVocabulary(chatId, (v) => { v.checkedThrough = lastAssistant.id; });
		return false;
	}
	const engine = deps.engine();
	if (!engine) { console.info(`[chat ${chatId}] vocabulary check skipped — no model for the auditor role`); return false; }
	if (!deps.canStart(engine.model.provider)) { console.info(`[chat ${chatId}] vocabulary check skipped — background use is off for ${engine.model.provider}`); return false; }
	const events = readEvidence();
	const ungraded = unjudgedAnswers(record, events);
	const missed = missedWithThinking(chatId, record.vocabulary?.checkedAt, events);
	const answers = [
		...ungraded.map((a) => ({ id: a.toolCallId, question: a.question, answer: a.answer, thinking: a.thinking, graded: "ungraded" as const })),
		...missed.map((a) => ({ id: a.toolCallId, question: a.question, answer: "", thinking: a.thinking, graded: "missed" as const })),
	].slice(-12);
	const teaching = taught.map(teachingTextOf).join("\n\n---\n\n").slice(-14000);
	const learner = msgs.slice(-60).map(learnerTextOf).filter(Boolean).join("\n").slice(-4000);
	const { text } = await runSubagent([], {
		role: "auditor",
		engine,
		systemPrompt: VOCABULARY_CHECK_PROMPT,
		prompt: vocabularyCheckInput(record.vocabulary, learner, teaching, answers),
		maxTurns: 1,
		chatId,
	});
	const reply = parseVocabularyReply(text);
	const at = new Date().toISOString();
	const held = heldTerms(record.vocabulary);
	const answerItems = new Map(events.filter((e): e is Extract<LearnerEvent, { kind: "answer" }> => e.kind === "answer").map((e) => [e.toolCallId, e.items]));
	deps.chatStore.updateVocabulary(chatId, (v) => {
		if (reply) {
			addTerms(v, reply.learnerUsed.map((term) => ({ term, gloss: "", source: "known" as const, at })));
			addTerms(v, reply.introduced.map((t) => ({ term: t.term, gloss: t.gloss, source: "taught" as const, messageId: lastAssistant.id, at })));
			addFlags(v, reply.unexplained.map((u) => ({ term: u.term, where: u.where, messageId: lastAssistant.id, at })));
		}
		v.checkedThrough = lastAssistant.id;
		v.checkedAt = at;
	});
	if (reply) {
		const out: Omit<LearnerEvent, "id" | "at">[] = [];
		for (const t of reply.introduced) out.push({ kind: "taught", itemId: termItem(t.term), term: t.term, gloss: t.gloss, chatId, messageId: lastAssistant.id, ...(t.lang ? { lang: t.lang } : {}), ...(t.example ? { example: t.example, ...(t.exampleEn ? { exampleEn: t.exampleEn } : {}) } : {}) } as never);
		for (const u of reply.unexplained) if (!held.has(normTerm(u.term))) {
			out.push({ kind: "used-early", itemId: termItem(u.term), term: u.term, chatId, messageId: lastAssistant.id } as never);
			// a meaning for the glossary until the lesson gives one (a later "taught" gloss replaces it)
			if (u.meaning) out.push({ kind: "meaning", itemId: termItem(u.term), meaning: u.meaning.slice(0, 400), source: "model" } as never);
		}
		const isHeld = (t: string) => held.has(normTerm(t)) || reply.introduced.some((x) => normTerm(x.term) === normTerm(t));
		for (const t of reply.usedCorrectly) if (isHeld(t)) out.push({ kind: "use", itemId: termItem(t), term: t, correct: true, chatId } as never);
		for (const m of reply.misused) if (isHeld(m.term)) out.push({ kind: "use", itemId: termItem(m.term), term: m.term, correct: false, how: m.how, chatId } as never);
		for (const d of reply.drift) if (isHeld(d.term)) out.push({ kind: "drift", itemId: termItem(d.term), term: d.term, taughtAs: d.taughtAs, nowAs: d.nowAs, chatId } as never);
		const asked = new Set(answers.map((a) => a.id));
		for (const v of reply.verdicts) if (ungraded.some((a) => a.toolCallId === v.id)) out.push({ kind: "verdict", toolCallId: v.id, outcome: v.correct ? "correct" : "miss" } as never);
		for (const m of reply.misconceptions) {
			if (m.id && !asked.has(m.id)) continue;
			const items = m.term && isHeld(m.term) ? [termItem(m.term)] : answerItems.get(m.id) ?? [];
			if (items.length) out.push({ kind: "misconception", items, belief: m.belief, chatId, ...(m.id ? { toolCallId: m.id } : {}) } as never);
		}
		appendEvidence(out as never);
		if (deps.graphStore && (reply.introduced.length || reply.unexplained.length)) tidySoon({ chatStore: deps.chatStore, graphStore: deps.graphStore }, deps.engine());
	}
	if (!reply) console.info(`[chat ${chatId}] vocabulary check: unreadable reply (${text.slice(0, 120)})`);
	return !!reply;
}
