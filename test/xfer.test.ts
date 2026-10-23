/**
 * `xfer_*`, the bridge's own transfer tools (src/xfer.ts).
 *
 * What these tests are for: the wiring the real binaries cannot be asked about. The
 * share flow runs against a stub file server written at run time — same command-line
 * shape as `dufs` (root, `--port`, `--path-prefix`, `--auth user:pass@/:rw`), and the
 * same rule that nothing outside the prefix is served — so the assertions are about
 * *this* module: that the port it picks is the port it serves on, that the credentials
 * it invents are the ones the server checks and stay inside the process, that a share
 * is audited, that `stop` and the TTL really close it. Which flags `dufs` actually
 * accepts, and whether the bytes it writes are byte-exact, is real-machine work
 * (`test/obtain-probe.ts`, `test/install-probe.ts`), not something a unit test can
 * fake its way to.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { auditLogPath, auditStart } from "../src/audit.ts";
import type { resolveBinary } from "../src/obtain.ts";
import { XFER_ROUTE } from "../src/server.ts";
import {
	createXfer,
	resolveXferPath,
	XFER_TOOL_NAMES,
	XFER_TOOLS,
	type Xfer,
	type XferToolResult,
} from "../src/xfer.ts";

const dir = mkdtempSync(join(tmpdir(), "a2mcp-xfer-"));
const stubDir = mkdtempSync(join(tmpdir(), "a2mcp-stub-"));
const auditBase = join(dir, "audit.log");
const auditFile = auditLogPath({ A2MCP_AUDIT: auditBase });
process.env.A2MCP_AUDIT = auditBase;

/** The origin the bridge tells this module it is on — the getter's answer in a test. */
const BRIDGE_ORIGIN = "http://127.0.0.1:3456";
/** What `/a2mcp tunnel` would have announced, without a cloudflared in the test. */
const PUBLIC_ORIGIN = "https://calm-river-abc.trycloudflare.com";

/** The text half of a tool result; these tools never answer with anything else. */
const textOf = (r: XferToolResult) => r.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");

const lines = () => (existsSync(auditFile) ? readFileSync(auditFile, "utf8").split("\n").filter(Boolean) : []);
/** The audit chain is a queue; a sentinel proves this test's own record is on disk. */
async function flush(): Promise<void> {
	const marker = `xfer-sentinel-${Math.random()}`;
	await auditStart(marker, "flush", "flush", {}, process.env);
	if (!lines().some((l) => l.includes(marker))) throw new Error("audit record missing right after its own await");
}
const recordsFor = async (needle: string) => {
	await flush();
	return lines().filter((l) => l.includes(needle));
};

/**
 * A stand-in for dufs: same argument shape, serves the root over HTTP with the given
 * basic credentials, accepts PUT, and — the half this module now depends on — only
 * answers under the `--path-prefix` it was handed, 400 elsewhere. Written as an
 * executable with a shebang because `xfer.dufs` names a program, not a shell line —
 * the first version of this test passed `bun <file>` as the binary name and spawn
 * looked for a file with that whole string as its name.
 */
const STUB = `#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
const root = argv[0];
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const port = Number(flag("--port"));
const prefix = flag("--path-prefix") ?? "";
const creds = (flag("--auth") ?? "").split("@")[0];
const expected = "Basic " + Buffer.from(creds).toString("base64");
Bun.serve({
	hostname: "127.0.0.1",
	port,
	fetch: async (req) => {
		if (req.headers.get("authorization") !== expected) return new Response("denied", { status: 401 });
		const raw = new URL(req.url).pathname;
		if (prefix && raw !== prefix && !raw.startsWith(prefix + "/")) return new Response("outside the prefix", { status: 400 });
		const under = prefix ? raw.slice(prefix.length) || "/" : raw;
		// dufs decodes the path before it touches the disk, so a name with a space or a
		// '#' is that name on disk and not its percent-encoding.
		const p = join(root, decodeURIComponent(under));
		if (req.method === "PUT") {
			mkdirSync(dirname(p), { recursive: true });
			await Bun.write(p, req);
			return new Response("ok");
		}
		if (!existsSync(p)) return new Response("nope", { status: 404 });
		// The readiness probe asks for the prefixed root, which is a directory: a
		// listing, not a file. Reading it as a file throws, and a 500 there is what a
		// readiness loop keeps waiting on.
		if (statSync(p).isDirectory()) {
			// What dufs does with a Range on a directory, measured on 0.46.0: the range
			// is refused with 404, while a plain GET gets the listing. The chunk tools
			// always send a Range, so this half is the one they meet.
			return req.headers.get("range") ? new Response("nope", { status: 404 }) : new Response("listing");
		}
		const data = readFileSync(p);
		const range = req.headers.get("range");
		if (!range) return new Response(data);
		// Range as dufs 0.46.0 answers it: an end past the file is refused outright with
		// a 416 whose content-range carries the total (measured: 8-20 on ten bytes is
		// a 416, 8-9 is a 206). The chunk tools ask for a full chunk every time, so
		// the last call of every file that is not a multiple runs into exactly this.
		const m = /bytes=(\\d+)-(\\d+)/.exec(range);
		const start = Number(m?.[1] ?? 0);
		const end = Number(m?.[2] ?? data.length - 1);
		if (start >= data.length || end >= data.length) {
			return new Response("range", { status: 416, headers: { "content-range": "bytes */" + data.length } });
		}
		return new Response(data.subarray(start, end + 1), {
			status: 206,
			headers: { "content-range": "bytes " + start + "-" + end + "/" + data.length },
		});
	},
});
`;
const stub = join(stubDir, "stub-dufs");
writeFileSync(stub, STUB, { mode: 0o755 });

/**
 * A stand-in that fails the way a file server fails: a reason on stderr, then
 * exit. The reason it prints carries the credential it was handed, so the test
 * can see both that the reason reaches the caller and that the credential does
 * not.
 */
const FAILING = `#!/usr/bin/env bun
const argv = process.argv.slice(2);
const creds = (argv[argv.indexOf("--auth") + 1] ?? "").split("@")[0];
console.error("Error: Path '" + argv[0] + "' is not readable (creds " + creds + ")");
process.exit(1);
`;
const failingStub = join(stubDir, "failing-dufs");
writeFileSync(failingStub, FAILING, { mode: 0o755 });

const opened: Xfer[] = [];

function makeXfer(
	over: {
		dufs?: string;
		resolveBinary?: typeof resolveBinary;
		bridgeUrl?: string;
		/** A value, or a getter so one test can open and close the tunnel between calls. */
		publicUrl?: string | null | (() => string | null);
	} = {},
) {
	const x = createXfer(
		{ dufs: over.dufs ?? stub, cloudflared: "cloudflared-not-used-here" },
		{
			...(over.resolveBinary ? { resolveBinary: over.resolveBinary } : {}),
			// Passing no `bridgeUrl` at all is the case the fallback in `routeUrl`
			// exists for: the answer then names the route and nothing about the origin.
			...(over.bridgeUrl ? { bridgeUrl: () => over.bridgeUrl as string } : {}),
			...("publicUrl" in over
				? {
						publicUrl: typeof over.publicUrl === "function" ? over.publicUrl : () => over.publicUrl as string | null,
					}
				: {}),
		},
	);
	opened.push(x);
	return x;
}

afterEach(async () => {
	for (const x of opened.splice(0)) await x.stop();
});

afterAll(() => {
	delete process.env.A2MCP_AUDIT;
	rmSync(dir, { recursive: true, force: true });
	rmSync(stubDir, { recursive: true, force: true });
});

/** Bind probe: succeeds only if that port is free, which is how "closed" is read. */
function portIsFree(port: number): boolean {
	try {
		const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) });
		probe.stop(true);
		return true;
	} catch {
		return false;
	}
}

const internalSecret = (auth: string): string =>
	Buffer.from(auth.replace(/^Basic /, ""), "base64")
		.toString()
		.split(":")[1];

describe("the xfer tool surface", () => {
	test("advertises exactly the names it handles", () => {
		const x = makeXfer();
		expect(XFER_TOOLS.map((t) => t.name)).toEqual([...XFER_TOOL_NAMES]);
		for (const name of XFER_TOOL_NAMES) expect(x.handles(name)).toBe(true);
		expect(x.handles("read")).toBe(false);
		expect(x.handles("xfer_everything")).toBe(false);
	});

	test("every tool has an object schema and a description a caller can act on", () => {
		for (const t of XFER_TOOLS) {
			expect(t.inputSchema.type).toBe("object");
			expect(t.description.length).toBeGreaterThan(40);
		}
	});

	test("the catalog tells a caller the route, the token, and where the public URL comes from", () => {
		// This is what a remote model reads before deciding to share anything.
		const share = XFER_TOOLS[0].description;
		expect(share).toContain("/xfer/");
		expect(share).toContain("Bearer");
		expect(share).toContain("/a2mcp tunnel");
		expect(share).toContain("publicUrl");
		expect(share).not.toContain("quick tunnel");
		expect(share).not.toContain("basic auth");
	});
});

describe("path resolution", () => {
	test("expands ~ and ~/x against the host home, and leaves absolute paths alone", () => {
		expect(resolveXferPath("~")).toBe(homedir());
		expect(resolveXferPath("~/x/y")).toBe(join(homedir(), "x/y"));
		expect(resolveXferPath("/tmp/absolute")).toBe("/tmp/absolute");
	});

	test("resolves relative paths against the working directory", () => {
		expect(resolveXferPath("somewhere/file.bin")).toBe(join(process.cwd(), "somewhere/file.bin"));
	});
});

describe("xfer_share refusals", () => {
	test("no path is refused and audited", async () => {
		const x = makeXfer();
		const r = await x.call("xfer_share", {}, "sid-1");
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("path");
		const rec = JSON.parse((await recordsFor('"tool":"xfer"'))[0] ?? "{}") as { tool?: string; isError?: boolean };
		expect(rec.tool).toBe("xfer");
		expect(rec.isError).toBe(true);
	});

	test("a path that does not exist is refused, with the path in the message", async () => {
		const x = makeXfer();
		const missing = join(dir, "not-here.bin");
		const r = await x.call("xfer_share", { path: missing }, "sid-1");
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain(missing);
		expect((await recordsFor("not-here.bin")).length).toBeGreaterThan(0);
	});

	test("a named path that is not an executable is refused, with the path in the message", async () => {
		// A value containing `/` is the escape hatch: the real resolver (src/obtain.ts)
		// uses it as given and reaches for nothing, so this costs no network and no
		// install attempt.
		const x = makeXfer({ dufs: join(stubDir, "no-such-dufs-here") });
		const r = await x.call("xfer_share", { path: dir }, "sid-1");
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("no-such-dufs-here");
		expect(textOf(r)).toContain("downloads nothing");
	});

	test("a file server that fails says why, and its credential does not travel with the reason", async () => {
		const x = makeXfer({ dufs: failingStub });
		const r = await x.call("xfer_share", { path: dir }, "sid-1");
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("is not readable");
		expect(textOf(r)).toContain("<secret>");
		expect(textOf(r)).not.toMatch(/creds omp:[A-Za-z0-9_-]{8,}/);
	});

	test("a bare name goes through the resolver, and the path it returns is what runs", async () => {
		const seen: Array<[string, string]> = [];
		const x = makeXfer({
			dufs: "dufs-nomatter-what-this-is-called",
			resolveBinary: async (name, configured) => {
				seen.push([name, configured]);
				return {
					path: stub,
					installed: {
						name: "dufs",
						version: "0.0.0-test",
						target: "test-target",
						sha256: "x".repeat(64),
						dest: stub,
					},
				};
			},
		});
		const r = await x.call("xfer_share", { path: dir }, "sid-1");
		expect(r.isError).toBe(false);
		// Exactly one lookup: a share is the file server alone now, and cloudflared
		// belongs to the operator's tunnel command.
		expect(seen).toEqual([["dufs", "dufs-nomatter-what-this-is-called"]]);
		// The caller is told what the bridge fetched, because that is where the seconds went.
		expect(JSON.parse(textOf(r)).installed).toEqual({ dufs: "0.0.0-test" });
	});

	test("a resolver that cannot fetch is a refusal, not a half-open share", async () => {
		const x = makeXfer({
			resolveBinary: async () => {
				throw new Error("no pinned dufs build for test-target");
			},
		});
		const r = await x.call("xfer_share", { path: dir }, "sid-1");
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("no pinned dufs build");
		expect((await recordsFor("no pinned dufs build")).length).toBeGreaterThan(0);
		// Nothing was left listening on a port nobody owns.
		expect(x.target()).toBeNull();
	});
});

describe("xfer_share lifecycle", () => {
	test("serves the path at the bridge's route, and keeps its own credential in the process", async () => {
		const shareDir = join(dir, "shared");
		mkdirSync(shareDir, { recursive: true });
		writeFileSync(join(shareDir, "hello.txt"), "hello over http\n");

		const x = makeXfer({ bridgeUrl: BRIDGE_ORIGIN });
		const r = await x.call("xfer_share", { path: shareDir, ttlSeconds: 60 }, "sid-2");
		expect(textOf(r)).not.toContain("cannot");
		expect(r.isError).toBe(false);
		const body = JSON.parse(textOf(r)) as {
			url: string;
			publicUrl: string | null;
			route: string;
			port: number;
			expiresAt: string;
			usage: Record<string, string>;
			user?: string;
			secret?: string;
			host?: string;
		};
		expect(body.url).toBe(`${BRIDGE_ORIGIN}${XFER_ROUTE}/`);
		// No tunnel in this test: the field is present and null, and the usage line
		// names the two routes left instead of leaving the caller to guess one.
		expect(body.publicUrl).toBeNull();
		expect(body.usage.public).toContain("no public address");
		expect(body.usage.public).toContain("SSH port forward");
		expect(body.usage.public).toContain("/a2mcp tunnel");
		expect(body.route).toBe(`${XFER_ROUTE}/`);
		expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
		// The fields the tunnel era returned are gone rather than emptied: a caller
		// reading `user`/`secret` would go looking for credentials that no longer exist.
		expect(body.user).toBeUndefined();
		expect(body.secret).toBeUndefined();
		expect(body.host).toBeUndefined();
		expect(Object.keys(body.usage).sort()).toEqual(["download", "public", "upload"]);
		expect(body.usage.download).toContain("Bearer <TOKEN>");
		expect(body.usage.download).toContain(`${BRIDGE_ORIGIN}${XFER_ROUTE}/<name>`);

		// The proxy's seam is the loopback origin and the internal credential, and the
		// stub checks exactly those on the port the module picked.
		const t = x.target();
		if (!t) throw new Error("target() is null with a share open");
		expect(t.port).toBe(body.port);
		expect(t.baseUrl).toBe(`http://127.0.0.1:${body.port}`);
		const good = await fetch(`${t.baseUrl}${XFER_ROUTE}/hello.txt`, { headers: { authorization: t.auth } });
		expect(good.status).toBe(200);
		expect(await good.text()).toBe("hello over http\n");
		const bad = await fetch(`${t.baseUrl}${XFER_ROUTE}/hello.txt`, {
			headers: { authorization: `Basic ${Buffer.from("omp:wrong").toString("base64")}` },
		});
		expect(bad.status).toBe(401);
		// What the stub checked is a credential the tool result never mentions.
		expect(textOf(r)).not.toContain(internalSecret(t.auth));

		const rec = JSON.parse((await recordsFor(shareDir))[0] ?? "{}") as {
			tool?: string;
			isError?: boolean;
			args?: string;
		};
		expect(rec.tool).toBe("xfer");
		expect(rec.isError).toBe(false);
		// The record names the route the bytes go out at. An operator reading this log
		// wants to know what was reachable, and `/xfer/` on the bridge's own port is the
		// answer — the public half is the tunnel's business and its own record.
		expect(JSON.parse(rec.args ?? "{}")).toMatchObject({ path: shareDir, route: `${XFER_ROUTE}/` });
	});

	test("the closing record carries what crossed the share", async () => {
		// The audit records a share's opening and its closing, not every GET and PUT
		// in between — one record per request would drown the log. The tally is the
		// answer to "was this path touched, and how much moved", which is the
		// question an operator asks about a route that may be sitting behind a public
		// hostname. It says how much, never who: the token is shared, so the bytes
		// carry no identity.
		const x = makeXfer();
		await x.call("xfer_share", { path: dir }, "sid-usage");
		const t = x.target();
		if (!t) throw new Error("target() is null with a share open");
		t.note?.({ method: "GET", bytes: 4096 });
		t.note?.({ method: "PUT", bytes: 128 });
		await x.call("xfer_stop", {}, "sid-usage");
		// The last matching record, not the first: the audit file spans every test
		// in this file and they all share one directory.
		const recs = (await recordsFor(dir)).map((l) => JSON.parse(l) as { args?: string });
		const stopped = recs
			.map((r) => JSON.parse(r.args ?? "{}"))
			.filter((a) => a.action === "stop")
			.pop();
		expect(stopped).toMatchObject({ usage: { requests: 2, bytes: 4224, uploads: 1 } });
	});

	test("a share nothing crossed carries no usage at all", async () => {
		// The field is absent rather than zeroed: a share nobody touched is not a
		// fact about a share.
		const x = makeXfer();
		await x.call("xfer_share", { path: dir }, "sid-nousage");
		await x.call("xfer_stop", {}, "sid-nousage");
		const recs = (await recordsFor(dir)).map((l) => JSON.parse(l) as { args?: string });
		const stopped = recs
			.map((r) => JSON.parse(r.args ?? "{}"))
			.filter((a) => a.action === "stop")
			.pop();
		expect(stopped?.usage).toBeUndefined();
	});

	test("a bridge whose origin is not yet known still answers with the route", async () => {
		const x = makeXfer({ bridgeUrl: undefined });
		const body = JSON.parse(textOf(await x.call("xfer_share", { path: dir }, "sid-2"))) as { url: string };
		expect(body.url).toBe(`${XFER_ROUTE}/`);
	});

	test("reports the operator's tunnel as publicUrl, and follows it per call", async () => {
		// The tunnel is the operator's: this test only turns the getter's answer on
		// and off, which is all the module is allowed to observe.
		let tunnel: string | null = PUBLIC_ORIGIN;
		const x = makeXfer({ bridgeUrl: BRIDGE_ORIGIN, publicUrl: () => tunnel });

		const started = JSON.parse(textOf(await x.call("xfer_share", { path: dir }, "sid-5"))) as {
			publicUrl: string | null;
			usage: Record<string, string>;
		};
		expect(started.publicUrl).toBe(`${PUBLIC_ORIGIN}${XFER_ROUTE}/`);
		expect(started.usage.public).toContain("Bearer <TOKEN>");
		expect(started.usage.public).toContain(`${PUBLIC_ORIGIN}${XFER_ROUTE}/<name>`);

		const open = JSON.parse(textOf(await x.call("xfer_status", {}, "sid-5"))) as { publicUrl: string | null };
		expect(open.publicUrl).toBe(`${PUBLIC_ORIGIN}${XFER_ROUTE}/`);

		// Status answers for the moment it is asked: closing the tunnel takes the
		// address away without touching the share.
		tunnel = null;
		const closed = JSON.parse(textOf(await x.call("xfer_status", {}, "sid-5"))) as { publicUrl: string | null };
		expect(closed.publicUrl).toBeNull();
	});

	test("status reports the open share and stop frees the port", async () => {
		const x = makeXfer({ bridgeUrl: BRIDGE_ORIGIN });
		expect(x.target()).toBeNull();
		expect(JSON.parse(textOf(await x.call("xfer_status", {}, "sid-3")))).toEqual({ serving: false });

		const started = JSON.parse(textOf(await x.call("xfer_share", { path: dir }, "sid-3"))) as { port: number };
		expect(typeof started.port).toBe("number");
		expect(x.target()).not.toBeNull();
		const status = JSON.parse(textOf(await x.call("xfer_status", {}, "sid-3"))) as {
			serving: boolean;
			port: number;
			path: string;
			url: string;
		};
		expect(status.serving).toBe(true);
		expect(status.port).toBe(started.port);
		expect(status.path).toBe(dir);
		expect(status.url).toBe(`${BRIDGE_ORIGIN}${XFER_ROUTE}/`);

		const stopped = JSON.parse(textOf(await x.call("xfer_stop", {}, "sid-3"))) as { stopped: boolean };
		expect(stopped.stopped).toBe(true);
		expect(x.target()).toBeNull();
		expect(portIsFree(started.port)).toBe(true);
		expect(JSON.parse(textOf(await x.call("xfer_stop", {}, "sid-3")))).toEqual({
			stopped: false,
			note: "nothing was shared",
		});
	});

	test("a second share replaces the first rather than leaving it open", async () => {
		const x = makeXfer();
		const first = JSON.parse(textOf(await x.call("xfer_share", { path: dir }, "sid-4"))) as {
			port: number;
			replaced: boolean;
		};
		expect(first.replaced).toBe(false);
		const second = JSON.parse(textOf(await x.call("xfer_share", { path: dir }, "sid-4"))) as { replaced: boolean };
		expect(second.replaced).toBe(true);
		expect(portIsFree(first.port)).toBe(true);
		expect((await recordsFor("replaced")).length).toBeGreaterThan(0);
	});

	test("stop comes back as soon as the file server is seen to exit", async () => {
		// The shape that once wedged the real thing: `close` sent SIGTERM and only
		// subscribed to the child's exit after an await, and dufs answers SIGTERM in a few
		// milliseconds — the event had been emitted before anyone was listening, the wait
		// never resolved, and `xfer_stop` hung on a share that was in fact closed. The
		// await that opened the window was the tunnel teardown, and it is gone; what is
		// pinned here is that the kill and the subscription stayed adjacent, so the exit
		// is heard rather than fallen back over.
		const x = makeXfer();
		const started = JSON.parse(textOf(await x.call("xfer_share", { path: dir }, "sid-6"))) as { port: number };

		const began = Date.now();
		const answered = await Promise.race([
			x.call("xfer_stop", {}, "sid-6").then((r) => JSON.parse(textOf(r)) as { stopped: boolean }),
			Bun.sleep(4000).then(() => null),
		]);
		expect(answered).not.toBeNull();
		expect(answered?.stopped).toBe(true);
		// And it came back because the server was seen to exit, not because the 2 s
		// SIGKILL fallback expired.
		expect(Date.now() - began).toBeLessThan(2000);
		expect(portIsFree(started.port)).toBe(true);
	});

	test("the TTL closes the share on its own", async () => {
		const x = makeXfer();
		const started = JSON.parse(textOf(await x.call("xfer_share", { path: dir, ttlSeconds: 1 }, "sid-5"))) as {
			port: number;
		};
		expect(typeof started.port).toBe("number");
		// The expiry is a real `setTimeout` inside the module whose handler also kills a
		// child process, so the assertion awaits the record that handler writes rather
		// than sleeping a guessed duration — and a fake clock cannot make the child exit.
		const deadline = Date.now() + 3000;
		let expired = "";
		while (!expired && Date.now() < deadline) {
			expired = (await recordsFor("ttl expired"))[0] ?? "";
			if (!expired) await Bun.sleep(20);
		}
		expect(expired).toContain("ttl expired");
		expect(x.target()).toBeNull();
		expect(portIsFree(started.port)).toBe(true);
	});
});

/**
 * `xfer_get` / `xfer_put`: the same file carried in base64 chunks for a caller that
 * can make a tool call but cannot send an HTTP request with a header.
 *
 * The stub above answers Range the way `dufs` 0.46.0 does (206 with a content-range,
 * 416 with the total, 404 for a directory), because both tools read and write through
 * it: what is being tested here is the arithmetic around those answers — where a chunk
 * ends, what `next` means, when a file is complete — and the refusals that keep a name
 * inside the share.
 */
describe("the chunk tools", () => {
	const shareDir = () => {
		const d = mkdtempSync(join(dir, "chunks-"));
		mkdirSync(d, { recursive: true });
		return d;
	};
	/** Bytes that survive a round trip only if nothing treats them as text. */
	const bytesOf = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256));
	const openShare = async (x: Xfer, path: string) => {
		const r = await x.call("xfer_share", { path, ttlSeconds: 60 }, "sid-chunk");
		if (r.isError) throw new Error(textOf(r));
	};

	interface Chunk {
		name: string;
		offset: number;
		total: number | null;
		bytes: number;
		next: number | null;
		encoding: string;
		data: string;
	}

	test("a chunk read walks a file to its end, and the pieces reassemble it byte-exact", async () => {
		const d = shareDir();
		const original = bytesOf(1000);
		writeFileSync(join(d, "blob.bin"), original);
		const x = makeXfer();
		await openShare(x, d);

		const pieces: Buffer[] = [];
		let offset = 0;
		let total: number | null = null;
		let calls = 0;
		for (;;) {
			const r = JSON.parse(
				textOf(await x.call("xfer_get", { name: "blob.bin", offset, maxBytes: 137 }, "sid-chunk")),
			) as Chunk;
			calls++;
			expect(r.encoding).toBe("base64");
			expect(r.offset).toBe(offset);
			total ??= r.total;
			expect(r.total).toBe(original.length);
			pieces.push(Buffer.from(r.data, "base64"));
			if (r.next === null) break;
			expect(r.next).toBe(offset + r.bytes);
			offset = r.next;
			expect(calls).toBeLessThan(20);
		}
		// 1000 bytes in 137-byte pieces: eight calls, the last one partial.
		expect(calls).toBe(8);
		expect(Buffer.concat(pieces).equals(original)).toBe(true);
		expect(total).toBe(1000);
	});

	test("the chunk is 256 KB unless asked otherwise, and a single call is capped at 1 MB", async () => {
		const d = shareDir();
		writeFileSync(join(d, "big.bin"), bytesOf(1_500_000));
		const x = makeXfer();
		await openShare(x, d);

		const plain = JSON.parse(textOf(await x.call("xfer_get", { name: "big.bin" }, "sid-chunk"))) as Chunk;
		expect(plain.bytes).toBe(256 * 1024);
		expect(Buffer.from(plain.data, "base64").length).toBe(256 * 1024);

		const greedy = JSON.parse(
			textOf(await x.call("xfer_get", { name: "big.bin", offset: 0, maxBytes: 8 * 1024 * 1024 }, "sid-chunk")),
		) as Chunk;
		expect(greedy.bytes).toBe(1024 * 1024);

		// A fraction under one byte is one byte, not an empty range: `bytes=0--1` is
		// not a request any server accepts.
		const tiny = JSON.parse(textOf(await x.call("xfer_get", { name: "big.bin", maxBytes: 0.5 }, "sid-chunk"))) as Chunk;
		expect(tiny.bytes).toBe(1);

		// And the tail of the file is where the cap stops mattering.
		const tail = JSON.parse(
			textOf(await x.call("xfer_get", { name: "big.bin", offset: 1_450_000, maxBytes: 1024 * 1024 }, "sid-chunk")),
		) as Chunk;
		expect(tail.bytes).toBe(50_000);
		expect(tail.next).toBeNull();
	});

	test("a range at or past the end answers done with no bytes, and an empty file is one such call", async () => {
		const d = shareDir();
		writeFileSync(join(d, "ten.txt"), "0123456789");
		writeFileSync(join(d, "empty.txt"), "");
		const x = makeXfer();
		await openShare(x, d);

		const past = JSON.parse(textOf(await x.call("xfer_get", { name: "ten.txt", offset: 10 }, "sid-chunk"))) as Chunk;
		expect(past).toMatchObject({ offset: 10, total: 10, bytes: 0, next: null, data: "" });

		const empty = JSON.parse(textOf(await x.call("xfer_get", { name: "empty.txt" }, "sid-chunk"))) as Chunk;
		expect(empty).toMatchObject({ total: 0, bytes: 0, next: null, data: "" });
	});

	test("a name never leaves the share, and a directory is not read in chunks", async () => {
		const d = shareDir();
		mkdirSync(join(d, "sub"));
		writeFileSync(join(dir, "outside.txt"), "not yours");
		const x = makeXfer();
		await openShare(x, d);

		const up = await x.call("xfer_get", { name: "../outside.txt" }, "sid-chunk");
		expect(up.isError).toBe(true);
		expect(textOf(up)).toContain("leaves the share");

		// A leading slash means the share root — not the host's — so this is a miss
		// inside the share, never the host's own /etc/passwd.
		const absolute = await x.call("xfer_get", { name: "/etc/passwd" }, "sid-chunk");
		expect(absolute.isError).toBe(true);
		expect(textOf(absolute)).toContain("no file named 'etc/passwd'");

		const dirOut = await x.call("xfer_get", { name: "sub" }, "sid-chunk");
		expect(dirOut.isError).toBe(true);
		expect(textOf(dirOut)).toContain("a directory is listed with the host's own tools");
	});

	test("both tools say what to call first when nothing is shared", async () => {
		const x = makeXfer();
		for (const tool of ["xfer_get", "xfer_put"]) {
			const r = await x.call(tool, tool === "xfer_get" ? { name: "a" } : { name: "a", data: "YQ==" }, "sid-none");
			expect(r.isError).toBe(true);
			expect(textOf(r)).toContain("call xfer_share first");
		}
	});

	test("a chunked upload lands byte-exact, and only the last call writes", async () => {
		const d = shareDir();
		const original = bytesOf(900);
		const x = makeXfer();
		await openShare(x, d);

		const first = JSON.parse(
			textOf(
				await x.call(
					"xfer_put",
					{ name: "up.bin", data: original.subarray(0, 300).toString("base64"), offset: 0, total: 900 },
					"sid-chunk",
				),
			),
		) as { received: number; total: number; next: number; done: boolean };
		expect(first).toMatchObject({ received: 300, total: 900, next: 300, done: false });
		expect(existsSync(join(d, "up.bin"))).toBe(false);

		await x.call(
			"xfer_put",
			{ name: "up.bin", data: original.subarray(300, 600).toString("base64"), offset: 300 },
			"sid-chunk",
		);
		expect(existsSync(join(d, "up.bin"))).toBe(false);

		const last = JSON.parse(
			textOf(
				await x.call(
					"xfer_put",
					{ name: "up.bin", data: original.subarray(600).toString("base64"), offset: 600, total: 900 },
					"sid-chunk",
				),
			),
		) as { bytes: number; done: boolean };
		expect(last).toMatchObject({ bytes: 900, done: true });
		expect(readFileSync(join(d, "up.bin")).equals(original)).toBe(true);
	});

	test("one call with no offset writes the whole file, and url-safe base64 is read as itself", async () => {
		const d = shareDir();
		const x = makeXfer();
		await openShare(x, d);
		// 0xfb 0xff encodes to `+/8=`, which is `-_8=` in the url-safe alphabet.
		const raw = Buffer.from([0xfb, 0xff, 0x00]);
		const urlSafe = raw.toString("base64url");
		const r = JSON.parse(textOf(await x.call("xfer_put", { name: "one.bin", data: urlSafe }, "sid-chunk"))) as {
			bytes: number;
			done: boolean;
		};
		expect(r).toMatchObject({ bytes: 3, done: true });
		expect(readFileSync(join(d, "one.bin")).equals(raw)).toBe(true);
	});

	test("an out-of-order chunk is refused, and the staged pieces are still there", async () => {
		const d = shareDir();
		const x = makeXfer();
		await openShare(x, d);
		await x.call("xfer_put", { name: "seq.bin", data: "AAAA", offset: 0, total: 9 }, "sid-chunk");

		const wrong = await x.call("xfer_put", { name: "seq.bin", data: "AAAA", offset: 6 }, "sid-chunk");
		expect(wrong.isError).toBe(true);
		expect(textOf(wrong)).toContain("expected offset 3");

		// The right offset still completes it: a refused piece loses nothing.
		const done = JSON.parse(
			textOf(await x.call("xfer_put", { name: "seq.bin", data: "AAAAAAAA", offset: 3, total: 9 }, "sid-chunk")),
		) as { bytes: number; done: boolean };
		expect(done).toMatchObject({ bytes: 9, done: true });
		expect(readFileSync(join(d, "seq.bin")).toString("base64")).toBe("AAAAAAAAAAAA");
	});

	test("a file over the cap is refused before anything is buffered", async () => {
		const d = shareDir();
		const x = makeXfer();
		await openShare(x, d);
		const r = await x.call(
			"xfer_put",
			{ name: "huge.bin", data: "AAAA", offset: 0, total: 17 * 1024 * 1024 },
			"sid-chunk",
		);
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("belongs on the /xfer/ route");
		expect(existsSync(join(d, "huge.bin"))).toBe(false);
	});

	test("a half-sent upload is dropped with the share it was aimed at", async () => {
		const d = shareDir();
		const x = makeXfer();
		await openShare(x, d);
		await x.call("xfer_put", { name: "later.bin", data: "AAAA", offset: 0, total: 9 }, "sid-chunk");

		// The next share serves a different path; a piece arriving against it would be
		// written into a file the caller never named.
		await x.call("xfer_stop", {}, "sid-chunk");
		await openShare(x, d);
		const r = await x.call("xfer_put", { name: "later.bin", data: "AAAA", offset: 3, total: 9 }, "sid-chunk");
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("start again with offset 0");
	});

	test("an upload nobody finished is forgotten after ten minutes", async () => {
		const d = shareDir();
		let clock = 1_000_000;
		const x = createXfer(
			{ dufs: stub, cloudflared: "cloudflared-not-used-here" },
			{ now: () => clock, bridgeUrl: () => BRIDGE_ORIGIN },
		);
		opened.push(x);
		await openShare(x, d);
		await x.call("xfer_put", { name: "idle.bin", data: "AAAA", offset: 0, total: 9 }, "sid-chunk");

		clock += 10 * 60 * 1000 + 1;
		const late = await x.call("xfer_put", { name: "idle.bin", data: "AAAA", offset: 3, total: 9 }, "sid-chunk");
		expect(late.isError).toBe(true);
		expect(textOf(late)).toContain("start again with offset 0");
	});

	test("a name with spaces and a hash travels as itself in both directions", async () => {
		const d = shareDir();
		const x = makeXfer();
		await openShare(x, d);
		await x.call("xfer_put", { name: "a b#c.txt", data: Buffer.from("odd name").toString("base64") }, "sid-chunk");
		expect(readFileSync(join(d, "a b#c.txt"), "utf8")).toBe("odd name");

		const back = JSON.parse(textOf(await x.call("xfer_get", { name: "a b#c.txt" }, "sid-chunk"))) as Chunk;
		expect(Buffer.from(back.data, "base64").toString()).toBe("odd name");
	});

	test("a chunk that runs past the announced total is refused, and nothing is written", async () => {
		const d = shareDir();
		const x = makeXfer();
		await openShare(x, d);
		const r = await x.call(
			"xfer_put",
			{ name: "liar.bin", data: Buffer.alloc(6).toString("base64"), offset: 0, total: 3 },
			"sid-chunk",
		);
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("runs to 6 bytes");
		expect(existsSync(join(d, "liar.bin"))).toBe(false);
	});

	test("a backslash reads as a separator, the way a Windows caller writes a path", async () => {
		const d = shareDir();
		mkdirSync(join(d, "sub"), { recursive: true });
		writeFileSync(join(d, "sub", "nested.txt"), "deep");
		const x = makeXfer();
		await openShare(x, d);
		const r = JSON.parse(textOf(await x.call("xfer_get", { name: "sub\\nested.txt" }, "sid-chunk"))) as Chunk;
		expect(Buffer.from(r.data, "base64").toString()).toBe("deep");
	});

	test("each chunk is one record, and the payload is not in it", async () => {
		const d = shareDir();
		const x = makeXfer();
		await openShare(x, d);
		await x.call("xfer_put", { name: "audited.bin", data: Buffer.from(bytesOf(64)).toString("base64") }, "sid-chunk");
		await x.call("xfer_get", { name: "audited.bin" }, "sid-chunk");

		const recs = (await recordsFor("audited.bin")).map(
			(l) => JSON.parse(l) as { args?: string; isError?: boolean; tool?: string },
		);
		const actions = recs.map((r) => (JSON.parse(r.args ?? "{}") as { action?: string }).action);
		expect(actions).toContain("put");
		expect(actions).toContain("get");
		for (const r of recs) expect(JSON.stringify(r)).not.toContain("AAEC");
	});
});
