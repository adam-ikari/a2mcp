/**
 * The client MCP proxy end to end: stdio in, real `dufs` behind a real bridge.
 *
 *   bun run test:proxy
 *
 * `scripts/a2mcp-proxy.mjs` is the answer to "this client can call tools but cannot
 * send an HTTP request with a header". It speaks MCP on stdio, forwards to the bridge,
 * and adds `a2mcp_upload` / `a2mcp_download`, which move bytes over `/xfer` in chunks
 * — never through a tool argument. This probe starts the bridge and a share for real
 * and drives the proxy as an MCP client would.
 *
 * What it pins: the forwarded catalog and calls, a 300 KB download and a 200 KB upload
 * byte-for-byte through 64 KB chunks, a refused overwrite that leaves the remote bytes
 * alone, a share opened and closed by the proxy, a share reused and left open, an
 * unrelated share refusing the transfer, resume of both directions from a
 * half-finished local state, and the same transfers from the command line — the path
 * for an agent that has a shell but cannot change its MCP client config.
 *
 * Not in `bun test` and not in CI: it needs the pinned `dufs` and a Node or Bun
 * runtime to spawn the proxy. Without `dufs` it says so and exits 0, the way the other
 * host probes do.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { BridgeConfig } from "../src/config.ts";
import { startServer, XFER_ROUTE } from "../src/server.ts";
import { createXfer, XFER_TOOLS } from "../src/xfer.ts";

let failures = 0;
function check(cond: unknown, label: string, detail = ""): void {
	console.log(`${cond ? "ok" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
}
function info(msg: string): void {
	console.log(`info: ${msg}`);
}
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const bytesOf = (n: number, seed = 11): Buffer =>
	Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + seed) % 256));

const dufs =
	Bun.which("dufs") ?? (existsSync(join(homedir(), ".local/bin/dufs")) ? join(homedir(), ".local/bin/dufs") : null);
if (!dufs) {
	info("dufs is not on PATH or in ~/.local/bin — cannot run the proxy probe");
	process.exit(0);
}
const node = Bun.which("node");
const runtime = node ?? process.execPath;
const script = join(import.meta.dir, "..", "scripts", "a2mcp-proxy.mjs");

const work = await mkdtemp(join(tmpdir(), "a2mcp-proxy-probe-"));
const shareDir = join(work, "share");
const otherDir = join(work, "other");
const outDir = join(work, "out");
await mkdir(shareDir, { recursive: true });
await mkdir(otherDir, { recursive: true });
await mkdir(outDir, { recursive: true });

const BIG = bytesOf(300_000, 17);
const UP = bytesOf(200_000, 91);
const RESUME = bytesOf(150_000, 43);
await writeFile(join(shareDir, "remote.bin"), BIG);
await writeFile(join(otherDir, "elsewhere.txt"), "not this share");
await writeFile(join(outDir, "up.bin"), UP);
await writeFile(join(outDir, "resume.bin"), RESUME);

const token = randomBytes(24).toString("base64url");
const cfg: BridgeConfig = {
	port: 0,
	host: "127.0.0.1",
	token,
	host_llm: "allow",
	xfer: { dufs, cloudflared: "cloudflared" },
};

let hostCalls = 0;
const xfer = createXfer(cfg.xfer);
const bridge = await startServer(cfg, {
	getTools: async () => [
		{
			name: "host_echo",
			description: "Echo the text it is given.",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		},
		...XFER_TOOLS,
	],
	callTool: async (name, args, sid) => {
		if (xfer.handles(name)) return xfer.call(name, args, sid);
		if (name === "host_echo") {
			hostCalls++;
			return { content: [{ type: "text", text: String((args as { text?: string })?.text ?? "") }], isError: false };
		}
		return { content: [{ type: "text", text: `no tool '${name}'` }], isError: true };
	},
	serverInfo: () => ({ name: "a2mcp-proxy-probe", version: "0.0.0" }),
	xfer: { target: () => xfer.target() },
});
const base = `http://127.0.0.1:${bridge.port}/`;
const auth = { authorization: `Bearer ${token}` };

// --- the proxy, as a client spawns it ----------------------------------------------
const proxy = spawn(runtime, [script], {
	env: { ...process.env, A2MCP_URL: base, A2MCP_TOKEN: token, A2MCP_CHUNK_BYTES: "65536" },
	stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
proxy.stderr.on("data", (c: Buffer) => {
	stderr += c.toString();
});
const rl = createInterface({ input: proxy.stdout });
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: Timer }>();
let nextId = 1;
rl.on("line", (line) => {
	let msg: { id?: number; result?: unknown; error?: { message?: string } };
	try {
		msg = JSON.parse(line);
	} catch {
		info(`proxy wrote a non-JSON line: ${line.slice(0, 120)}`);
		return;
	}
	if (typeof msg.id !== "number") return;
	const p = pending.get(msg.id);
	if (!p) return;
	pending.delete(msg.id);
	clearTimeout(p.timer);
	if (msg.error) p.reject(new Error(msg.error.message ?? "JSON-RPC error"));
	else p.resolve(msg.result);
});
proxy.once("exit", (code) => {
	for (const p of pending.values()) {
		clearTimeout(p.timer);
		p.reject(new Error(`proxy exited (${code}); stderr: ${stderr.slice(0, 300)}`));
	}
	pending.clear();
});

function request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, timeoutMs);
		pending.set(id, { resolve, reject, timer });
		proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}
function notify(method: string, params?: unknown): void {
	proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

type ToolResult = {
	isError?: boolean;
	content?: Array<{ type: string; text?: string }>;
};
async function callTool(
	name: string,
	args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; value: unknown }> {
	const r = (await request("tools/call", { name, arguments: args })) as ToolResult;
	const text = (r.content ?? []).map((c) => c.text ?? "").join("");
	let value: unknown = null;
	try {
		value = JSON.parse(text);
	} catch {
		value = text;
	}
	return { isError: r.isError === true, text, value };
}

async function shareStatus(): Promise<Record<string, unknown>> {
	const r = await callTool("xfer_status", {});
	return (r.value ?? {}) as Record<string, unknown>;
}

/**
 * The same script, run for one file and exit — no stdio MCP client attached.
 * Asynchronous on purpose: the bridge this child talks to lives in this process, so
 * a blocking wait on the child would stop the parent's event loop and deadlock the
 * transfer halfway (measured: 60s timeout, then SIGTERM).
 */
function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
	return new Promise((resolve) => {
		const child = spawn(runtime, [script, ...args], {
			env: { ...process.env, A2MCP_URL: base, A2MCP_TOKEN: token, A2MCP_CHUNK_BYTES: "65536" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (c: Buffer) => {
			out += c.toString();
		});
		child.stderr.on("data", (c: Buffer) => {
			err += c.toString();
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.once("error", (e) => {
			clearTimeout(timer);
			resolve({ code: -1, out, err: `${err} [spawn error: ${e.message}]` });
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, out, err: `${err}${signal ? ` [signal: ${signal}]` : ""}` });
		});
	});
}

try {
	// --- 1. forwarding ------------------------------------------------------------
	const init = (await request("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "proxy-probe", version: "0" },
	})) as { serverInfo?: { name?: string } };
	check(
		init.serverInfo?.name === "a2mcp-proxy-probe",
		"initialize is forwarded to the bridge",
		String(init.serverInfo?.name),
	);
	notify("notifications/initialized");

	const listed = (await request("tools/list", {})) as { tools?: Array<{ name: string }> };
	const names = (listed.tools ?? []).map((t) => t.name);
	check(
		["host_echo", "xfer_share", "xfer_status", "xfer_stop", "a2mcp_upload", "a2mcp_download"].every((n) =>
			names.includes(n),
		),
		"the catalog is the host tools plus three xfer tools plus two local ones",
		names.join(","),
	);
	check(
		names.filter((n) => n === "a2mcp_upload" || n === "a2mcp_download").length === 2,
		"the local tools appear once",
	);

	const echoed = await callTool("host_echo", { text: "still forwarded" });
	check(
		hostCalls === 1 && !echoed.isError && echoed.text === "still forwarded",
		"a host tool call is forwarded verbatim",
	);

	// --- 2. a download the proxy opens and closes a share for ---------------------
	const down = await callTool("a2mcp_download", {
		remotePath: join(shareDir, "remote.bin"),
		localPath: join(outDir, "down.bin"),
	});
	const downValue = down.value as { share?: string; bytes?: number; resumedFrom?: number };
	const downBytes = await readFile(join(outDir, "down.bin")).catch(() => Buffer.alloc(0));
	check(
		!down.isError && sha(downBytes) === sha(BIG) && downValue.share === "opened" && downValue.bytes === BIG.length,
		"a 300 KB download is byte-exact through 64 KB range reads",
		`${downBytes.length} bytes, share=${downValue.share}`,
	);
	const afterDown = await shareStatus();
	check(afterDown.serving === false, "the proxy closed the share it opened", JSON.stringify(afterDown));

	// --- 3. an upload, and a refused overwrite ------------------------------------
	const up = await callTool("a2mcp_upload", {
		localPath: join(outDir, "up.bin"),
		remotePath: join(shareDir, "up.bin"),
	});
	const upBytes = await readFile(join(shareDir, "up.bin")).catch(() => Buffer.alloc(0));
	check(
		!up.isError && sha(upBytes) === sha(UP),
		"a 200 KB upload lands byte-exact, first chunk PUT then PATCH append",
		`${upBytes.length} bytes`,
	);
	const afterUp = await shareStatus();
	check(afterUp.serving === false, "the upload's share was closed too");

	const again = await callTool("a2mcp_upload", {
		localPath: join(outDir, "up.bin"),
		remotePath: join(shareDir, "up.bin"),
	});
	const upBytesAfter = await readFile(join(shareDir, "up.bin")).catch(() => Buffer.alloc(0));
	check(
		again.isError && again.text.includes("cannot be overwritten") && sha(upBytesAfter) === sha(UP),
		"a second upload refuses to overwrite a non-empty remote file, bytes untouched",
		again.text.slice(0, 90),
	);

	// --- 4. an existing share is reused and left open -----------------------------
	const opened = await callTool("xfer_share", { path: shareDir, ttlSeconds: 300 });
	check(!opened.isError, "a share was opened by hand");
	const reusedDown = await callTool("a2mcp_download", {
		remotePath: join(shareDir, "remote.bin"),
		localPath: join(outDir, "down2.bin"),
	});
	check(
		!reusedDown.isError && (reusedDown.value as { share?: string }).share === "reused",
		"a download under an existing share reuses it",
	);
	const statusOpen = await shareStatus();
	check(statusOpen.serving === true, "the reused share is still open after the transfer", JSON.stringify(statusOpen));

	// --- 5. resume an upload from this proxy's own half-written state --------------
	const resumeTarget = join(shareDir, "resume.bin");
	const sent = 40_000;
	const part = await fetch(`${base}${XFER_ROUTE}/resume.bin`, {
		method: "PUT",
		headers: auth,
		body: new Uint8Array(RESUME.subarray(0, sent)),
	});
	const localStat = await stat(join(outDir, "resume.bin"));
	const stateKey = createHash("sha256").update(`${base}\n${resumeTarget}`).digest("hex");
	const stateDir = join(tmpdir(), "a2mcp-proxy");
	await mkdir(stateDir, { recursive: true });
	await writeFile(
		join(stateDir, `${stateKey}.json`),
		JSON.stringify({
			source: join(outDir, "resume.bin"),
			size: RESUME.length,
			mtimeMs: localStat.mtimeMs,
			sent,
			prefixSha256: sha(RESUME.subarray(0, sent)),
			remotePath: resumeTarget,
		}),
	);
	const resumed = await callTool("a2mcp_upload", {
		localPath: join(outDir, "resume.bin"),
		remotePath: resumeTarget,
	});
	const resumedBytes = await readFile(resumeTarget).catch(() => Buffer.alloc(0));
	check(
		part.ok && !resumed.isError && (resumed.value as { resumedFrom?: number }).resumedFrom === sent,
		"an upload continues its own interrupted transfer from the confirmed offset",
		`resumedFrom=${(resumed.value as { resumedFrom?: number }).resumedFrom}`,
	);
	check(sha(resumedBytes) === sha(RESUME), "the resumed upload is byte-exact", `${resumedBytes.length} bytes`);

	// --- 6. resume a download from a part and a matching sidecar ------------------
	const probe = await fetch(`${base}${XFER_ROUTE}/remote.bin`, { headers: { ...auth, range: "bytes=0-0" } });
	const etag = probe.headers.get("etag");
	const remoteSize = Number(/(\d+)\s*$/.exec(probe.headers.get("content-range") ?? "")?.[1]);
	await probe.arrayBuffer();
	const partPath = join(outDir, "down3.bin.a2mcp-part");
	const half = 50_000;
	await writeFile(partPath, BIG.subarray(0, half));
	await writeFile(`${partPath}.json`, JSON.stringify({ etag, size: BIG.length }));
	const resumedDown = await callTool("a2mcp_download", {
		remotePath: join(shareDir, "remote.bin"),
		localPath: join(outDir, "down3.bin"),
	});
	const down3 = await readFile(join(outDir, "down3.bin")).catch(() => Buffer.alloc(0));
	check(
		remoteSize === BIG.length &&
			!resumedDown.isError &&
			(resumedDown.value as { resumedFrom?: number }).resumedFrom === half,
		"a download resumes from a part whose sidecar matches the remote file",
		`resumedFrom=${(resumedDown.value as { resumedFrom?: number }).resumedFrom}`,
	);
	check(sha(down3) === sha(BIG), "the resumed download is byte-exact", `${down3.length} bytes`);
	await callTool("xfer_stop", {});

	// --- 7. a share that does not cover the target is refused, not replaced -------
	const unrelated = await callTool("xfer_share", { path: otherDir, ttlSeconds: 300 });
	check(!unrelated.isError, "an unrelated share is open");
	const refused = await callTool("a2mcp_download", {
		remotePath: join(shareDir, "remote.bin"),
		localPath: join(outDir, "never.bin"),
	});
	const stillThere = await readFile(join(otherDir, "elsewhere.txt"), "utf8").catch(() => "");
	const statusOther = await shareStatus();
	check(
		refused.isError && refused.text.includes("does not cover"),
		"a transfer outside the open share is refused in words",
		refused.text.slice(0, 100),
	);
	check(
		stillThere === "not this share" && statusOther.serving === true && statusOther.path === otherDir,
		"the unrelated share was not replaced or stopped",
		String(statusOther.path),
	);
	await callTool("xfer_stop", {});

	// --- 8. the same client from a shell -------------------------------------------
	const cliDownPath = join(outDir, "cli-down.bin");
	const cliDown = await runCli(["download", join(shareDir, "remote.bin"), cliDownPath]);
	const cliDownBytes = await readFile(cliDownPath).catch(() => Buffer.alloc(0));
	check(
		cliDown.code === 0 && sha(cliDownBytes) === sha(BIG),
		"the CLI download is byte-exact",
		`exit ${cliDown.code}${cliDown.err ? `, stderr: ${cliDown.err.trim().slice(0, 120)}` : ""}`,
	);
	check(
		cliDown.out.includes('"share":"opened"') && !cliDown.out.includes(token) && !cliDown.err.includes(token),
		"the CLI prints the share it used, and never the token",
		cliDown.out.trim().slice(0, 120),
	);
	check((await shareStatus()).serving === false, "the CLI closed the share it opened");

	const cliUp = bytesOf(120_000, 5);
	await writeFile(join(outDir, "cli-up.bin"), cliUp);
	const cliUpRun = await runCli(["upload", join(outDir, "cli-up.bin"), join(shareDir, "cli-up.bin")]);
	const cliUpBytes = await readFile(join(shareDir, "cli-up.bin")).catch(() => Buffer.alloc(0));
	check(
		cliUpRun.code === 0 && sha(cliUpBytes) === sha(cliUp),
		"the CLI upload lands byte-exact",
		`${cliUpBytes.length} bytes${cliUpRun.err ? `, stderr: ${cliUpRun.err.trim().slice(0, 120)}` : ""}`,
	);
} catch (e) {
	check(false, "the probe itself failed", `${(e as Error)?.message ?? e}\n${stderr.slice(0, 500)}`);
} finally {
	proxy.stdin.end();
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			proxy.kill("SIGKILL");
			resolve();
		}, 2000);
		proxy.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	await xfer.stop();
	bridge.stop();
	await rm(work, { recursive: true, force: true });
	const leftover = join(tmpdir(), "a2mcp-proxy");
	if (failures === 0) await rm(leftover, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILURES`} — client MCP proxy, chunked file transfer`);
process.exit(failures === 0 ? 0 : 1);
