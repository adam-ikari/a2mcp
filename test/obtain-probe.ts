/**
 * The pinned download, driven against the real release host.
 *
 *   bun run test:obtain
 *
 * ## What it checks
 *
 * That the version and sha256 pinned in `src/obtain.ts` are the bytes GitHub
 * actually serves — for both binaries, and for every row of the table rather than
 * only this machine's, since `HEAD`ing a URL costs nothing and a target this host
 * cannot run is otherwise checked by nobody. That what extracts is a binary answering
 * the command line `src/xfer.ts` builds: `--auth user:pass@/:rw` is the flag that was
 * found the hard way, and it was found on dufs 0.43.0, so the pin moving to 0.46.0 had
 * to be re-measured and not assumed. And that a share opened with the fetched binary
 * behaves: GET, a Range request, a PUT that lands on disk, a wrong password, a
 * directory listing, and the port afterwards.
 *
 * The fetch is driven twice on purpose: once through `resolveBinary` directly, and
 * once through `xfer_share` with nothing on PATH and an empty install dir, which is
 * the only way to say the tool that announces `installed` is the tool that did the
 * downloading. Every run writes to temp directories, never to the operator's
 * `~/.local/bin`.
 *
 * ## Why a probe and not a test
 *
 * It needs egress to github.com, and `bun test` is the suite that does not have any.
 * The unit half (`test/obtain.test.ts`) pins the logic against a local server; this
 * half is the only thing that can say the table's hashes are real.
 *
 * ## What the tunnel gets here
 *
 * The assertions run against a stubbed tunnel opener. This machine's network re-signs
 * TLS for proxied hostnames, so a `*.trycloudflare.com` URL cannot be fetched back from
 * the machine that published it, and a check that depends on that measures the network.
 * The real tunnel is still opened, in section 5, by the cloudflared this probe fetched
 * in section 1, inside a child with a hard timeout — not for cleanliness but because it
 * had to be: twice on 2026-10-17 a probe that held a real cloudflared and its public
 * fetch in its own process finished every local check and then never returned, sitting
 * on a full core with no syscall left to make (156 MB read, 59 MB written, neither
 * attributed). The bridge does not do either of those things: it talks to `127.0.0.1`
 * and to the release host, and hands the public URL to the caller. Every hard check
 * here runs against `127.0.0.1:<port>`.
 *
 * Env:
 *   A2A_OBTAIN_TARGET   install destination override; default a temp dir, so this
 *                       never writes into the operator's ~/.local/bin
 */
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditStart } from "../src/audit.ts";
import { pinnedUrl, pinsFor, resolveBinary, targetKey } from "../src/obtain.ts";
import type { TunnelOpener } from "../src/tunnel.ts";
import { createXfer } from "../src/xfer.ts";

let failures = 0;
function check(cond: unknown, label: string, detail = ""): void {
	console.log(`${cond ? "ok" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
}
function info(msg: string): void {
	console.log(`info: ${msg}`);
}
function fail(msg: string): never {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
}

const work = await mkdtemp(join(tmpdir(), "a2a-obtain-probe-"));
const binDir = process.env.A2A_OBTAIN_TARGET ?? join(work, "bin");
const ledger = join(work, "installs.json");
const auditFile = join(work, "audit.log");
process.env.A2A_BRIDGE_AUDIT = auditFile;

// An empty PATH is the point: nothing on this machine may satisfy the lookup, or the
// probe reports the pinned download works while it never ran.
const env = { PATH: "" } as NodeJS.ProcessEnv;
const target = targetKey();
const dufsPin = pinsFor("dufs")[target];
const cfPin = pinsFor("cloudflared")[target];
if (!dufsPin) fail(`no pinned dufs build for ${target} — nothing to probe on this platform`);
if (!cfPin) fail(`no pinned cloudflared build for ${target} — the table has a hole this probe exists to find`);

for (const p of [dufsPin, cfPin])
	console.log(`target: ${target}  asset: ${p.asset}  pinned sha256: ${p.sha256.slice(0, 12)}…`);
console.log("");

// --- 1. both pins, fetched from the real release host -------------------------
//
// The same four claims per binary: the download landed where the resolver said, the
// archive's hash matched the pinned one (a mismatch is the failure mode that refuses
// to install, so the call itself would have failed), the file that extracts runs, and
// it calls itself the pinned version. `--version` is the cheap proof that the
// extraction picked the right entry out of the archive — a `dufs` that is really a
// `LICENSE` would be executable and hashed correctly all the same.
for (const name of ["dufs", "cloudflared"] as const) {
	const pin = name === "dufs" ? dufsPin : cfPin;
	const t0 = Date.now();
	const got = await resolveBinary(name, name, "probe-sid", { env, binDir, ledger }).catch((e: Error) =>
		fail(`the pinned ${name} download failed: ${e.message}`),
	);
	const secs = ((Date.now() - t0) / 1000).toFixed(1);
	await access(got.path, constants.X_OK).catch(() => fail(`resolved ${got.path} is not executable`));
	check(
		got.installed?.version === pin.version,
		`${name}: installed reports the pinned version`,
		got.installed?.version ?? "null",
	);
	check(got.path === join(binDir, name), `${name}: installed where it said it would`, got.path);
	info(`${name}: downloaded and extracted in ${secs}s`);

	const versionOut = execFileSync(got.path, ["--version"], { encoding: "utf8" }).trim();
	check(versionOut.includes(pin.version), `${name}: the binary calls itself the pinned version`, versionOut);

	const ledgerJson = JSON.parse(await readFile(ledger, "utf8")) as Record<string, { version: string; sha256: string }>;
	check(
		ledgerJson[got.path]?.version === pin.version,
		`${name}: the ledger names this install`,
		ledgerJson[got.path]?.version ?? "absent",
	);

	// Reuse: same empty PATH, so only the install already in place can make this cost nothing.
	const again = await resolveBinary(name, name, "probe-sid", { env, binDir, ledger });
	check(
		again.path === got.path && again.installed === null,
		`${name}: a second call reuses the install without fetching`,
		again.path,
	);
}

// --- 2. a share that fetches the binary itself -------------------------------
//
// Section 1 called the resolver directly. This section does not: it hands `xfer` the
// bare name `dufs` with an empty PATH and an empty install dir, which is the shape a
// real host has on a machine where nobody installed anything. So the download, the
// spawn of what it wrote, and the `installed` field all have to work from inside
// `xfer_share` — the one path the unit tests can only run against a stub server.
const shareDir = join(work, "shared");
await mkdir(shareDir, { recursive: true });
const HELLO = "hello over http, from the fetched dufs\n";
await writeFile(join(shareDir, "hello.txt"), HELLO);

// The path the resolver wrote in section 1, not the operator's own copy: naming it
// here is the escape-hatch branch (`installed.cloudflared` must come back null), and
// section 4 then publishes through the build this repository pinned.
const cloudflared = join(binDir, "cloudflared");
await access(cloudflared, constants.X_OK).catch(() => fail(`${cloudflared} is not there after section 1`));

const fresh = join(work, "bin2");
const freshLedger = join(work, "installs2.json");
const deps2 = { env, binDir: fresh, ledger: freshLedger };
// The tunnel is stubbed for the assertions, for two measured reasons (2026-10-17): this
// network cannot serve a `*.trycloudflare.com` hostname back to the machine that
// published it, and holding that real connection inside the probe left the process
// spinning afterwards — a full core, no syscalls, every later await starved. What this
// section asserts is the resolver and `dufs`, and the real tunnel gets its own section
// at the end, inside a child that can be killed.
const stubTunnel: TunnelOpener = async (opts) => ({
	url: `https://probe-stub-${opts.port}.trycloudflare.com`,
	port: opts.port,
	pid: 0,
	stop: async () => {},
});
const xfer = createXfer({ dufs: "dufs", cloudflared }, { obtain: deps2, openTunnel: stubTunnel });
const res = await xfer.call("xfer_share", { path: shareDir, ttlSeconds: 300 }, "probe-sid");
const bodyText = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
if (res.isError) fail(`xfer_share refused: ${bodyText}`);
const share = JSON.parse(bodyText) as {
	url: string;
	host: string;
	user: string;
	secret: string;
	port: number;
	installed: { dufs: string | null; cloudflared: string | null };
};
check(share.installed.dufs === dufsPin.version, "xfer_share names the build it fetched", String(share.installed.dufs));
await access(join(fresh, "dufs"), constants.X_OK).catch(() =>
	fail("xfer_share did not leave the binary where it said"),
);
check(share.installed.cloudflared === null, "nothing was fetched for cloudflared (named as a path)", "null");

const local = `http://127.0.0.1:${share.port}`;
const auth = `Basic ${Buffer.from(`${share.user}:${share.secret}`).toString("base64")}`;

const get = await fetch(`${local}/hello.txt`, { headers: { authorization: auth } });
check(get.status === 200 && (await get.text()) === HELLO, "GET returns the bytes it holds", String(get.status));

const range = await fetch(`${local}/hello.txt`, { headers: { authorization: auth, range: "bytes=0-4" } });
check(range.status === 206 && (await range.text()) === HELLO.slice(0, 5), "Range requests work", String(range.status));

const put = await fetch(`${local}/uploaded.txt`, {
	method: "PUT",
	headers: { authorization: auth },
	body: "written by the probe\n",
});
check(put.status < 300, "PUT is accepted", String(put.status));
check((await readFile(join(shareDir, "uploaded.txt"), "utf8")) === "written by the probe\n", "the PUT landed on disk");

const wrong = await fetch(`${local}/hello.txt`, {
	headers: { authorization: `Basic ${Buffer.from(`${share.user}:wrong`).toString("base64")}` },
});
check(wrong.status === 401 || wrong.status === 403, "a wrong password is refused", String(wrong.status));

const listing = await fetch(`${local}/`, { headers: { authorization: auth } });
check(listing.status === 200, "the directory listing answers", String(listing.status));

await xfer.call("xfer_stop", {}, "probe-sid");
const portFree = await fetch(`${local}/`, { headers: { authorization: auth } }).then(
	() => false,
	() => true,
);
check(portFree, "the port is released after stop");

// Reuse through the tool, not through the resolver: same empty PATH, now a filled
// install dir, and the answer must say nobody fetched anything.
const reuseRes = await xfer.call("xfer_share", { path: shareDir, ttlSeconds: 300 }, "probe-sid");
const reuseText = reuseRes.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const reuse = JSON.parse(reuseText) as typeof share;
check(
	!reuseRes.isError && reuse.installed.dufs === null,
	"the next share reuses the install instead of fetching",
	reuseRes.isError ? reuseText : "null",
);
await xfer.call("xfer_stop", {}, "probe-sid");

// --- 3. every row of the table, including the ones this machine cannot run -----
//
// `HEAD` asks the release host for nothing but a status, and it is the only check
// that covers a target this host cannot execute: a tag or an asset name typed wrong
// is invisible to the unit tests, which build the URL for `targetKey()` alone, and
// it shows up as a download that never resolves on somebody else's machine.
const rows = (["dufs", "cloudflared"] as const).flatMap((name) =>
	Object.entries(pinsFor(name)).map(([t, p]) => [name, t, p] as const),
);
const answers = await Promise.all(
	rows.map(async ([name, , p]) => {
		const r = await fetch(pinnedUrl(name, p), {
			method: "HEAD",
			redirect: "follow",
			signal: AbortSignal.timeout(20_000),
		}).catch((e: Error) => e.message);
		return typeof r === "string" ? r : `HTTP ${r.status}`;
	}),
);
for (let i = 0; i < rows.length; i++) {
	const [name, t] = rows[i];
	check(answers[i] === "HTTP 200", `${name} for ${t} answers at its pinned URL`, answers[i]);
}

// --- 4. the record ------------------------------------------------------------

const marker = `obtain-probe-sentinel-${Math.random()}`;
await auditStart(marker, "flush", "flush", {}, process.env);
const log = await readFile(auditFile, "utf8");
for (const v of [dufsPin.version, cfPin.version])
	check(log.includes("install") && log.includes(v), `the audit holds the ${v} install record`);
// `args` is stored serialized, so the quotes inside it arrive escaped.
check(log.includes(String.raw`"action\":\"share\"`), "the audit holds the share record");

// --- 5. the real tunnel, in a child ------------------------------------------
//
// Reported, not asserted, and deliberately not done in this process. The publish itself
// is measurable here — `src/xfer.ts` with the real `cloudflared` announced a
// `*.trycloudflare.com` hostname on 2026-10-17 — but fetching that hostname back from
// the machine that published it is not: the network re-signs TLS for proxied names. And
// the fetch is the part that wedged the probe twice that day, so it runs in a child with
// a hard timeout and dies with whatever connection it leaves behind.
const tunnelChild = `
	import { openQuickTunnel } from ${JSON.stringify(join(import.meta.dir, "..", "src", "tunnel.ts"))};
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("from the probe child") });
	const opened = await openQuickTunnel({
		bin: ${JSON.stringify(cloudflared)},
		port: server.port,
		timeoutMs: 30_000,
	}).catch((e) => "no URL announced: " + String(e && e.message).slice(0, 160));
	if (typeof opened === "string") {
		console.log(opened);
	} else {
		console.log("announced " + opened.url);
		const via = await fetch(opened.url + "/", { signal: AbortSignal.timeout(15_000) }).then(
			(r) => "HTTP " + r.status,
			(e) => String(e && e.message).slice(0, 80),
		);
		console.log("fetched back from the publishing machine: " + via);
		await opened.stop();
		server.stop(true);
	}
`;
let tunnelAnswer = "";
try {
	tunnelAnswer = execFileSync(process.execPath, ["-e", tunnelChild], {
		encoding: "utf8",
		timeout: 60_000,
		stdio: ["ignore", "pipe", "pipe"],
	})
		.trim()
		.replace(/\n/g, "; ");
} catch (e) {
	const err = e as Error & { stderr?: string; signal?: string };
	tunnelAnswer = err.signal
		? `the child was killed after 60s (${err.signal})`
		: (err.stderr ?? "").split("\n").find(Boolean) || err.message.split("\n")[0];
}
info(`real tunnel: ${tunnelAnswer}`);

await rm(work, { recursive: true, force: true });
delete process.env.A2A_BRIDGE_AUDIT;
console.log(
	`\n${failures === 0 ? "PASS" : `${failures} FAILURES`} — target ${target}, dufs ${dufsPin.version}, cloudflared ${cfPin.version}`,
);
process.exit(failures === 0 ? 0 : 1);
