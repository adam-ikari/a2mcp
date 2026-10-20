/**
 * File transfer over plain HTTP, wired into the MCP endpoint as tools.
 *
 * ## What this is, and what it is not
 *
 * There is no transfer protocol here. The bytes never touch JSON-RPC: a tool call says
 * *which* path to hand out, `dufs` serves that path on a loopback port, and the bridge
 * proxies it under `/xfer/` on its own port (src/server.ts). A caller then moves files
 * with `curl`, `rclone`, a browser or a WebDAV client — GET to download, PUT to upload —
 * the same thing they would do against any other HTTP file server, with the same Bearer
 * token the MCP calls use.
 *
 * That shape was chosen against the alternative, an encode-and-chunk protocol on
 * the MCP channel: MCP has no binary content type (JSON-RPC is text; its image and
 * resource blocks are base64), the host's `read` tool truncates at ~150 KB and its
 * `bash` at 768 bytes, so in-band bytes cost 33% more and arrive in fragments.
 * Driving an existing HTTP server costs nothing per byte and gives range requests,
 * resumable downloads and directory listings for free.
 *
 * One port, one gate, rather than one per surface: a cloudflared quick tunnel fronts
 * exactly one origin (src/tunnel.ts), so files and tools share a hostname by sharing
 * this port. Whether that hostname exists at all is the operator's call — `/a2mcp
 * tunnel` — and never a tool's. Without it the route is reachable on the host and
 * through whatever port forward the operator set up, and nothing more.
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
			"Serve a host path over plain HTTP at the bridge's own /xfer/ route, under the same " +
			"Bearer token as the tool calls: download with GET (range requests work), upload with PUT, " +
			"or point any WebDAV client at the route. " +
			"The share closes itself at `ttlSeconds` (default 3600) or on xfer_stop. " +
			"Reachable on the host's loopback; a public hostname appears only while the operator's " +
			"`/a2mcp tunnel` is open, at the same /xfer/ path. " +
			"Sharing a path under this token shares it with every holder of that token.",
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
];

export interface XferToolResult {
	content: McpContent[];
	isError: boolean;
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

	async function close(reason: string): Promise<void> {
		const s = share;
		if (!s) return;
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
		if (reason !== "stop") await auditXfer(null, "close", { path: s.path, port: s.port, why: reason }, null);
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
			const missing = /ENOENT|not found|127/.test(`${why}${serverErr}`);
			const hint = missing
				? ` — the bridge resolves '${cfg.dufs}' itself: PATH first, then a pinned download into ${defaultBinDir(process.env, process.platform)}. A configured value containing '/' or '\\' is used exactly as given and never fetched`
				: "";
			await auditXfer(sid, "share", { path, port }, why);
			return text(`${why}${hint}`, true);
		}

		const startedAt = now();
		const expiresAt = startedAt + ttl * 1000;
		const timer = setTimeout(() => {
			void close("ttl expired");
		}, ttl * 1000);
		// A pending share must not keep the process alive on its own; shutdown closes
		// it explicitly.
		timer.unref?.();
		share = { path, port, auth, startedAt, expiresAt, server, timer };

		const url = routeUrl();
		await auditXfer(sid, "share", { path, port, ttl, route: `${XFER_ROUTE}/` }, null);
		return text({
			url,
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
				public:
					"the same /xfer/ path under the operator's public hostname while `/a2mcp tunnel` is open; " +
					"loopback or an SSH forward only when it is not",
			},
			// Why this call took a few seconds: a version here means the bridge fetched
			// that build during this call (src/obtain.ts), `null` means it was already there.
			installed: { dufs: dufs.installed?.version ?? null },
		});
	}

	return {
		handles: (name) => (XFER_TOOL_NAMES as readonly string[]).includes(name),
		target: () =>
			share === null ? null : { port: share.port, baseUrl: `http://127.0.0.1:${share.port}`, auth: share.auth },
		async call(name, args, sid) {
			try {
				if (name === "xfer_share") return await begin(args, sid);
				if (name === "xfer_stop") {
					const was = share;
					await close("stop");
					await auditXfer(sid, "stop", { path: was?.path ?? null }, null);
					return text(was ? { stopped: true, path: was.path } : { stopped: false, note: "nothing was shared" });
				}
				if (name === "xfer_status") {
					if (!share) return text({ serving: false });
					return text({
						serving: true,
						path: share.path,
						url: routeUrl(),
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
