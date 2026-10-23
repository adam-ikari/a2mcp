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
 * `xfer_get` and `xfer_put` are the exception, and they exist for one caller: the one
 * that can make a tool call but cannot send an HTTP request with a header. They carry
 * the same file in base64 chunks, one call per chunk, which is worse on every axis
 * that matters per byte — 33% larger, a call and a context window per piece — and
 * better on the only one that is left: it needs nothing but the MCP endpoint. They
 * read and write *through* the file server (a Range GET, one PUT of the assembled
 * bytes), so the share root, what exists and what may be written stay in the place
 * that already decides them.
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

/** What `xfer_get` returns when the caller does not say, and the most one call may ask for. */
const GET_CHUNK_BYTES = 256 * 1024;
const GET_CHUNK_MAX = 1024 * 1024;

/** The largest file `xfer_put` will assemble in the bridge's memory. */
const PUT_MAX_BYTES = 16 * 1024 * 1024;
/** How long a half-sent upload is kept, and how many may be in flight at once. */
const PUT_IDLE_MS = 10 * 60 * 1000;
const PUT_SLOTS = 4;

/** Every tool this module owns. The bridge's catalog appends exactly these. */
export const XFER_TOOL_NAMES = ["xfer_share", "xfer_status", "xfer_stop", "xfer_get", "xfer_put"] as const;

/**
 * The catalog entries, written the way a caller reads them: what the tool does,
 * what the argument means, and the one thing neither of those implies — that the
 * share rides on the token. Whoever holds it holds the directory.
 */
export const XFER_TOOLS: McpTool[] = [
	{
		name: "xfer_share",
		description:
			"Serve a host path over WebDAV at the bridge's own /xfer/ route, under the same " +
			"Bearer token as the tool calls: mount it with any WebDAV client that can send " +
			"`Authorization: Bearer <token>` (rclone, curl, or your own HTTP client) — GET to " +
			"download (range requests work), PUT to upload, PROPFIND for a listing. " +
			"The share closes itself at `ttlSeconds` (default 3600) or on xfer_stop. " +
			"Reachable on the host's loopback; while the operator's `/a2mcp tunnel` is open the reply's " +
			"`publicUrl` is the same /xfer/ route on that hostname. " +
			"Every holder of that token can read and write the shared path.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"File or directory to serve. `~` and `~/x` expand to the host's home; relative paths resolve against the host's working directory.",
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
		description: "Report the current share, if any: path, the route to use, and when it closes.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "xfer_stop",
		description:
			"Close the current share: stop the file server and take the /xfer/ route down. Safe to call when nothing is shared.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "xfer_get",
		description:
			"Read one chunk of a file inside the share, as base64 — for a caller that can make tool calls but " +
			"cannot send an HTTP request. `name` is relative to the share root. `offset` defaults to 0 and " +
			"`maxBytes` to 262144 (at most 1048576). The reply's `next` is the offset to ask for next, or null at " +
			"the end of the file; `total` is the file's size. Each chunk costs its bytes in base64 and in your " +
			"context: when you can send `Authorization: Bearer <token>`, the /xfer/ route from xfer_share moves " +
			"the same file with neither.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description:
						"Path inside the share. A leading '/' is ignored, a backslash reads as a separator, '..' is refused.",
				},
				offset: { type: "number", description: "Byte offset to start at. Default 0." },
				maxBytes: { type: "number", description: `Bytes to return. Default ${GET_CHUNK_BYTES}, cap ${GET_CHUNK_MAX}.` },
			},
			required: ["name"],
		},
	},
	{
		name: "xfer_put",
		description:
			"Write a file inside the share from base64, in one call or in chunks — for a caller that cannot send " +
			"an HTTP request. One call with no `offset` writes the whole file. A longer file goes in pieces: give " +
			"`total` once, and each call's `offset` is the previous reply's `next`; the call that reaches `total` " +
			"writes it. Pieces are held in the bridge's memory, up to 16777216 bytes and 10 minutes — a bigger " +
			"file belongs on the /xfer/ route.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description:
						"Path inside the share. A leading '/' is ignored, a backslash reads as a separator, '..' is refused.",
				},
				data: { type: "string", description: "The chunk's bytes, base64 (standard or url-safe)." },
				offset: {
					type: "number",
					description: "Byte offset this chunk starts at. Default 0, which also restarts a staged upload.",
				},
				total: {
					type: "number",
					description:
						"The whole file's size in bytes. Default `offset` + this chunk's length, i.e. this chunk ends the file.",
				},
			},
			required: ["name", "data"],
		},
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

/**
 * A file `xfer_put` is carrying in pieces. Kept by session and name, in the bridge's
 * memory, because the pieces arrive as separate tool calls and nothing else in this
 * process holds them: the file server only sees the finished file.
 */
interface Staged {
	name: string;
	parts: Buffer[];
	received: number;
	total: number;
	expiresAt: number;
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
	/** Half-sent uploads (`xfer_put`), held between calls and dropped with the share. */
	const staged = new Map<string, Staged>();

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
		// An upload in pieces belongs to the share it was aimed at: the next share
		// serves a different path, and a piece arriving against it would land in a
		// file the caller never named.
		staged.clear();
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
		return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
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

		const url = routeUrl();
		const publicUrl = publicRouteUrl();
		await auditXfer(sid, "share", { path, port, ttl, route: `${XFER_ROUTE}/` }, null);
		return text({
			url,
			publicUrl,
			route: `${XFER_ROUTE}/`,
			path,
			port,
			replaced,
			startedAt: new Date(startedAt).toISOString(),
			expiresAt: new Date(expiresAt).toISOString(),
			usage: {
				// `<TOKEN>` stays a placeholder: this object is read by the host's model
				// and lands in logs, and the bridge's token belongs to neither.
				download: `curl -H 'Authorization: Bearer <TOKEN>' -O ${url}<name>`,
				upload: `curl -H 'Authorization: Bearer <TOKEN>' -T <local> ${url}<name>`,
				// No tunnel means no public address, and the reply says which two ways
				// in are left rather than leaving a remote caller to invent a third.
				public:
					publicUrl === null
						? "no public address — `/a2mcp tunnel` is closed; use an SSH port forward to the bridge port, or ask the operator to run `/a2mcp tunnel`"
						: `curl -H 'Authorization: Bearer <TOKEN>' -O ${publicUrl}<name>`,
			},
			// Why this call took a few seconds: a version here means the bridge fetched
			// that build during this call (src/obtain.ts), `null` means it was already there.
			installed: { dufs: dufs.installed?.version ?? null },
		});
	}

	/**
	 * A name as `xfer_get`/`xfer_put` take it: a path inside the share.
	 *
	 * A leading `/` means the share root, and `..` is refused rather than resolved —
	 * the file server would refuse an escape on its own, since it is told its prefix,
	 * but a caller that never learns why is worth the line. A backslash is read as a
	 * separator because a Windows caller writes paths that way.
	 */
	function shareName(input: unknown): { name: string } | { why: string } {
		if (typeof input !== "string" || input.trim().length === 0) {
			return { why: "a 'name' is required — a path inside the share" };
		}
		const segments = input
			.replaceAll("\\", "/")
			.split("/")
			.filter((s) => s.length > 0 && s !== ".");
		if (segments.includes("..")) return { why: `'${input}' leaves the share: '..' is refused` };
		if (segments.length === 0) return { why: `'${input}' names no file` };
		return { name: segments.join("/") };
	}

	/** One file on the share's own loopback route — the same path the proxy serves. */
	function fileUrl(s: Share, name: string): string {
		return `http://127.0.0.1:${s.port}${XFER_ROUTE}/${name.split("/").map(encodeURIComponent).join("/")}`;
	}

	/** Base64 as a caller may spell it: standard or url-safe, whitespace and padding optional. */
	function decodeBase64(input: string): Buffer | null {
		const compact = input.replace(/\s/g, "").replaceAll("-", "+").replaceAll("_", "/");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
		return Buffer.from(compact, "base64");
	}

	/** Drop uploads nobody finished. Cheap enough to run on every call. */
	function sweepStaged(): void {
		const t = now();
		for (const [k, v] of staged) if (v.expiresAt <= t) staged.delete(k);
	}

	/**
	 * `xfer_get`: one chunk of a file, read through the file server rather than off
	 * the disk, so the tree's rules (the share root, what exists, what is a file)
	 * stay in the one place that already decides them.
	 *
	 * A range that starts past the end is how the end is learned: `dufs` answers 416
	 * with a `content-range` whose only value is the total, and that total is what
	 * lets the last call of a loop answer "done" instead of asking for a chunk that
	 * cannot exist.
	 */
	async function getChunk(args: unknown, sid: string | null): Promise<XferToolResult> {
		const a = (args ?? {}) as { name?: unknown; offset?: unknown; maxBytes?: unknown };
		const named = shareName(a.name);
		if ("why" in named) {
			await auditXfer(sid, "get", { name: String(a.name) }, named.why);
			return text(named.why, true);
		}
		const s = share;
		if (s === null) {
			const why = "nothing is shared — call xfer_share first, then xfer_get";
			await auditXfer(sid, "get", { name: named.name }, why);
			return text(why, true);
		}
		const offset = Number.isInteger(a.offset) && (a.offset as number) >= 0 ? (a.offset as number) : 0;
		const asked = typeof a.maxBytes === "number" && a.maxBytes > 0 ? Math.floor(a.maxBytes) : GET_CHUNK_BYTES;
		const want = Math.max(1, Math.min(asked, GET_CHUNK_MAX));
		const send = (first: number, last: number) =>
			fetch(fileUrl(s, named.name), { headers: { authorization: s.auth, range: `bytes=${first}-${last}` } });
		const answer = { name: named.name, offset };
		const done = (total: number | null): XferToolResult =>
			text({ ...answer, total, bytes: 0, next: null, encoding: "base64", data: "" });
		let r: Response;
		try {
			r = await send(offset, offset + want - 1);
			// `dufs` refuses a range whose *end* passes the end of the file with a 416,
			// and that is the last chunk of every file that is not a multiple of the
			// chunk. Its 416 carries the size, so the retry asks for what is there
			// instead of handing the caller a short answer as if it were finished.
			if (r.status === 416) {
				const size = Number(/\/(\d+)\s*$/.exec(r.headers.get("content-range") ?? "")?.[1] ?? -1);
				if (size > offset) r = await send(offset, size - 1);
				else {
					await auditXfer(sid, "get", { ...answer, bytes: 0 }, null);
					return done(size >= 0 ? size : null);
				}
			}
		} catch (e) {
			const why = `cannot reach the file server: ${(e as Error).message}`;
			await auditXfer(sid, "get", { name: named.name, offset }, why);
			return text(why, true);
		}
		if (r.status === 416) {
			const size = Number(/\/(\d+)\s*$/.exec(r.headers.get("content-range") ?? "")?.[1] ?? -1);
			await auditXfer(sid, "get", { ...answer, bytes: 0 }, null);
			return done(size >= 0 ? size : null);
		}
		if (r.status === 404) {
			const why = `no file named '${named.name}' in the share — a directory is listed with the host's own tools, not read in chunks`;
			await auditXfer(sid, "get", answer, why);
			return text(why, true);
		}
		if (!r.ok) {
			const why = `the file server answered ${r.status}`;
			await auditXfer(sid, "get", answer, why);
			return text(why, true);
		}
		// No `content-range` on a 200 means the range was ignored, which for this
		// server is what a directory looks like: answering with the whole file here
		// would hand a caller a chunk that is not one.
		const range = /bytes\s+\d+-\d+\/(\d+)\s*$/.exec(r.headers.get("content-range") ?? "");
		if (range === null) {
			const why = `'${named.name}' did not answer a range request — it is not a file this share can read in chunks`;
			await auditXfer(sid, "get", answer, why);
			return text(why, true);
		}
		const body = Buffer.from(await r.arrayBuffer());
		const total = Number(range[1]);
		const next = offset + body.length < total ? offset + body.length : null;
		await auditXfer(sid, "get", { ...answer, bytes: body.length }, null);
		return text({
			...answer,
			total,
			bytes: body.length,
			next,
			encoding: "base64",
			data: body.toString("base64"),
		});
	}

	/**
	 * `xfer_put`: a file written from base64, whole or in pieces.
	 *
	 * The pieces are held here until the last one arrives, and the file itself is
	 * written by the file server — one PUT of the assembled bytes, so the share stays
	 * the only thing that writes into the tree, and a path the server refuses (outside
	 * the root, a directory that does not exist) is refused in the server's words.
	 *
	 * A file larger than `PUT_MAX_BYTES` is refused rather than buffered without a
	 * ceiling: the route moves those without this process holding them.
	 */
	async function putChunk(args: unknown, sid: string | null): Promise<XferToolResult> {
		const a = (args ?? {}) as { name?: unknown; data?: unknown; offset?: unknown; total?: unknown };
		const named = shareName(a.name);
		if ("why" in named) {
			await auditXfer(sid, "put", { name: String(a.name) }, named.why);
			return text(named.why, true);
		}
		const s = share;
		if (s === null) {
			const why = "nothing is shared — call xfer_share first, then xfer_put";
			await auditXfer(sid, "put", { name: named.name }, why);
			return text(why, true);
		}
		const bytes = typeof a.data === "string" ? decodeBase64(a.data) : null;
		if (bytes === null) {
			const why = "a 'data' is required — the chunk's bytes as base64";
			await auditXfer(sid, "put", { name: named.name }, why);
			return text(why, true);
		}
		const offset = Number.isInteger(a.offset) && (a.offset as number) >= 0 ? (a.offset as number) : 0;
		sweepStaged();
		const key = `${sid ?? ""}\u0000${named.name}`;
		let held = offset === 0 ? null : (staged.get(key) ?? null);
		// The size is announced once — by the first chunk, or by any later one that
		// repeats it. A piece that says nothing about it is measured against the
		// upload already in flight, not against itself: `offset + length` is only the
		// whole file when the piece is the last one.
		const total =
			Number.isInteger(a.total) && (a.total as number) >= 0
				? (a.total as number)
				: (held?.total ?? offset + bytes.length);
		if (offset + bytes.length > total) {
			const why = `this chunk runs to ${offset + bytes.length} bytes but the file was announced as ${total} — start again with offset 0`;
			await auditXfer(sid, "put", { name: named.name, offset, bytes: bytes.length, total }, why);
			return text(why, true);
		}
		if (total > PUT_MAX_BYTES) {
			const why = `${total} bytes is more than xfer_put carries (${PUT_MAX_BYTES}); a larger file belongs on the /xfer/ route from xfer_share`;
			await auditXfer(sid, "put", { name: named.name, total }, why);
			return text(why, true);
		}
		if (offset === 0) {
			// A fresh start replaces whatever was half-sent under this name: that is
			// what a caller retrying after a lost reply needs, and it cannot lose
			// anything the caller still thinks it sent.
			staged.delete(key);
			if (total > bytes.length) {
				if (staged.size >= PUT_SLOTS) {
					// Oldest deadline first: the upload nearest to being forgotten.
					const oldest = [...staged.entries()].sort((x, y) => x[1].expiresAt - y[1].expiresAt)[0];
					if (oldest) staged.delete(oldest[0]);
				}
				held = { name: named.name, parts: [], received: 0, total, expiresAt: now() + PUT_IDLE_MS };
				staged.set(key, held);
			}
		} else if (held === null) {
			const why = `no upload of '${named.name}' is in flight — start again with offset 0`;
			await auditXfer(sid, "put", { name: named.name, offset }, why);
			return text(why, true);
		} else if (held.total !== total) {
			staged.delete(key);
			const why = `'${named.name}' was announced as ${held.total} bytes, not ${total} — start again with offset 0`;
			await auditXfer(sid, "put", { name: named.name, total }, why);
			return text(why, true);
		} else if (held.received !== offset) {
			const why = `expected offset ${held.received} for '${named.name}', not ${offset} — the next chunk continues where the last one ended`;
			await auditXfer(sid, "put", { name: named.name, offset, expected: held.received }, why);
			return text(why, true);
		}
		if (held !== null) {
			held.parts.push(bytes);
			held.received += bytes.length;
			held.expiresAt = now() + PUT_IDLE_MS;
			if (held.received > held.total) {
				staged.delete(key);
				const why = `'${named.name}' received ${held.received} bytes but was announced as ${held.total} — start again with offset 0`;
				await auditXfer(sid, "put", { name: named.name, total }, why);
				return text(why, true);
			}
			if (held.received < held.total) {
				await auditXfer(sid, "put", { name: named.name, offset, bytes: bytes.length }, null);
				return text({
					name: named.name,
					received: held.received,
					total: held.total,
					next: held.received,
					done: false,
				});
			}
			staged.delete(key);
		}
		const body = held === null ? bytes : Buffer.concat(held.parts);
		let r: Response;
		try {
			r = await fetch(fileUrl(s, named.name), {
				method: "PUT",
				headers: { authorization: s.auth },
				// A fresh view over its own ArrayBuffer: `Buffer` types its buffer as
				// ArrayBufferLike, which fetch's BodyInit does not take.
				body: new Uint8Array(body),
			});
		} catch (e) {
			const why = `cannot reach the file server: ${(e as Error).message}`;
			await auditXfer(sid, "put", { name: named.name, bytes: body.length }, why);
			return text(why, true);
		}
		if (!r.ok) {
			const why =
				r.status === 404
					? `no directory named '${named.name}' in the share — the file server does not create one on upload`
					: `the file server refused the upload (status ${r.status})`;
			await auditXfer(sid, "put", { name: named.name, bytes: body.length }, why);
			return text(why, true);
		}
		await auditXfer(sid, "put", { name: named.name, bytes: body.length }, null);
		return text({ name: named.name, bytes: body.length, done: true });
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
				if (name === "xfer_get") return await getChunk(args, sid);
				if (name === "xfer_put") return await putChunk(args, sid);
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
