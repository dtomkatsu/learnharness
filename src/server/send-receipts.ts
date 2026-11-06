/**
 * Sends received but not yet answered, per chat (2026-11-06). The client's
 * no-ack watchdog (components/session-core.ts postAcknowledged) asks the
 * record whether a send it has waited on is still on its way; this is the
 * server's half of the answer: "it is here, I am holding it" (a compaction,
 * a subscription catalog refresh — waits that show nowhere else), so a send
 * the server holds is never called lost, and a send it never saw is.
 *
 * On globalThis for the reason turn-liveness.ts gives: each route is its
 * own module instance, and POST /api/chat must be seen by GET
 * /api/chats/[id]. Ephemeral by design — a restart answers every send.
 */

interface LhGlobal {
	__lhSendReceipts?: Map<string, number>;
}

function receipts(): Map<string, number> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhSendReceipts ??= new Map<string, number>());
}

/** A send for the chat has arrived; call the returned function once it is answered. */
export function sendReceived(chatId: string): () => void {
	const map = receipts();
	map.set(chatId, (map.get(chatId) ?? 0) + 1);
	let done = false;
	return () => {
		if (done) return;
		done = true;
		const n = (map.get(chatId) ?? 1) - 1;
		if (n > 0) map.set(chatId, n);
		else map.delete(chatId);
	};
}

/** Whether the server is holding a send for the chat right now. */
export function sendPending(chatId: string): boolean {
	return (receipts().get(chatId) ?? 0) > 0;
}
