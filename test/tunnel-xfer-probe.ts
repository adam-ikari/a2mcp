/**
 * The file route and the tunnel, on one origin.
 *
 *   bun run test:tunnel-xfer
 *
 * ## What it checks
 *
 * That a client on the far end of one origin — the public hostname a tunnel fronts —
 * can move a file over `/xfer/` with the Bearer token: GET, Range, PUT, and the
 * `PATCH X-Update-Range: append` the client proxy uses for later chunks. The address
 * it uses is never typed here: it is the `publicUrl` the share's own reply named, so
 * the check is that the address handed out is the address that serves.
 *
 * The origin is an edge in this process, not cloudflared: a `Bun.serve` that forwards
 * path, method, headers and body to the bridge's port, which is the shape a quick
 * tunnel has (one origin, everything under it). TLS and the Cloudflare edge are left
 * out on purpose — this machine's network re-signs TLS for proxied hostnames, so a
 * published hostname cannot be fetched back from the machine that published it, and a
 * check that needs that measures the network. The real tunnel is section 5, and it
 * asserts the one thing that is local: that the announced hostname is the `publicUrl`
 * a share reports while a tunnel is up.
 *
 * ## Why a probe and not a test
 *
 * It runs the pinned `dufs` and, in section 4, a real `cloudflared`. `bun test` has no
 * egress and no binaries; the unit half of the same code is `test/xfer.test.ts` (share
 * lifecycle against a stub) and `test/xfer-route.test.ts` (the proxy).
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "../src/config.ts";
import { startServer, XFER_ROUTE } from "../src/server.ts";
import { openQuickTunnel } from "../src/tunnel.ts";
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

const work = await mkdtemp(join(tmpdir(), "a2mcp-tunnel-xfer-"));
const shared = join(work, "share");
await mkdir(shared, { recursive: true });
const token = randomBytes(24).toString("base64url");

/** Bytes that survive only if nothing treats them as text. */
const bytesOf = (n: number, seed = 11): Buffer =>
	Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + seed) % 256));
const BIG = bytesOf(300_000);
const UP = bytesOf(200_000, 91);
const TAIL = bytesOf(1000, 7);
await writeFile(join(shared, "routed.bin"), BIG);

/** The operator's tunnel origin, as this probe stands it in. */
let publicOrigin = "";
/** What section 5's real tunnel announced, once one is up. */
let announced: string | null = null;
let bridgePort = 0;

const cfg: BridgeConfig = {
	port: 0,
	host: "127.0.0.1",
	token,
	host_llm: "allow",
	xfer: { dufs: "dufs", cloudflared: "cloudflared" },
};

const xfer = createXfer(cfg.xfer, {
	bridgeUrl: () => `http://127.0.0.1:${bridgePort}`,
	publicUrl: () => announced ?? publicOrigin ?? null,
});

const bridge = await startServer(cfg, {
	getTools: async () => [...XFER_TOOLS],
	callTool: async (name, args, sid) => {
		if (xfer.handles(name)) return xfer.call(name, args, sid);
		return { content: [{ type: "text", text: `no tool '${name}'` }], isError: true };
	},
	serverInfo: () => ({ name: "a2mcp-probe", version: "0.0.0" }),
	xfer: { target: () => xfer.target() },
});
bridgePort = bridge.port;

/**
 * The tunnel's half of the shape: one origin, every path forwarded to the port behind
 * it. `host` is dropped so the forwarded request names the origin the way cloudflared's
 * does, and nothing else is rewritten — a path the tunnel would change is a path this
 * probe must not change either.
 */
const edge = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (req) => {
		const url = new URL(req.url);
		const headers = new Headers(req.headers);
		headers.delete("host");
		return fetch(`http://127.0.0.1:${bridge.port}${url.pathname}${url.search}`, {
			method: req.method,
			headers,
			body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
		});
	},
});
publicOrigin = `http://127.0.0.1:${edge.port}`;
console.log(`origin: ${publicOrigin} -> bridge 127.0.0.1:${bridge.port}`);
console.log("");

const auth = { authorization: `Bearer ${token}` };

/** One JSON-RPC call over the origin the tunnel would front. */
async function rpc(method: string, params: unknown, sid?: string): Promise<Record<string, unknown>> {
	const r = await fetch(`${publicOrigin}/`, {
		method: "POST",
		headers: { "content-type": "application/json", ...auth, ...(sid ? { "mcp-session-id": sid } : {}) },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return { status: r.status, sid: r.headers.get("mcp-session-id"), body: (await r.json()) as unknown };
}

type ToolReply = {
	isError?: boolean;
	content?: Array<{ type: string; text?: string }>;
};
const textOf = (reply: ToolReply): string => (reply.content ?? []).map((c) => c.text ?? "").join("");

// --- 1. one origin, both surfaces --------------------------------------------------
const init = await rpc("initialize", {
	protocolVersion: "2025-11-25",
	capabilities: {},
	clientInfo: { name: "tunnel-xfer-probe", version: "0" },
});
const sid = init.sid as string | undefined;
check(
	init.status === 200 && typeof sid === "string" && sid.length > 0,
	"the MCP endpoint answers on the origin",
	`HTTP ${init.status}`,
);

const listed = await rpc("tools/list", {}, sid);
const names = ((listed.body as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map(
	(t) => t.name,
);
check(
	["xfer_share", "xfer_status", "xfer_stop"].every((n) => names.includes(n)),
	"the three transfer tools are on the origin's catalog",
	names.join(","),
);

const shareCall = await rpc("tools/call", { name: "xfer_share", arguments: { path: shared, ttlSeconds: 300 } }, sid);
const share = JSON.parse(textOf((shareCall.body as { result: ToolReply }).result)) as {
	publicUrl: string | null;
	port: number;
};
check(
	share.publicUrl === `${publicOrigin}${XFER_ROUTE}/`,
	"the share reports the tunnel's /xfer/ route as publicUrl",
	String(share.publicUrl),
);

// --- 2. the route the reply named, used as a client would -------------------------
const routed = await fetch(`${share.publicUrl}routed.bin`, { headers: auth });
const routedBytes = Buffer.from(await routed.arrayBuffer());
check(
	routed.status === 200 && sha(routedBytes) === sha(BIG),
	"a GET on the advertised route returns the file byte-exact",
	`HTTP ${routed.status}, ${routedBytes.length} bytes, ${sha(routedBytes).slice(0, 12)}`,
);

const ranged = await fetch(`${share.publicUrl}routed.bin`, { headers: { ...auth, range: "bytes=1000-1999" } });
const rangedBytes = Buffer.from(await ranged.arrayBuffer());
check(
	ranged.status === 206 && rangedBytes.equals(BIG.subarray(1000, 2000)),
	"a Range through the same origin returns the slice and nothing else",
	`HTTP ${ranged.status}, ${rangedBytes.length} bytes`,
);

const noToken = await fetch(`${share.publicUrl}routed.bin`);
const wrongToken = await fetch(`${share.publicUrl}routed.bin`, { headers: { authorization: "Bearer not-the-token" } });
check(
	noToken.status === 401 && wrongToken.status === 401,
	"the token is the only gate on that origin: none and wrong are both 401",
	`${noToken.status}/${wrongToken.status}`,
);

const uploaded = await fetch(`${share.publicUrl}uploaded.bin`, {
	method: "PUT",
	headers: auth,
	body: new Uint8Array(UP),
});
const uploadedOnDisk = await readFile(join(shared, "uploaded.bin")).catch(() => Buffer.alloc(0));
check(
	uploaded.status < 300 && sha(uploadedOnDisk) === sha(UP),
	"a PUT through the same origin lands on the host's disk byte-exact",
	`HTTP ${uploaded.status}, ${uploadedOnDisk.length} bytes`,
);
const appended = await fetch(`${share.publicUrl}uploaded.bin`, {
	method: "PATCH",
	headers: { ...auth, "x-update-range": "append" },
	body: new Uint8Array(TAIL),
});
const appendedOnDisk = await readFile(join(shared, "uploaded.bin")).catch(() => Buffer.alloc(0));
check(
	appended.status < 300 && sha(appendedOnDisk) === sha(Buffer.concat([UP, TAIL])),
	"a PATCH append through the same origin continues the file byte-exact",
	`HTTP ${appended.status}, ${appendedOnDisk.length} bytes`,
);
// --- 3. closing the share closes the route ----------------------------------------
await rpc("tools/call", { name: "xfer_stop", arguments: {} }, sid);
const afterStop = await fetch(`${share.publicUrl}routed.bin`, { headers: auth });
check(afterStop.status === 404, "xfer_stop takes the route down on the origin too", `HTTP ${afterStop.status}`);

// --- 4. a real tunnel, and the one thing about it that is local -------------------
//
// The publish is measurable here; the fetch-back is not (this network re-signs TLS for
// proxied hostnames), and `test:obtain` reports that half. What is asserted is the
// wiring a broken edition would get wrong: while a tunnel is up, the share's
// `publicUrl` is that hostname, not the loopback origin.
await rpc("tools/call", { name: "xfer_share", arguments: { path: shared, ttlSeconds: 120 } }, sid);
const opened = await openQuickTunnel({ bin: "cloudflared", port: bridge.port, timeoutMs: 30_000 }).catch(
	(e: Error) => e.message.split("\n")[0],
);
if (typeof opened === "string") {
	info(`real tunnel: no hostname (${opened.slice(0, 120)}) — the wiring check below needs one`);
} else {
	announced = opened.url;
	const status = await rpc("tools/call", { name: "xfer_status", arguments: {} }, sid);
	const reported = JSON.parse(textOf((status.body as { result: ToolReply }).result)) as { publicUrl: string | null };
	check(
		reported.publicUrl === `${opened.url}${XFER_ROUTE}/`,
		"with a real tunnel up, the share reports its hostname as publicUrl",
		String(reported.publicUrl),
	);
	await opened.stop();
}

await xfer.stop();
bridge.stop();
edge.stop(true);
await rm(work, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILURES`} — tunnel + file transfer, one origin`);
process.exit(failures === 0 ? 0 : 1);
