/**
 * The page-level crypto.randomUUID shim (2026-11-10): plain-http pages have no
 * randomUUID, so it is built from getRandomValues before anything else runs.
 * The shim is inline source, so it is evaluated in a bare context here, the
 * way a browser would.
 */

import assert from "node:assert/strict";
import * as vm from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";
import { RANDOM_UUID_SHIM } from "../lib/secure-context-shim.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What a plain-http page has: getRandomValues, no randomUUID. */
function insecureCrypto() {
	return { getRandomValues: (array: Uint8Array) => webcrypto.getRandomValues(array) } as { getRandomValues: (a: Uint8Array) => Uint8Array; randomUUID?: () => string };
}

function run(window: unknown) {
	vm.runInNewContext(RANDOM_UUID_SHIM, { window, Uint8Array });
}

describe("randomUUID shim", () => {
	it("gives a plain-http page a v4 randomUUID", () => {
		const crypto = insecureCrypto();
		assert.equal(crypto.randomUUID, undefined);
		run({ crypto });
		assert.equal(typeof crypto.randomUUID, "function");
		const ids = new Set(Array.from({ length: 200 }, () => crypto.randomUUID!()));
		assert.equal(ids.size, 200, "ids do not repeat");
		for (const id of ids) assert.match(id, UUID_V4);
	});

	it("leaves a page that already has randomUUID alone", () => {
		const own = () => "native";
		const crypto = { ...insecureCrypto(), randomUUID: own };
		run({ crypto });
		assert.equal(crypto.randomUUID, own);
	});

	it("does nothing, and does not throw, with no crypto or no getRandomValues", () => {
		assert.doesNotThrow(() => run({}));
		assert.doesNotThrow(() => run({ crypto: {} }));
		assert.doesNotThrow(() => vm.runInNewContext(RANDOM_UUID_SHIM, {}), "no window at all (server render)");
	});

	it("survives a frozen crypto object", () => {
		const crypto = Object.freeze(insecureCrypto());
		assert.doesNotThrow(() => run({ crypto }));
	});
});
