import { handleChatRequest, sendReceived } from "@/src/server";

// One line when a send arrives and one when it is answered: a send that hangs
// on "Thinking…" with neither line never reached the server (the browser held
// it); with only the first, the server is stuck on it. Between the two the
// chat's record says sendPending, so the client's watchdog keeps waiting.
export async function POST(req: Request) {
	const t0 = Date.now();
	let tag = "?";
	let answered = () => {};
	try {
		const b = JSON.parse(await req.clone().text()) as { chatId?: unknown; input?: { type?: unknown } };
		tag = `${String(b.chatId)} ${String(b.input?.type)}`;
		if (typeof b.chatId === "string" && b.chatId) answered = sendReceived(b.chatId);
	} catch { /* handleChatRequest answers the bad body */ }
	console.info(`[send] ${new Date(t0).toISOString()} ${tag} arrived`);
	try {
		const res = await handleChatRequest(req);
		console.info(`[send] ${tag} → ${res.status} in ${Date.now() - t0} ms`);
		return res;
	} catch (err) {
		console.info(`[send] ${tag} → threw in ${Date.now() - t0} ms`);
		throw err;
	} finally {
		answered();
	}
}
