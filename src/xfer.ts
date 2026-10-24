/**
 * File transfer over WebDAV, wired into the MCP endpoint as tools.
 *
 * ## What this is, and what it is not
 *
 * The bridge defines no transfer protocol of its own. The default way bytes move is
 * not JSON-RPC at all: a tool call says *which* path to hand out, `dufs` serves that
 * path on a loopback port, and the bridge proxies it under `/xfer/` on its own port
 * (src/server.ts). The route speaks WebDAV — the standard protocol for moving files
 * over HTTP — so a caller mounts it with any WebDAV client that can send the bridge's
 * `Authorization: Bearer` header (`rclone`, `curl`, or their own HTTP client): GET to
 * download, PUT to upload, PROPFIND for a listing, Range to resume. One gate, the same
 * Bearer token the MCP calls use.
 *
 * That is the shape to prefer, and it was chosen against encode-and-chunk on the MCP
 * channel: MCP has no binary content type (JSON-RPC is text; its image and resource
 * blocks are base64), the host's `read` tool truncates at ~150 KB and its `bash` at
 * 768 bytes, so in-band bytes cost 33% more and arrive in fragments. Driving an
 * existing HTTP server costs nothing per byte and gives range requests, resumable
 * downloads and directory listings for free.
 *
 * So no file byte crosses the MCP channel: `tools/list` carries three verbs for the
 * route, never its contents. A client that can make tool calls but cannot send an HTTP
 * request has one other way in — `scripts/a2mcp-proxy.mjs`, a caller-side stdio proxy
 * that speaks this route on its behalf (Range GET down, PUT + `PATCH
 * X-Update-Range: append` up) and adds `a2mcp_upload` / `a2mcp_download` to the
 * catalog it forwards. The proxy is not part of the bridge and gives the bridge no new
 * tool; the share root and what may be written stay where they already were.
 *
 * One port, one gate, rather than one per surface: a cloudflared quick tunnel fronts
 * exactly one origin (src/tunnel.ts), so files and tools share a hostname by sharing
 * this port. Whether that hostname exists at all is the operator's call — `/a2mcp
 * tunnel` — and never a tool's. Without it the route is reachable on the host and
 * through whatever port forward the operator set up, and nothing more. A share
 * reports the hostname while it is up (`publicUrl`, read at call time) and says
 * there is none while it is down; it never opens one.
 *
 * ## Why `dufs`
 *
 * One static binary per platform, no runtime, no config file, no account: GET with
 * Range, PUT, MKCOL, PROPFIND with a directory listing, and HTTP basic auth, which
 * keeps the loopback port shut even though the bridge is the only thing meant to knock
 * on it. Verbs the bridge does not ask for stay refused: `--allow-upload` is the only
 * permission granted, so DELETE and MOVE come back 403 from the file server.
 *
 * `xfer.dufs` names the program, PATH is searched for that name, and when nothing
 * answers, `src/obtain.ts` downloads the pinned build, verifies it against the sha256
 * pinned beside the version, and installs it into the bridge's bin directory
 * (`~/.local/bin`, or `%LOCALAPPDATA%\a2mcp\bin` on Windows). A value containing a `/`
 * or a `\` is the operator saying "use exactly this" and is never downloaded for. See
 * `src/obtain.ts` for why that is the shape it is. `cloudflared` is resolved the same
 * way, by the operator's tunnel command rather than by a share.
 *
 * ## What is deliberately left to the host
 *
 * Serving a path is a read the bridge resolves itself, so every action is audited
 * (`tool: "xfer"`). Fetching a remote URL *into* a host path is not offered: the
 * host's own `bash` + `curl` already does that, and that path passes the host's
 * approval gate, which a bridge-owned write would not.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { auditXfer } from "./audit.ts";
import type { XferConfig } from "./config.ts";
import { type BinaryName, defaultBinDir, type ObtainDeps, type Resolved, resolveBinary } from "./obtain.ts";
import type { McpContent, McpTool, XferRoute } from "./server.ts";
import { XFER_ROUTE } from "./server.ts";

/** How long a share stays open when the caller does not say. */
const DEFAULT_TTL_SECONDS = 3600;

/** Every tool this module owns. The bridge's catalog appends exactly these. */
export const XFER_TOOL_NAMES = ["xfer_share", "xfer_status", "xfer_stop"] as const;

/**
 * The catalog entries, written the way a caller reads them: what the tool does,
 * what the argument means, and the one thing neither of those implies — that the
 * share rides on the token. Whoever holds it holds the directory.
 */
export const XFER_TOOLS: McpTool[] = [
	{
		name: "xfer_share",
		description:
			"Serve a host path over WebDAV at the bridge's /xfer/ route, under the same " +
			"Bearer token as tool calls. GET downloads (range works), PUT uploads, PROPFIND " +
			"lists; mount it with any WebDAV client that sends `Authorization: Bearer <token>`. " +
			"Closes at `ttlSeconds` (default 3600) or on xfer_stop. While `/a2mcp tunnel` is " +
			"open, `publicUrl` is the same route on that hostname. Whoever holds the token can " +
			"read and write the path.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"File or directory to serve; `~` and `~/x` mean the host's home, relative paths its working directory.",
				},
				ttlSeconds: {
					type: "number",
					description: `Seconds until the share closes itself. Default ${DEFAULT_TTL_SECONDS}.`,
				},
			},
			required: ["path"],
		},
	},
	{
		name: "xfer_status",
		description: "Report the current share: path, route, and when it closes; `serving: false` when none.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "xfer_stop",
		description: "Close the share and take `/xfer/` down. Safe when nothing is shared.",
		inputSchema: { type: "object", properties: {} },
	},
];

export interface XferToolResult {
	content: McpContent[];
	isError: boolean;
}

/** What crossed a share while it was open. A floor, not a measurement. */
interface ShareUsage {
	requests: number;
	bytes: number;
	uploads: number;
}

interface Share {
	path: string;
	port: number;
	/** The internal credential: what the proxy presents to the file server. */
	auth: string;
	startedAt: number;
	expiresAt: number;
	server: ChildProcess;
	timer: ReturnType<typeof setTimeout>;
	usage: ShareUsage;
}

export interface XferDeps {
	/** Test seam: replace how a missing binary is found or fetched (src/obtain.ts). */
	resolveBinary?: typeof resolveBinary;
	/** Forwarded to the resolver: `binDir`, `fetchImpl`, `base`, `target`, the caps. */
	obtain?: ObtainDeps;
	/**
	 * The bridge's own origin with the route on it, as a caller would type it. A getter,
	 * because the port is not known until the server is listening and a share can outlive
	 * a rebind.
	 */
	bridgeUrl?(): string;
	/**
	 * The operator's public origin for this port — the `/a2mcp tunnel` hostname — or
	 * null while no tunnel is open. A getter for the same reason `bridgeUrl` is one:
	 * the tunnel comes and goes while a share lives, so a reply answers for the moment
	 * it is asked, not for the moment the share began.
	 */
	publicUrl?(): string | null;
	now?(): number;
}

export interface Xfer {
	handles(name: string): boolean;
	call(name: string, args: unknown, sid: string | null): Promise<XferToolResult>;
	/** Where `/xfer/*` forwards to, or null when nothing is shared. */
	target(): XferRoute | null;
	stop(): Promise<void>;
}

/**
 * Resolve a caller-supplied path the way a shell would: `~` against the host's
 * home, relative against the host's working directory. No root is imposed — the
 * share is exactly the path that was asked for, which is what makes the audit
 * record mean something.
 */
export function resolveXferPath(input: string): string {
	const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
	return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/**
 * Resolves once the child is gone — including when it went already.
 *
 * `exit` is emitted once, so a listener attached after an await that spanned the
 * child's death watches an event that has already happened and never resolves.
 * Reading the exit code in the same tick as the registration closes the gap: a
 * synchronous pair cannot have a death between its halves.
 */
function exited(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((r) => child.once("exit", () => r()));
}

/** A port nothing is listening on right now. */
function freePort(): number {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
	const port = probe.port ?? 0;
	probe.stop(true);
	return port;
}

function basic(user: string, secret: string): string {
	return `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
}

/**
 * Wait until the file server answers on its port, or give up.
 *
 * `failure()` is the spawn-error channel: a binary that is not there never sets an
 * exit code, so a readiness loop that only watches `exitCode` would sit out the
 * whole timeout before reporting what it already knew.
 */
async function waitForServer(
	child: ChildProcess,
	port: number,
	auth: string,
	timeoutMs: number,
	failure: () => string | null,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = "no answer yet";
	while (Date.now() < deadline) {
		const spawnFailure = failure();
		if (spawnFailure !== null) throw new Error(`cannot run the file server: ${spawnFailure}`);
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`the file server exited with code ${child.exitCode} before it served anything`);
		}
		try {
			const r = await fetch(`http://127.0.0.1:${port}${XFER_ROUTE}/`, { headers: { authorization: auth } });
			// Anything under 500 counts: the process is up and talking HTTP.
			if (r.status < 500) return;
			last = `status ${r.status}`;
		} catch (e) {
			last = (e as Error).message;
		}
		await Bun.sleep(150);
	}
	throw new Error(`the file server did not answer on 127.0.0.1:${port}${XFER_ROUTE}/ within ${timeoutMs}ms (${last})`);
}

export function createXfer(cfg: XferConfig, deps: XferDeps = {}): Xfer {
	const now = deps.now ?? Date.now;
	const find = deps.resolveBinary ?? resolveBinary;
	const obtain = deps.obtain ?? {};
	/** PATH first, then the pinned download (src/obtain.ts). */
	const resolveBin = (name: BinaryName, configured: string, sid: string | null): Promise<Resolved> =>
		find(name, configured, sid, obtain);
	let share: Share | null = null;

	/** What a caller types. The port is the bridge's, not the file server's. */
	const routeUrl = (): string => `${deps.bridgeUrl?.() ?? ""}${XFER_ROUTE}/`;

	/**
	 * The same route under the operator's tunnel, or null when there is none. Read
	 * per call: `/a2mcp tunnel` may open or close between two `xfer_status` calls,
	 * and this module only ever reports that state — it never starts a tunnel.
	 */
	const publicRouteUrl = (): string | null => {
		const origin = deps.publicUrl?.()?.replace(/\/+$/, "") ?? "";
		return origin.length === 0 ? null : `${origin}${XFER_ROUTE}/`;
	};

	/**
	 * The tally, as it goes into a record — absent when nothing crossed the route.
	 *
	 * A floor, not a measurement: bytes are counted from the two content-lengths,
	 * so a chunked request counts as zero. And it says how much moved, never who
	 * moved it: the token is shared, so the bytes carry no identity.
	 */
	function usageFields(usage: ShareUsage | null): Record<string, unknown> {
		if (!usage || usage.requests === 0) return {};
		return { usage: { requests: usage.requests, bytes: usage.bytes, uploads: usage.uploads } };
	}

	async function close(reason: string): Promise<ShareUsage | null> {
		const s = share;
		if (!s) return null;
		share = null;
		clearTimeout(s.timer);
		// The waiter is registered before the signal is sent and the two statements are
		// not separated by an await: the file server answers SIGTERM within a few
		// milliseconds, and an exit delivered before anyone is listening is an exit
		// nobody hears (test/xfer.test.ts). On Windows there is no SIGTERM to answer —
		// `kill` ends the process there — so the 2 s fallback below never fires.
		const dead = exited(s.server);
		s.server.kill("SIGTERM");
		// The port is what has to be free before another share can be opened, and it
		// is released when the child exits, not when the signal is sent.
		const gone = await Promise.race([dead.then(() => true), Bun.sleep(2000).then(() => false)]);
		if (!gone) {
			s.server.kill("SIGKILL");
			await dead;
		}
		if (reason !== "stop") {
			await auditXfer(null, "close", { path: s.path, port: s.port, why: reason, ...usageFields(s.usage) }, null);
		}
		return s.usage;
	}

	function text(value: unknown, isError = false): XferToolResult {
		// Compact on purpose: every reply is read by a model, and indentation buys
		// nothing there but tokens.
		return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
	}

	async function begin(args: unknown, sid: string | null): Promise<XferToolResult> {
		const a = (args ?? {}) as { path?: unknown; ttlSeconds?: unknown };
		if (typeof a.path !== "string" || a.path.length === 0) {
			await auditXfer(sid, "share", { path: String(a.path) }, "path is required");
			return text("xfer_share needs a 'path' — the file or directory to serve", true);
		}
		const path = resolveXferPath(a.path);
		const ttl = typeof a.ttlSeconds === "number" && a.ttlSeconds > 0 ? Math.floor(a.ttlSeconds) : DEFAULT_TTL_SECONDS;

		try {
			await stat(path);
		} catch (e) {
			const why = `cannot serve ${path}: ${(e as Error).message}`;
			await auditXfer(sid, "share", { path }, why);
			return text(why, true);
		}

		// Resolve the file server before anything is torn down: a share that works
		// must not be closed by a call that never got a binary.
		let dufs: Resolved;
		try {
			dufs = await resolveBin("dufs", cfg.dufs, sid);
		} catch (e) {
			const why = (e as Error).message;
			await auditXfer(sid, "share", { path }, why);
			return text(why, true);
		}

		// One share at a time: a second `xfer_share` replaces the first rather than
		// leaving a route open that the caller has stopped thinking about.
		const replaced = share !== null;
		if (replaced) await close("replaced");

		const port = freePort();
		const user = "omp";
		const secret = randomBytes(12).toString("base64url");
		const auth = basic(user, secret);
		let server: ChildProcess;
		let serverErr = "";
		let spawnFailure: string | null = null;
		try {
			server = spawn(
				dufs.path,
				[
					path,
					"--bind",
					"127.0.0.1",
					"--port",
					String(port),
					// Told its own prefix, the file server emits prefix-correct absolute
					// references — the directory page's CSS and JS, the `?json` listing, the
					// PROPFIND hrefs — so a caller following one stays on the route. The
					// constant is the one the proxy matches on (src/server.ts).
					"--path-prefix",
					XFER_ROUTE,
					"--allow-upload",
					// dufs takes credentials and their role in one string: `user:pass@/path:rw`.
					// Without the `@…` half it refuses the argument outright — which is how this
					// was found, a bare `user:pass` exits 1 with "Invalid auth".
					// The path here is relative to the share root, NOT to the prefix: writing
					// `@${XFER_ROUTE}:rw` matches nothing and every request comes back 403,
					// including the ones with the right credentials.
					"--auth",
					`${user}:${secret}@/:rw`,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			server.stderr?.on("data", (c: Buffer) => {
				serverErr += c.toString();
			});
			server.once("error", (e: Error) => {
				spawnFailure = e.message;
				serverErr += e.message;
			});
		} catch (e) {
			const why = `cannot start ${dufs.path}: ${(e as Error).message}`;
			await auditXfer(sid, "share", { path }, why);
			return text(why, true);
		}

		try {
			await waitForServer(server, port, auth, 10_000, () => spawnFailure);
		} catch (e) {
			const why = (e as Error).message;
			server.kill("SIGKILL");
			// The file server's own reason, when it has one: "exited with code 1"
			// says nothing about which path or which flag was wrong, and the reason
			// is on its stderr. The secret is scrubbed — it is that file server's
			// own credential, and this text goes to the caller.
			const said = serverErr
				.trim()
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.pop();
			const because = said ? `${why} (${said.replaceAll(secret, "<secret>")})` : why;
			const missing = /ENOENT|not found|127/.test(`${why}${serverErr}`);
			const hint = missing
				? ` — the bridge resolves '${cfg.dufs}' itself: PATH first, then a pinned download into ${defaultBinDir(process.env, process.platform)}. A configured value containing '/' or '\\' is used exactly as given and never fetched`
				: "";
			await auditXfer(sid, "share", { path, port }, because);
			return text(`${because}${hint}`, true);
		}

		const startedAt = now();
		const expiresAt = startedAt + ttl * 1000;
		const timer = setTimeout(() => {
			void close("ttl expired");
		}, ttl * 1000);
		// A pending share must not keep the process alive on its own; shutdown closes
		// it explicitly.
		timer.unref?.();
		share = { path, port, auth, startedAt, expiresAt, server, timer, usage: { requests: 0, bytes: 0, uploads: 0 } };

		const publicUrl = publicRouteUrl();
		await auditXfer(sid, "share", { path, port, ttl, route: `${XFER_ROUTE}/` }, null);
		return text({
			url: routeUrl(),
			publicUrl,
			route: `${XFER_ROUTE}/`,
			path,
			port,
			replaced,
			startedAt: new Date(startedAt).toISOString(),
			expiresAt: new Date(expiresAt).toISOString(),
			// Why this call took a few seconds: a version here means the bridge fetched
			// that build during this call (src/obtain.ts), `null` means it was already there.
			installed: { dufs: dufs.installed?.version ?? null },
		});
	}

	return {
		handles: (name) => (XFER_TOOL_NAMES as readonly string[]).includes(name),
		target: () => {
			// The share is captured, not looked up again: a request that was routed
			// to one share must not land its tally on the share that replaced it
			// while it was in flight.
			const s = share;
			if (s === null) return null;
			return {
				port: s.port,
				baseUrl: `http://127.0.0.1:${s.port}`,
				auth: s.auth,
				note: (u: { method: string; bytes: number }) => {
					s.usage.requests++;
					s.usage.bytes += u.bytes;
					if (u.method === "PUT" || u.method === "POST" || u.method === "PATCH") s.usage.uploads++;
				},
			};
		},
		async call(name, args, sid) {
			try {
				if (name === "xfer_share") return await begin(args, sid);
				if (name === "xfer_stop") {
					const was = share;
					// The tally goes into the record that closes the share, whichever
					// one that is — `close` writes its own, except for this reason.
					const usage = await close("stop");
					await auditXfer(sid, "stop", { path: was?.path ?? null, ...usageFields(usage) }, null);
					return text(was ? { stopped: true, path: was.path } : { stopped: false, note: "nothing was shared" });
				}
				if (name === "xfer_status") {
					if (!share) return text({ serving: false });
					return text({
						serving: true,
						path: share.path,
						url: routeUrl(),
						publicUrl: publicRouteUrl(),
						route: `${XFER_ROUTE}/`,
						port: share.port,
						startedAt: new Date(share.startedAt).toISOString(),
						expiresAt: new Date(share.expiresAt).toISOString(),
					});
				}
				return text(`xfer has no tool '${name}'`, true);
			} catch (e) {
				const why = (e as Error)?.message ?? String(e);
				await auditXfer(sid, name, {}, why);
				return text(why, true);
			}
		},
		async stop() {
			await close("bridge stopped");
		},
	};
}
