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
 * to be re-measured and not assumed; `--path-prefix` is the newer one, and its half is
 * measured here as well — the file server refusing a path outside the prefix, and its
 * own listing referencing paths inside it. And that a share opened with the fetched
 * binary behaves: GET, a Range request, a PUT that lands on disk, a wrong password, a
 * directory listing, and the port afterwards.
 *
 * The two Windows rows are read as bytes rather than as a status, because nothing in
 * this repository runs a Windows binary: the zip is opened by the same reader a
 * `win32-x64` install calls, and the `.exe` is confirmed as a PE and against the
 * bridge's own download cap. Bytes that are the right shape are not bytes that run,
 * and the probe says which of the two it established.
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
 * ## Where the tunnel fits here
 *
 * `xfer_share` does not open one: a share is the file server, and the public half is
 * the operator's `/a2mcp tunnel` command (src/server.ts serves both surfaces on one
 * port). Section 5 therefore tests the tunnel on its own terms — it opens a real one
 * with the cloudflared fetched in section 1, inside a child with a hard timeout. That
 * had to be a child, and not for cleanliness: twice on 2026-10-17 a probe holding a
 * real cloudflared and its public fetch in its own process finished every local check
 * and then never returned, sitting on a full core with no syscall left to make (156 MB
 * read, 59 MB written, neither attributed). It is also why no assertion here reaches
 * for a `*.trycloudflare.com` URL: this machine's network re-signs TLS for proxied
 * hostnames, so a published hostname cannot be fetched back from the machine that
 * published it, and a check that depends on that measures the network. Every hard
 * check runs against `127.0.0.1:<port>`.
 *
 * Env:
 *   A2MCP_OBTAIN_TARGET   install destination override; default a temp dir, so this
 *                       never writes into the operator's ~/.local/bin
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditLogPath, auditStart } from "../src/audit.ts";
import { pinnedUrl, pinsFor, readZipEntry, resolveBinary, targetKey } from "../src/obtain.ts";
import { XFER_ROUTE } from "../src/server.ts";
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
/** Computed here, never taken from the host that serves the bytes. */
const sha256Of = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const work = await mkdtemp(join(tmpdir(), "a2mcp-obtain-probe-"));
const binDir = process.env.A2MCP_OBTAIN_TARGET ?? join(work, "bin");
const ledger = join(work, "installs.json");
const auditBase = join(work, "audit.log");
const auditFile = auditLogPath({ A2MCP_AUDIT: auditBase });
process.env.A2MCP_AUDIT = auditBase;

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

// The path the resolver wrote in section 1, not the operator's own copy. A share does
// not read this name any more — the operator's tunnel command does — and it is passed
// here so the config the probe drives is the config a real host has. Section 4
// publishes through the build this repository pinned.
const cloudflared = join(binDir, "cloudflared");
await access(cloudflared, constants.X_OK).catch(() => fail(`${cloudflared} is not there after section 1`));

const fresh = join(work, "bin2");
const freshLedger = join(work, "installs2.json");
const deps2 = { env, binDir: fresh, ledger: freshLedger };
// No tunnel anywhere in this section, and none in the tool either: a share is the file
// server now. The assertions run on the loopback port through the same seam the bridge
// proxies against (`xfer.target()`), which is the only path left that a caller of this
// probe can reach without the operator's `/a2mcp tunnel`. That the stub-free binary
// answers *only* under the prefix it was handed is checked here too, because the
// coupling between `src/server.ts`'s matcher and `src/xfer.ts`'s argv is what makes the
// file server's own absolute references stay on the route.
const xfer = createXfer({ dufs: "dufs", cloudflared }, { obtain: deps2 });
const res = await xfer.call("xfer_share", { path: shareDir, ttlSeconds: 300 }, "probe-sid");
const bodyText = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
if (res.isError) fail(`xfer_share refused: ${bodyText}`);
const share = JSON.parse(bodyText) as {
	url: string;
	route: string;
	port: number;
	usage: Record<string, string>;
	installed: { dufs: string | null };
	user?: string;
	secret?: string;
};
check(share.installed.dufs === dufsPin.version, "xfer_share names the build it fetched", String(share.installed.dufs));
await access(join(fresh, "dufs"), constants.X_OK).catch(() =>
	fail("xfer_share did not leave the binary where it said"),
);
check(
	!("cloudflared" in share.installed),
	"the share reports the one binary it resolves",
	JSON.stringify(share.installed),
);
check(
	share.user === undefined && share.secret === undefined && share.url.endsWith(`${XFER_ROUTE}/`),
	"the answer carries a route, not credentials",
	share.url,
);
check(
	share.usage.download.includes("Bearer <TOKEN>"),
	"usage asks for the bridge token, not a password",
	share.usage.download,
);

const target2 = xfer.target();
if (!target2) fail("target() answered null with a share open");
const local = target2.baseUrl;
const auth = target2.auth;

const get = await fetch(`${local}${XFER_ROUTE}/hello.txt`, { headers: { authorization: auth } });
check(get.status === 200 && (await get.text()) === HELLO, "GET returns the bytes it holds", String(get.status));

const range = await fetch(`${local}${XFER_ROUTE}/hello.txt`, { headers: { authorization: auth, range: "bytes=0-4" } });
check(range.status === 206 && (await range.text()) === HELLO.slice(0, 5), "Range requests work", String(range.status));

const put = await fetch(`${local}${XFER_ROUTE}/uploaded.txt`, {
	method: "PUT",
	headers: { authorization: auth },
	body: "written by the probe\n",
});
check(put.status < 300, "PUT is accepted", String(put.status));
check((await readFile(join(shareDir, "uploaded.txt"), "utf8")) === "written by the probe\n", "the PUT landed on disk");

const wrong = await fetch(`${local}${XFER_ROUTE}/hello.txt`, {
	headers: { authorization: `Basic ${Buffer.from("omp:wrong").toString("base64")}` },
});
check(wrong.status === 401 || wrong.status === 403, "a wrong password is refused", String(wrong.status));

const listing = await fetch(`${local}${XFER_ROUTE}/`, { headers: { authorization: auth } });
check(listing.status === 200, "the directory listing answers", String(listing.status));
// The listing's own absolute references have to name the prefix, or a caller that
// follows one leaves the route. This is the contract `--path-prefix` buys.
const page = await listing.text();
const refs = page.match(/(?:href|src)="\/[^"]*"/g) ?? [];
check(
	refs.every((r) => r.includes(`"${XFER_ROUTE}/`)),
	"the listing's absolute references stay under the prefix",
	refs.slice(0, 3).join(" "),
);

const outside = await fetch(`${local}/hello.txt`, { headers: { authorization: auth } });
check(outside.status === 400, "the file server refuses a path outside its prefix", String(outside.status));

await xfer.call("xfer_stop", {}, "probe-sid");
const portFree = await fetch(`${local}${XFER_ROUTE}/`, { headers: { authorization: auth } }).then(
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

// --- 3b. the Windows rows read as bytes, because nothing here runs them ---------
//
// A `win32-x64` row pointing at the wrong asset still answers HTTP 200 above, and no
// check in this repository executes a Windows binary. So the two rows are read the
// way the host will read them: the zip through the same `readZipEntry` a `win32-x64`
// install calls, the `.exe` through its first two bytes and the size the release host
// reports for it. What this cannot say is that the bytes run — only that they are the
// bytes the table promised, in the shape the code expects.
{
	const dufsWin = pinsFor("dufs")["win32-x64"];
	const cfWin = pinsFor("cloudflared")["win32-x64"];
	if (!dufsWin || !cfWin) {
		check(
			false,
			"both Windows rows are still in the table",
			dufsWin ? "cloudflared's row is gone" : "dufs' row is gone",
		);
	} else {
		const zip = Buffer.from(
			await (await fetch(pinnedUrl("dufs", dufsWin), { signal: AbortSignal.timeout(60_000) })).arrayBuffer(),
		);
		const got = sha256Of(zip);
		check(
			got === dufsWin.sha256,
			"the Windows dufs zip hashes on this machine to the pinned value",
			`got ${got}, pinned ${dufsWin.sha256}`,
		);
		let inside = 0;
		let why = "";
		try {
			inside = readZipEntry(zip, "dufs.exe", 64 * 1024 * 1024).length;
		} catch (e) {
			why = (e as Error).message;
		}
		check(inside > 0, "the reader a win32-x64 host calls finds 'dufs.exe' in that zip", why || `${inside} bytes`);

		const ranged = await fetch(pinnedUrl("cloudflared", cfWin), {
			headers: { Range: "bytes=0-1" },
			signal: AbortSignal.timeout(60_000),
		}).catch((e: Error) => e.message);
		if (typeof ranged === "string") {
			check(false, "the Windows cloudflared answer accepts a range request", ranged);
		} else {
			const two = Buffer.from(await ranged.arrayBuffer());
			check(
				ranged.status === 206 && two.toString("latin1") === "MZ",
				"the Windows cloudflared row serves a PE executable, not an archive",
				`HTTP ${ranged.status}, first two bytes ${two.toString("hex")}`,
			);
			const total = Number(/\/(\d+)\s*$/.exec(ranged.headers.get("content-range") ?? "")?.[1] ?? 0);
			check(
				total > 0 && total < 64 * 1024 * 1024,
				"that .exe fits under the bridge's own download cap",
				`${total} bytes reported, cap 67108864`,
			);
		}
	}
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
delete process.env.A2MCP_AUDIT;
console.log(
	`\n${failures === 0 ? "PASS" : `${failures} FAILURES`} — target ${target}, dufs ${dufsPin.version}, cloudflared ${cfPin.version}`,
);
process.exit(failures === 0 ? 0 : 1);
