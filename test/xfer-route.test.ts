/**
 * The `/xfer` reverse proxy at the dispatch layer.
 *
 * Nothing here runs a real `dufs`: the file server is a stub `Bun.serve` that records
 * what the proxy handed it and answers from a table. That is deliberate — the question
 * this file answers is *what the proxy does to a request and its answer*, and every
 * interesting behavior (the internal credential replacing the caller's, the prefix
 * travelling unchanged, a 301 not being followed, `www-authenticate` not travelling
 * back) is invisible against a real server because a real server does the ordinary
 * thing. Byte-for-byte forwarding against the pinned `dufs` build is the host probes'
 * job (`test/obtain-probe.ts` §2, `test/install-probe.ts` §5).
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { BridgeDeps, XferRoute, XferRouteDeps } from "../src/server.ts";
import { startServer, XFER_ROUTE } from "../src/server.ts";

const TOKEN = "xfer-route-test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
/** The credential the share hands the proxy — internal, loopback, never for the caller. */
const INTERNAL = `Basic ${Buffer.from("omp:stub-secret").toString("base64")}`;

interface Seen {
	method: string;
	path: string;
	search: string;
	headers: Record<string, string>;
	body: string;
	n: number;
}

const seen: Seen[] = [];
/** Answer table: `METHOD /path` → what the stub returns. */
let table: Record<string, () => Response> = {};
/** Set when the stub should not answer at all (the share's port is gone). */
let unreachable = false;

const stub = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (req) => {
		const url = new URL(req.url);
		const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
		seen.push({
			method: req.method,
			path: url.pathname,
			search: url.search,
			headers: Object.fromEntries(req.headers),
			body,
			n: seen.length,
		});
		if (unreachable) return new Response(null, { status: 599 });
		const hit = table[`${req.method} ${url.pathname}${url.search}`] ?? table[`${req.method} ${url.pathname}`];
		return hit ? hit() : new Response("not found", { status: 404 });
	},
});
const stubPort = stub.port ?? 0;
const stubBase = `http://127.0.0.1:${stubPort}`;

let shared: XferRoute | null = { port: stubPort, baseUrl: stubBase, auth: INTERNAL };
const xfer: XferRouteDeps = { target: () => shared };

let callToolHits = 0;
function makeDeps(): BridgeDeps {
	return {
		async getTools() {
			return [];
		},
		async callTool() {
			callToolHits++;
			return { content: [{ type: "text", text: "stub" }], isError: false };
		},
		serverInfo: () => ({ name: "stub-server", version: "9.9.9" }),
		xfer,
	};
}

const bridge = await startServer(
	{
		port: 0,
		host: "127.0.0.1",
		token: TOKEN,
		host_llm: "allow" as const,
		xfer: { dufs: "dufs", cloudflared: "cloudflared" },
	},
	makeDeps(),
);
const base = `http://127.0.0.1:${bridge.port}/`;

function reset(): void {
	seen.length = 0;
	table = {};
	unreachable = false;
	shared = { port: stubPort, baseUrl: stubBase, auth: INTERNAL };
	callToolHits = 0;
}

const last = (): Seen => seen[seen.length - 1];

async function via(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
	return fetch(`${base}${path}`, { ...init, headers: { ...AUTH, ...(init.headers ?? {}) } });
}

describe("/xfer proxy — what reaches the file server", () => {
	test("a request through the route is reported to the share, with the bytes that crossed", async () => {
		// The audit records a share's opening and closing, not every GET and PUT in
		// between — one record per request would drown the log. The share keeps a
		// tally instead, and the proxy feeds it: "was this path touched, and how
		// much moved" is the question an operator asks about a public route.
		reset();
		const notes: Array<{ method: string; bytes: number }> = [];
		shared = {
			port: stubPort,
			baseUrl: stubBase,
			auth: INTERNAL,
			note: (u) => {
				notes.push(u);
			},
		};
		table["GET /xfer/a.bin"] = () => new Response("0123456789", { headers: { "content-length": "10" } });
		const res = await via("xfer/a.bin");
		expect(res.status).toBe(200);
		expect(notes).toEqual([{ method: "GET", bytes: 10 }]);
	});

	test("an upload is reported with the bytes that went in", async () => {
		reset();
		const notes: Array<{ method: string; bytes: number }> = [];
		shared = {
			port: stubPort,
			baseUrl: stubBase,
			auth: INTERNAL,
			note: (u) => {
				notes.push(u);
			},
		};
		table["PUT /xfer/up.bin"] = () => new Response(null, { status: 201 });
		const res = await via("xfer/up.bin", { method: "PUT", body: "hello" });
		expect(res.status).toBe(201);
		expect(notes).toEqual([{ method: "PUT", bytes: 5 }]);
	});

	test("a request that never reached the file server is not counted", async () => {
		// The upstream being gone is the share closing under a client; nothing
		// crossed, so nothing is counted.
		reset();
		const notes: Array<{ method: string; bytes: number }> = [];
		// The port belongs to nothing: what `close()` leaves behind for a client
		// whose share closed under it.
		shared = {
			port: 1,
			baseUrl: "http://127.0.0.1:1",
			auth: INTERNAL,
			note: (u) => {
				notes.push(u);
			},
		};
		const realError = console.error;
		console.error = () => {};
		const res = await via("xfer/gone.bin");
		console.error = realError;
		expect(res.status).toBe(502);
		expect(notes).toEqual([]);
	});

	test("the path is forwarded with the prefix intact, because the file server was told it", async () => {
		reset();
		table["GET /xfer/dir/file.txt"] = () => new Response("payload", { status: 200 });
		const res = await via("xfer/dir/file.txt");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("payload");
		expect(last().path).toBe(`${XFER_ROUTE}/dir/file.txt`);
	});

	test("the query string travels", async () => {
		reset();
		table["GET /xfer/?json"] = () => new Response('{"href":"/"}', { status: 200 });
		const res = await via("xfer/?json");
		expect(res.status).toBe(200);
		expect(last().search).toBe("?json");
	});

	test("the caller's credential is overwritten, not merged, and identity is forced", async () => {
		reset();
		table["GET /xfer/x.txt"] = () => new Response("x", { status: 200 });
		await via("xfer/x.txt", { headers: { authorization: `Bearer ${TOKEN}`, "accept-encoding": "gzip, br" } });
		const s = last();
		expect(s.headers.authorization).toBe(INTERNAL);
		expect(s.headers.authorization).not.toContain(TOKEN);
		// A gzipped body would keep the file server's content-length and etag while no
		// longer being those bytes.
		expect(s.headers["accept-encoding"]).toBe("identity");
		// The stub is on loopback; the caller's Host header names the public hostname.
		expect(s.headers.host).toBe(`127.0.0.1:${stubPort}`);
	});

	test("an upload's body and length arrive intact", async () => {
		reset();
		table["PUT /xfer/up.txt"] = () => new Response("", { status: 201 });
		const payload = "bytes that must not be re-encoded\n".repeat(400);
		const res = await via("xfer/up.txt", { method: "PUT", body: payload });
		expect(res.status).toBe(201);
		const s = last();
		expect(s.body).toBe(payload);
		expect(s.headers["content-length"]).toBe(String(Buffer.byteLength(payload)));
	});

	test("an append PATCH reaches the file server as itself, header and body intact", async () => {
		// The client proxy uploads its first chunk with PUT and every later chunk with
		// PATCH + X-Update-Range: append. If the route rewrote either half, dufs would
		// truncate the file or refuse the write, so this is pinned here.
		reset();
		table["PATCH /xfer/up.txt"] = () => new Response(null, { status: 204 });
		const payload = "appended after the first PUT\n";
		const res = await via("xfer/up.txt", {
			method: "PATCH",
			headers: { "x-update-range": "append", "content-type": "application/octet-stream" },
			body: payload,
		});
		expect(res.status).toBe(204);
		const s = last();
		expect(s.method).toBe("PATCH");
		expect(s.headers["x-update-range"]).toBe("append");
		expect(s.headers["content-type"]).toBe("application/octet-stream");
		expect(s.body).toBe(payload);
		expect(s.headers["content-length"]).toBe(String(Buffer.byteLength(payload)));
	});

	test("PUT/MOVE/PROPFIND are not gated by the MCP method list", async () => {
		reset();
		table["PROPFIND /xfer/"] = () =>
			new Response("<D:multistatus/>", { status: 207, headers: { "content-type": "application/xml" } });
		table["MOVE /xfer/a.txt"] = () => new Response("", { status: 405 });
		const pf = await via("xfer/", { method: "PROPFIND", headers: { depth: "1" } });
		expect(pf.status).toBe(207);
		expect(last().headers.depth).toBe("1");
		// Whatever the file server says about a verb it did not enable is forwarded.
		const mv = await via("xfer/a.txt", { method: "MOVE", headers: { destination: `${stubBase}/xfer/b.txt` } });
		expect(mv.status).toBe(405);
	});
});

describe("/xfer proxy — what comes back to the caller", () => {
	test("hop-by-hop and the file server's own 401 challenge are stripped", async () => {
		reset();
		table["GET /xfer/private.txt"] = () =>
			new Response("", {
				status: 401,
				headers: { "www-authenticate": 'Basic realm="DUFS"', connection: "keep-alive" },
			});
		const res = await via("xfer/private.txt");
		// Reachable only if the injected internal credential stops matching — which the
		// caller cannot fix, and a realm naming it would advertise.
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBeNull();
		expect(res.headers.get("connection")).toBeNull();
	});

	test("a redirect is reported, not followed", async () => {
		reset();
		table["GET /xfer/dir"] = () => new Response("", { status: 301, headers: { location: "/xfer/dir/" } });
		table["GET /xfer/dir/"] = () => new Response("index", { status: 200 });
		// `manual` on the caller's side too: a client that followed for itself would
		// resolve `/xfer/dir/` against the bridge and never show what the proxy answered.
		const res = await fetch(`${base}xfer/dir`, { headers: AUTH, redirect: "manual" });
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe("/xfer/dir/");
		// One upstream request: following would have made it two, and the second a GET.
		expect(seen.length).toBe(1);
	});

	test("status, headers and body of an ordinary answer pass through", async () => {
		reset();
		table["GET /xfer/big.bin"] = () =>
			new Response("abcdefg", {
				status: 206,
				headers: { "content-range": "bytes 0-6/99", "content-type": "application/octet-stream", etag: '"abc"' },
			});
		const res = await via("xfer/big.bin", { headers: { range: "bytes=0-6" } });
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe("bytes 0-6/99");
		expect(res.headers.get("etag")).toBe('"abc"');
		expect(await res.text()).toBe("abcdefg");
		expect(last().headers.range).toBe("bytes=0-6");
	});
});

describe("/xfer at the dispatch order", () => {
	test("an unauthenticated file request is 401 and the file server is never touched", async () => {
		reset();
		table["GET /xfer/x.txt"] = () => new Response("x", { status: 200 });
		const res = await fetch(`${base}xfer/x.txt`);
		expect(res.status).toBe(401);
		expect(seen.length).toBe(0);
	});

	test("with nothing shared the route is 404, and the answer names the tool to call", async () => {
		reset();
		shared = null;
		const res = await via("xfer/whatever");
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: string }).error).toContain("xfer_share");
		expect(seen.length).toBe(0);
	});

	test("POST /xfer is a file request, not a tool call", async () => {
		reset();
		// A caller that PUTs a JSON document would otherwise be read as JSON-RPC: the MCP
		// branch reads a body and ignores the pathname entirely.
		table["POST /xfer/echo"] = () => new Response("posted", { status: 200 });
		const res = await via("xfer/echo", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("posted");
		expect(callToolHits).toBe(0);
		expect(last().body).toContain("tools/list");
	});

	test("DELETE /xfer/f is a file delete and does not end the MCP session", async () => {
		reset();
		table["DELETE /xfer/f.txt"] = () => new Response("gone", { status: 403 });
		const init = await fetch(base, {
			method: "POST",
			headers: { "content-type": "application/json", ...AUTH },
			body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
		});
		const sid = init.headers.get("mcp-session-id");
		if (!sid) throw new Error("initialize failed");
		const del = await via("xfer/f.txt", { method: "DELETE" });
		// The DELETE branch ends a session on any path whatsoever, so a file delete that
		// fell through to it would answer 204 and silently evict an unrelated client.
		expect(del.status).toBe(403);
		expect(await del.text()).toBe("gone");
		expect(last().method).toBe("DELETE");
		const ping = await fetch(base, {
			method: "POST",
			headers: { "content-type": "application/json", ...AUTH, "mcp-session-id": sid },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(ping.status).toBe(200);
	});

	test("a sibling path is not the file route", async () => {
		reset();
		const get = await fetch(`${base}xfer-private`, { headers: AUTH });
		expect(get.status).toBe(405);
		// `initialize` rather than `ping`: the session gate answers 400 for a ping with no
		// session, and 400 here would look like the proxy having swallowed the path.
		const post = await fetch(`${base}xfer-private`, {
			method: "POST",
			headers: { "content-type": "application/json", ...AUTH },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect(post.status).toBe(200);
		expect(seen.length).toBe(0);
	});

	test("GET / keeps refusing with 405 while GET /xfer works", async () => {
		reset();
		table["GET /xfer/"] = () => new Response("<html>listing</html>", { status: 200 });
		expect((await fetch(base, { headers: AUTH })).status).toBe(405);
		const listing = await via("xfer/");
		expect(listing.status).toBe(200);
		expect(await listing.text()).toBe("<html>listing</html>");
	});

	test("HEAD gets the headers and no body", async () => {
		reset();
		table["HEAD /xfer/x.txt"] = () => new Response("", { status: 200, headers: { "x-size": "7" } });
		const res = await via("xfer/x.txt", { method: "HEAD" });
		expect(res.status).toBe(200);
		expect(res.headers.get("x-size")).toBe("7");
		expect(await res.text()).toBe("");
		expect(last().method).toBe("HEAD");
	});

	test("a file server that stopped answering is 502, with the reason kept off the wire", async () => {
		reset();
		// The port belongs to nothing: what `close()` leaves behind for a client whose
		// share closed under it (TTL, xfer_stop, or a bridge that is going away).
		shared = { port: 1, baseUrl: "http://127.0.0.1:1", auth: INTERNAL };
		const logged: string[] = [];
		const realError = console.error;
		console.error = (...args: unknown[]) => logged.push(args.join(" "));
		// The proxy answers 502 rather than throwing, so the restore below is reached.
		const res = await via("xfer/x.txt");
		console.error = realError;
		expect(res.status).toBe(502);
		const body = ((await res.json()) as { error: string }).error;
		expect(body).toContain("file server is not answering");
		expect(body).not.toContain("127.0.0.1");
		// The log is where the actionable half goes: which port refused, and in words.
		expect(logged.join(" ")).toContain("127.0.0.1:1");
		expect(logged.join(" ")).toContain("Unable to connect");
	});

	test("the MCP surface is unchanged while a share is live", async () => {
		reset();
		const init = await fetch(base, {
			method: "POST",
			headers: { "content-type": "application/json", ...AUTH },
			body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
		});
		const sid = init.headers.get("mcp-session-id");
		const list = await fetch(base, {
			method: "POST",
			headers: { "content-type": "application/json", ...AUTH, "mcp-session-id": sid ?? "" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(((await list.json()) as { result: { tools: unknown[] } }).result.tools).toEqual([]);
		expect(seen.length).toBe(0);
	});
});

// The stub answers on a port of its own; releasing both is what makes the next `bun
// test` run start clean.
afterAll(() => {
	bridge.stop();
	stub.stop(true);
});
