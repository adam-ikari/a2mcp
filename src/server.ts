import { randomUUID } from "node:crypto";
import { auditHostLlm } from "./audit.ts";
import { authorize } from "./auth.ts";
import type { BridgeConfig } from "./config.ts";
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
	/** Absent when the bridge runs without takeover wiring; the route then answers 501. */
	takeover?: TakeoverDeps;
	/** Clock override for tests (session TTL / eviction). Defaults to Date.now. */
	now?(): number;
}

/**
 * Ceiling on one request body, for every request on this port.
 *
 * It was 1 MB while the port carried only JSON-RPC messages. The raw-byte
 * endpoint that pushed it to 128 MB is gone (2026-10-16), so this value is now
 * headroom nothing asks for rather than a size the bridge is built around: Bun
 * buffers a body up to this limit before the handler sees it, so the cost is
 * memory *per in-flight request*. Lower it back if that memory is worth more than
 * a large MCP message would be.
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

	async function handler(req: Request): Promise<Response> {
		try {
			if (req.method === "GET") return new Response(null, { status: 405 });
			if (req.method !== "POST" && req.method !== "DELETE") return new Response(null, { status: 405 });

			// Auth precedes every state-touching branch: an unauthenticated
			// DELETE must not be able to terminate another client's session.
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

			// The takeover switch: one token, one raw path outside JSON-RPC, audited,
			// POST only.
			// It lives at a raw path rather than as a `tools/list` entry because the
			// catalog is the host registry verbatim, and this is not a host tool —
			// it is the bridge acting on the host, and the bridge does not get to
			// hide that in a tool list (src/takeover.ts).
			if (new URL(req.url).pathname === "/host-llm" && req.method === "POST") {
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
				// caller never asked for.
				const p = new URL(req.url).pathname;
				if (p === "/host-llm") {
					return json(405, { error: `${p} accepts POST only` });
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
