/**
 * `src/tunnel.ts` against a child that talks too much.
 *
 * What these tests are for: the one loop in this module that runs as long as a share is
 * open — reading cloudflared's output to find the hostname in it. The buffer that reader
 * keeps can go wrong in two directions. Stop it too early and the hostname is lost, and
 * the symptom is a tunnel that never announces one; never stop it and an hour-long share
 * becomes an hour of growing memory inside the host's own process. The test that pins the
 * first of those feeds the child more output before the announcement than the transcript
 * holds, because the natural wrong implementation ("stop appending once full") fails
 * exactly there. The bound trims after the search, so a hostname is always read while it is
 * still whole; which end survives the trim decides only what a failure message quotes.
 *
 * What is not tested here: that a quick tunnel is reachable. That is `cloudflared` and
 * the network's business, and this machine's network re-signs TLS for proxied hostnames.
 * `bun run test:obtain` reports the real one, and `test/xfer.test.ts` stubs the opener.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openQuickTunnel } from "../src/tunnel.ts";

const dir = mkdtempSync(join(tmpdir(), "a2mcp-tunnel-"));

/**
 * A stand-in for cloudflared: `lines` log lines of about `width` characters, and the
 * hostname after them (the ordinary case) or before them — with `announceFirst` off, the
 * announcement arrives behind more output than the transcript keeps.
 *
 * One `writeSync` per line, each followed by `await Bun.sleep(5)`, and the pacing is what
 * makes the test mean anything: the reader has to see the noise as several chunks before it
 * has anything to bound. Without the yield the pipe coalesces the writes into a handful of
 * events of uneven size (measured here: 200 KB arrived in ~10 reads, one of them the whole
 * transcript), and a bound the size of a transcript is then crossed at most once. Two other
 * shapes hid the announcement instead of burying it: a `process.stdout.write` loop ending in
 * `console.log` (Bun queues the async writes and lets the synchronous call past them, so the
 * hostname arrives first) and one `writeSync` of the whole transcript.
 *
 * `bun <file>` cannot be the binary name (`spawn` would look for a file called that
 * whole string), so this is an executable with a shebang, like the stub in
 * `test/xfer.test.ts`.
 */
function chatter(lines: number, width: number, announceFirst = true): string {
	const file = join(dir, `chatter-${lines}x${width}-${announceFirst ? "after" : "before"}`);
	const announced = 'writeSync(1, "https://chatty-tunnel.trycloudflare.com\\n");';
	writeFileSync(
		file,
		`#!/usr/bin/env bun
import { writeSync } from "node:fs";
const line = "INF registering proxy connection ${"x".repeat(Math.max(0, width - 33))}\\n";
${announceFirst ? announced : ""}
for (let i = 0; i < ${lines}; i++) {
	writeSync(1, line);
	await Bun.sleep(5);
}
${announceFirst ? "" : announced}
setTimeout(() => process.exit(0), 60_000);
`,
		{ mode: 0o755 },
	);
	return file;
}

const opened: { stop(): Promise<void> }[] = [];

afterAll(async () => {
	for (const t of opened.splice(0)) await t.stop();
	rmSync(dir, { recursive: true, force: true });
});

test("resolves with the hostname the child announces", async () => {
	const t = await openQuickTunnel({ bin: chatter(0, 40), port: 41_000, timeoutMs: 10_000 });
	opened.push(t);
	expect(t.url).toBe("https://chatty-tunnel.trycloudflare.com");
	expect(t.port).toBe(41_000);
});

test("a child that quits before announcing one is an error, with its output", async () => {
	const file = join(dir, "silent");
	writeFileSync(file, '#!/usr/bin/env bun\nconsole.error("connection refused by the edge");\nprocess.exit(3);\n', {
		mode: 0o755,
	});
	await expect(openQuickTunnel({ bin: file, port: 41_001, timeoutMs: 10_000 })).rejects.toThrow(/exited with code 3/);
});

test("the missing binary is reported, not thrown as a raw ENOENT", async () => {
	await expect(openQuickTunnel({ bin: join(dir, "not-here"), port: 41_002, timeoutMs: 10_000 })).rejects.toThrow(
		/not-here/,
	);
});

test("still finds the hostname behind more output than the transcript holds", async () => {
	// 80 KB of log lines ahead of the announcement, against a 64 KB transcript: a reader
	// that stops appending once its buffer is full loses the hostname here and times out.
	const t = await openQuickTunnel({ bin: chatter(80, 1024, false), port: 41_003, timeoutMs: 10_000 });
	opened.push(t);
	expect(t.url).toBe("https://chatty-tunnel.trycloudflare.com");
});
