/**
 * SIDE THREADS (2026-11): a session asked from another one carries
 * `parent: { id, term? }` from birth (absent = top level), the list carries
 * it, and nestChats orders a list so each session is followed by its
 * threads, indented by depth. Isolated LH_DATA_DIR, as chat-kind.test.ts.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-threads-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { nestChats } = await import("../src/core/side-threads.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("side threads", () => {
	it("a top-level session carries no parent field", () => {
		const chat = chatStore.createChat("lesson");
		assert.equal("parent" in chat, false);
	});

	it("createChat with a parent stamps it on the record and the list", () => {
		const lesson = chatStore.createChat("gradient descent");
		const side = chatStore.createChat("what is a gradient", undefined, { id: lesson.id, term: "gradient" });
		assert.deepEqual(side.parent, { id: lesson.id, term: "gradient" });
		assert.deepEqual(chatStore.getChat(side.id)?.parent, { id: lesson.id, term: "gradient" });
		assert.deepEqual(chatStore.listChats().find((c) => c.id === side.id)?.parent, { id: lesson.id, term: "gradient" });
	});

	it("an empty term is left out", () => {
		const lesson = chatStore.createChat("x");
		const side = chatStore.createChat("y", undefined, { id: lesson.id });
		assert.deepEqual(side.parent, { id: lesson.id });
	});

	it("nestChats puts threads under their session, in order, recursively", () => {
		const rows = nestChats([
			{ id: "b" },
			{ id: "a1", parent: { id: "a" } },
			{ id: "a" },
			{ id: "a1x", parent: { id: "a1" } },
			{ id: "a2", parent: { id: "a" } },
		]);
		assert.deepEqual(rows.map((r) => [r.chat.id, r.depth]), [["b", 0], ["a", 0], ["a1", 1], ["a1x", 2], ["a2", 1]]);
	});

	it("a thread whose parent is gone stands at the top level; a cycle loses nothing", () => {
		const rows = nestChats([{ id: "orphan", parent: { id: "deleted" } }, { id: "p", parent: { id: "q" } }, { id: "q", parent: { id: "p" } }]);
		assert.deepEqual(rows.map((r) => [r.chat.id, r.depth]).sort(), [["orphan", 0], ["p", 0], ["q", 1]].sort());
	});
});
