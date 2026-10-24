import { randomUUID } from "node:crypto";
import { auditHostLlm } from "./audit.ts";
import { authorize } from "./auth.ts";
import type { BridgeConfig } from "./config.ts";
import { BRIDGE_INSTRUCTIONS } from "./instructions.ts";
import type { HostLlmState } from "./takeover.ts";

export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/** The switch behind `POST /host-llm` — see src/takeover.ts for what arming costs. */
export interface TakeoverDeps {
	/**
	 * The takeover's own state type, imported rather than restated: the route
	 * forwards whatever comes back as the response body, so a narrower declaration
	 * here would quietly describe a shorter response than the one the operator
	 * reads (`degraded` was added to it and this signature still claimed two
	 * fields).
	 */
	setEnabled(enabled: boolean): HostLlmState;
}

export interface BridgeDeps {
	getTools(): Promise<McpTool[]>;
	callTool(name: string, args: unknown, sid: string | null): Promise<{ content: McpContent[]; isError: boolean }>;
	serverInfo(): { name: string; version: string };
	/** The caller-side proxy's source; null when the package did not ship it. */
	clientScript?(): string | null;
	/** Absent when the bridge runs without takeover wiring; the route then answers 501. */
	takeover?: TakeoverDeps;
	/** Absent when there is no file-share wiring; `/xfer/*` then answers 404. */
	xfer?: XferRouteDeps;
	/** Clock override for tests (session TTL / eviction). Defaults to Date.now. */
	now?(): number;
}

/**
 * What the `/xfer/` proxy needs from the active file share: the loopback origin to
 * forward to, and the internal Basic credential to present to `dufs` behind the
 * caller's Bearer. `target()` returning null means nothing is shared, and `/xfer/*`
 * then answers 404.
 */
export interface XferRoute {
	port: number;
	baseUrl: string;
	auth: string;
	/**
	 * Report one request that went through the route.
	 *
	 * The audit records a share's opening and its closing, not every GET and PUT
	 * in between — one record per request would drown the log, and the bytes are
	 * not attributable anyway (the token is shared). The share keeps a tally
	 * instead, and writes it into the record that closes it: that answers "was
	 * this path touched, and how much moved", which is the question an operator
	 * asks about a public route.
	 */
	note?(usage: { method: string; bytes: number }): void;
}

/**
 * The seam the file-share module hands the server. Declared here rather than in
 * xfer.ts for the same reason `TakeoverDeps` is: the server must not import xfer at
 * runtime, and a structural `xfer?: XferRouteDeps` lets extensions/a2mcp.ts pass the
 * `Xfer` object it already builds without a module cycle.
 */
export interface XferRouteDeps {
	target(): XferRoute | null;
}

/**
 * Ceiling on one request body, for every request on this port.
 *
 * History, because the number has meant three different things: JSON-RPC only (1 MB),
 * then a raw-byte endpoint that needed 128 MB and was removed (2026-10-16), and now the
 * `/xfer` route back — a `PUT` of a file is a request body on this port, so the cap is
 * the upload limit. The limit is 128 MB because that is what the removed endpoint
 * already paid for and what `dufs` itself imposes no ceiling against: a caller past it
 * gets the body refused here, not silently truncated by the file server.
 *
 * The cost is memory *per in-flight request*: Bun buffers a body up to this limit
 * before the handler sees it. Lower it if that is worth more than a large upload.
 *
 * Measured: Bun accepts `maxRequestBodySize` well past 1 MB (checked at 16, 128
 * and 256 MB — bodies just under each cap arrived intact).
 */
const MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024;

/**
 * How long a connection may carry no traffic before Bun closes it, in seconds.
 *
 * Bun's default is 10, and inside a request that clock measures *silence*, not
 * the request's total: a body that stops arriving for 10 s is torn down by the
 * server itself. Measured on Bun 1.3.14 — a POST whose body paused 15 s
 * mid-flight: `[Bun.serve]: request timed out after 10 seconds`, then the
 * handler's `req.arrayBuffer()` throws `AbortError: The connection was closed.`
 * and the caller's socket is already gone. 255 is Bun's maximum, and long enough
 * that only a genuinely dead connection reaches it.
 */
const REQUEST_IDLE_TIMEOUT_SECONDS = 255;

/**
 * Unauthorized attempts since the process started. Module-level rather than
 * per-endpoint: the operator's question is "is someone guessing the token on this
 * machine", and a bridge that rebinds (Main parks and resumes) must not get to
 * restart the count. See the 401 branch in the handler for why this is a log line
 * and never an audit record.
 */
let deniedAttempts = 0;

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 1 day idle expiry
/** Upper bound on tracked sessions; the least-recently-seen entry is evicted first. */
export const MAX_SESSIONS = 64;

interface JsonRpcRequest {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: {
		protocolVersion?: string;
		name?: string;
		arguments?: unknown;
	};
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/**
 * The path prefix the file share is served under, and the only place it is written.
 *
 * `src/xfer.ts` imports this constant and hands it to the file server as
 * `--path-prefix`, so the child process and the matcher cannot drift. That coupling is
 * the point: told its prefix, the file server emits prefix-correct absolute references
 * (the directory page's own CSS/JS, the `?json` `uri_prefix`, PROPFIND hrefs), and a
 * caller that follows one lands back on this route. Prefix-blind instead, every one of
 * those would name the public origin's root — outside the route, where the MCP handler
 * answers 405 — and the proxy would have to rewrite bytes to fix it.
 */
export const XFER_ROUTE = "/xfer";

/**
 * Where the caller-side proxy is served from.
 *
 * A remote agent that cannot read this repository still needs the client that
 * chunks transfers; fetching it from the endpoint it is already talking to beats
 * sending it to GitHub (a lab host may have no way out). The file is static and
 * behind the same Bearer token as everything else: it is the bridge's own client,
 * not a new surface with a new secret.
 */
export const CLIENT_ROUTE = "/a2mcp/proxy.mjs";

/** Hop-by-hop headers RFC 7230 says a proxy must not forward, in either direction. */
const HOP_BY_HOP = [
	"connection",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"proxy-authenticate",
	"proxy-authorization",
];

/**
 * Is this request the file route?
 *
 * `/xfer` and `/xfer/a/b` both belong to it; a sibling like `/xfer-private` does not,
 * which is why the test is exact-or-slash and never a bare `startsWith(XFER_ROUTE)`.
 * The path itself goes to the file server unchanged — see `XFER_ROUTE`.
 */
function underXfer(pathname: string): boolean {
	return pathname === XFER_ROUTE || pathname.startsWith(`${XFER_ROUTE}/`);
}

export async function startServer(
	cfg: BridgeConfig,
	deps: BridgeDeps,
): Promise<{ port: number; fellBack: boolean; stop(): void }> {
	// mcp-session-id -> last-seen timestamp. Dynamic membership + per-entry
	// timestamps, hence Map.
	const sessions = new Map<string, number>();
	const now: () => number = deps.now ?? Date.now;

	/**
	 * The session id this bridge actually issued, or `null` when the header does not
	 * name one that is still live. A hit refreshes the timestamp, so the TTL tracks
	 * idle time exactly as the MCP path below does.
	 *
	 * The raw routes (`/host-llm`) need the lookup differently than the MCP path.
	 * There a stale id is an error; here it has to stay a `null`, because the value
	 * goes into the audit record's `sid` — and `sid` is what attributes a shared
	 * token's calls to a client (src/audit.ts). Handed through on trust it would be
	 * the caller's own claim, so any token holder could file a call under someone
	 * else's session. Rejecting instead would make the bridge decide who may act,
	 * which is a position the protocol never gave it: a token-only request is
	 * already accepted and records `sid: null`.
	 */
	function issuedSession(raw: string | null): string | null {
		if (raw === null || raw === "") return null;
		const ts = sessions.get(raw);
		if (ts === undefined || now() - ts > SESSION_TTL_MS) {
			if (ts !== undefined) sessions.delete(raw);
			return null;
		}
		sessions.set(raw, now());
		return raw;
	}

	/** Evict the least-recently-seen session so the map stays bounded. */
	function evictOldest(): void {
		let oldestSid: string | null = null;
		let oldestTs = Infinity;
		for (const [k, t] of sessions) {
			if (t < oldestTs) {
				oldestTs = t;
				oldestSid = k;
			}
		}
		if (oldestSid !== null) sessions.delete(oldestSid);
	}

	/**
	 * Forward one `/xfer/*` request to the file server behind the active share.
	 *
	 * The proxy exists because a quick tunnel fronts exactly one origin (`src/tunnel.ts`),
	 * so carrying files and tools over a single hostname means carrying them over this
	 * port. Three consequences shape the code: the caller's credential is the bridge's
	 * Bearer and nothing else, `dufs`'s own Basic stays a loopback detail that is injected
	 * here and never handed out, and whatever is shared is reachable exactly as long as
	 * the operator's tunnel is.
	 *
	 * The path is forwarded unchanged, and that is the whole of the rewriting: the file
	 * server was told this prefix when it started (`XFER_ROUTE`), so it agrees with the
	 * matcher about where the route begins and its own absolute references — the directory
	 * page's CSS and JS, the `?json` listing, the PROPFIND hrefs — name a path that still
	 * belongs to the route.
	 *
	 * What is left to get right, and why each line is here:
	 *
	 * - `accept-encoding: identity`. A gzipped body would keep `dufs`'s `content-length`
	 *   and `etag` while no longer being those bytes, and a `Range` request into a gzipped
	 *   stream has no coherent answer. Range support is the reason `dufs` was chosen.
	 * - `content-length` is left as the caller sent it. The body passes through untouched,
	 *   so the caller's count is the true one.
	 * - `redirect: "manual"`. The pinned `dufs` answers 200/201 where Apache would redirect,
	 *   so nothing here is a workaround for a live behavior — it is the guarantee that a
	 *   method-rewriting follow (a 301 after a `PUT`, re-issued as a `GET`, reporting success
	 *   for an upload whose body nobody kept) cannot be introduced by the proxy.
	 * - `host` is removed so `fetch` sets it from the loopback URL it is given.
	 * - `www-authenticate` is dropped on the way out. The internal credential is not
	 *   something a caller can act on, and a 401 naming its realm would advertise it.
	 * - the query string is preserved: the directory page's own app re-fetches the same path
	 *   with `?json`, and everything else is the file server's business.
	 *
	 * The `Authorization` assignment comes last, after the header copy, so no
	 * caller-supplied credential reaches the file server: the header the caller sent is
	 * overwritten, not merged.
	 */
	async function proxyXfer(req: Request, url: URL): Promise<Response> {
		const t = deps.xfer?.target();
		if (t === null || t === undefined) {
			return json(404, { error: "nothing is shared — call xfer_share first, then use /xfer/" });
		}
		const headers = new Headers(req.headers);
		for (const h of HOP_BY_HOP) headers.delete(h);
		headers.delete("host");
		headers.set("accept-encoding", "identity");
		headers.set("authorization", t.auth);
		const upstream = `${t.baseUrl}${url.pathname}${url.search}`;
		let res: Response;
		try {
			res = await fetch(upstream, {
				method: req.method,
				headers,
				// GET/HEAD carry no body, and asking for one on those two makes fetch
				// reject the request before it is sent. Everything else streams through.
				body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
				redirect: "manual",
			});
		} catch (e) {
			// The usual cause is a share that closed mid-request: TTL, xfer_stop, or the
			// port released under a client still sending. The reason and the port go to the
			// log, not the response — a 502 body naming its own upstream tells a token
			// holder nothing they can act on and everything about this machine's layout.
			// The URL is spelled out because the error Bun raises does not carry it.
			console.error("[a2mcp] /xfer cannot reach", upstream, "—", e);
			return json(502, { error: "the file server is not answering — the share may have closed" });
		}
		const out = new Headers(res.headers);
		for (const h of HOP_BY_HOP) out.delete(h);
		out.delete("www-authenticate");
		// What crossed the route, counted once. The bytes come from the two
		// content-lengths — the request body in, the response body out — which are
		// the true ones here because `accept-encoding: identity` is forced below, so
		// the upstream's length is the length of the bytes that move. A request
		// without a content-length (chunked) counts as zero: the tally is a floor,
		// not a measurement.
		const length = (h: Headers) => {
			const n = Number(h.get("content-length") ?? "");
			return Number.isFinite(n) && n > 0 ? n : 0;
		};
		t.note?.({ method: req.method, bytes: length(headers) + length(res.headers) });
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
	}

	async function handler(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const isXfer = underXfer(url.pathname);
			const isClient = url.pathname === CLIENT_ROUTE;

			// The method gates cover the MCP surface only. `/xfer` is a plain HTTP file
			// route where GET is the download and PUT the upload, so the gate is
			// prefix-scoped rather than moved: a GET of `/` still has to be refused with
			// 405 (test/server.test.ts and test/hardening.ts pin it). The client script
			// is the other GET: one static file, and it is fetched before any session
			// exists, so it cannot be a POST.
			if (!isXfer && !isClient) {
				if (req.method === "GET") return new Response(null, { status: 405 });
				if (req.method !== "POST" && req.method !== "DELETE") return new Response(null, { status: 405 });
			}

			// Auth precedes every state-touching branch: an unauthenticated
			// DELETE must not be able to terminate another client's session. The same
			// Bearer gates `/xfer` — one token, one gate, over files and over tools.
			if (!authorize({ token: cfg.token }, req.headers)) {
				// Unauthorised attempts stay out of the audit file on purpose. That log
				// holds one rotated generation, so a pre-auth writer would only have to
				// pump volume past the cap to drop real records with it. The operator
				// still needs to know someone is knocking: this goes to the host's log,
				// once and then every 50th.
				deniedAttempts++;
				if (deniedAttempts === 1 || deniedAttempts % 50 === 0) {
					console.warn(`[a2mcp] ${deniedAttempts} unauthorized attempt(s) — check the token in the remote mcp.json`);
				}
				return json(401, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "unauthorized" } });
			}

			// The file share: raw bytes over the bridge's own port, ahead of every branch
			// below. Both of them would answer a file request as an MCP request — the JSON-RPC
			// half reads a body and ignores the pathname entirely (`PUT /xfer/a` would be
			// parsed as JSON and refused with -32700), and the DELETE half ends a session on
			// any path whatsoever (`DELETE /xfer/a` would return 204 for a job dufs does).
			if (isXfer) return await proxyXfer(req, url);

			// The caller-side client. Static source, no state touched, no audit record:
			// the interesting event is a transfer, and that is already recorded by the
			// share's closing tally. A bridge whose package omitted the script answers
			// 404 rather than serving an empty file the agent would run and fail on.
			if (isClient) {
				if (req.method !== "GET") return new Response(null, { status: 405 });
				const script = deps.clientScript?.() ?? null;
				if (script === null) return json(404, { error: "the proxy client is not bundled on this bridge" });
				return new Response(script, {
					headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
				});
			}

			// The takeover switch: one token, one raw path outside JSON-RPC, audited,
			// POST only.
			// It lives at a raw path rather than as a `tools/list` entry because the
			// catalog is the host registry verbatim, and this is not a host tool —
			// it is the bridge acting on the host, and the bridge does not get to
			// hide that in a tool list (src/takeover.ts).
			if (url.pathname === "/host-llm" && req.method === "POST") {
				const sid = issuedSession(req.headers.get("mcp-session-id"));
				if (!deps.takeover) {
					return json(501, { error: "host-llm takeover is not wired on this bridge" });
				}
				let body: unknown;
				try {
					body = await req.json();
				} catch {
					return json(400, { error: "expected a JSON body with a boolean 'enabled'" });
				}
				const enabled = (body as Record<string, unknown> | null)?.enabled;
				if (typeof enabled !== "boolean") {
					return json(400, { error: "field 'enabled' must be a boolean" });
				}
				try {
					const state = deps.takeover.setEnabled(enabled);
					// Awaited: the answer says the host's inference is now deny, and
					// whoever flipped it has to be findable in the log by `sid` the
					// moment they get that answer.
					await auditHostLlm(sid, enabled, null);
					return json(200, state);
				} catch (e) {
					// Refusals are audited too: "someone tried to arm the deny and the
					// bridge said no" is exactly the kind of thing the log exists for.
					const msg = (e as Error)?.message ?? String(e);
					await auditHostLlm(sid, enabled, msg);
					return json(500, { error: msg });
				}
			}

			if (req.method === "DELETE") {
				// `/host-llm` never accepts DELETE — it has no business ending an MCP
				// session, and answering 204 here would report a session teardown the
				// caller never asked for. `/xfer/...` got its own answer above, which is
				// dufs deleting a file rather than this map dropping a session.
				if (url.pathname === "/host-llm") {
					return json(405, { error: `${url.pathname} accepts POST only` });
				}
				const sid = req.headers.get("mcp-session-id");
				if (sid) sessions.delete(sid);
				return new Response(null, { status: 204 });
			}

			let msg: unknown;
			try {
				msg = await req.json();
			} catch {
				return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
			}
			if (Array.isArray(msg)) {
				return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
			}
			const rpc = msg as JsonRpcRequest;
			if (typeof rpc !== "object" || rpc === null || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
				return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
			}
			// Normalize: JSON.stringify drops an undefined id, which would yield a
			// response violating JSON-RPC's "id must be present" rule.
			const id = rpc.id ?? null;

			// Session enforcement covers every post-initialize message — requests
			// *and* notifications. Omitting the header is not an escape hatch
			// (400, matching the official SDK transport); omp's own client always
			// sends it. A hit refreshes the timestamp so the TTL tracks *idle*
			// time; an unknown or idle-expired id gets 404 plus lazy cleanup.
			const sid = req.headers.get("mcp-session-id");
			if (rpc.method !== "initialize") {
				if (sid === null) {
					return json(400, { jsonrpc: "2.0", id, error: { code: -32000, message: "missing mcp-session-id" } });
				}
				const ts = sessions.get(sid);
				if (ts === undefined || now() - ts > SESSION_TTL_MS) {
					if (ts !== undefined) sessions.delete(sid);
					return json(404, { jsonrpc: "2.0", id, error: { code: -32000, message: "unknown session" } });
				}
				sessions.set(sid, now());
			}

			// Notifications: no id, no result.
			if (rpc.method.startsWith("notifications/")) {
				return new Response(null, { status: 202 });
			}

			switch (rpc.method) {
				case "initialize": {
					const newSid = randomUUID();
					// Abandoned clients never come back to be purged, so bound the
					// map: evict least-recently-seen before inserting.
					if (sessions.size >= MAX_SESSIONS) evictOldest();
					sessions.set(newSid, now());
					return json(
						200,
						{
							jsonrpc: "2.0",
							id,
							result: {
								// Version negotiation: we speak exactly one version, so
								// always answer with ours — echoing the client's requested
								// version would "accept" anything (e.g. "1999-01-01").
								protocolVersion: DEFAULT_PROTOCOL_VERSION,
								capabilities: { tools: {} },
								serverInfo: deps.serverInfo(),
								// The client shows this to its model before the first call. It is
								// the only place the endpoint can explain itself to an agent
								// the operator never handed a prompt to.
								instructions: BRIDGE_INSTRUCTIONS,
							},
						},
						{ "mcp-session-id": newSid },
					);
				}
				case "ping":
					return json(200, { jsonrpc: "2.0", id, result: {} });
				case "tools/list": {
					const tools = await deps.getTools();
					return json(200, { jsonrpc: "2.0", id, result: { tools } });
				}
				case "tools/call": {
					const name = rpc.params?.name ?? "";
					const args = rpc.params?.arguments;
					try {
						const r = await deps.callTool(name, args, sid);
						return json(200, { jsonrpc: "2.0", id, result: { content: r.content, isError: r.isError } });
					} catch (e) {
						// Tool rejection must not become an HTTP error.
						return json(200, {
							jsonrpc: "2.0",
							id,
							result: {
								content: [{ type: "text", text: String((e as Error)?.message ?? e) }],
								isError: true,
							},
						});
					}
				}
				default:
					return json(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
			}
		} catch (e) {
			// Details (host paths, stack) go to the server log only: a 500 body
			// must not leak host internals to a token holder.
			console.error("[a2mcp] internal error:", e);
			return json(500, {
				jsonrpc: "2.0",
				id: null,
				error: { code: -32603, message: "internal error" },
			});
		}
	}

	async function serve(port: number) {
		return Bun.serve({
			hostname: cfg.host,
			port,
			maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
			// Above: Bun's 10 s default severs a tunnel upload mid-body.
			idleTimeout: REQUEST_IDLE_TIMEOUT_SECONDS,
			fetch: handler,
		});
	}

	let server: Awaited<ReturnType<typeof serve>>;
	let fellBack = false;
	try {
		server = await serve(cfg.port);
	} catch (e) {
		// EADDRINUSE on an explicit port: retry once on an ephemeral port, and
		// flag it so the caller can warn (remote mcp.json pins the old port).
		if (cfg.port !== 0 && (e as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
			server = await serve(0);
			fellBack = true;
		} else {
			throw e;
		}
	}

	return {
		port: server.port ?? cfg.port,
		fellBack,
		stop() {
			// Not `stop(true)`: the port is released when Main goes away, and a
			// tools/call can be mid-flight at that moment. Forcing it severs the
			// socket — the client gets ECONNRESET and the audit loses the `done`
			// half of a call the host already paid for. A graceful stop refuses new
			// connections all the same and lets this one answer.
			server.stop();
		},
	};
}
