/**
 * Browser-only mode (`npm run dev` / `npm start`) has no desktop secret, so
 * the API is guarded by where it listens, a Host check against DNS rebinding,
 * and a cross-site check on writes. None of this is user authentication.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";
import { browserAPIRefusal, browserHostAllowed, browserOnlyMode, browserOriginNameAllowed } from "../src/server/desktop-access.ts";

const secret = "a".repeat(64);

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return run();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const browserEnv = { LH_DESKTOP_SERVER: undefined, LH_DESKTOP_API_SECRET: undefined, LH_ALLOWED_HOSTS: undefined };

function request(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
	return new Request(url, init);
}

describe("browser-only Host check", () => {
	it("accepts localhost names and IP literals on any port", () => {
		for (const host of ["localhost:3000", "LOCALHOST", "app.localhost:3000", "127.0.0.1:3000", "[::1]:3000", "192.168.1.20:3000", "10.0.0.5"]) {
			assert.equal(browserHostAllowed(host, {}), true, host);
		}
	});

	it("rejects other names, the shape a DNS-rebinding page arrives with", () => {
		for (const host of ["rebind.attacker.example:3000", "mymac.local:3000", "localhost.attacker.example", "127.0.0.1.nip.io:3000", "", null]) {
			assert.equal(browserHostAllowed(host, {}), false, String(host));
		}
	});

	it("LH_ALLOWED_HOSTS adds exact names, case-insensitive, port ignored, no wildcards", () => {
		const env = { LH_ALLOWED_HOSTS: " mymac.local, Proxy.Example.com ," };
		assert.equal(browserHostAllowed("mymac.local:3000", env), true);
		assert.equal(browserHostAllowed("proxy.example.com", env), true);
		assert.equal(browserHostAllowed("sub.proxy.example.com", env), false);
		assert.equal(browserHostAllowed("other.example.com", env), false);
	});
});

describe("browser-only cross-site check", () => {
	const api = "http://localhost:3000/api/chats";

	it("refuses every request with a disallowed Host, reads included", () => {
		const refusal = browserAPIRefusal(request("http://rebind.attacker.example:3000/api/settings"), {});
		assert.match(refusal ?? "", /LH_ALLOWED_HOSTS/);
	});

	it("leaves reads alone, since a cross-site page cannot read the response", () => {
		for (const method of ["GET", "HEAD", "OPTIONS"]) {
			assert.equal(browserAPIRefusal(request(api, { method, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), {}), undefined, method);
		}
	});

	it("refuses writes another site or an opaque origin sends", () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			for (const headers of [
				{ origin: "https://evil.example", "sec-fetch-site": "cross-site" },
				{ "sec-fetch-site": "cross-site" },
				{ "sec-fetch-site": "same-site" },
				{ origin: "https://evil.example" },
				{ origin: "null" },
				{ origin: "http://localhost:3001" },
			] as Record<string, string>[]) {
				assert.match(browserAPIRefusal(request(api, { method, headers }), {}) ?? "", /Cross-site/, `${method} ${JSON.stringify(headers)}`);
			}
		}
	});

	it("allows same-origin browser writes and header-less clients such as curl", () => {
		assert.equal(browserAPIRefusal(request(api, { method: "POST", headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" } }), {}), undefined);
		assert.equal(browserAPIRefusal(request(api, { method: "POST", headers: { origin: "http://localhost:3000" } }), {}), undefined);
		assert.equal(browserAPIRefusal(request(api, { method: "POST" }), {}), undefined);
	});
});

/** Fork (2026-11): the tablet reaches this server through a forwarder that keeps the page's
 * own Origin (https://name:9750) while the request arrives for loopback, and through an https
 * front that ends TLS. Names the owner listed in LH_ALLOWED_HOSTS count as same-origin. */
describe("origins on a listed host name", () => {
	const env = { LH_ALLOWED_HOSTS: "devin-mini.example.ts.net, Mini.Example.TS.net" };
	const tunnelled = "http://127.0.0.1:3010/api/chat";

	it("accepts the page's own origin on any scheme or port, however the request arrives", () => {
		for (const origin of ["https://devin-mini.example.ts.net:9750", "https://devin-mini.example.ts.net:9810", "http://devin-mini.example.ts.net:8750", "https://mini.example.ts.net"]) {
			for (const url of [tunnelled, "http://devin-mini.example.ts.net:3010/api/chat"]) {
				assert.equal(browserAPIRefusal(request(url, { method: "POST", headers: { origin, "sec-fetch-site": "same-origin" } }), env), undefined, `${origin} -> ${url}`);
				assert.equal(browserAPIRefusal(request(url, { method: "POST", headers: { origin } }), env), undefined, `${origin} (no Sec-Fetch-Site) -> ${url}`);
			}
		}
	});

	it("still refuses what the browser itself calls cross-site, on a listed name or not", () => {
		for (const headers of [
			{ origin: "https://devin-mini.example.ts.net:9750", "sec-fetch-site": "cross-site" },
			{ origin: "https://devin-mini.example.ts.net:9750", "sec-fetch-site": "same-site" },
			{ origin: "https://evil.example", "sec-fetch-site": "same-origin" },
		] as Record<string, string>[]) {
			assert.match(browserAPIRefusal(request(tunnelled, { method: "POST", headers }), env) ?? "", /Cross-site/, JSON.stringify(headers));
		}
	});

	it("covers only listed names: unlisted hosts, lookalikes, localhost and IP origins, an opaque origin", () => {
		for (const origin of ["https://other.example.ts.net:9750", "https://devin-mini.example.ts.net.evil.example", "https://evil-devin-mini.example.ts.net", "http://localhost:3001", "http://127.0.0.1:3001", "http://192.168.1.20:3010", "null", ""]) {
			assert.equal(browserOriginNameAllowed(origin, env), false, origin);
			assert.match(browserAPIRefusal(request(tunnelled, { method: "POST", headers: { origin } }), env) ?? "", /Cross-site/, origin);
		}
	});

	it("changes nothing when no host names are listed", () => {
		assert.equal(browserOriginNameAllowed("https://devin-mini.example.ts.net:9750", {}), false);
		assert.match(browserAPIRefusal(request(tunnelled, { method: "POST", headers: { origin: "https://devin-mini.example.ts.net:9750" } }), {}) ?? "", /Cross-site/);
	});

	it("leaves the Host check alone: an origin on a listed name does not make an unlisted Host acceptable", () => {
		const refusal = browserAPIRefusal(request("http://rebind.attacker.example:3010/api/chat", { method: "POST", headers: { origin: "https://devin-mini.example.ts.net:9750" } }), env);
		assert.match(refusal ?? "", /LH_ALLOWED_HOSTS/);
	});
});

describe("proxy", () => {
	it("applies the browser checks only when there is no desktop secret", () => {
		assert.equal(browserOnlyMode({}), true);
		assert.equal(browserOnlyMode({ LH_DESKTOP_SERVER: "1" }), false);
		assert.equal(browserOnlyMode({ LH_DESKTOP_API_SECRET: secret }), false);
	});

	it("blocks cross-site writes and rebinding hosts in browser-only mode", () => {
		withEnv(browserEnv, () => {
			const csrf = proxy(new NextRequest("http://localhost:3000/api/chats", { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" } }));
			assert.equal(csrf.status, 403);
			assert.equal(proxy(new NextRequest("http://rebind.attacker.example:3000/api/settings")).status, 403);
			const ok = proxy(new NextRequest("http://localhost:3000/api/chats", { method: "POST", headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" } }));
			assert.equal(ok.headers.get("x-middleware-next"), "1");
		});
	});

	it("keeps the desktop path unchanged: the secret decides, not Host or Origin", () => {
		withEnv({ LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret, LH_ALLOWED_HOSTS: undefined }, () => {
			const viaGateway = proxy(new NextRequest("http://mymac.local:4747/api/chats", { method: "POST", headers: { "x-learnharness-desktop": secret } }));
			assert.equal(viaGateway.headers.get("x-middleware-next"), "1");
			assert.equal(proxy(new NextRequest("http://127.0.0.1:3000/api/chats", { method: "POST" })).status, 403);
		});
	});
});

describe("package scripts", () => {
	it("serve on loopback unless the developer passes a later -H", () => {
		const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: { dev: string; start: string; "desktop:dev": string } };
		assert.match(scripts.dev, /^npm run plugins:build-core && npm run plugins:build-authoring && next dev -H localhost\b/);
		assert.match(scripts.start, /^next start -H localhost\b/);
		assert.match(scripts["desktop:dev"], /"npm run dev"/);
	});
});
