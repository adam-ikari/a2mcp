import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditDone, auditHostLlm, auditLogPath, auditStart, auditWriteFailures } from "../src/audit.ts";

/**
 * Rotation retention.
 *
 * docs/protocol.md tells callers to read the audit log for a `start` with no
 * `done` as the hang signal, and warns that the evidence ages out. Both halves
 * come from `rename(file, `${file}.1`)` overwriting the previous `.1`: one
 * generation is kept, so a record survives at most two rotations.
 *
 * Proving that against a live host is expensive (test/hardening.ts has to push a
 * couple of hundred deliberately fattened calls through a real host to cross 512 KB
 * once, and the pair-splitting it checks there is a different fact from retention).
 * Here the log is the only thing under test.
 */
describe("audit rotation retention", () => {
	const dir = `/tmp/a2mcp-audit-retention-${process.pid}`;
	const file = join(dir, "audit.log");
	const rolled = `${file}.1`;
	const env = { A2MCP_AUDIT: file } as NodeJS.ProcessEnv;

	// Values under the 120-char leaf cap survive redaction, and serializeArgs then
	// truncates the whole args string at 1024 chars, so each record is ~1.1 KB and
	// one generation holds roughly 475 of them.
	const fatter: Record<string, string> = {};
	for (let k = 0; k < 10; k++) fatter[`f${k}`] = "y".repeat(110);

	const has = (needle: string) => [file, rolled].some((p) => existsSync(p) && readFileSync(p, "utf8").includes(needle));

	/**
	 * Enough pairs to cross the 512 KB cap at least once. The pairs go out back to
	 * back: `appendLine` hands each line to one process-wide chain, so there is no
	 * interleaving left to blur the size, and how fast they arrive does not change
	 * which records survive.
	 */
	const phase = async (tag: string, pairs = 300) => {
		// The last append in the burst is the tail of the chain, so awaiting it says
		// every record before it has been attempted. This used to poll the two files
		// until their sizes stopped changing and then sleep another 200 ms "to let
		// the last few in-flight appends land" — a wait that existed only because the
		// audit functions returned nothing to await.
		let last: Promise<void> | undefined;
		for (let i = 0; i < pairs; i++) {
			void auditStart(`${tag}-${i}`, "sid", "read", fatter, env);
			last = auditDone(`${tag}-${i}`, "sid", "read", fatter, false, env);
		}
		await last;
	};

	test("a record survives at most one further rotation", async () => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });

		// 200 records is ~220 KB, well under the cap: the log is a single file and
		// every record is readable. This is the state a caller greps in.
		await phase("gen-a", 100);
		expect(has('"id":"gen-a-0"')).toBe(true);

		await phase("gen-b");
		await phase("gen-c");
		await phase("gen-d");

		// 1800 records more, ~2 MB, through a log that keeps one `.1`. The evidence of
		// a call that never completed therefore has an expiry date: enough later
		// traffic and it is in neither file.
		expect(has('"id":"gen-a-0"')).toBe(false);
		expect(has('"id":"gen-b-0"')).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	}, 120_000);
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
		const file = env.A2MCP_AUDIT as string;
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
			["auditDone", () => auditDone("shape-done", "sid", "read", {}, false, env)],
			["auditHostLlm", () => auditHostLlm("sid", true, null, env)],
		] as const) {
			const returned = call();
			expect(returned, `${name} returns the queue tail`).toBeInstanceOf(Promise);
			await returned;
		}
		const logFile = env.A2MCP_AUDIT as string;
		const raw = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
		const onDisk = readRecords().map((r) => String(r.id));
		expect(onDisk).toContain("shape-start");
		expect(onDisk).toContain("shape-done");
		// auditHostLlm mints its own uuid, so the identifying content is in the record
		// rather than in its id — and `args` is itself a serialized string, so the
		// payload shows up escaped inside the line.
		expect(raw).toContain('"tool":"host_llm"');
	});

	test("args that JSON.stringify rejects are still recorded", async () => {
		// A custom tool can hand over a BigInt and `JSON.stringify` throws on it. The
		// record survives that; its args do not, which is the accepted half of the
		// trade — a vague line beats no line for the `start` without `done` lookup.
		// Awaited, not wrapped in `expect(() => …).not.toThrow()`: these return the
		// queue tail now, and a sync call-throw assertion on a promise-returning
		// function proves nothing about the rejection it used to be guarding.
		await expect(auditStart("big-start", "sid", "read", { when: 10n }, env)).resolves.toBeUndefined();
		await expect(auditDone("big-done", "sid", "read", { when: 10n }, false, env)).resolves.toBeUndefined();
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
			await expect(auditDone("dead-1", "sid", "read", { path: "/etc/hostname" }, true, dead)).resolves.toBeUndefined();
		} finally {
			console.error = realError;
			process.off("unhandledRejection", collect);
		}
		expect(unhandled).toEqual([]);
		expect(auditWriteFailures()).toBeGreaterThanOrEqual(before + 2);
		expect(printed.some((l) => l.includes("audit record not written") && l.includes(dead.A2MCP_AUDIT as string))).toBe(
			true,
		);
	});
});

/**
 * Concurrent writes across the rotation boundary.
 *
 * `appendLine` does `stat` then `rename` then `appendFile`, and those three are not
 * one step. Two calls that are in flight together can both read a size over the cap
 * and both rotate, and the second `rename` writes over the `.1` the first one just
 * put the previous generation into. The loss lands on whichever records happened to
 * sit in the current file when the extra rotation fired, written milliseconds
 * earlier, plus the whole generation that was rotated out of the way. The docs
 * promise one retained generation and the pair readable across both files; under
 * this race a call's `start` can be in neither, and a call whose audit line is its
 * only trace — one that does not go through the host's approval gate — can leave
 * no trace at all.
 *
 * The log is primed to just under 512 KB and hit with a burst, so exactly one
 * rotation is needed to hold everything. That is the line the test draws: one
 * rotation keeps every record visible across the two files, any extra rotation has
 * eaten data. Measured on the unsynchronized version over six runs, two outcomes:
 * the worst left one record in each file, 570 of the 572 written being in neither;
 * the mildest left 1 of the 60 burst records. Each extra rotation carries away
 * whatever file it fired on, records written milliseconds earlier included.
 */
describe("concurrent writes across the rotation boundary", () => {
	const dir = `/tmp/a2mcp-audit-race-${process.pid}`;
	const file = join(dir, "audit.log");
	const rolled = `${file}.1`;
	const env = { A2MCP_AUDIT: file } as NodeJS.ProcessEnv;

	// The cap in src/audit.ts, and the padding to sit just under it.
	const MAX_LOG_BYTES = 512 * 1024;
	const BURST = 60;

	// ~1.15 KB per record: below the 120-char leaf cap so redaction leaves it alone,
	// below the 1024-char args cut so nothing is truncated.
	const fatter: Record<string, string> = {};
	for (let k = 0; k < 10; k++) fatter[`f${k}`] = "y".repeat(110);

	const primeLine = (id: string) =>
		`${JSON.stringify({ ts: "0", id, sid: "prime", phase: "start", tool: "read", args: "p".repeat(940) })}\n`;

	const idsOnDisk = () => {
		const out = new Set<string>();
		for (const p of [file, rolled]) {
			if (!existsSync(p)) continue;
			for (const line of readFileSync(p, "utf8").split("\n").filter(Boolean)) {
				try {
					out.add(JSON.parse(line).id as string);
				} catch {
					/* a torn line is its own failure; the count below catches it */
				}
			}
		}
		return out;
	};

	test("one rotation, and every record written is still readable", async () => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });

		let prime = "";
		let primeCount = 0;
		while (prime.length + primeLine(`prime-${primeCount}`).length < MAX_LOG_BYTES - 200) {
			prime += primeLine(`prime-${primeCount++}`);
		}
		writeFileSync(file, prime);
		const headroom = MAX_LOG_BYTES - statSync(file).size;
		// The burst has to overflow the headroom, otherwise nothing rotates and the
		// test proves only that an untouched log is fine.
		expect(BURST * 1150).toBeGreaterThan(headroom);

		// The last append of the burst is the tail of the chain. Awaiting it — rather
		// than watching both files stop changing and then sleeping 300 ms for "the
		// stragglers" — is what the burst was actually waiting for.
		let last: Promise<void> | undefined;
		for (let i = 0; i < BURST; i++) last = auditStart(`race-${i}`, "sid", "read", fatter, env);
		await last;

		const seen = idsOnDisk();
		const missing = [
			...Array.from({ length: primeCount }, (_, i) => `prime-${i}`),
			...Array.from({ length: BURST }, (_, i) => `race-${i}`),
		].filter((id) => !seen.has(id));

		// Every record survives: the burst crosses the cap once, the previous
		// generation lands in `.1`, and nothing overwrites it.
		expect(missing.slice(0, 5)).toEqual([]);
		expect(missing.length).toBe(0);

		rmSync(dir, { recursive: true, force: true });
	}, 120_000);
});

describe("auditLogPath", () => {
	test("the default is the filename the docs promise", () => {
		// Every test above passes $A2MCP_AUDIT, so the default name is asserted nowhere
		// but here — and a probe seeding the wrong file would still be green, because the
		// env var is what it reads. Same reason test/obtain.test.ts pins the ledger name.
		expect(auditLogPath({})).toMatch(/(^|\/)a2mcp\.log$/);
		expect(auditLogPath({ A2MCP_AUDIT: "/elsewhere/a.log" })).toBe("/elsewhere/a.log");
	});
});
