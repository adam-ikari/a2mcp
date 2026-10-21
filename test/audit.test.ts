import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	auditDone,
	auditHostLlm,
	auditLogPath,
	auditQuiet,
	auditStart,
	auditTunnel,
	auditWriteFailures,
	setAuditQuiet,
} from "../src/audit.ts";

/**
 * Day files.
 *
 * The log is one file per day and the bridge sets no bounds on it: no size cap, no
 * file count, nothing deleted. How long evidence is kept is the administrator's
 * call — the bridge's part is to put each day's records where they can be found
 * and kept, in a shape logrotate and "copy it out before you need it" both expect.
 */
describe("audit day files", () => {
	const dir = `/tmp/a2mcp-audit-days-${process.pid}`;
	const base = join(dir, "audit.log");
	const env = { A2MCP_AUDIT: base } as NodeJS.ProcessEnv;
	const fileFor = (at: Date) => auditLogPath(env, at);
	const today = new Date();
	const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

	test("a record lands in the file for the day it is stamped with", async () => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		await auditStart("day-yesterday", "sid", "read", { path: "/etc/hostname" }, env, yesterday);
		await auditDone("day-yesterday", "sid", "read", { path: "/etc/hostname" }, false, null, env, yesterday);
		await auditStart("day-today", "sid", "read", { path: "/etc/hostname" }, env, today);
		// The name and the contents cannot disagree: the file is picked from the same
		// moment the timestamp is stamped.
		expect(readFileSync(fileFor(yesterday), "utf8")).toContain('"id":"day-yesterday"');
		expect(readFileSync(fileFor(yesterday), "utf8")).not.toContain('"id":"day-today"');
		expect(readFileSync(fileFor(today), "utf8")).toContain('"id":"day-today"');
		rmSync(dir, { recursive: true, force: true });
	});

	test("the bridge deletes nothing: an earlier day's file is still there", async () => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(fileFor(yesterday), '{"id":"kept-by-the-administrator"}\n');
		await auditStart("only-today", "sid", "read", {}, env, today);
		expect(existsSync(fileFor(yesterday))).toBe(true);
		expect(readFileSync(fileFor(yesterday), "utf8")).toContain("kept-by-the-administrator");
		rmSync(dir, { recursive: true, force: true });
	});
});

/**
 * The invariant behind `appendLine`'s swallowed rejection: auditing must never fail
 * or delay the call itself. Two ways a record could go missing — args the log
 * cannot serialize, and a path it cannot write to.
 */
describe("audit never loses a call", () => {
	const dir = `/tmp/a2mcp-audit-invariant-${process.pid}`;
	const env = { A2MCP_AUDIT: join(dir, "audit.log") } as NodeJS.ProcessEnv;

	const readRecords = () => {
		// The dated file, not the base name: the bridge writes one file per day.
		const file = auditLogPath(env);
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	};

	const recordFor = (id: string) => {
		// Every caller awaits its own append before looking, so this is one read and
		// not a poll. It used to retry for three seconds, which is the wait that hid
		// the ordering bug: a caller that answered before its record landed still
		// passed here, and the race only showed up in the real-host scenarios.
		const hit = readRecords().find((r) => r.id === id);
		if (!hit) throw new Error(`audit record ${id} is not on disk after its own await`);
		return hit;
	};

	beforeAll(() => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("the audit functions hand back the queue tail, so a caller can wait for its own line", async () => {
		// Two halves, and the split matters. The property itself — "the record is on
		// disk the moment the await returns" — can only be observed through a slow
		// disk: on a fast one both the old fire-and-forget shape and the awaited one
		// look identical, which is exactly why the ordering bug survived as a flake
		// in the real-host scenarios instead of failing here. So the behavioural half
		// is asserted directly (with no waiting of any kind around the read), and the
		// deterministic half pins the shape the request path depends on: every entry
		// point returns the chain tail. Drop the `Promise` from one of these signatures
		// and this goes red immediately, no timing involved.
		for (const [name, call] of [
			["auditStart", () => auditStart("shape-start", "sid", "read", {}, env)],
			["auditDone", () => auditDone("shape-done", "sid", "read", {}, false, null, env)],
			["auditHostLlm", () => auditHostLlm("sid", true, null, env)],
			["auditTunnel", () => auditTunnel("stop", {}, null, env)],
		] as const) {
			const returned = call();
			expect(returned, `${name} returns the queue tail`).toBeInstanceOf(Promise);
			await returned;
		}
		const logFile = auditLogPath(env);
		const raw = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
		const onDisk = readRecords().map((r) => String(r.id));
		expect(onDisk).toContain("shape-start");
		expect(onDisk).toContain("shape-done");
		// auditHostLlm mints its own uuid, so the identifying content is in the record
		// rather than in its id — and `args` is itself a serialized string, so the
		// payload shows up escaped inside the line.
		expect(raw).toContain('"tool":"host_llm"');
	});

	test("a done record carries the failure's text, cut at 200, and only on a failure", async () => {
		// The outcome of a remote call exists nowhere else — the host's transcript
		// keeps the arguments and never the result — so the reason a call failed has
		// to live in this record; `isError: true` on its own says that something
		// failed and nothing about what. The cut is the same 200 the other records'
		// error halves use: the text is a tool's own output and can be any length.
		await auditDone("why-1", "sid", "read", {}, true, "x".repeat(300), env);
		await auditDone("why-2", "sid", "read", {}, false, "a success has no reason", env);
		const recs = readRecords().filter((r) => r.id === "why-1" || r.id === "why-2");
		const failed = recs.find((r) => r.id === "why-1");
		expect(failed).toMatchObject({ isError: true, phase: "done" });
		expect(String(failed?.error)).toHaveLength(200);
		// And a success carries no error field at all: `isError: false` beside an
		// `error` would be a contradiction in a log people read to decide whether to
		// trust a call.
		const ok = recs.find((r) => r.id === "why-2");
		expect(ok).toMatchObject({ isError: false });
		expect(ok?.error).toBeUndefined();
	});

	test("the quiet gate stops every writer, not just the calls", async () => {
		// One switch for every writer. A mode that silenced the calls but not the
		// shares, the tunnel or the arming would promise whatever the code paths
		// happened to be wired for — and the promise would change with the next
		// record kind.
		const before = readRecords().length;
		setAuditQuiet(true);
		await auditStart("quiet-start", "sid", "read", {}, env);
		await auditDone("quiet-done", "sid", "read", {}, false, null, env);
		await auditTunnel("start", { url: "https://quiet.example" }, null, env);
		await auditHostLlm("sid", true, null, env);
		setAuditQuiet(false);
		expect(readRecords().length).toBe(before);
		expect(readRecords().some((r) => String(r.args).includes("quiet.example"))).toBe(false);
		// And the switch's own record is the one line that survives it: it is written
		// just outside the silent window, so a quiet stretch says why.
		expect(auditQuiet()).toBe(false);
	});

	test("a tunnel record carries no session and cuts its error like the others", async () => {
		// `/a2mcp tunnel` is an operator command, not a request: there is no caller
		// session to attribute, so `sid` is null by design — the same shape as the
		// startup host_llm record (also no `id` to pair by; it mints a uuid). What
		// has to hold is the tag, the null, and the 200-char error cut, because the
		// error half is the line an operator greps when the tunnel did not come up.
		await auditTunnel("start", { url: "https://t.example.trycloudflare.com", port: 41_000 }, null, env);
		await auditTunnel("start", { port: 41_000 }, "t".repeat(300), env);
		const recs = readRecords().filter((r) => r.tool === "tunnel");
		const started = recs.find((r) => !r.isError && String(r.args).includes("t.example"));
		expect(started).toMatchObject({ sid: null, phase: "event", tool: "tunnel", isError: false });
		expect(String(started?.args)).toContain('"port":41000');
		const failed = recs.find((r) => r.isError);
		expect(String(failed?.error)).toHaveLength(200);
	});

	test("args that JSON.stringify rejects are still recorded", async () => {
		// A custom tool can hand over a BigInt and `JSON.stringify` throws on it. The
		// record survives that; its args do not, which is the accepted half of the
		// trade — a vague line beats no line for the `start` without `done` lookup.
		// Awaited, not wrapped in `expect(() => …).not.toThrow()`: these return the
		// queue tail now, and a sync call-throw assertion on a promise-returning
		// function proves nothing about the rejection it used to be guarding.
		await expect(auditStart("big-start", "sid", "read", { when: 10n }, env)).resolves.toBeUndefined();
		await expect(auditDone("big-done", "sid", "read", { when: 10n }, false, null, env)).resolves.toBeUndefined();
		// Distinct ids, not one pair: both appends are in flight at once and their
		// order in the file is not a contract.
		const start = recordFor("big-start");
		const done = recordFor("big-done");
		expect(start).toMatchObject({ tool: "read", phase: "start" });
		expect(done).toMatchObject({ tool: "read", phase: "done", isError: false });
		expect(String(start?.args)).not.toContain("10");
	});

	test("args that are absent are recorded as absent, not dropped", async () => {
		// `tools/call` without `arguments` reaches this as undefined, and
		// JSON.stringify(undefined) is undefined rather than a string.
		await auditStart("none-1", "sid", "read", undefined, env);
		const rec = recordFor("none-1");
		expect(rec?.args).toBe("undefined");
	});

	test("an unwritable log path does not reach the caller or the process", async () => {
		// The `appendLine` chain ends in a `.catch` for a reason: an audit
		// failure that surfaces as an unhandled rejection noise-floods the host's own
		// error log, which is a worse outcome than a missing line. Swallowed is not
		// silent, though — the log is the only trace of a call, so a bridge that
		// cannot write it has to say so once and keep a count.
		const dead = { A2MCP_AUDIT: join(dir, "no-such-dir", "audit.log") } as NodeJS.ProcessEnv;
		const unhandled: unknown[] = [];
		const collect = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", collect);
		const before = auditWriteFailures();
		const printed: string[] = [];
		const realError = console.error;
		console.error = (...a: unknown[]) => printed.push(a.map(String).join(" "));
		try {
			// The property is stronger than "does not throw", and it is the one that
			// matters now: the request path *awaits* this promise before answering, so
			// a rejection here would surface as a failed `tools/call`. Asserting the
			// resolution is what pins "auditing cannot break the call" to something
			// real — a sync `not.toThrow()` on a promise-returning function asserted
			// nothing at all.
			await expect(auditStart("dead-1", "sid", "read", { path: "/etc/hostname" }, dead)).resolves.toBeUndefined();
			await expect(
				auditDone("dead-1", "sid", "read", { path: "/etc/hostname" }, true, null, dead),
			).resolves.toBeUndefined();
		} finally {
			console.error = realError;
			process.off("unhandledRejection", collect);
		}
		expect(unhandled).toEqual([]);
		expect(auditWriteFailures()).toBeGreaterThanOrEqual(before + 2);
		expect(printed.some((l) => l.includes("audit record not written") && l.includes(auditLogPath(dead)))).toBe(true);
	});
});

/**
 * Concurrent writes into one day's file.
 *
 * The old rotation was `stat` → `rename` → `appendFile`, three steps that two calls
 * in flight together could interleave: the second rotation wrote over the `.1` the
 * first one had just parked the previous generation in, and what vanished was the
 * record another call wrote milliseconds earlier — the whole trace of the call it
 * belonged to. That race is gone with the rotation: a day is a file, the file only
 * grows, and the bridge deletes nothing.
 *
 * The test draws that line: a burst that would have crossed the old 512 KB cap,
 * written all at once, and every record is still readable afterwards, in one file.
 */
describe("concurrent writes into one day's file", () => {
	const dir = `/tmp/a2mcp-audit-race-${process.pid}`;
	const base = join(dir, "audit.log");
	const env = { A2MCP_AUDIT: base } as NodeJS.ProcessEnv;
	const file = auditLogPath(env);

	// The cap the old code rotated at. The file is expected to pass it now.
	const OLD_CAP = 512 * 1024;
	const BURST = 500;

	// ~1.15 KB per record: below the 120-char leaf cap so redaction leaves it alone,
	// below the 1024-char args cut so nothing is truncated.
	const fatter: Record<string, string> = {};
	for (let k = 0; k < 10; k++) fatter[`f${k}`] = "y".repeat(110);

	const idsOnDisk = () => {
		const out = new Set<string>();
		if (!existsSync(file)) return out;
		for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
			try {
				out.add(JSON.parse(line).id as string);
			} catch {
				/* a torn line is its own failure; the count below catches it */
			}
		}
		return out;
	};

	test("a burst past the old cap keeps every record, in one file", async () => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });

		// The last append of the burst is the tail of the chain. Awaiting it — rather
		// than watching the file stop changing and then sleeping 300 ms for "the
		// stragglers" — is what the burst was actually waiting for.
		const written: Promise<void>[] = [];
		for (let i = 0; i < BURST; i++) {
			written.push(auditStart(`race-${i}`, "sid", "read", fatter, env));
		}
		await Promise.all(written);

		const seen = idsOnDisk();
		const missing = Array.from({ length: BURST }, (_, i) => `race-${i}`).filter((id) => !seen.has(id));

		// Every record survives, and the day is one file that grew past the size the
		// old cap rotated at: no generation was parked, none was overwritten, and
		// nothing was deleted.
		expect(missing.slice(0, 5)).toEqual([]);
		expect(missing.length).toBe(0);
		expect(statSync(file).size).toBeGreaterThan(OLD_CAP);
		expect(readdirSync(dir)).toEqual([file.slice(dir.length + 1)]);

		rmSync(dir, { recursive: true, force: true });
	}, 120_000);
});

describe("auditLogPath", () => {
	test("the file is named for its day, in front of the extension", () => {
		// Every test above passes $A2MCP_AUDIT, so the default name is asserted nowhere
		// but here — and a probe seeding the wrong file would still be green, because the
		// env var is what it reads. Same reason test/obtain.test.ts pins the ledger name.
		expect(auditLogPath({})).toMatch(/(^|\/)a2mcp\.\d{4}-\d{2}-\d{2}\.log$/);
		expect(auditLogPath({ A2MCP_AUDIT: "/elsewhere/a.log" })).toMatch(/^\/elsewhere\/a\.\d{4}-\d{2}-\d{2}\.log$/);
	});

	test("the day is the one the record is stamped with", () => {
		// The name and the contents cannot disagree: the file is picked from the same
		// moment the timestamp is stamped. A record at 23:59:59.999Z and one at
		// 00:00:00.001Z are a second apart and a day apart.
		expect(auditLogPath({}, new Date("2026-10-21T23:59:59.999Z"))).toMatch(/2026-10-21.log$/);
		expect(auditLogPath({}, new Date("2026-10-22T00:00:00.001Z"))).toMatch(/2026-10-22.log$/);
	});
});
