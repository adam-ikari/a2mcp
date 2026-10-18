/**
 * `xfer_*`, the bridge's own transfer tools (src/xfer.ts).
 *
 * What these tests are for: the wiring the real binaries cannot be asked about.
 * The share flow runs against a stub file server written at run time (an
 * executable that takes the same command line: root, `--port`, `--auth
 * user:pass@/:rw`) and a stubbed tunnel opener, so the assertions are about *this*
 * module — that the port it picks is the port it serves on, that the credentials
 * it invents are the ones the server checks, that a share is audited, that `stop`
 * and the TTL really close it. Which flags `dufs` accepts and whether
 * `cloudflared` publishes a reachable hostname is real-machine work, not something
 * a unit test can fake its way to.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { auditStart } from "../src/audit.ts";
import type { resolveBinary } from "../src/obtain.ts";
import type { TunnelOpener } from "../src/tunnel.ts";
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
const auditFile = join(dir, "audit.log");
process.env.A2MCP_AUDIT = auditFile;

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
 * A stand-in for dufs: same argument shape, serves the root over HTTP with the
 * given basic credentials, accepts PUT. Written as an executable with a shebang
 * because `xfer.dufs` names a program, not a shell line — the first version of this
 * test passed `bun <file>` as the binary name and spawn looked for a file with that
 * whole string as its name.
 */
const STUB = `#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
const root = argv[0];
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const port = Number(flag("--port"));
const creds = (flag("--auth") ?? "").split("@")[0];
const expected = "Basic " + Buffer.from(creds).toString("base64");
Bun.serve({
	hostname: "127.0.0.1",
	port,
	fetch: async (req) => {
		if (req.headers.get("authorization") !== expected) return new Response("denied", { status: 401 });
		const p = join(root, new URL(req.url).pathname);
		if (req.method === "PUT") {
			mkdirSync(dirname(p), { recursive: true });
			await Bun.write(p, req);
			return new Response("ok");
		}
		if (!existsSync(p)) return new Response("nope", { status: 404 });
		// The readiness probe asks for "/", which is the root directory: a listing, not
		// a file. Reading it as a file throws, and a 500 there is what a readiness loop
		// keeps waiting on.
		if (statSync(p).isDirectory()) return new Response("listing");
		return new Response(readFileSync(p));
	},
});
`;
const stub = join(stubDir, "stub-dufs");
writeFileSync(stub, STUB, { mode: 0o755 });

/**
 * The tunnel opener is faked, so this name is never executed — it only has to be a
 * path the real resolver (src/obtain.ts) accepts without reaching for the network.
 * A bare name here would be a request to download, which is what these tests are not
 * about.
 */
const cloudStub = join(stubDir, "stub-cloudflared");
writeFileSync(cloudStub, "#!/usr/bin/env bun\n", { mode: 0o755 });

const opened: Xfer[] = [];
/**
 * The stand-in tunnel opener. `stopMs` is how long its `stop()` takes: the real one
 * tears down a child process and therefore spends event-loop time, and that window is
 * where a share's other child dies.
 */
function fakeTunnel(stopMs = 0): TunnelOpener {
	return async (opts) => ({
		url: `https://stub-tunnel-${opts.port}.trycloudflare.com`,
		port: opts.port,
		pid: 4242,
		stop: async () => {
			if (stopMs > 0) await Bun.sleep(stopMs);
		},
	});
}

function makeXfer(
	over: { dufs?: string; cloudflared?: string; resolveBinary?: typeof resolveBinary; tunnelStopMs?: number } = {},
) {
	const x = createXfer(
		{ dufs: over.dufs ?? stub, cloudflared: over.cloudflared ?? cloudStub },
		{
			openTunnel: fakeTunnel(over.tunnelStopMs ?? 0),
			...(over.resolveBinary ? { resolveBinary: over.resolveBinary } : {}),
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

	test("a bare name goes through the resolver, and the path it returns is what runs", async () => {
		const seen: Array<[string, string]> = [];
		const x = makeXfer({
			dufs: "dufs-nomatter-what-this-is-called",
			cloudflared: "cloudflared-also-just-a-name",
			resolveBinary: async (name, configured) => {
				seen.push([name, configured]);
				return name === "dufs"
					? {
							path: stub,
							installed: {
								name: "dufs",
								version: "0.0.0-test",
								target: "test-target",
								sha256: "x".repeat(64),
								dest: stub,
							},
						}
					: { path: cloudStub, installed: null };
			},
		});
		const r = await x.call("xfer_share", { path: dir }, "sid-1");
		expect(r.isError).toBe(false);
		expect(seen).toEqual([
			["dufs", "dufs-nomatter-what-this-is-called"],
			["cloudflared", "cloudflared-also-just-a-name"],
		]);
		// The caller is told what the bridge fetched, because that is where the seconds went.
		expect(JSON.parse(textOf(r)).installed).toEqual({ dufs: "0.0.0-test", cloudflared: null });
	});

	test("a resolver that cannot fetch is a refusal, not a half-open share", async () => {
		const x = makeXfer({
			resolveBinary: async (name) => {
				if (name === "cloudflared") throw new Error("no pinned cloudflared build for test-target");
				return { path: stub, installed: null };
			},
		});
		const r = await x.call("xfer_share", { path: dir }, "sid-1");
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("no pinned cloudflared build");
		const rec = await recordsFor("no pinned cloudflared build");
		expect(rec.length).toBeGreaterThan(0);
	});
});

describe("xfer_share lifecycle", () => {
	test("serves the path, hands back a URL with credentials, and audits it", async () => {
		const shareDir = join(dir, "shared");
		mkdirSync(shareDir, { recursive: true });
		writeFileSync(join(shareDir, "hello.txt"), "hello over http\n");

		const x = makeXfer();
		const r = await x.call("xfer_share", { path: shareDir, ttlSeconds: 60 }, "sid-2");
		expect(textOf(r)).not.toContain("cannot");
		expect(r.isError).toBe(false);
		const body = JSON.parse(textOf(r)) as {
			url: string;
			host: string;
			port: number;
			user: string;
			secret: string;
			expiresAt: string;
		};
		expect(body.url.startsWith(`https://${body.user}:${body.secret}@`)).toBe(true);
		expect(body.host).toContain("trycloudflare.com");
		expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

		// The stub checks the credentials the module invented, on the port it picked.
		const good = await fetch(`http://127.0.0.1:${body.port}/hello.txt`, {
			headers: { authorization: `Basic ${Buffer.from(`${body.user}:${body.secret}`).toString("base64")}` },
		});
		expect(good.status).toBe(200);
		expect(await good.text()).toBe("hello over http\n");
		const bad = await fetch(`http://127.0.0.1:${body.port}/hello.txt`, {
			headers: { authorization: `Basic ${Buffer.from("omp:wrong").toString("base64")}` },
		});
		expect(bad.status).toBe(401);

		const rec = JSON.parse((await recordsFor(shareDir))[0] ?? "{}") as { tool?: string; isError?: boolean };
		expect(rec.tool).toBe("xfer");
		expect(rec.isError).toBe(false);
	});

	test("status reports the open share and stop frees the port", async () => {
		const x = makeXfer();
		expect(JSON.parse(textOf(await x.call("xfer_status", {}, "sid-3")))).toEqual({ serving: false });

		const started = JSON.parse(textOf(await x.call("xfer_share", { path: dir }, "sid-3"))) as { port: number };
		expect(typeof started.port).toBe("number");
		const status = JSON.parse(textOf(await x.call("xfer_status", {}, "sid-3"))) as {
			serving: boolean;
			port: number;
			path: string;
		};
		expect(status.serving).toBe(true);
		expect(status.port).toBe(started.port);
		expect(status.path).toBe(dir);

		const stopped = JSON.parse(textOf(await x.call("xfer_stop", {}, "sid-3"))) as { stopped: boolean };
		expect(stopped.stopped).toBe(true);
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

	test("stop returns when the file server dies while the tunnel is being torn down", async () => {
		// The shape that wedged the real thing: `close` sent SIGTERM, awaited the tunnel,
		// and only then subscribed to the file server's exit. dufs answers SIGTERM in a
		// few milliseconds, so the event had already been emitted by the time anyone was
		// listening, the wait never resolved, and `xfer_stop` hung forever on a share
		// that was in fact fully closed. The stub's stop() spends that milliseconds of
		// event-loop time; a stub that resolves immediately keeps the kill and the
		// subscription adjacent and proves nothing.
		const x = makeXfer({ tunnelStopMs: 150 });
		const started = JSON.parse(textOf(await x.call("xfer_share", { path: dir }, "sid-6"))) as { port: number };

		const began = Date.now();
		const answered = await Promise.race([
			x.call("xfer_stop", {}, "sid-6").then((r) => JSON.parse(textOf(r)) as { stopped: boolean }),
			Bun.sleep(4000).then(() => null),
		]);
		expect(answered).not.toBeNull();
		expect(answered?.stopped).toBe(true);
		// And it came back because the server was seen to exit, not because a fallback
		// timer expired.
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
		expect(portIsFree(started.port)).toBe(true);
	});
});
