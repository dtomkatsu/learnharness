/**
 * Sends the server has received, per send id (2026-11-06). The client's
 * no-ack watchdog (components/session-core.ts postAcknowledged) tags each
 * POST /api/chat with a sendId and, when the ack is late, asks about THAT
 * send instead of guessing from the record: held (arrived, not yet answered
 * — a compaction or catalog refresh can hold it for a while), answered
 * (accepted: the input is written), or never seen. Before it tells the
 * learner a send was lost it cancels it here: a send cancelled unseen is
 * refused if it arrives later (no duplicate when they send it again), and a
 * cancel that finds it held or answered turns the verdict around.
 *
 * Only accepted sends stay "answered": a refused POST (409, 4xx, 5xx — the
 * write-ahead only happens on acceptance) forgets its id, so the 409
 * identity-retry may send the same id again.
 *
 * Also counted per chat (sendPending) for sends of any client, tagged or not.
 * On globalThis for the reason turn-liveness.ts gives: each route is its own
 * module instance. Ephemeral by design — a restart forgets every send, and
 * entries expire after SEND_TTL_MS so a wedged handler cannot hold a chat
 * "pending" for good.
 */

export type SendState = "held" | "answered" | "cancelled";

interface Entry { chatId: string; state: SendState; at: number }
interface Store { sends: Map<string, Entry>; pending: Map<string, Map<number, number>>; seq: number }
interface LhGlobal { __lhSendReceipts?: Store }

export const SEND_TTL_MS = 15 * 60_000;

function store(): Store {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhSendReceipts ??= { sends: new Map(), pending: new Map(), seq: 0 });
}

function prune(s: Store, now: number): void {
	for (const [id, e] of s.sends) if (now - e.at > SEND_TTL_MS) s.sends.delete(id);
	for (const [chat, held] of s.pending) {
		for (const [k, at] of held) if (now - at > SEND_TTL_MS) held.delete(k);
		if (held.size === 0) s.pending.delete(chat);
	}
}

/**
 * A send for the chat has arrived. Returns `refused` when its id was already
 * seen (cancelled, held, or answered) — the route answers without running it
 * again — else a function to call once with the answer's HTTP status.
 */
export function sendReceived(chatId: string, sendId?: string): { refused: SendState } | { answered: (status: number) => void } {
	const s = store(), now = Date.now();
	prune(s, now);
	if (sendId) {
		const seen = s.sends.get(sendId);
		if (seen && seen.chatId === chatId) return { refused: seen.state };
		s.sends.set(sendId, { chatId, state: "held", at: now });
	}
	const k = ++s.seq;
	const held = s.pending.get(chatId) ?? new Map<number, number>();
	held.set(k, now);
	s.pending.set(chatId, held);
	let done = false;
	return {
		answered: (status: number) => {
			if (done) return;
			done = true;
			const h = s.pending.get(chatId);
			if (h) { h.delete(k); if (h.size === 0) s.pending.delete(chatId); }
			if (!sendId) return;
			if (status >= 200 && status < 300) s.sends.set(sendId, { chatId, state: "answered", at: Date.now() });
			else s.sends.delete(sendId);
		},
	};
}

/** What the server knows of one send: null when never seen (or forgotten). */
export function sendState(chatId: string, sendId: string): SendState | null {
	const s = store();
	prune(s, Date.now());
	const e = s.sends.get(sendId);
	return e && e.chatId === chatId ? e.state : null;
}

/** Cancel a send the client is about to call lost. Returns its state after:
 *  "cancelled" (never seen — it will be refused if it arrives), or the state
 *  it already had (held / answered: not lost after all). */
export function cancelSend(chatId: string, sendId: string): SendState {
	const s = store(), now = Date.now();
	prune(s, now);
	const e = s.sends.get(sendId);
	if (e && e.chatId === chatId) return e.state;
	s.sends.set(sendId, { chatId, state: "cancelled", at: now });
	return "cancelled";
}

/** Whether the server is holding any send for the chat right now. */
export function sendPending(chatId: string): boolean {
	const s = store();
	prune(s, Date.now());
	return (s.pending.get(chatId)?.size ?? 0) > 0;
}
