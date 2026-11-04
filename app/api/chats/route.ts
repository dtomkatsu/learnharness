import { chainsForSelection, formatChainLine, termItem } from "@/src/core";
import { newGraphContextMessage, type GraphContextPick } from "@/src/core";
import { appendEvidence, compactionInFlight, createChat, getChat, isTurnRunning, listChats, readSettingsRecord, stores, titleFromPrompt } from "@/src/server";
import type { ChatListItem } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; graphContext?: unknown; parent?: unknown };
	const title = typeof body.title === "string" ? body.title : "";
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	const kind = body.kind === "practice" ? ("practice" as const) : undefined;
	// A side thread (2026-11): { parent: { id, term? } } files the new session
	// under the session it was asked from. The parent must exist — a link to
	// nothing is refused rather than stored.
	let parent: { id: string; term?: string } | undefined;
	if (body.parent !== undefined) {
		const p = body.parent as { id?: unknown; term?: unknown };
		if (typeof p !== "object" || p === null || typeof p.id !== "string" || !getChat(p.id)) {
			return Response.json({ error: "parent must name an existing session" }, { status: 400 });
		}
		const term = typeof p.term === "string" ? p.term.trim().slice(0, 200) : "";
		parent = term ? { id: p.id, term } : { id: p.id };
	}
	const chat = createChat(titleFromPrompt(title || "Untitled session"), kind, parent);
	// The lesson it was asked from hears of it (2026-11): the term waits on
	// that lesson's vocabulary ledger and reaches its teacher as a note at
	// the start of its next turn — a side question is a gap in the lesson.
	if (parent) {
		try {
			const term = parent.term || chat.title;
			stores.chatStore.updateVocabulary?.(parent.id, (v) => {
				v.sideQuestions.push({ chatId: chat.id, term, at: new Date().toISOString() });
			});
			// …and to the learner model: an asked term is reviewable, first in line.
			appendEvidence([{ kind: "asked", itemId: termItem(term), term, chatId: parent.id, sideChatId: chat.id } as never]);
		} catch (err) {
			console.error(`[chat ${parent.id}] side-question note failed:`, err);
		}
	}
	// PER-SESSION MODELS (owner, 2026-09-28): a session owns its model +
	// thinking level from birth — stamped verbatim from the STRONG slot,
	// the new-session default. From here the strong slot never reaches
	// this session again: in-session picks write the session's own record
	// (PUT /api/chats/:id/settings). No strong slot configured (fresh BYOK
	// boot) → no stamp; the turn gate's 503 models_not_configured envelope
	// refuses honestly until the setup flow fills the slot.
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	// The session's map context (owner, 2026-10-04): the picked
	// propositions ride the CREATION — message[0] is a graph-context
	// marker (a separate custom message BEFORE the learner's first user
	// message), carrying the picks plus the reasoning chains among them.
	// The picks carry their own name/statement (what the learner saw at
	// pick time); the chains derive from the CURRENT graph snapshot.
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
					.slice(0, 64)
			: [];
	if (picks.length > 0) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		stores.chatStore.saveMessages(chat.id, [newGraphContextMessage(picks, chainLines)]);
	}
	return Response.json({ id: chat.id, title: chat.title, ...(chat.parent ? { parent: chat.parent } : {}) });
}
