/**
 * File transfer over plain HTTP, wired into the MCP endpoint as tools.
 *
 * ## What this is, and what it is not
 *
 * There is no transfer protocol here. The bytes never touch JSON-RPC: a tool call
 * says *which* path to hand out, `dufs` serves that path over HTTP, and a
 * cloudflared quick tunnel (src/tunnel.ts) gives it a public hostname. A caller
 * then moves files with `curl`, `rclone`, a browser or a WebDAV client — GET to
 * download, PUT to upload — the same thing they would do against any other HTTP
 * file server.
 *
 * That shape was chosen against the alternative, an encode-and-chunk protocol on
 * the MCP channel: MCP has no binary content type (JSON-RPC is text; its image and
 * resource blocks are base64), the host's `read` tool truncates at ~150 KB and its
 * `bash` at 768 bytes, so in-band bytes cost 33% more and arrive in fragments.
 * Driving an existing HTTP server costs nothing per byte and gives range requests,
 * resumable downloads and directory listings for free.
 *
 * ## Why `dufs`
 *
 * One static binary per platform, no runtime, no config file, no account: GET
 * (with Range), PUT, DELETE, MKCOL/PROPFIND for WebDAV clients, directory
 * listings, and built-in HTTP basic auth so a public hostname is not an open door.
 * `cloudflared` is the other half, and the bridge goes looking for both of them the
 * same way.
 *
 * The binaries are named, and the bridge can go and get them: `xfer.dufs` /
 * `xfer.cloudflared` point at a program, PATH is searched for that name, and when
 * nothing answers, `src/obtain.ts` downloads the pinned build, verifies it against
 * the sha256 pinned beside the version, and installs it to `~/.local/bin`. A value
 * containing a `/` is the operator saying "use exactly this" and is never
 * downloaded for. See `src/obtain.ts` for why that is the shape it is.
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
import { type BinaryName, type ObtainDeps, type Resolved, resolveBinary } from "./obtain.ts";
import type { McpContent, McpTool } from "./server.ts";
import { openQuickTunnel, type QuickTunnel, type TunnelOpener } from "./tunnel.ts";

/** How long a share stays open when the caller does not say. */
const DEFAULT_TTL_SECONDS = 3600;

/** Every tool this module owns. The bridge's catalog appends exactly these. */
export const XFER_TOOL_NAMES = ["xfer_share", "xfer_status", "xfer_stop"] as const;

/**
 * The catalog entries, written the way a caller reads them: what the tool does,
 * what the argument means, and the one thing neither of those implies — that the
 * URL is a capability. Handing it out hands over the directory.
 */
export const XFER_TOOLS: McpTool[] = [
	{
		name: "xfer_share",
		description:
			"Serve a host path over plain HTTP and publish it through a cloudflared quick tunnel. " +
			"Returns a URL with HTTP basic auth credentials embedded: download with GET, upload with PUT, " +
			"or point any WebDAV client at it. Range requests and directory listings work. " +
			"The share closes itself at `ttlSeconds` (default 3600) or on xfer_stop. " +
			"The URL is a capability — whoever holds it can read and write that path until it closes.",
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
		description: "Report the current share, if any: path, local port, public URL, and when it closes.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "xfer_stop",
		description: "Close the current share: stop the HTTP server and the tunnel. Safe to call when nothing is shared.",
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
	url: string;
	host: string;
	user: string;
	secret: string;
	startedAt: number;
	expiresAt: number;
	server: ChildProcess;
	tunnel: QuickTunnel;
	timer: ReturnType<typeof setTimeout>;
}

export interface XferDeps {
	/** Test seam: replace the tunnel opener (the real one needs cloudflared on PATH). */
	openTunnel?: TunnelOpener;
	/** Test seam: replace how a missing binary is found or fetched (src/obtain.ts). */
	resolveBinary?: typeof resolveBinary;
	/** Forwarded to the resolver: `binDir`, `fetchImpl`, `base`, `target`, the caps. */
	obtain?: ObtainDeps;
	now?(): number;
}

export interface Xfer {
	handles(name: string): boolean;
	call(name: string, args: unknown, sid: string | null): Promise<XferToolResult>;
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
			const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { authorization: auth } });
			if (r.status < 500) return;
			last = `status ${r.status}`;
		} catch (e) {
			last = (e as Error).message;
		}
		await Bun.sleep(150);
	}
	throw new Error(`the file server did not answer on 127.0.0.1:${port} within ${timeoutMs}ms (${last})`);
}

export function createXfer(cfg: XferConfig, deps: XferDeps = {}): Xfer {
	const openTunnel: TunnelOpener = deps.openTunnel ?? openQuickTunnel;
	const now = deps.now ?? Date.now;
	const find = deps.resolveBinary ?? resolveBinary;
	const obtain = deps.obtain ?? {};
	/** One call per binary per share: PATH first, then the pinned download (src/obtain.ts). */
	const resolveBin = (name: BinaryName, configured: string, sid: string | null): Promise<Resolved> =>
		find(name, configured, sid, obtain);
	let share: Share | null = null;

	async function close(reason: string): Promise<void> {
		const s = share;
		if (!s) return;
		share = null;
		clearTimeout(s.timer);
		// The waiter is registered before the signal is sent, and the two statements
		// are not separated by an await: the file server answers SIGTERM within a few
		// milliseconds, and `tunnel.stop()` below is real event-loop time enough for
		// its exit to be delivered inside that await (test/xfer.test.ts).
		const dead = exited(s.server);
		s.server.kill("SIGTERM");
		await s.tunnel.stop();
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
		// leaving a public URL open that the caller has stopped thinking about.
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
					"--allow-upload",
					// dufs takes credentials and their role in one string: `user:pass@/path:rw`.
					// Without the `@…` half it refuses the argument outright — which is how this
					// was found, a bare `user:pass` exits 1 with "Invalid auth".
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

		let tunnel: QuickTunnel;
		let cf: Resolved;
		try {
			await waitForServer(server, port, auth, 10_000, () => spawnFailure);
			cf = await resolveBin("cloudflared", cfg.cloudflared, sid);
			tunnel = await openTunnel({ bin: cf.path, port });
		} catch (e) {
			const why = (e as Error).message;
			server.kill("SIGKILL");
			const missing = /ENOENT|not found|127/.test(`${why}${serverErr}`);
			const hint = missing
				? ` — the bridge resolves '${cfg.dufs}' and '${cfg.cloudflared}' itself: PATH first, then a pinned download into ~/.local/bin. A configured value containing '/' is used exactly as given and never fetched`
				: "";
			await auditXfer(sid, "share", { path, port }, why);
			return text(`${why}${hint}`, true);
		}

		const startedAt = now();
		const expiresAt = startedAt + ttl * 1000;
		const host = tunnel.url.replace(/^https?:\/\//, "");
		const timer = setTimeout(() => {
			void close("ttl expired");
		}, ttl * 1000);
		// A pending share must not keep the process alive on its own; shutdown closes
		// it explicitly.
		timer.unref?.();
		share = {
			path,
			port,
			url: `https://${user}:${secret}@${host}/`,
			host,
			user,
			secret,
			startedAt,
			expiresAt,
			server,
			tunnel,
			timer,
		};

		await auditXfer(sid, "share", { path, port, ttl }, null);
		return text({
			url: share.url,
			host: tunnel.url,
			user,
			secret,
			path,
			port,
			replaced,
			startedAt: new Date(startedAt).toISOString(),
			expiresAt: new Date(expiresAt).toISOString(),
			usage: {
				download: `curl -u ${user}:${secret} -O ${tunnel.url}/<name>`,
				upload: `curl -u ${user}:${secret} -T <local> ${tunnel.url}/<name>`,
			},
			// Why this call took a few seconds: a version here means the bridge fetched
			// that build during this call (src/obtain.ts), `null` means it was already there.
			installed: { dufs: dufs.installed?.version ?? null, cloudflared: cf.installed?.version ?? null },
		});
	}

	return {
		handles: (name) => (XFER_TOOL_NAMES as readonly string[]).includes(name),
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
						port: share.port,
						url: share.url,
						host: `https://${share.host}`,
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
