/**
 * The after-turn vocabulary check (2026-11): after a teaching turn settles,
 * one cheap model call reads the teaching the check has not seen yet and
 * sorts its technical terms — taught here (recorded on the ledger), used
 * before they were taught (flagged), or the learner's own (known). Flags wait
 * on the ledger and reach the teacher as a lesson-notes marker at the start
 * of its next turn (chat-handler). Fire-and-forget like extraction: never
 * blocks the turn, one run per chat at a time, skipped under tests (tests
 * call runVocabularyCheck directly with a scripted engine).
 */
import { runSubagent } from "../agent/subagents/pi-run.ts";
import type { PiEngine } from "../agent/models.ts";
import type { ChatStore } from "../core/ports.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { addFlags, addTerms, parseVocabularyReply, VOCABULARY_CHECK_PROMPT, vocabularyCheckInput } from "../core/vocabulary.ts";

export interface VocabularyCheckDeps {
	chatStore: ChatStore;
	/** The checker's engine (the auditor role's — the cheap slot); undefined = not configured. */
	engine: () => PiEngine | undefined;
	/** Whether a background call may go to this provider now (key present, background use allowed). */
	canStart: (provider: string) => boolean;
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
			const args = (b.arguments ?? {}) as { question?: unknown; options?: unknown; explanation?: unknown; questions?: unknown };
			const opts = Array.isArray(args.options) ? args.options.map((o: any) => (typeof o === "string" ? o : o?.label)).filter(Boolean) : [];
			out.push(["Question: " + String(args.question ?? ""), opts.length ? "Options: " + opts.join(" | ") : "", args.explanation ? "Explanation: " + String(args.explanation) : ""].filter(Boolean).join("\n"));
		}
	}
	return out.join("\n\n");
}

/** What the learner wrote: their messages and their answers to questions. */
function learnerTextOf(m: LhMessage): string {
	const x = m as unknown as { role: string; content: Block[] | string; toolName?: string; customType?: string };
	const text = (c: Block[] | string) => (typeof c === "string" ? c : c.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n"));
	if (x.role === "user") return text(x.content);
	if (x.role === "toolResult" && x.toolName && QUESTIONS.has(x.toolName)) return text(x.content);
	return "";
}

export function triggerVocabularyCheck(chatId: string, deps: VocabularyCheckDeps): void {
	if (process.env.NODE_ENV === "test") return;
	if (running.has(chatId)) return;
	running.add(chatId);
	void runVocabularyCheck(chatId, deps)
		.catch((err) => console.error(`[chat ${chatId}] vocabulary check failed:`, err))
		.finally(() => running.delete(chatId));
}

/** One check over the teaching since the last. Resolves true when the ledger took a reply. */
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
	const teaching = taught.map(teachingTextOf).join("\n\n---\n\n").slice(-14000);
	const learner = msgs.slice(-60).map(learnerTextOf).filter(Boolean).join("\n").slice(-4000);
	const { text } = await runSubagent([], {
		role: "auditor",
		engine,
		systemPrompt: VOCABULARY_CHECK_PROMPT,
		prompt: vocabularyCheckInput(record.vocabulary, learner, teaching),
		maxTurns: 1,
		chatId,
	});
	const reply = parseVocabularyReply(text);
	const at = new Date().toISOString();
	deps.chatStore.updateVocabulary(chatId, (v) => {
		if (reply) {
			addTerms(v, reply.learnerUsed.map((term) => ({ term, gloss: "", source: "known" as const, at })));
			addTerms(v, reply.introduced.map((t) => ({ term: t.term, gloss: t.gloss, source: "taught" as const, messageId: lastAssistant.id, at })));
			addFlags(v, reply.unexplained.map((u) => ({ term: u.term, where: u.where, messageId: lastAssistant.id, at })));
		}
		v.checkedThrough = lastAssistant.id;
	});
	if (!reply) console.info(`[chat ${chatId}] vocabulary check: unreadable reply (${text.slice(0, 120)})`);
	return !!reply;
}

