/**
 * `POST /blob` at the layer this bridge owns: the route dispatch in server.ts,
 * the `issuedSession` lookup that decides the audit's `sid`, and the record
 * `auditBlob` leaves behind. The bytes themselves — multi-chunk append
 * correctness, offset races under concurrency, RSS of a 100 MB upload — stay
 * with `test/blob-probe.ts` against a real host (35 checks). What lives here is
 * the wiring the probe also exercises but cannot run without `omp`, and the two
 * clock moves (`/blob` refreshes the idle TTL, an expired session attributes as
 * `null`) that only an injected clock can reach at all.
 *
 * Small files in a temp dir are not a "fake disk" — the writes are real and
 * tiny; what they deliberately do not re-litigate is byte fidelity.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditStart } from "../src/audit.ts";
import { handleBlob } from "../src/blob.ts";
import type { BridgeDeps } from "../src/server.ts";
import { SESSION_TTL_MS, startServer } from "../src/server.ts";

const TOKEN = "route-test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const dir = `/tmp/a2a-blob-route-${process.pid}`;
const auditFile = join(dir, "audit.log");

// Injectable clock, same shape as test/server.test.ts: the TTL branches of
// issuedSession are only reachable by moving time, not waiting for it.
let clock = Date.now();

function makeDeps(): BridgeDeps {
	return {
		async getTools() {
			return [{ name: "echo", description: "Echo args back", inputSchema: { type: "object" } }];
		},
		async callTool(name, args) {
			return { content: [{ type: "text", text: `${name} saw ${JSON.stringify(args)}` }], isError: false };
		},
		serverInfo: () => ({ name: "stub-server", version: "9.9.9" }),
		now: () => clock,
	};
}

async function init(base: string): Promise<string> {
	const res = await fetch(base, {
		method: "POST",
		headers: { "content-type": "application/json", ...AUTH },
		body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
	});
	const sid = res.headers.get("mcp-session-id");
	if (!sid) throw new Error(`initialize failed with HTTP ${res.status}`);
	return sid;
}

async function ping(base: string, sid: string): Promise<Response> {
	return fetch(base, {
		method: "POST",
		headers: { "content-type": "application/json", ...AUTH, "mcp-session-id": sid },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
	});
}

function postBlob(
	base: string,
	query: string,
	body: string | Uint8Array,
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(`${base}blob${query}`, {
		method: "POST",
		headers: { ...AUTH, "content-type": "application/octet-stream", ...headers },
		body: body as BodyInit,
	});
}

const target = (name: string) => join(dir, name);

const lines = (): string[] =>
	existsSync(auditFile) ? readFileSync(auditFile, "utf8").split("\n").filter(Boolean) : [];

const recordsHolding = (needle: string) => lines().filter((l) => l.includes(needle));

/**
 * Drain the audit chain.
 *
 * `POST /blob` awaits its record before it answers, so a record belonging to a
 * response this test already holds is on disk by the time that response arrived —
 * no polling needed. The sentinel is still worth keeping: it proves the chain is
 * empty rather than assuming the ordering held, which is the honest way to check
 * an absence.
 */
async function flush(): Promise<void> {
	const marker = `sentinel-${Date.now()}-${Math.random()}`;
	await auditStart(marker, "flush", "flush", {}, process.env);
	if (recordsHolding(marker).length === 0) throw new Error("audit record missing right after its own await");
}

async function recordFor(needle: string): Promise<Record<string, unknown>> {
	await flush();
	const hit = recordsHolding(needle)[0];
	if (!hit) throw new Error(`no audit record holding ${needle}`);
	return JSON.parse(hit) as Record<string, unknown>;
}

beforeAll(() => {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	// auditBlob is reached through handleBlob, which does not thread an env
	// through — the log path is resolved from process.env at call time.
	process.env.A2A_BRIDGE_AUDIT = auditFile;
});

afterAll(() => {
	delete process.env.A2A_BRIDGE_AUDIT;
	rmSync(dir, { recursive: true, force: true });
});

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
	const s = await startServer({ port: 0, host: "127.0.0.1", token: TOKEN, host_llm: "allow" as const }, makeDeps());
	try {
		await fn(`http://127.0.0.1:${s.port}/`);
	} finally {
		s.stop();
	}
}

describe("/blob route dispatch and audit wiring", () => {
	test("unauthenticated POST /blob is a 401 before the payload is read", async () => {
		await withServer(async (base) => {
			const res = await fetch(`${base}blob?path=${encodeURIComponent(target("never.bin"))}`, {
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: "nope",
			});
			expect(res.status).toBe(401);
			await flush();
			expect(existsSync(target("never.bin"))).toBe(false);
			expect(recordsHolding("never.bin")).toEqual([]);
		});
	});

	test("DELETE /blob is 405 and does not end the MCP session", async () => {
		await withServer(async (base) => {
			const sid = await init(base);
			const res = await fetch(`${base}blob?path=${encodeURIComponent(target("del.bin"))}`, {
				method: "DELETE",
				headers: AUTH,
			});
			expect(res.status).toBe(405);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toContain("POST only");
			// The whole point of the guard: a write endpoint answering 204 here
			// would report a session teardown nobody asked for.
			expect((await ping(base, sid)).status).toBe(200);
			expect(existsSync(target("del.bin"))).toBe(false);
		});
	});

	test("rejected shapes (no path, empty body, bad offset) write nothing and audit nothing", async () => {
		await withServer(async (base) => {
			expect((await postBlob(base, "", "x")).status).toBe(400);
			expect((await postBlob(base, `?path=${encodeURIComponent(target("empty.bin"))}`, "")).status).toBe(400);
			expect((await postBlob(base, `?path=${encodeURIComponent(target("off.bin"))}&offset=abc`, "x")).status).toBe(400);
			await flush();
			for (const n of ["empty.bin", "off.bin"]) expect(existsSync(target(n))).toBe(false);
			expect(recordsHolding("empty.bin")).toEqual([]);
			expect(recordsHolding("off.bin")).toEqual([]);
		});
	});

	test("a write with an issued session is audited verbatim, beside the bytes", async () => {
		await withServer(async (base) => {
			const sid = await init(base);
			const res = await postBlob(base, `?path=${encodeURIComponent(target("raw.bin"))}`, "abcdef", {
				"mcp-session-id": sid,
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { written: number; offset: number; size: number };
			expect(body).toMatchObject({ written: 6, offset: 0, size: 6 });
			expect(readFileSync(target("raw.bin"), "utf8")).toBe("abcdef");
			const rec = await recordFor("raw.bin");
			expect(rec).toMatchObject({ phase: "done", tool: "blob:write", sid, isError: false });
			expect(String(rec.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/); // the bridge's own pairing UUID
			expect(String(rec.args)).toContain('"bytes":6');
			expect(recordsHolding("raw.bin").length).toBe(1); // one line, not a start/done pair
		});
	});

	test("a session id the bridge never issued is attributed as null, not as the claim", async () => {
		await withServer(async (base) => {
			const forged = await postBlob(base, `?path=${encodeURIComponent(target("forged.bin"))}`, "x", {
				"mcp-session-id": "i-say-so",
			});
			expect(forged.status).toBe(200);
			const headerless = await postBlob(base, `?path=${encodeURIComponent(target("nosid.bin"))}`, "x");
			expect(headerless.status).toBe(200);
			expect((await recordFor("forged.bin")).sid).toBeNull();
			expect((await recordFor("nosid.bin")).sid).toBeNull();
		});
	});

	test("/blob hits refresh the idle clock, and expiry re-attributes to null", async () => {
		const start = clock;
		await withServer(async (base) => {
			const sid = await init(base);

			// Just short of a TTL on the MCP path; the blob hit is the only activity.
			clock = start + SESSION_TTL_MS - 1000;
			const hit = await postBlob(base, `?path=${encodeURIComponent(target("ttl.bin"))}`, "x", {
				"mcp-session-id": sid,
			});
			expect(hit.status).toBe(200);
			expect((await recordFor("ttl.bin")).sid).toBe(sid);

			// More than a full TTL after THAT hit: the session is alive only
			// because /blob moved last-seen. Without the refresh in issuedSession
			// this ping is a 404.
			clock = start + 2 * SESSION_TTL_MS - 1500;
			expect((await ping(base, sid)).status).toBe(200);

			// Let it lapse for real. The same id may still upload — the bridge
			// does not gate on this — but the lookup has evicted it, so the
			// record says "caller unknown".
			clock = start + 3 * SESSION_TTL_MS;
			const late = await postBlob(base, `?path=${encodeURIComponent(target("late.bin"))}`, "y", {
				"mcp-session-id": sid,
			});
			expect(late.status).toBe(200);
			expect((await recordFor("late.bin")).sid).toBeNull();
		});
		clock = start;
	});

	test("an upload that cannot open is audited as an error, not missing", async () => {
		await withServer(async (base) => {
			mkdirSync(target("adir"), { recursive: true });
			const res = await postBlob(base, `?path=${encodeURIComponent(target("adir"))}`, "x");
			expect(res.status).toBe(500);
			const rec = await recordFor("adir");
			expect(rec.isError).toBe(true);
			expect(String(rec.error)).toContain("open failed");
			expect(String(rec.args)).toContain('"bytes":0');
		});
	});

	test("a 409 offset mismatch rewrites nothing and still leaves a record", async () => {
		await withServer(async (base) => {
			const first = await postBlob(base, `?path=${encodeURIComponent(target("clash.bin"))}`, "12345678");
			expect(first.status).toBe(200);
			await recordFor("clash.bin");

			const clash = await postBlob(base, `?path=${encodeURIComponent(target("clash.bin"))}&offset=5`, "xx");
			expect(clash.status).toBe(409);
			expect(readFileSync(target("clash.bin"), "utf8")).toBe("12345678");
			// Written nothing, still recorded: this endpoint bypasses the host's
			// approval gate, so the log is the only trace a caller leaves, and a
			// chunked upload whose offset drifts is the commonest way to land here.
			const rec = await recordFor("does not match the current size");
			expect(rec.tool).toBe("blob:write");
			expect(rec.isError).toBe(true);
			expect(String(rec.args)).toContain('"bytes":0');
			expect(recordsHolding("clash.bin").length).toBe(2); // the write, then the refusal
		});
	});

	test("a 409 on a fresh file is recorded too — nothing about a refusal is invisible", async () => {
		await withServer(async (base) => {
			// The same refusal decided before the body is read: no handle is open, no
			// bytes moved, and it used to be the one exit with no line at all.
			const res = await postBlob(base, `?path=${encodeURIComponent(target("never.bin"))}&offset=9`, "xx");
			expect(res.status).toBe(409);
			const rec = await recordFor("never.bin");
			expect(rec.isError).toBe(true);
			expect(String(rec.args)).toContain('"offset":9');
			expect(existsSync(target("never.bin"))).toBe(false);
		});
	});
});

/**
 * The third refusal, and the only one that needed a race to reach: between the
 * size read before the body and the size read after the handle is open, another
 * writer appends. Concurrency is what makes it reachable in production and what
 * makes it awkward to test — the body is held open across the window here so the
 * window is a promise instead of a hope. `handleBlob` reads one method off the
 * request, so a stub with a gated `arrayBuffer` is the whole seam.
 */
describe("handleBlob's in-flight offset race", () => {
	// Same temp dir and audit log as the route tests above: `handleBlob` resolves
	// the log path from process.env at call time, so there is nothing to set up.
	test("a file that grew while the body was in flight is refused, and the refusal is recorded", async () => {
		const path = target("raced.bin");
		writeFileSync(path, "123");
		const url = new URL(`http://127.0.0.1/blob?path=${encodeURIComponent(path)}&offset=3`);

		let enter!: () => void;
		const reading = new Promise<void>((r) => {
			enter = r;
		});
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const body = Buffer.from("xx");
		const req = {
			arrayBuffer: async () => {
				// Reached only after the pre-flight stat, which is what makes the
				// ordering below deterministic rather than a coin flip.
				enter();
				await gate;
				return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
			},
		} as unknown as Request;

		const pending = handleBlob(req, url, { sid: null });
		await reading;
		appendFileSync(path, "456"); // the other writer, inside the window
		release();

		const res = await pending;
		expect(res.status).toBe(409);
		expect(String((res.body as { error?: string }).error)).toContain("changed while the upload was in flight");
		expect(readFileSync(path, "utf8")).toBe("123456"); // the racing append, not our two bytes

		// Drain the audit queue by waiting for this record rather than a timer.
		await flush();
		const rec = await recordFor("changed while the upload was in flight");
		expect(rec.tool).toBe("blob:write");
		expect(rec.isError).toBe(true);
		expect(String(rec.args)).toContain('"offset":3');
		expect(String(rec.args)).toContain('"bytes":0');
	});
});
