/**
 * SEND RECEIPTS (src/server/send-receipts.ts): what the server knows of each
 * tagged send — held, answered (accepted), or cancelled unseen by the
 * client's watchdog — and the per-chat "holding a send" flag.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cancelSend, sendPending, sendReceived, sendState } from "../src/server/send-receipts.ts";

const begin = (chat: string, id?: string) => {
	const r = sendReceived(chat, id);
	assert.ok("answered" in r, `expected a fresh send, got ${JSON.stringify(r)}`);
	return r.answered;
};

describe("send receipts", () => {
	it("held while running, answered once accepted", () => {
		const done = begin("c1", "s1");
		assert.equal(sendState("c1", "s1"), "held");
		assert.equal(sendPending("c1"), true);
		done(200);
		assert.equal(sendState("c1", "s1"), "answered");
		assert.equal(sendPending("c1"), false);
	});

	it("a refused send (409 and the like) is forgotten, so the identity retry may resend its id", () => {
		begin("c2", "s2")(409);
		assert.equal(sendState("c2", "s2"), null);
		begin("c2", "s2")(200);
		assert.equal(sendState("c2", "s2"), "answered");
	});

	it("an answered or held send arriving again is refused, never run twice", () => {
		begin("c3", "s3")(200);
		assert.deepEqual(sendReceived("c3", "s3"), { refused: "answered" });
		const done = begin("c3", "s4");
		assert.deepEqual(sendReceived("c3", "s4"), { refused: "held" });
		done(200);
	});

	it("a cancel of an unseen send makes the send refused if it turns up later", () => {
		assert.equal(cancelSend("c4", "s5"), "cancelled");
		assert.deepEqual(sendReceived("c4", "s5"), { refused: "cancelled" });
	});

	it("a cancel of a send already held or answered says so and changes nothing", () => {
		const done = begin("c5", "s6");
		assert.equal(cancelSend("c5", "s6"), "held");
		done(200);
		assert.equal(cancelSend("c5", "s6"), "answered");
		assert.equal(sendState("c5", "s6"), "answered");
	});

	it("ids are per chat; untagged sends still count as pending", () => {
		begin("c6", "s7")(200);
		assert.equal(sendState("c7", "s7"), null);
		const done = begin("c8");
		assert.equal(sendPending("c8"), true);
		done(200); done(200);
		assert.equal(sendPending("c8"), false);
	});
});
