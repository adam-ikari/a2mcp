/**
 * `POST /host-llm` at the dispatch layer: the order the handler checks things
 * in (method → auth → body → action), what each refusal shape
 * returns, and the audit record `auditHostLlm` leaves. The takeover itself is
 * stubbed — a real arm is the 7th host probe's job (`test/takeover-probe.ts`);
 * what lives here is the wiring the probe cannot vary cheaply: 401-before-body,
 * 405 semantics, the `sid` attribution, and the error path being a record
 * rather than a missing line.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { auditStart } from "../src/audit.ts";
import type { BridgeDeps, TakeoverDeps } from "../src/server.ts";
import { startServer } from "../src/server.ts";

const TOKEN = "hostllm-test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const dir = `/tmp/a2mcp-hostllm-route-${process.pid}`;
const auditFile = join(dir, "audit.log");

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
process.env.A2MCP_AUDIT = auditFile;

type Call = { enabled: boolean };

function makeTakeover(): TakeoverDeps & { calls: Call[]; fail: string | null } {
	const stub = {
		calls: [] as Call[],
		fail: null as string | null,
		enabled: true,
		setEnabled(enabled: boolean) {
			stub.calls.push({ enabled });
			if (stub.fail) throw new Error(stub.fail);
			stub.enabled = enabled;
			// The third field is part of the shape the endpoint forwards: the stub
			// used to omit it and `TakeoverDeps` used not to require it, which is
			// exactly the drift the declared type now prevents.
			return { enabled: stub.enabled, denied: stub.calls.length, degraded: false };
		},
	};
	return stub;
}

function makeDeps(takeover?: TakeoverDeps & { calls: Call[] }): BridgeDeps {
	return {
		async getTools() {
			return [];
		},
		async callTool() {
			return { content: [{ type: "text", text: "stub" }], isError: false };
		},
		serverInfo: () => ({ name: "stub-server", version: "9.9.9" }),
		takeover,
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

function postHostLlm(base: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${base}host-llm`, {
		method: "POST",
		headers: { "content-type": "application/json", ...AUTH, ...headers },
		body,
	});
}

const lines = (): string[] =>
	existsSync(auditFile) ? readFileSync(auditFile, "utf8").split("\n").filter(Boolean) : [];
const recordsHolding = (needle: string) => lines().filter((l) => l.includes(needle));

/**
 * Drain the audit chain.
 *
 * The request path awaits its own record before answering, so a record belonging
 * to a response this test already has is on disk by the time the response
 * arrives — awaiting the sentinel is enough and no polling is needed. It still
 * takes a sentinel rather than reading the file straight away: every test in
 * this file shares one log, and the sentinel proves the chain is empty instead of
 * assuming the ordering held.
 */
async function flush(): Promise<void> {
	const marker = `sentinel-${Date.now()}-${Math.random()}`;
	await auditStart(marker, "flush", "flush", {}, process.env);
	if (recordsHolding(marker).length === 0) throw new Error("audit record missing right after its own await");
}

async function recordFor(needle: string): Promise<Record<string, unknown>> {
	await flush();
	// Last match, not first: every test shares this log file, and args like
	// `{"enabled":true}` repeat across cases by design.
	const all = recordsHolding(needle);
	const hit = all[all.length - 1];
	if (!hit) throw new Error(`no audit record holding ${needle}`);
	return JSON.parse(hit) as Record<string, unknown>;
}

async function withServer(
	fn: (base: string, takeover: ReturnType<typeof makeTakeover>) => Promise<void>,
): Promise<void> {
	const takeover = makeTakeover();
	const s = await startServer(
		{
			port: 0,
			host: "127.0.0.1",
			token: TOKEN,
			host_llm: "allow" as const,
			xfer: { dufs: "dufs", cloudflared: "cloudflared" },
		},
		makeDeps(takeover),
	);
	try {
		await fn(`http://127.0.0.1:${s.port}/`, takeover);
	} finally {
		s.stop();
	}
}

describe("POST /host-llm route dispatch", () => {
	test("unauthenticated requests are refused before the body is read or the switch is touched", async () => {
		await withServer(async (base, takeover) => {
			const res = await fetch(`${base}host-llm`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled: false }),
			});
			expect(res.status).toBe(401);
			expect(takeover.calls).toEqual([]);
			await flush();
			expect(recordsHolding('"tool":"host_llm"').length).toBe(0); // no record for a knock that never got in
		});
	});

	test("DELETE and GET are 405; a DELETE does not end the MCP session", async () => {
		await withServer(async (base, takeover) => {
			const sid = await init(base);
			const del = await fetch(`${base}host-llm`, { method: "DELETE", headers: AUTH });
			expect(del.status).toBe(405);
			const body = (await del.json()) as { error?: string };
			expect(body.error).toContain("POST only");
			const get = await fetch(base, { method: "GET", headers: AUTH });
			expect(get.status).toBe(405);
			expect(takeover.calls).toEqual([]);
			const ping = await fetch(base, {
				method: "POST",
				headers: { "content-type": "application/json", ...AUTH, "mcp-session-id": sid },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			});
			expect(ping.status).toBe(200);
		});
	});

	test("malformed bodies are 400 and never reach the switch", async () => {
		await withServer(async (base, takeover) => {
			expect((await postHostLlm(base, "not json")).status).toBe(400);
			expect((await postHostLlm(base, JSON.stringify({ enabled: "false" }))).status).toBe(400);
			expect((await postHostLlm(base, JSON.stringify({}))).status).toBe(400);
			expect((await postHostLlm(base, JSON.stringify([]))).status).toBe(400);
			expect((await postHostLlm(base, "null")).status).toBe(400);
			expect(takeover.calls).toEqual([]);
			await flush();
			expect(recordsHolding('"tool":"host_llm"').length).toBe(0);
		});
	});

	test("a valid toggle answers with the post-call state and audits one record", async () => {
		await withServer(async (base, takeover) => {
			const sid = await init(base);
			const off = await postHostLlm(base, JSON.stringify({ enabled: false }), { "mcp-session-id": sid });
			expect(off.status).toBe(200);
			// Exact equality on purpose: the route forwards the takeover's state as
			// the response body, so this pins the whole documented shape — including
			// `degraded`, which is what tells a caller that deny is on over a session
			// it never reached.
			expect(await off.json()).toEqual({ enabled: false, denied: 1, degraded: false });
			expect(takeover.calls).toEqual([{ enabled: false }]);

			const on = await postHostLlm(base, JSON.stringify({ enabled: true }), { "mcp-session-id": sid });
			expect(on.status).toBe(200);
			expect(await on.json()).toEqual({ enabled: true, denied: 2, degraded: false });

			await flush();
			const rec = await recordFor('enabled\\":false');
			expect(rec).toMatchObject({ phase: "done", tool: "host_llm", sid, isError: false });
			expect(recordsHolding('enabled\\":true').length).toBe(1); // one line per toggle, not a pair
		});
	});

	test("a forged session header attributes as null, not as the claim", async () => {
		await withServer(async (base) => {
			const res = await postHostLlm(base, JSON.stringify({ enabled: true }), { "mcp-session-id": "i-say-so" });
			expect(res.status).toBe(200);
			expect((await recordFor('enabled\\":true')).sid).toBeNull();
		});
	});

	test("a refused arming is a 500 with the reason, and the refusal is audited", async () => {
		await withServer(async (base, takeover) => {
			takeover.fail = "cannot arm takeover: model custom/native uses pi-native transport";
			const res = await postHostLlm(base, JSON.stringify({ enabled: false }));
			expect(res.status).toBe(500);
			expect(((await res.json()) as { error: string }).error).toContain("pi-native");
			const rec = await recordFor("pi-native");
			expect(rec.isError).toBe(true);
			expect(String(rec.args)).toContain('"enabled":false');
		});
	});

	test("a bridge without takeover wiring answers 501 instead of pretending", async () => {
		const s = await startServer(
			{
				port: 0,
				host: "127.0.0.1",
				token: TOKEN,
				host_llm: "allow" as const,
				xfer: { dufs: "dufs", cloudflared: "cloudflared" },
			},
			makeDeps(undefined),
		);
		try {
			const res = await postHostLlm(`http://127.0.0.1:${s.port}/`, JSON.stringify({ enabled: false }));
			expect(res.status).toBe(501);
		} finally {
			s.stop();
		}
	});
});
