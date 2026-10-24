#!/usr/bin/env node
/**
 * A stdio MCP proxy for the a2mcp bridge, with file transfer.
 *
 * It forwards every message to the bridge's HTTP endpoint, so the host's tools
 * appear exactly as they do to any MCP client. What it adds is two local tools:
 * `a2mcp_upload` and `a2mcp_download`. Those take a path on each side and move
 * the bytes over the bridge's `/xfer/` WebDAV route in chunks — a Range GET per
 * download chunk, a PUT for the first upload chunk and `PATCH X-Update-Range:
 * append` for the rest. No file byte, and no base64, enters the MCP conversation.
 *
 * Zero dependencies; Node 20+ or Bun. Wire it into `mcp.json` as a stdio server:
 *
 *   {"command": "node", "args": ["/path/to/a2mcp-proxy.mjs"],
 *    "env": {"A2MCP_URL": "http://127.0.0.1:8787/", "A2MCP_TOKEN": "..."}}
 *
 * With no MCP client in reach it also moves a single file from the command line:
 *
 *   node a2mcp-proxy.mjs upload LOCAL_PATH HOST_PATH
 *   node a2mcp-proxy.mjs download HOST_PATH LOCAL_PATH
 *
 * That path runs the same chunked, resumable transfer and the same share rules;
 * it exists so an agent with a shell does not have to write its own client.
 *
 * The token is read from the environment by preference: a token in argv is
 * visible in `ps`. It is never printed.
 *
 * Shares are the host's call, and there is exactly one at a time. The proxy
 * reuses an existing share that covers the path; otherwise it opens one with
 * `xfer_share` and closes it afterwards, but only if the share is still the one
 * it opened. It never replaces a share it did not create and never stops one it
 * did not open.
 *
 * Uploads do not overwrite: the share grants `--allow-upload` only, so a
 * non-empty remote file cannot be replaced through it. The single exception is
 * resuming the proxy's own interrupted upload, proven by a state file under
 * `os.tmpdir()/a2mcp-proxy/` and by the remote file's prefix.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "2025-11-25";
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const MIN_CHUNK_BYTES = 4 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const XFER_ROUTE = "/xfer";
const STATE_DIR = join(tmpdir(), "a2mcp-proxy");

const LOCAL_TOOL_NAMES = ["a2mcp_upload", "a2mcp_download"];

export const LOCAL_TOOLS = [
	{
		name: "a2mcp_upload",
		description:
			"Upload a file to the host over the bridge's /xfer route, in chunks. `localPath` is on the machine " +
			"running this proxy; `remotePath` is on the host (the target's directory must exist). Bytes never enter " +
			"the MCP conversation. A non-empty remote file is never overwritten; call again with the same arguments " +
			"to resume this proxy's own interrupted upload.",
		inputSchema: {
			type: "object",
			properties: {
				localPath: { type: "string", description: "File on this machine. `~/x` expands to this machine's home." },
				remotePath: { type: "string", description: "Absolute path on the host (`/x`, `C:/x`, `//host/share/x`)." },
			},
			required: ["localPath", "remotePath"],
		},
	},
	{
		name: "a2mcp_download",
		description:
			"Download a file from the host over the bridge's /xfer route, in chunks, to this machine. `remotePath` " +
			"is on the host; `localPath` is the destination here and is replaced atomically. An interrupted " +
			"download resumes from `<localPath>.a2mcp-part`. Bytes never enter the MCP conversation.",
		inputSchema: {
			type: "object",
			properties: {
				remotePath: { type: "string", description: "Absolute path on the host (`/x`, `C:/x`, `//host/share/x`)." },
				localPath: {
					type: "string",
					description: "Destination on this machine. `~/x` expands to this machine's home.",
				},
			},
			required: ["remotePath", "localPath"],
		},
	},
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * A remote path in one spelling: forward slashes, no `.` or `..`, no trailing
 * slash. Absolute POSIX, Windows-drive and UNC paths keep their root; `~` and
 * `~/x` are kept for the host to expand.
 */
export function normalizeRemote(input) {
	if (typeof input !== "string" || input.trim().length === 0) {
		throw new Error("a remote path is required");
	}
	if (input.includes("\0")) throw new Error("a remote path cannot contain NUL");
	const raw = input.trim().replaceAll("\\", "/");
	const kind = /^[A-Za-z]:\//.test(raw)
		? "drive"
		: raw.startsWith("//")
			? "unc"
			: raw.startsWith("/")
				? "posix"
				: raw === "~" || raw.startsWith("~/")
					? "home"
					: "relative";
	if (kind === "relative") {
		throw new Error(`'${input}' is not an absolute host path — use '/x', 'C:/x', '//host/share/x' or '~/x'`);
	}
	const rest =
		kind === "drive" ? raw.slice(3) : kind === "unc" ? raw.slice(2) : kind === "posix" ? raw.slice(1) : raw.slice(1);
	const parts = [];
	for (const seg of rest.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") throw new Error(`'${input}' contains '..' — a remote path is taken as given`);
		parts.push(seg);
	}
	if (kind === "unc" && parts.length < 2) {
		throw new Error(`'${input}' is not a UNC share — it needs a server and a share name`);
	}
	if (kind === "drive") return `${raw.slice(0, 2)}/${parts.join("/")}`;
	if (kind === "unc") return `//${parts.join("/")}`;
	if (kind === "posix") return `/${parts.join("/")}`;
	return parts.length === 0 ? "~" : `~/${parts.join("/")}`;
}

function windowsLike(path) {
	return /^[A-Za-z]:\//.test(path) || path.startsWith("//");
}

export function isAbsoluteRemote(path) {
	try {
		const p = normalizeRemote(path);
		return p !== "~" && !p.startsWith("~/");
	} catch {
		return false;
	}
}

/** Same-tree test. Windows drives and UNC compare case-insensitively. */
export function covers(root, target) {
	const r = normalizeRemote(root);
	const t = normalizeRemote(target);
	const fold = windowsLike(r) || windowsLike(t) ? (s) => s.toLowerCase() : (s) => s;
	const rr = fold(r);
	const tt = fold(t);
	if (rr === tt) return true;
	return tt.startsWith(rr.endsWith("/") ? rr : `${rr}/`);
}

/**
 * The name under the share root, percent-encoded per segment. Empty means the
 * target *is* the shared path — which for a single-file share is the route root.
 */
export function relativeName(root, target) {
	if (!covers(root, target))
		throw new Error(`${normalizeRemote(target)} is outside the share at ${normalizeRemote(root)}`);
	const r = normalizeRemote(root);
	const t = normalizeRemote(target);
	const fold = windowsLike(r) || windowsLike(t) ? (s) => s.toLowerCase() : (s) => s;
	if (fold(r) === fold(t)) return "";
	const base = r.endsWith("/") ? r : `${r}/`;
	return t.slice(base.length).split("/").map(encodeURIComponent).join("/");
}

export function dirnameRemote(input) {
	const p = normalizeRemote(input);
	if (p === "/" || p === "~") return p;
	if (/^[A-Za-z]:\/$/.test(p)) return p;
	if (/^[A-Za-z]:\//.test(p) && !p.slice(3).includes("/")) return `${p.slice(0, 2)}/`;
	if (p.startsWith("//")) {
		const parts = p.slice(2).split("/");
		return parts.length <= 2 ? p : `//${parts.slice(0, -1).join("/")}`;
	}
	if (p.startsWith("~/") && !p.slice(2).includes("/")) return "~";
	const i = p.lastIndexOf("/");
	if (i === 0) return "/";
	return p.slice(0, i);
}

export function basenameRemote(input) {
	const p = normalizeRemote(input);
	const i = p.lastIndexOf("/");
	return i < 0 ? p : p.slice(i + 1);
}

/** The one place the route's URL is spelled. `relative` is the output of `relativeName`. */
export function xferUrl(baseUrl, relative) {
	return `${baseUrl.replace(/\/+$/, "")}${XFER_ROUTE}/${relative}`;
}

export function resolveLocalPath(input) {
	if (typeof input !== "string" || input.trim().length === 0) throw new Error("a local path is required");
	const raw = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
	return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
}

// ---------------------------------------------------------------------------
// Chunk and resume decisions (pure, so the tests can pin them)
// ---------------------------------------------------------------------------

export function clampChunkBytes(value) {
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK_BYTES;
	return Math.max(MIN_CHUNK_BYTES, Math.min(Math.floor(n), MAX_CHUNK_BYTES));
}

/** Where a resumed download starts: the part's length, or zero when the part is not this file. */
export function downloadResumeFrom(partSize, sidecar, remote) {
	if (!Number.isInteger(partSize) || partSize <= 0) return 0;
	if (!sidecar || typeof sidecar !== "object") return 0;
	if (sidecar.size !== remote.size) return 0;
	if (sidecar.etag && remote.etag && sidecar.etag !== remote.etag) return 0;
	if (partSize > remote.size) return 0;
	return partSize;
}

/**
 * Whether an existing non-empty remote file may be appended to, and from where.
 * Everything except a proven own-upload resume is refused: dufs is granted
 * upload but not delete, and this is where that boundary is turned into words.
 */
export function planUploadResume(state, local, remoteSize) {
	if (remoteSize === 0) return { start: 0, resumed: false };
	if (!state || typeof state !== "object") {
		return { refuse: `the host already has ${remoteSize} bytes there` };
	}
	if (state.source !== local.path) return { refuse: "the saved upload state is for a different local file" };
	if (state.size !== local.size)
		return { refuse: `the local file was ${state.size} bytes when the upload started, now ${local.size}` };
	if (state.mtimeMs !== local.mtimeMs) return { refuse: "the local file changed since the upload started" };
	if (state.sent !== remoteSize) {
		return { refuse: `the interrupted upload reached ${state.sent} bytes, but the host now has ${remoteSize}` };
	}
	if (typeof state.prefixSha256 !== "string") return { refuse: "the saved upload state has no prefix checksum" };
	return { start: remoteSize, resumed: true, prefixSha256: state.prefixSha256 };
}

// ---------------------------------------------------------------------------
// Bridge client
// ---------------------------------------------------------------------------

class BridgeError extends Error {}
class SessionExpired extends BridgeError {}
class RpcError extends Error {
	constructor(error) {
		super(`JSON-RPC error ${error?.code}: ${error?.message}`);
		this.rpc = error;
	}
}

class Bridge {
	constructor(url, token) {
		this.url = url.replace(/\/+$/, "") + "/";
		this.base = url.replace(/\/+$/, "");
		this.token = token;
		this.sid = null;
		this.nextId = 1;
		this.handshaking = null;
	}

	async postRaw(message, { withSid = true } = {}) {
		const headers = {
			"content-type": "application/json",
			accept: "application/json",
			authorization: `Bearer ${this.token}`,
		};
		if (withSid && this.sid) headers["mcp-session-id"] = this.sid;
		let res;
		try {
			res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(message) });
		} catch (e) {
			throw new BridgeError(`cannot reach ${this.url}: ${e?.message ?? e}`);
		}
		const sid = res.headers.get("mcp-session-id");
		if (sid) this.sid = sid;
		if (res.status === 400 || res.status === 404) {
			await res.arrayBuffer().catch(() => {});
			throw new SessionExpired(`HTTP ${res.status} — the bridge session is missing or expired`);
		}
		if (res.status === 401) {
			await res.arrayBuffer().catch(() => {});
			throw new BridgeError("401 unauthorized — the token does not match the bridge config");
		}
		if (message.id === undefined) {
			await res.arrayBuffer().catch(() => {});
			if (!res.ok) throw new BridgeError(`HTTP ${res.status} for ${message.method}`);
			return undefined;
		}
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).trim();
			throw new BridgeError(`HTTP ${res.status}: ${detail || res.statusText}`);
		}
		let body;
		try {
			body = await res.json();
		} catch {
			throw new BridgeError("the bridge answered with something that is not JSON");
		}
		if (body?.error) throw new RpcError(body.error);
		return body?.result;
	}

	async handshake() {
		this.sid = null;
		await this.postRaw(
			{
				jsonrpc: "2.0",
				id: this.nextId++,
				method: "initialize",
				params: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "a2mcp-proxy", version: "1" },
				},
			},
			{ withSid: false },
		);
		if (!this.sid) throw new BridgeError("initialize returned no mcp-session-id header");
		await this.postRaw({ jsonrpc: "2.0", method: "notifications/initialized" });
	}

	async ensureSession() {
		if (this.sid) return;
		if (!this.handshaking) {
			this.handshaking = this.handshake().finally(() => {
				this.handshaking = null;
			});
		}
		await this.handshaking;
	}

	/** One request, one re-handshake and retry when the bridge lost the session. */
	async rpc(method, params) {
		await this.ensureSession();
		const before = this.sid;
		try {
			return await this.postRaw({ jsonrpc: "2.0", id: this.nextId++, method, params });
		} catch (e) {
			if (!(e instanceof SessionExpired)) throw e;
			if (this.sid === before) {
				if (!this.handshaking) {
					this.handshaking = this.handshake().finally(() => {
						this.handshaking = null;
					});
				}
				await this.handshaking;
			}
			return await this.postRaw({ jsonrpc: "2.0", id: this.nextId++, method, params });
		}
	}

	/**
	 * The client's own `initialize`, forwarded verbatim. The proxy adopts the
	 * session id the bridge hands back, so both sides then share one session.
	 */
	async initialize(message) {
		this.sid = null;
		const result = await this.postRaw(message, { withSid: false });
		if (!this.sid) throw new BridgeError("initialize returned no mcp-session-id header");
		return result;
	}

	async notify(method, params) {
		if (!this.sid) return;
		try {
			await this.postRaw({ jsonrpc: "2.0", method, params });
		} catch (e) {
			if (e instanceof SessionExpired) return;
			throw e;
		}
	}

	async close() {
		if (!this.sid) return;
		const sid = this.sid;
		this.sid = null;
		try {
			await fetch(this.url, {
				method: "DELETE",
				headers: { authorization: `Bearer ${this.token}`, "mcp-session-id": sid },
			});
		} catch {
			// Teardown is best-effort; the session expires on its own.
		}
	}
}

// ---------------------------------------------------------------------------
// Local file helpers
// ---------------------------------------------------------------------------

async function writeJsonAtomic(path, value) {
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(value));
	try {
		await rename(tmp, path);
	} catch (e) {
		if (e?.code !== "EEXIST" && e?.code !== "EPERM") throw e;
		await rm(path, { force: true });
		await rename(tmp, path);
	}
}

async function objectOrNull(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

async function sizeOrNull(path) {
	try {
		const st = await stat(path);
		return st.isFile() ? st.size : null;
	} catch {
		return null;
	}
}

async function readRange(fh, offset, length) {
	const buf = Buffer.allocUnsafe(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await fh.read(buf, filled, length - filled, offset + filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return filled === length ? buf : buf.subarray(0, filled);
}

/** Feed `[0, length)` of a file into an existing hash without finalizing it. */
async function hashInto(hash, path, length) {
	const fh = await open(path, "r");
	try {
		let left = length;
		const buf = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, left)));
		while (left > 0) {
			const want = Math.min(left, buf.length);
			const { bytesRead } = await fh.read(buf, 0, want, length - left);
			if (bytesRead === 0) throw new Error(`${path} ended before ${length} bytes`);
			hash.update(buf.subarray(0, bytesRead));
			left -= bytesRead;
		}
	} finally {
		await fh.close();
	}
}

async function sha256File(path) {
	const hash = createHash("sha256");
	const size = await sizeOrNull(path);
	if (size === null) throw new Error(`${path} is not a file`);
	await hashInto(hash, path, size);
	return hash.digest("hex");
}

async function replaceFile(part, target) {
	try {
		await rename(part, target);
	} catch (e) {
		// Windows rename refuses to replace an existing file.
		if (e?.code !== "EEXIST" && e?.code !== "EPERM") throw e;
		await rm(target, { force: true });
		await rename(part, target);
	}
}

// ---------------------------------------------------------------------------
// Talk to the bridge's own xfer tools
// ---------------------------------------------------------------------------

function toolText(result) {
	const parts = Array.isArray(result?.content) ? result.content : [];
	return parts
		.filter((c) => c?.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

async function callXfer(bridge, name, args) {
	const result = await bridge.rpc("tools/call", { name, arguments: args });
	const text = toolText(result);
	let value = null;
	try {
		value = JSON.parse(text);
	} catch {
		value = text;
	}
	if (result?.isError) throw new Error(`${name}: ${text.trim() || "failed"}`);
	return value;
}

async function closeIfOurs(bridge, opened) {
	try {
		const status = await callXfer(bridge, "xfer_status", {});
		if (status?.serving && status.path === opened.path && status.startedAt === opened.startedAt) {
			await callXfer(bridge, "xfer_stop", {});
		}
	} catch (e) {
		process.stderr.write(`[a2mcp-proxy] could not close the share: ${e?.message ?? e}\n`);
	}
}

/**
 * Run `fn` under a share that covers `remotePath`. Reuses the host's share when
 * it covers the path, opens one otherwise, and closes only its own.
 */
async function withShare(bridge, remotePath, kind, fn) {
	const target = normalizeRemote(remotePath);
	const status = await callXfer(bridge, "xfer_status", {});
	let root;
	let relative;
	let mode;
	let opened = null;
	if (status?.serving) {
		if (!isAbsoluteRemote(target)) {
			throw new Error(
				`the host is already serving ${status.path}; '${target}' cannot be matched against it — use the absolute path`,
			);
		}
		root = normalizeRemote(status.path);
		if (!covers(root, target)) {
			throw new Error(
				`the host is already serving ${status.path}, which does not cover ${target}. Stop that share (xfer_stop) or choose a path under it.`,
			);
		}
		relative = relativeName(root, target);
		if (kind === "upload" && relative === "") {
			throw new Error(
				`the host is serving ${status.path} itself; a file share cannot receive an upload — stop it or share its directory`,
			);
		}
		mode = "reused";
	} else {
		const sharePath = kind === "download" ? target : dirnameRemote(target);
		// The share's root as asked for, before the host expands `~`: the reply
		// carries the expanded absolute path, which no longer matches the target.
		relative = relativeName(sharePath, target);
		const shared = await callXfer(bridge, "xfer_share", { path: sharePath });
		root = normalizeRemote(shared.path);
		mode = "opened";
		opened = { path: shared.path, startedAt: shared.startedAt };
	}
	try {
		return await fn({ root, relative, mode });
	} finally {
		if (opened) await closeIfOurs(bridge, opened);
	}
}

// ---------------------------------------------------------------------------
// HTTP file operations through /xfer
// ---------------------------------------------------------------------------

class RouteError extends Error {
	constructor(status, what) {
		super(`${status} ${what}`);
		this.status = status;
	}
}

function routeFailure(status, path) {
	if (status === 401) return new RouteError(status, "unauthorized — the bridge token is wrong");
	if (status === 403)
		return new RouteError(status, `the file server refused ${path} — it may be a directory or already exist`);
	if (status === 404) return new RouteError(status, `${path} is not there`);
	if (status === 416) return new RouteError(status, `the host file changed while ${path} was read`);
	if (status === 502) return new RouteError(status, "the share closed — call again to reopen it");
	return new RouteError(status, `the file server answered ${status} for ${path}`);
}

/** `size`/`etag` of a remote file: 206, 416 for empty, 404 missing, 200 not a plain file. */
async function probeFile(bridge, url) {
	const res = await fetch(url, { headers: { authorization: `Bearer ${bridge.token}`, range: "bytes=0-0" } });
	const etag = res.headers.get("etag");
	const cr = res.headers.get("content-range") ?? "";
	if (res.status === 206) {
		const size = Number(/\/(\d+)\s*$/.exec(cr)?.[1]);
		await res.arrayBuffer().catch(() => {});
		if (!Number.isFinite(size)) throw new Error(`the file server answered a range with '${cr}'`);
		return { exists: true, size, etag, notFile: false };
	}
	if (res.status === 416) {
		const size = Number(/bytes\s+\*\/(\d+)/.exec(cr)?.[1] ?? 0);
		await res.arrayBuffer().catch(() => {});
		return { exists: true, size: Number.isFinite(size) ? size : 0, etag, notFile: false };
	}
	if (res.status === 404) {
		await res.arrayBuffer().catch(() => {});
		return { exists: false, size: 0, etag: null, notFile: false };
	}
	if (res.status === 200) {
		await res.arrayBuffer().catch(() => {});
		return { exists: true, size: null, etag: null, notFile: true };
	}
	await res.arrayBuffer().catch(() => {});
	throw routeFailure(res.status, new URL(url).pathname);
}

async function downloadFile(bridge, remotePath, localPath, chunkBytes) {
	const target = normalizeRemote(remotePath);
	const local = resolveLocalPath(localPath);
	const parent = dirname(local);
	const parentStat = await stat(parent).catch(() => null);
	if (!parentStat?.isDirectory()) throw new Error(`the target directory ${parent} does not exist`);
	if ((await stat(local).catch(() => null))?.isDirectory()) throw new Error(`${local} is a directory`);

	const part = `${local}.a2mcp-part`;
	const sidecarPath = `${part}.json`;

	return await withShare(bridge, target, "download", async ({ relative, mode }) => {
		const url = xferUrl(bridge.base, relative);
		const meta = await probeFile(bridge, url);
		if (!meta.exists)
			throw new Error(`no file at ${target} on the host — directories are listed with the host's own tools`);
		if (meta.notFile) throw new Error(`${target} is a directory, not a file`);

		const partSize = (await sizeOrNull(part)) ?? 0;
		const sidecar = await objectOrNull(sidecarPath);
		const start = downloadResumeFrom(partSize, sidecar, meta);
		if (start === 0 && partSize > 0) await rm(part, { force: true });
		await writeJsonAtomic(sidecarPath, { etag: meta.etag, size: meta.size });

		let offset = start;
		if (meta.size === 0) {
			await writeFile(part, Buffer.alloc(0));
		} else {
			const fh = await open(part, start === 0 ? "w" : "a");
			try {
				while (offset < meta.size) {
					const end = Math.min(offset + chunkBytes - 1, meta.size - 1);
					let res;
					try {
						res = await fetch(url, {
							headers: { authorization: `Bearer ${bridge.token}`, range: `bytes=${offset}-${end}` },
						});
					} catch (e) {
						throw new Error(
							`the download stopped at ${offset} of ${meta.size} bytes: ${e?.message ?? e} — run it again to resume`,
						);
					}
					if (res.status === 416) {
						await res.arrayBuffer().catch(() => {});
						const now = await probeFile(bridge, url);
						if (!now.exists || now.size !== meta.size) {
							throw new Error(`${target} changed while it was being downloaded — run it again`);
						}
						break;
					}
					if (res.status === 200) {
						await res.arrayBuffer().catch(() => {});
						throw new Error(
							`${target} did not answer a range request — it is not a file this route can read in chunks`,
						);
					}
					if (!res.ok) {
						await res.arrayBuffer().catch(() => {});
						throw routeFailure(res.status, target);
					}
					const buf = Buffer.from(await res.arrayBuffer());
					if (buf.length === 0) break;
					await fh.write(buf, 0, buf.length);
					offset += buf.length;
				}
			} finally {
				await fh.close();
			}
		}

		const after = await probeFile(bridge, url);
		if (!after.exists || after.size !== meta.size || (meta.etag && after.etag && meta.etag !== after.etag)) {
			await rm(part, { force: true });
			await rm(sidecarPath, { force: true });
			throw new Error(`${target} changed while it was being downloaded — run it again`);
		}
		if (offset !== meta.size) {
			throw new Error(
				`the download stopped at ${offset} of ${meta.size} bytes — run it again to resume from ${offset}`,
			);
		}
		await replaceFile(part, local);
		await rm(sidecarPath, { force: true });
		const sha256 = await sha256File(local);
		return {
			ok: true,
			localPath: local,
			remotePath: target,
			bytes: meta.size,
			sha256,
			resumedFrom: start,
			share: mode,
		};
	});
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function sendChunk(bridge, url, buf, offset) {
	if (offset === 0) {
		return await fetch(url, {
			method: "PUT",
			headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/octet-stream" },
			body: new Uint8Array(buf),
		});
	}
	return await fetch(url, {
		method: "PATCH",
		headers: {
			authorization: `Bearer ${bridge.token}`,
			"content-type": "application/octet-stream",
			"x-update-range": "append",
		},
		body: new Uint8Array(buf),
	});
}

async function uploadFile(bridge, localPath, remotePath, chunkBytes) {
	const local = resolveLocalPath(localPath);
	const target = normalizeRemote(remotePath);
	const st = await stat(local).catch(() => null);
	if (!st?.isFile()) throw new Error(`${local} is not a file`);
	const localInfo = { path: local, size: st.size, mtimeMs: st.mtimeMs };
	if (localInfo.size > 0 && basenameRemote(target).length === 0) {
		throw new Error(`${target} does not name a file`);
	}

	const key = createHash("sha256").update(`${bridge.url}\n${target}`).digest("hex");
	const statePath = join(STATE_DIR, `${key}.json`);

	return await withShare(bridge, target, "upload", async ({ relative, mode }) => {
		const url = xferUrl(bridge.base, relative);
		const remote = await probeFile(bridge, url);
		if (remote.notFile) throw new Error(`${target} is a directory on the host`);

		const state = await objectOrNull(statePath);
		const plan = planUploadResume(state, localInfo, remote.exists ? remote.size : 0);
		if (plan.refuse) {
			throw new Error(
				`${target} already has ${remote.size} bytes on the host and cannot be overwritten: ${plan.refuse}. Delete it on the host first.`,
			);
		}
		await mkdir(STATE_DIR, { recursive: true });

		const hash = createHash("sha256");
		let offset = plan.start;
		if (plan.resumed) {
			await hashInto(hash, local, offset);
			const prefix = hash.copy().digest("hex");
			if (prefix !== plan.prefixSha256) {
				throw new Error(
					`${target} holds bytes that are not the start of ${local} — the saved state is stale. Delete the host file first.`,
				);
			}
		}
		if (offset > localInfo.size) throw new Error(`the host file is longer than ${local} — delete it on the host first`);

		const saveState = async () => {
			await writeJsonAtomic(statePath, {
				source: local,
				size: localInfo.size,
				mtimeMs: localInfo.mtimeMs,
				sent: offset,
				prefixSha256: hash.copy().digest("hex"),
				remotePath: target,
			});
		};

		if (localInfo.size === 0) {
			// An empty file still needs one request to exist.
			const res = await sendChunk(bridge, url, Buffer.alloc(0), 0);
			await res.arrayBuffer().catch(() => {});
			if (!res.ok) throw routeFailure(res.status, target);
			await rm(statePath, { force: true });
			return {
				ok: true,
				localPath: local,
				remotePath: target,
				bytes: 0,
				sha256: hash.digest("hex"),
				resumedFrom: 0,
				share: mode,
			};
		}

		const fh = await open(local, "r");
		try {
			while (offset < localInfo.size) {
				const want = Math.min(chunkBytes, localInfo.size - offset);
				const buf = await readRange(fh, offset, want);
				if (buf.length !== want) throw new Error(`${local} changed size while it was being uploaded`);
				let res;
				try {
					res = await sendChunk(bridge, url, buf, offset);
				} catch (e) {
					res = null;
					const confirmed = await probeFile(bridge, url).catch(() => null);
					if (confirmed?.exists && confirmed.size > offset && confirmed.size <= offset + buf.length) {
						const written = confirmed.size - offset;
						hash.update(buf.subarray(0, written));
						offset = confirmed.size;
						await saveState();
						continue;
					}
					throw new Error(
						`the upload stopped at ${offset} of ${localInfo.size} bytes: ${e?.message ?? e} — run it again to resume`,
					);
				}
				if (res.ok) {
					await res.arrayBuffer().catch(() => {});
					hash.update(buf);
					offset += buf.length;
					await saveState();
					continue;
				}
				await res.arrayBuffer().catch(() => {});
				// The request failed after the body may have landed: the file's current
				// length is the only truthful answer about how much was written.
				const confirmed = await probeFile(bridge, url).catch(() => null);
				if (confirmed?.exists && confirmed.size > offset && confirmed.size <= offset + buf.length) {
					const written = confirmed.size - offset;
					hash.update(buf.subarray(0, written));
					offset = confirmed.size;
					await saveState();
					continue;
				}
				if (res.status >= 500 && confirmed?.exists && confirmed.size === offset) {
					// Nothing landed and the server faltered: retry this chunk once.
					const retry = await sendChunk(bridge, url, buf, offset);
					if (retry.ok) {
						await retry.arrayBuffer().catch(() => {});
						hash.update(buf);
						offset += buf.length;
						await saveState();
						continue;
					}
					await retry.arrayBuffer().catch(() => {});
					throw routeFailure(retry.status, target);
				}
				throw routeFailure(res.status, target);
			}
		} finally {
			await fh.close();
		}

		await rm(statePath, { force: true });
		return {
			ok: true,
			localPath: local,
			remotePath: target,
			bytes: localInfo.size,
			sha256: hash.digest("hex"),
			resumedFrom: plan.start,
			share: mode,
		};
	});
}

// ---------------------------------------------------------------------------
// stdio JSON-RPC
// ---------------------------------------------------------------------------

function result(id, value) {
	return { jsonrpc: "2.0", id, result: value };
}

function rpcError(id, error) {
	return { jsonrpc: "2.0", id, error };
}

function toolError(id, message) {
	return result(id, { content: [{ type: "text", text: message }], isError: true });
}

function errorFor(id, e) {
	if (e instanceof RpcError) return rpcError(id, e.rpc);
	const message = e?.message ?? String(e);
	return rpcError(id, { code: -32603, message });
}

function forwardable(message) {
	return {
		jsonrpc: "2.0",
		id: message.id,
		method: message.method,
		...(message.params !== undefined ? { params: message.params } : {}),
	};
}

export function parseArgs(argv, env = process.env) {
	const out = {
		url: env.A2MCP_URL ?? "",
		token: env.A2MCP_TOKEN ?? "",
		chunkBytes: clampChunkBytes(env.A2MCP_CHUNK_BYTES ?? DEFAULT_CHUNK_BYTES),
		help: false,
		command: null,
		operands: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const [flag, inline] =
			arg.startsWith("--") && arg.includes("=")
				? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
				: [arg, null];
		const value = () => {
			if (inline !== null) return inline;
			const next = argv[++i];
			if (next === undefined) throw new Error(`${flag} needs a value`);
			return next;
		};
		if (flag === "--help" || flag === "-h") out.help = true;
		else if (flag === "--url") out.url = value();
		else if (flag === "--token") out.token = value();
		else if (flag === "--chunk-bytes") out.chunkBytes = clampChunkBytes(value());
		else if ((arg === "upload" || arg === "download") && out.command === null) out.command = arg;
		else if (!arg.startsWith("-") && out.command !== null && out.operands.length < 2) out.operands.push(arg);
		else throw new Error(`unknown argument '${arg}'`);
	}
	if (out.command !== null && out.operands.length !== 2) {
		throw new Error(
			out.command === "upload"
				? "upload needs a local path and a host path"
				: "download needs a host path and a local path",
		);
	}
	return out;
}

const USAGE = `a2mcp-proxy — a stdio MCP proxy for the a2mcp bridge, with chunked file transfer.

Usage:
  node a2mcp-proxy.mjs [--url URL] [--token TOKEN] [--chunk-bytes N]
  node a2mcp-proxy.mjs upload LOCAL_PATH HOST_PATH
  node a2mcp-proxy.mjs download HOST_PATH LOCAL_PATH

  --url          bridge URL, or A2MCP_URL
  --token        Bearer token, or A2MCP_TOKEN (preferred: argv is visible in ps)
  --chunk-bytes  bytes per chunk, 4096..67108864 (default 8388608), or A2MCP_CHUNK_BYTES

MCP client configuration:
  {"command": "node", "args": ["a2mcp-proxy.mjs"],
   "env": {"A2MCP_URL": "http://127.0.0.1:8787/", "A2MCP_TOKEN": "..."}}

Adds two tools: a2mcp_upload {localPath, remotePath}, a2mcp_download {remotePath, localPath}.
File bytes travel over the bridge's /xfer route; they never enter the conversation.

upload / download move one file and exit, for a shell with no MCP client: same
chunks, same resume, same share rules (reuse a covering share, open one when none
does, close only the one it opened). They print a compact JSON result.`;

async function run(opts) {
	const bridge = new Bridge(opts.url, opts.token);
	let fileQueue = Promise.resolve();
	const serialize = (fn) => {
		const run = fileQueue.then(fn, fn);
		fileQueue = run.then(
			() => {},
			() => {},
		);
		return run;
	};

	const write = (message) => {
		process.stdout.write(`${JSON.stringify(message)}\n`);
	};

	const handleLocalCall = async (id, name, args) => {
		const a = args ?? {};
		if (name === "a2mcp_upload") {
			if (typeof a.localPath !== "string" || typeof a.remotePath !== "string") {
				write(toolError(id, "a2mcp_upload needs 'localPath' and 'remotePath'"));
				return;
			}
			try {
				const value = await serialize(() => uploadFile(bridge, a.localPath, a.remotePath, opts.chunkBytes));
				write(result(id, { content: [{ type: "text", text: JSON.stringify(value) }], isError: false }));
			} catch (e) {
				write(toolError(id, e?.message ?? String(e)));
			}
			return;
		}
		if (typeof a.remotePath !== "string" || typeof a.localPath !== "string") {
			write(toolError(id, "a2mcp_download needs 'remotePath' and 'localPath'"));
			return;
		}
		try {
			const value = await serialize(() => downloadFile(bridge, a.remotePath, a.localPath, opts.chunkBytes));
			write(result(id, { content: [{ type: "text", text: JSON.stringify(value) }], isError: false }));
		} catch (e) {
			write(toolError(id, e?.message ?? String(e)));
		}
	};

	const handle = async (message) => {
		const id = message.id;
		const isRequest = id !== undefined && id !== null;
		try {
			if (message.method === "initialize") {
				const value = await bridge.initialize(forwardable(message));
				write(result(id, value));
				return;
			}
			if (message.method?.startsWith("notifications/")) {
				await bridge.notify(message.method, message.params);
				return;
			}
			if (message.method === "tools/list") {
				const listed = await bridge.rpc("tools/list", message.params ?? {});
				const tools = Array.isArray(listed?.tools) ? listed.tools : [];
				const merged = {
					...listed,
					tools: [...tools.filter((t) => !LOCAL_TOOL_NAMES.includes(t?.name)), ...LOCAL_TOOLS],
				};
				if (isRequest) write(result(id, merged));
				return;
			}
			if (message.method === "tools/call") {
				const name = message.params?.name;
				if (LOCAL_TOOL_NAMES.includes(name)) {
					await handleLocalCall(id, name, message.params?.arguments);
					return;
				}
			}
			const value = await bridge.rpc(message.method, message.params);
			if (isRequest) write(result(id, value));
		} catch (e) {
			if (isRequest) write(errorFor(id, e));
		}
	};

	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	rl.on("line", (line) => {
		const text = line.trim();
		if (text.length === 0) return;
		let message;
		try {
			message = JSON.parse(text);
		} catch {
			write(rpcError(null, { code: -32700, message: "parse error" }));
			return;
		}
		if (Array.isArray(message)) {
			write(rpcError(null, { code: -32600, message: "batch requests are not supported" }));
			return;
		}
		if (typeof message !== "object" || message === null || typeof message.method !== "string") {
			write(rpcError(message?.id ?? null, { code: -32600, message: "invalid request" }));
			return;
		}
		// Not awaited: a transfer must not block ping or any other forwarded call.
		void handle(message);
	});
	rl.on("close", () => {
		void fileQueue.finally(() => bridge.close()).finally(() => process.exit(0));
	});
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`a2mcp-proxy: ${e?.message ?? e}\n\n${USAGE}\n`);
		process.exit(2);
	}
	if (opts.help) {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	if (!opts.url) {
		process.stderr.write(`a2mcp-proxy: --url (or A2MCP_URL) is required\n\n${USAGE}\n`);
		process.exit(2);
	}
	if (!opts.token) {
		process.stderr.write(`a2mcp-proxy: --token (or A2MCP_TOKEN) is required\n`);
		process.exit(2);
	}
	if (opts.command !== null) {
		await runCommand(opts);
		return;
	}
	await run(opts);
}

/** One file, then exit. The same transfer the MCP tools run, without the stdio half. */
async function runCommand(opts) {
	const bridge = new Bridge(opts.url, opts.token);
	const [first, second] = opts.operands;
	try {
		const outcome =
			opts.command === "upload"
				? await uploadFile(bridge, first, second, opts.chunkBytes)
				: await downloadFile(bridge, first, second, opts.chunkBytes);
		process.stdout.write(`${JSON.stringify(outcome)}\n`);
	} finally {
		await bridge.close();
	}
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main().catch((e) => {
		process.stderr.write(`a2mcp-proxy: ${e?.message ?? e}\n`);
		process.exit(1);
	});
}
