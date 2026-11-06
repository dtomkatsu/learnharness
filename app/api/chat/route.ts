import { cancelSend, handleChatRequest, sendReceived } from "@/src/server";

// One line when a send arrives and one when it is answered: a send that hangs
// on "Thinking…" with neither line never reached the server (the browser held
// it); with only the first, the server is stuck on it. Between the two the
// send is "held" (src/server/send-receipts.ts), which the client's watchdog
// asks about by its sendId; `{chatId, cancelSend}` is the watchdog cancelling
// a send it is about to call lost.
export async function POST(req: Request) {
	const t0 = Date.now();
	let tag = "?";
	let answered: (status: number) => void = () => {};
	try {
		const b = JSON.parse(await req.clone().text()) as { chatId?: unknown; input?: { type?: unknown }; sendId?: unknown; cancelSend?: unknown };
		const chatId = typeof b.chatId === "string" && b.chatId ? b.chatId : null;
		if (chatId && typeof b.cancelSend === "string" && b.cancelSend) {
			const state = cancelSend(chatId, b.cancelSend);
			console.info(`[send] ${chatId} cancel ${b.cancelSend} → ${state}`);
			return Response.json({ state });
		}
		const sendId = typeof b.sendId === "string" && b.sendId ? b.sendId : undefined;
		tag = `${String(b.chatId)} ${String(b.input?.type)}${sendId ? ` ${sendId}` : ""}`;
		if (chatId) {
			const r = sendReceived(chatId, sendId);
			if ("refused" in r) {
				// Seen before: cancelled by the watchdog (refuse, it was reported
				// lost), or already held/answered (never run an input twice).
				console.info(`[send] ${new Date(t0).toISOString()} ${tag} arrived again — ${r.refused}, not run`);
				return r.refused === "cancelled"
					? Response.json({ error: "This send was cancelled after it failed to arrive in time." }, { status: 410 })
					: Response.json({ ok: true, duplicate: true });
			}
			answered = r.answered;
		}
	} catch { /* handleChatRequest answers the bad body */ }
	console.info(`[send] ${new Date(t0).toISOString()} ${tag} arrived`);
	let status = 500;
	try {
		const res = await handleChatRequest(req);
		status = res.status;
		console.info(`[send] ${tag} → ${res.status} in ${Date.now() - t0} ms`);
		return res;
	} catch (err) {
		console.info(`[send] ${tag} → threw in ${Date.now() - t0} ms`);
		throw err;
	} finally {
		answered(status);
	}
}
