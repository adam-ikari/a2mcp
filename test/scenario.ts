/**
 * Scenario probe (bun run test:scenario).
 *
 * The other five probes are flat checks: independent assertions, each with one
 * observation. This one is built the other way round — every scenario is a
 * narrative with a beginning, an act and an end state, and **the end state is
 * verified through a channel other than the one that produced it**:
 *
 *   - a remote `bash` call is verified by looking at the file it wrote
 *   - a token rotation is verified by which token the *running server* accepts
 *   - a port that the bridge gave up is verified by connecting to it
 *   - a config that must be refused is verified by the silence that follows
 *
 * Reasoning that stays inside one channel is how the deleted file-transfer
 * surface shipped two P1s with 100 green unit tests: every assertion was true
 * and none of them noticed a file being written twice.
 *
 * Scenarios needing different host configuration get their own host; scenarios
 * sharing one boot are grouped. Boot is the expensive part (~8s), so the
 * grouping matters more than the count.
 *
 * Requires the omp binary, no model credentials (see harness.ts).
 *
 * What this suite does NOT cover, and who owns it instead — knowing the edges of
 * a suite matters as much as knowing its middle:
 *
 *   - the exposure gate (`not exposed` for unregistered names and aliases)
 *     -> test:hardening. Confirmed by mutation: removing that gate leaves this
 *     suite entirely green, because no scenario calls a name outside the
 *     registry.
 *   - wire-level refusals (401/400/404/405, batch, bad jsonrpc) -> test:hardening
 *   - the prompt-tier hang and its 90s client timeout -> test:approval
 *   - package self-containment -> test:install
 *   - the file server binary's own behaviour (which flags it takes, Range,
 *     resumable downloads, where a missing binary comes from) -> test:obtain.
 *     This suite drives the bridge's use of it: the bytes a caller gets back
 *     are the bytes on the host's disk.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLogPath } from "../src/audit.ts";
import { linkExtension, seedModels } from "./harness.ts";

const OMP = process.env.OMP_BIN ?? "omp";
const tmp = mkdtempSync(join(tmpdir(), "a2mcp-scen-"));

let failures = 0;
let checks = 0;
const t0 = Date.now();
const stage = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

/**
 * A scenario passes only if every step inside it passes. Steps report their own
 * detail, so a scenario line says *what* broke and the step lines say how.
 */
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
	const before = failures;
	try {
		await fn();
	} catch (e) {
		failures++;
		console.log(`FAIL: scenario ${name} — threw: ${(e as Error).message}`);
	}
	console.log(`${failures === before ? "ok" : "FAIL"}: scenario ${name}`);
}

function step(cond: unknown, what: string, detail = ""): void {
	checks++;
	if (cond) {
		console.log(`  ok: ${what}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures++;
		console.log(`  FAIL: ${what}${detail ? ` — ${detail}` : ""}`);
	}
}

// --- host plumbing ---------------------------------------------------------

type Host = {
	child: ChildProcess;
	agentDir: string;
	cfgPath: string;
	auditPath: string;
	out: () => string;
	err: () => string;
	port: number;
	announced: RegExpMatchArray | null;
};

const hosts: Host[] = [];

/** A port the OS says is free right now. */
function freePort(): number {
	const s = createServer();
	s.listen(0, "127.0.0.1");
	const port = (s.address() as { port: number }).port;
	s.close();
	return port;
}

type BootOpts = {
	/** Extra argv for the host (approval modes etc.). */
	argv?: string[];
	/** Pre-written config; defaults to a port-only config (token self-heals). */
	config?: unknown;
	/** Pin the configured port to this number (caller occupies it when it wants EADDRINUSE). */
	port?: number;
	/** How long to wait for the bridge announcement. */
	announceMs?: number;
};

/**
 * Boot a host with a throwaway HOME. `announceMs: 0` means "do not wait for an
 * announcement" — used by the scenario that asserts the bridge must *not* come
 * up.
 */
async function boot(label: string, opts: BootOpts = {}): Promise<Host> {
	const home = join(tmp, label);
	const agentDir = join(home, ".omp", "agent");
	const cfgPath = join(agentDir, "a2mcp.json");
	const auditBase = join(agentDir, "a2mcp.log");
	const auditPath = auditLogPath({ A2MCP_AUDIT: auditBase });
	const outLog = join(home, "omp.out.log");
	const errLog = join(home, "omp.err.log");

	linkExtension(agentDir);
	seedModels(agentDir);

	const port = opts.port ?? freePort();
	writeFileSync(cfgPath, JSON.stringify(opts.config ?? { port, host: "127.0.0.1" }, null, 2));

	const child = spawn(OMP, ["--mode", "rpc", ...(opts.argv ?? [])], {
		env: { ...process.env, HOME: home, A2MCP_CONFIG: cfgPath, A2MCP_AUDIT: auditBase },
		stdio: ["pipe", openSync(outLog, "w"), openSync(errLog, "w")],
	});
	const read = (f: string) => {
		try {
			return readFileSync(f, "utf8");
		} catch {
			return "";
		}
	};
	const host: Host = {
		child,
		agentDir,
		cfgPath,
		auditPath,
		out: () => read(outLog),
		err: () => read(errLog),
		port,
		announced: null,
	};

	const waitMs = opts.announceMs ?? 30_000;
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		if (/a2mcp listening/.test(host.out())) break;
		if (child.exitCode !== null) break;
		child.stdin?.write(""); // the host exits on EOF, so keep stdin open
		await Bun.sleep(200);
	}
	host.announced = host.out().match(/a2mcp listening on (http:\/\/127\.0\.0\.1:\d+\/)/);

	// The token is written by the bridge on first start; give it a moment even
	// when no announcement was expected, so the caller can read the reason.
	if (!host.announced) await Bun.sleep(1500);

	hosts.push(host);
	return host;
}

function baseOf(host: Host): string {
	return host.announced?.[1] ?? `http://127.0.0.1:${host.port}/`;
}

/** Only the fields these scenarios read. Keeps a failed step's detail short. */
type RpcBody = {
	result?: { content?: Array<{ text?: string }>; isError?: boolean };
	error?: { code?: number; message?: string };
};

async function rpc(
	host: Host,
	method: string,
	params: unknown,
	opts: { token?: string; sid?: string; ms?: number } = {},
): Promise<{ status: number; body: RpcBody | null; sid: string | null }> {
	const r = await fetch(baseOf(host), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
			...(opts.sid ? { "mcp-session-id": opts.sid } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		// Always bounded. Without this, a scenario whose host never announced
		// itself would hang on the first fetch instead of failing with a reason.
		signal: AbortSignal.timeout(opts.ms ?? 20_000),
	});
	return {
		status: r.status,
		body: (await r.json().catch(() => null)) as RpcBody | null,
		sid: r.headers.get("mcp-session-id"),
	};
}

async function readToken(host: Host): Promise<string> {
	const cfg = JSON.parse(readFileSync(host.cfgPath, "utf8")) as { token: string };
	return cfg.token;
}
/** initialize + notification, the handshake every real client performs. */
async function handshake(host: Host, tk?: string): Promise<{ token: string; sid: string }> {
	const use = tk ?? (await readToken(host));
	const init = await rpc(host, "initialize", { protocolVersion: "2025-11-25" }, { token: use });
	const sid = init.sid ?? "";
	await rpc(host, "notifications/initialized", {}, { token: use, sid });
	return { token: use, sid };
}

type AuditRecord = {
	id?: string;
	sid?: string | null;
	phase?: string;
	tool?: string;
	isError?: boolean;
	args?: unknown;
};

function auditRecords(host: Host): AuditRecord[] {
	try {
		return (readFileSync(host.auditPath, "utf8") as string)
			.split("\n")
			.filter(Boolean)
			.flatMap((l) => {
				try {
					return [JSON.parse(l) as AuditRecord];
				} catch {
					return []; // partial trailing line
				}
			});
	} catch {
		return [];
	}
}

/** The audited args as an object — the audit stores them as a JSON string. */
function auditedArgs(r: AuditRecord): Record<string, unknown> {
	try {
		return JSON.parse(String(r.args ?? "{}")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

async function shutdown(host: Host): Promise<void> {
	host.child.kill("SIGTERM");
	await Bun.sleep(600);
	if (host.child.exitCode === null) host.child.kill("SIGKILL");
}

/** Can something still be connected to this port? */
async function portAccepts(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
		return true;
	} catch {
		return false;
	}
}

// --- the scenarios ---------------------------------------------------------

await scenario("a remote bash call's side effect is on disk and in the audit log", async () => {
	const host = await boot("s2");
	step(!!host.announced, "bridge announced");
	const { token: tk, sid } = await handshake(host);

	const marker = `a2mcp-scenario-${Date.now()}`;
	const file = join(tmp, marker);
	const call = await rpc(
		host,
		"tools/call",
		{ name: "bash", arguments: { command: `printf scenario-ok > ${file}` } },
		{ token: tk, sid, ms: 30_000 },
	);
	step(
		call.body?.result?.isError === false,
		"remote bash returned isError=false",
		JSON.stringify(call.body?.result?.content?.[0]?.text ?? "").slice(0, 120),
	);
	// Independent channel 1: the filesystem, not the RPC response.
	step(
		existsSync(file) && readFileSync(file, "utf8") === "scenario-ok",
		"the file the remote command wrote is on disk with the expected content",
	);

	// Independent channel 2: the audit log describes the same act.
	const recs = auditRecords(host).filter((r) => r.tool === "bash");
	const start = recs.find((r) => r.phase === "start");
	const done = recs.find((r) => r.phase === "done");
	step(!!start, "audit has a start record for bash");
	step(!!done, "audit has a done record for bash");
	step(start?.id === done?.id, "the two phases pair by id");
	step(start?.sid === sid, "the record carries the caller's session id", `sid=${String(start?.sid).slice(0, 8)}…`);
	step(String(start?.args ?? "").includes(marker), "the audited args name the file that was written");

	await shutdown(host);
});

await scenario("two clients share one token and stay independently revocable", async () => {
	const host = await boot("s3");
	step(!!host.announced, "bridge announced");
	const tk = await readToken(host);

	const a = await handshake(host);
	const b = await handshake(host);
	step(a.sid !== "" && b.sid !== "" && a.sid !== b.sid, "both clients hold distinct sessions");

	const callA = await rpc(
		host,
		"tools/call",
		{ name: "read", arguments: { path: host.cfgPath } },
		{ token: tk, sid: a.sid, ms: 20_000 },
	);
	step(callA.body?.result?.isError === false, "client A can call");

	const del = await fetch(baseOf(host), {
		method: "DELETE",
		headers: { authorization: `Bearer ${tk}`, "mcp-session-id": a.sid },
	});
	step(del.status === 204, "A's session terminates on DELETE", `status ${del.status}`);

	const afterA = await rpc(host, "ping", {}, { token: tk, sid: a.sid });
	step(afterA.status === 404, "A's session is gone", `status ${afterA.status}`);

	const callB = await rpc(
		host,
		"tools/call",
		{ name: "read", arguments: { path: host.cfgPath } },
		{ token: tk, sid: b.sid, ms: 20_000 },
	);
	step(callB.body?.result?.isError === false, "B is unaffected by A's termination");

	// Both clients' calls are attributable, which is the point of the sid field.
	const sids = new Set(
		auditRecords(host)
			.filter((r) => r.phase === "start")
			.map((r) => r.sid),
	);
	step(
		sids.has(a.sid) && sids.has(b.sid),
		"the audit log attributes calls to both client sessions",
		`${sids.size} distinct sids`,
	);

	await shutdown(host);
});

await scenario("an external config edit does not take effect until the host restarts", async () => {
	const host = await boot("s4");
	step(!!host.announced, "bridge announced");
	const tk = await readToken(host);
	const { sid } = await handshake(host);

	// Rewrite the token behind the running server's back.
	const nextToken = `rotated-${"x".repeat(40)}`;
	const cfg = JSON.parse(readFileSync(host.cfgPath, "utf8")) as Record<string, unknown>;
	cfg.token = nextToken;
	writeFileSync(host.cfgPath, JSON.stringify(cfg, null, 2));

	const oldStill = await rpc(host, "ping", {}, { token: tk, sid });
	step(
		oldStill.status === 200,
		"the running server still accepts the token it booted with",
		`status ${oldStill.status}`,
	);
	const newRejected = await rpc(host, "ping", {}, { token: nextToken, sid });
	step(
		newRejected.status === 401,
		"the edited token is not honoured by the running server",
		`status ${newRejected.status}`,
	);

	await shutdown(host);

	// Restart against the same HOME: now the edit applies.
	const again = await boot("s4-restart", { config: JSON.parse(readFileSync(host.cfgPath, "utf8")) });
	step(!!again.announced, "bridge announced after restart");
	const afterRestart = await rpc(again, "ping", {}, { token: nextToken });
	step(
		afterRestart.status === 401 || afterRestart.status === 400,
		"the restarted server requires a fresh handshake",
		`status ${afterRestart.status}`,
	);
	// What actually proves the restart applied the edit: on the session the
	// edited token opened, the pre-restart token is refused. The step this
	// replaces read the token back off disk and compared it to the value the
	// scenario itself had just written there — a file compared with itself,
	// under a label claiming the host had read it. (It did catch one real bug by
	// accident: a host that regenerates the token at boot rewrites that file, so
	// the comparison failed. That case is now covered directly below.)
	//
	// The status must be 401 and only 401: a 400 here means "no session yet",
	// which is the wrong reason to pass. Allowing it is what let the first
	// version of this check stay green against a host that had never seen the
	// edit. Same session, different token is what returns 401 — the shape the
	// pre-restart half of this scenario already uses.
	const fresh = await handshake(again, nextToken);
	const ping = await rpc(again, "ping", {}, { token: nextToken, sid: fresh.sid });
	step(ping.status === 200, "the edited token is accepted", `status ${ping.status}`);
	const oldOnSameSession = await rpc(again, "ping", {}, { token: tk, sid: fresh.sid });
	step(
		oldOnSameSession.status === 401,
		"the pre-restart token is refused on that same session",
		`status ${oldOnSameSession.status}`,
	);

	await shutdown(again);
});

await scenario("a busy configured port is given up, announced, and still serves", async () => {
	const busy = freePort();
	const blocker = createServer();
	await new Promise<void>((resolve) => blocker.listen(busy, "127.0.0.1", resolve));

	const host = await boot("s5", { port: busy });
	step(!!host.announced, "bridge announced on a different port", host.announced?.[1] ?? "no announcement");
	step(
		host.announced?.[1] !== `http://127.0.0.1:${busy}/`,
		"the announced port is not the occupied one",
		`busy=${busy}`,
	);
	step(/configured port \d+ is busy/.test(host.out()), "the host warned that the configured port was busy");

	const tk = await readToken(host);
	if (host.announced) {
		const init = await rpc(host, "initialize", { protocolVersion: "2025-11-25" }, { token: tk, ms: 8000 });
		step(init.status === 200, "the bridge is reachable at the announced port", `status ${init.status}`);
	} else {
		step(false, "the bridge is reachable at the announced port", "no announcement to reach");
	}

	blocker.close();
	await shutdown(host);
});

await scenario("a malformed config stops the bridge from coming up, and says why", async () => {
	// `port` present but not a number: fail-closed, so the extension must refuse
	// to start rather than come up on an unexpected endpoint.
	const host = await boot("s6", { config: { port: "not-a-number", host: "127.0.0.1" }, announceMs: 12_000 });
	step(!host.announced, "no bridge announcement", host.announced?.[1] ?? "(none, as required)");
	step(host.child.exitCode === null, "the host itself keeps running", `exit=${host.child.exitCode}`);
	const noise = `${host.out()}\n${host.err()}`;
	step(
		/a2mcp\.json/.test(noise) && /port/.test(noise),
		"the failure names the file and the field",
		noise
			.split("\n")
			.filter((l) => /a2mcp|port/i.test(l))
			.slice(0, 2)
			.join(" | ")
			.slice(0, 200),
	);

	await shutdown(host);
});

await scenario("the write tier splits one host policy across read and bash", async () => {
	// `--approval-mode` takes always-ask | write | yolo — the host rejects
	// anything else by name (measured, not assumed: "deny" is not a tier, it is
	// an outcome the host's own gate produces). `write` is the interesting one
	// and nobody had covered it: the *same* policy answers a read immediately
	// and holds a bash call open, which is the boundary the bridge must not
	// paper over with an opinion of its own.
	const host = await boot("s7", { argv: ["--approval-mode=write"] });
	step(!!host.announced, "bridge announced under --approval-mode=write", host.announced?.[1] ?? host.err().slice(-200));
	const { token: tk, sid } = await handshake(host);

	const tRead = Date.now();
	const readCall = await rpc(
		host,
		"tools/call",
		{ name: "read", arguments: { path: host.cfgPath } },
		{ token: tk, sid, ms: 20_000 },
	);
	const readMs = Date.now() - tRead;
	step(
		readCall.body?.result?.isError === false,
		"a read is answered under the write tier",
		`isError=${readCall.body?.result?.isError} in ${readMs}ms`,
	);

	// The write side, observed with a short client timeout: the expectation is
	// "no answer", and a hang is the documented behavior for a prompt-tier tool
	// with no UI to answer it (see test:approval, verdict B).
	const sideEffect = join(tmp, `write-tier-${Date.now()}`);
	let answered = false;
	let bashMs = 0;
	const t = Date.now();
	try {
		const call = await rpc(
			host,
			"tools/call",
			{ name: "bash", arguments: { command: `touch ${sideEffect}` } },
			{ token: tk, sid, ms: 8000 },
		);
		answered = true;
		bashMs = Date.now() - t;
		stage(
			`bash under write tier answered in ${bashMs}ms: ${JSON.stringify(call.body?.result?.content?.[0]?.text ?? "").slice(0, 120)}`,
		);
	} catch {
		bashMs = Date.now() - t;
	}
	step(!answered, "a bash call gets no answer while the write tier waits for a UI", `${bashMs}ms`);
	step(!existsSync(sideEffect), "and it did not execute");

	// The call that never settled must still be visible in the audit log.
	const recs = auditRecords(host).filter((r) => r.tool === "bash");
	step(
		recs.some((r) => r.phase === "start"),
		"the unsettled call left a start record",
		`start=${recs.filter((r) => r.phase === "start").length} done=${recs.filter((r) => r.phase === "done").length}`,
	);

	// And the server is still usable afterwards.
	const ping = await rpc(host, "ping", {}, { token: tk, sid, ms: 8000 });
	step(ping.status === 200, "the bridge still answers after the held call", `status ${ping.status}`);

	await shutdown(host);
});

await scenario("the host releasing the session releases the port", async () => {
	const host = await boot("s8");
	step(!!host.announced, "bridge announced");
	const port = Number(new URL(baseOf(host)).port);
	step(await portAccepts(port), "the port accepts connections while the host runs");

	await shutdown(host);
	let stillUp = true;
	for (let i = 0; i < 10 && stillUp; i++) {
		await Bun.sleep(400);
		stillUp = await portAccepts(port);
	}
	step(!stillUp, "and stops accepting once the host is gone", `port ${port}`);
});

await scenario("a mounted device is reachable through a tool path, not a tool name", async () => {
	const host = await boot("s10");
	step(!!host.announced, "bridge announced");
	const { token: tk, sid } = await handshake(host);

	const call = await rpc(
		host,
		"tools/call",
		{ name: "read", arguments: { path: "xd://" } },
		{ token: tk, sid, ms: 20_000 },
	);
	const text = (call.body?.result?.content ?? []).map((c) => c.text ?? "").join("");
	step(call.body?.result?.isError === false, "read xd:// does not error", `isError=${call.body?.result?.isError}`);
	// How many devices exist is the host's business, not the bridge's; record it.
	const mounted = (text.match(/xd:\/\/[a-z_]+/g) ?? []).length;
	stage(`xd:// listed ${mounted} mounted device(s)`);
	step(
		mounted === 0 || text.includes("xd://"),
		"the listing mentions device paths",
		text.slice(0, 120).replace(/\n/g, " "),
	);

	await shutdown(host);
});

// --- the file route, through the bridge -------------------------------------

/**
 * Call one of the bridge's own tools and read its reply as JSON.
 *
 * The `xfer_*` tools answer with a JSON object in the text content, so a
 * scenario can assert on fields instead of on prose. A tool that failed
 * answers with prose instead, and `data` stays empty.
 */
async function callTool(
	host: Host,
	name: string,
	args: Record<string, unknown>,
	tk: string,
	sid: string,
	ms = 180_000,
): Promise<{ isError: boolean; data: Record<string, unknown>; text: string }> {
	const r = await rpc(host, "tools/call", { name, arguments: args }, { token: tk, sid, ms });
	const text = r.body?.result?.content?.[0]?.text ?? "";
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// not JSON: `text` carries the reason
	}
	return { isError: r.body?.result?.isError === true, data, text };
}

/** A directory with one file in it, for a share to serve. */
function shareDir(name: string, file: string, body: string): string {
	const dir = join(tmp, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), body);
	return dir;
}

await scenario("a shared file's bytes come back byte-exact, and an upload lands on the host's disk", async () => {
	const host = await boot("s11");
	step(!!host.announced, "bridge announced");
	const { token: tk, sid } = await handshake(host);

	const bytes = Buffer.from("a2mcp-share-probe\n");
	const dir = shareDir("share-src", "hello.txt", bytes.toString());

	const share = await callTool(host, "xfer_share", { path: dir, ttlSeconds: 3600 }, tk, sid);
	step(!share.isError, "xfer_share succeeded", share.text.slice(0, 200));
	const route = String(share.data.url ?? "");
	step(route.startsWith("http://127.0.0.1:"), "the reply names a loopback route", route);
	step(Number(share.data.port ?? 0) > 0, "the reply names the file server's port", String(share.data.port));

	// The bytes a caller gets back are the bytes on the host's disk.
	const got = await fetch(`${route}hello.txt`, { headers: { authorization: `Bearer ${tk}` } });
	const back = Buffer.from(await got.arrayBuffer());
	step(got.status === 200, "the shared file answers 200", `status ${got.status}`);
	step(back.equals(bytes), "the bytes that came back are the bytes on disk");

	// An upload lands on the host's disk, byte-exact.
	const up = Buffer.from("uploaded-by-the-probe\n");
	const put = await fetch(`${route}uploaded.txt`, {
		method: "PUT",
		body: up,
		headers: { authorization: `Bearer ${tk}` },
	});
	step(put.status < 300, "the upload was accepted", `status ${put.status}`);
	step(
		existsSync(join(dir, "uploaded.txt")) && readFileSync(join(dir, "uploaded.txt")).equals(up),
		"the uploaded file is on the host's disk, byte-exact",
	);

	// The refusals hold.
	const del = await fetch(`${route}hello.txt`, { method: "DELETE", headers: { authorization: `Bearer ${tk}` } });
	step(del.status === 403, "DELETE is refused", `status ${del.status}`);
	const move = await fetch(`${route}hello.txt`, { method: "MOVE", headers: { authorization: `Bearer ${tk}` } });
	step(move.status === 403, "MOVE is refused", `status ${move.status}`);
	const anon = await fetch(`${route}hello.txt`);
	step(anon.status === 401, "a request without the token is refused", `status ${anon.status}`);
	const wrong = await fetch(`${route}hello.txt`, { headers: { authorization: "Bearer not-the-token" } });
	step(wrong.status === 401, "a request with a wrong token is refused", `status ${wrong.status}`);

	// A listing is a WebDAV listing.
	const propfind = await fetch(route, { method: "PROPFIND", headers: { authorization: `Bearer ${tk}` } });
	const xml = await propfind.text();
	step(propfind.status === 207, "PROPFIND answers 207", `status ${propfind.status}`);
	step(xml.includes("hello.txt"), "the listing names the shared file");

	// The audit log records the share as an event, not as a call.
	const recs = auditRecords(host).filter((r) => r.tool === "xfer");
	step(recs.length > 0, "the audit log has a record for the share", `${recs.length} record(s)`);
	step(
		recs.some((r) => r.phase === "event"),
		"the share is recorded as an event, not a call",
	);
	step(
		recs.some((r) => auditedArgs(r).action === "share"),
		"and the record says which action it was",
		recs.map((r) => String(auditedArgs(r).action ?? "?")).join(","),
	);

	// The share is closed by hand: the route goes with it, and the file server
	// does not outlive the bridge.
	const stop = await callTool(host, "xfer_stop", {}, tk, sid);
	step(!stop.isError && stop.data.stopped === true, "xfer_stop closes the share", stop.text.slice(0, 120));
	const gone = await fetch(`${route}hello.txt`, { headers: { authorization: `Bearer ${tk}` } });
	step(gone.status === 404, "and the route is gone with it", `status ${gone.status}`);
	const stillThere = await portAccepts(Number(share.data.port ?? 0));
	step(!stillThere, "the file server is gone too", `port ${share.data.port}`);

	await shutdown(host);
});

await scenario("the route keeps serving while the host's inference is switched off", async () => {
	const host = await boot("s12");
	step(!!host.announced, "bridge announced");
	const { token: tk, sid } = await handshake(host);

	const dir = shareDir("share-src-2", "keep.txt", "still-here\n");
	const share = await callTool(host, "xfer_share", { path: dir }, tk, sid);
	step(!share.isError, "xfer_share succeeded", share.text.slice(0, 200));
	const route = String(share.data.url ?? "");

	const before = await fetch(`${route}keep.txt`, { headers: { authorization: `Bearer ${tk}` } });
	step(before.status === 200, "the shared file answers before the switch", `status ${before.status}`);

	// The host's inference off: the takeover arms a tripwire on
	// `globalThis.fetch`, and the bridge's own traffic to its file server goes
	// through that same function. A provider on loopback put the bare host in
	// the key set, and the share died with "the file server did not answer".
	const armed = await fetch(new URL("host-llm", baseOf(host)), {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${tk}` },
		body: JSON.stringify({ enabled: false }),
	});
	const state = (await armed.json()) as { enabled?: boolean };
	step(armed.status === 200 && state.enabled === false, "the host's inference is switched off", JSON.stringify(state));

	const after = await fetch(`${route}keep.txt`, { headers: { authorization: `Bearer ${tk}` } });
	const afterBody = await after.text();
	step(after.status === 200, "the shared file still answers with the switch off", `status ${after.status}`);
	step(afterBody === "still-here\n", "and the bytes are the same");

	// A share opened while the switch is off: the readiness probe is an
	// in-process fetch too, so this is where the share used to die.
	const again = await callTool(
		host,
		"xfer_share",
		{ path: shareDir("share-src-3", "second.txt", "second\n") },
		tk,
		sid,
	);
	step(!again.isError, "a share opened with the switch off still succeeds", again.text.slice(0, 200));

	const off = await fetch(new URL("host-llm", baseOf(host)), {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${tk}` },
		body: JSON.stringify({ enabled: true }),
	});
	step(off.status === 200, "the switch is back on", `status ${off.status}`);

	// Close the share by hand so its file server does not outlive the host.
	const stop = await callTool(host, "xfer_stop", {}, tk, sid);
	step(!stop.isError && stop.data.stopped === true, "xfer_stop closes the share", stop.text.slice(0, 120));

	await shutdown(host);
});

await scenario("a second share replaces the first, and the TTL closes a share", async () => {
	const host = await boot("s13");
	step(!!host.announced, "bridge announced");
	const { token: tk, sid } = await handshake(host);

	const first = await callTool(host, "xfer_share", { path: shareDir("share-a", "a.txt", "a\n") }, tk, sid);
	step(!first.isError, "the first share succeeded", first.text.slice(0, 200));
	const firstPort = Number(first.data.port ?? 0);
	const firstRoute = String(first.data.url ?? "");
	step(
		(await fetch(`${firstRoute}a.txt`, { headers: { authorization: `Bearer ${tk}` } })).status === 200,
		"the first share serves its file",
	);

	const second = await callTool(host, "xfer_share", { path: shareDir("share-b", "b.txt", "b\n") }, tk, sid);
	step(!second.isError, "the second share succeeded", second.text.slice(0, 200));
	step(
		second.data.replaced === true,
		"the reply says the first share was replaced",
		JSON.stringify(second.data.replaced),
	);
	step(
		firstPort > 0 && !(await portAccepts(firstPort)),
		"the replaced share's file server is gone",
		`port ${firstPort}`,
	);

	const secondRoute = String(second.data.url ?? "");
	step(
		(await fetch(`${secondRoute}b.txt`, { headers: { authorization: `Bearer ${tk}` } })).status === 200,
		"the second share serves its file",
	);

	// The TTL closes the share by itself.
	const ttl = await callTool(host, "xfer_share", { path: shareDir("share-c", "c.txt", "c\n"), ttlSeconds: 1 }, tk, sid);
	step(!ttl.isError, "a share with a one-second TTL opened", ttl.text.slice(0, 200));
	const ttlRoute = String(ttl.data.url ?? "");
	step(
		(await fetch(`${ttlRoute}c.txt`, { headers: { authorization: `Bearer ${tk}` } })).status === 200,
		"the short-lived share serves its file right away",
	);
	await Bun.sleep(2500);
	const closed = await fetch(`${ttlRoute}c.txt`, { headers: { authorization: `Bearer ${tk}` } });
	const closedBody = await closed.text();
	step(closed.status === 404, "the expired share's route is gone", `status ${closed.status}`);
	step(closedBody.includes("nothing is shared"), "and it says nothing is shared", closedBody.slice(0, 120));

	// The audit log says the share closed, why, and what went through it.
	const closes = auditRecords(host).filter((r) => r.tool === "xfer" && auditedArgs(r).action === "close");
	step(closes.length > 0, "the audit log records the share closing", `${closes.length} close record(s)`);
	const whys = closes.map((r) => String(auditedArgs(r).why ?? "?"));
	step(whys.includes("replaced"), "including the one that was replaced", whys.join(","));
	const ttlClose = closes.find((r) => String(auditedArgs(r).why ?? "").includes("ttl"));
	step(!!ttlClose, "and the one that expired on its own", whys.join(","));
	const tally = (auditedArgs(ttlClose ?? {}).usage ?? {}) as { requests?: number; bytes?: number };
	step((tally.requests ?? 0) > 0, "with the tally of what went through it", JSON.stringify(tally));

	await shutdown(host);
});

// --- wrap up ---------------------------------------------------------------

for (const h of hosts) {
	try {
		h.child.kill("SIGKILL");
	} catch {}
}

console.log(`\nSCENARIOS: ${checks} steps, ${failures} failed`);
if (failures > 0) {
	console.error(`evidence kept at ${tmp}`);
	process.exitCode = 1;
} else {
	rmSync(tmp, { recursive: true, force: true });
}
