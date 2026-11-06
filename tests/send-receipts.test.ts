/**
 * SEND RECEIPTS (src/server/send-receipts.ts): the server's "I am holding a
 * send for this chat" flag behind the GET record's sendPending — counted per
 * chat (a retry can overlap the first POST), released exactly once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendPending, sendReceived } from "../src/server/send-receipts.ts";

describe("send receipts", () => {
	it("a received send is pending until answered", () => {
		assert.equal(sendPending("chat_r1"), false);
		const answered = sendReceived("chat_r1");
		assert.equal(sendPending("chat_r1"), true);
		answered();
		assert.equal(sendPending("chat_r1"), false);
	});

	it("overlapping sends count; each release is once only", () => {
		const a = sendReceived("chat_r2"), b = sendReceived("chat_r2");
		a(); a();
		assert.equal(sendPending("chat_r2"), true, "a double release must not free the other send");
		b();
		assert.equal(sendPending("chat_r2"), false);
	});

	it("chats are separate", () => {
		const a = sendReceived("chat_r3");
		assert.equal(sendPending("chat_r4"), false);
		a();
	});
});
