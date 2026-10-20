/**
 * Package self-containment + install-path probe.
 *
 *   bun run test:install
 *
 * ## What it checks
 *
 * That the published tarball can be installed by a machine that has never seen
 * this repo, and that what lands on disk is enough to load. Concretely: the
 * manifest carries a version and the `pi.extensions` load switch, the tarball
 * ships both halves the entry imports (`extensions/` + `src/`), every module
 * the entry pulls in is present, and none of them reaches for a dependency that
 * is not declared. Then that `omp install` links the bridge where the host looks
 * for it, and that the bridge comes up and serves MCP from a real host.
 *
 * The two groups that leave the network are the last two. The npm-install group
 * fetches what the README's one command fetches — the registry manifest and the
 * published tarball — and asserts what reaches disk is the package, not a
 * checkout of this repo; an unreachable registry or an unpublished version skips
 * the whole group as an info line, never a red. The binary group fetches the real
 * `dufs` release asset into its own throwaway HOME — the operator's `~/.local/bin` is
 * read before and after, never written.
 *
 * ## On plugin discovery and HOME
 *
 * Measured on three host versions, and the answer moved once, so the version is
 * part of the note:
 *
 *   ~/.omp/agent/extensions/   follows HOME             (a marker extension
 *                                        planted in a temp HOME does load)
 *   ~/.omp/plugins/            follows HOME as of 18.11.0, re-checked on 18.12.1
 *                                        (on 18.10.4 it did not; a temp HOME's
 *                                        registry is what the host reads now)
 *
 * What loads is the *registration*, not the directory: `omp install` writes the
 * plugin into `<plugins>/omp-plugins.lock.json` and the host loads from that
 * lock. A bare symlink into a temp HOME's `node_modules`, with no lock entry,
 * loads nothing — demonstrated on 18.11.0.
 *
 * So the end-to-end half below installs into the *same* HOME it boots with. That
 * makes it self-contained, and it drops a side effect the earlier shape had:
 * installing under the real HOME left pi-a2a-ext registered on the developer's
 * machine.
 *
 * A second trap cost an hour and is worth writing down: **the host refuses to
 * create a session without model configuration, and extensions load on
 * `session_start` — so a temp HOME with no models.yml starts no session, loads no
 * extension, and the bridge never announces itself.** That reads exactly like
 * "plugin discovery ignored my HOME" and is not. Every host here is seeded via
 * test/harness.ts. When a probe claims isolation or breakage, check the obvious
 * precondition before believing it.
 *
 * Env:
 *   A2MCP_INSTALL_SPEC  the spec under test, reported in the output so a failure
 *                     names what was actually checked (default: the npm name)
 */
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pinsFor, targetKey } from "../src/obtain.ts";
import { XFER_ROUTE } from "../src/server.ts";
import { XFER_TOOL_NAMES } from "../src/xfer.ts";
import { linkExtension, seedModels } from "./harness";

const REPO = resolve(import.meta.dir, "..");
const SPEC = process.env.A2MCP_INSTALL_SPEC ?? "a2mcp";

let failures = 0;
/**
 * `detail` is printed on **both** paths, so it has to read true on both: a
 * passing line that says "no announcement" next to a label saying the host
 * announced the bridge is worse than no line at all. A caller that only has
 * failure-shaped text to offer should follow `smoke.ts` instead and print
 * it only when the check fails.
 */
function check(cond: unknown, label: string, detail = ""): void {
	console.log(`${cond ? "ok" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
}
function fail(msg: string): never {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
}

console.log(`spec under test: ${SPEC}\n`);

// --- 1. the manifest is what makes this installable at all -------------------

const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
	name?: string;
	version?: string;
	pi?: { extensions?: string[] };
	files?: string[];
	dependencies?: Record<string, string>;
};

check(typeof manifest.name === "string" && manifest.name.length > 0, "manifest declares a name", manifest.name);
check(
	typeof manifest.version === "string" && manifest.version.length > 0,
	"manifest carries a version (else omp reports @undefined)",
	manifest.version,
);
check(
	Array.isArray(manifest.pi?.extensions) && manifest.pi.extensions.length > 0,
	"manifest declares pi.extensions (the load switch)",
	JSON.stringify(manifest.pi?.extensions),
);
// The bridge is zero-dependency by design: every import of a runtime package
// has to resolve to the host's own copy or the load fails.
check(
	Object.keys(manifest.dependencies ?? {}).length === 0,
	"no runtime dependencies (the host shim provides @oh-my-pi/*)",
	JSON.stringify(manifest.dependencies ?? {}),
);
// A files list that misses either half installs fine and then fails to load,
// because the entry imports ../src/*.ts.
const files = manifest.files ?? [];
check(files.includes("extensions/"), "files[] ships extensions/", JSON.stringify(files));
check(files.includes("src/"), "files[] ships src/ (the entry imports ../src/*.ts)", JSON.stringify(files));

// --- 2. what actually ships --------------------------------------------------

const stage = mkdtempSync(join(tmpdir(), "a2mcp-pack-"));
console.log("\n--- pack the tarball ---");
let packOut = "";
try {
	packOut = execFileSync("npm", ["pack", "--pack-destination", stage], {
		cwd: REPO,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
} catch (e) {
	fail(`npm pack failed: ${(e as { stderr?: string }).stderr ?? e}`);
}
const tarball = join(stage, packOut.trim().split("\n").at(-1) ?? "");
check(existsSync(tarball), "npm pack produced a tarball", tarball.split("/").at(-1));
const tarballBytes = existsSync(tarball) ? statSync(tarball).size : 0;
check(tarballBytes > 0 && tarballBytes < 500_000, "tarball is small (ships no node_modules)", `${tarballBytes} B`);

// Unpack it: the check has to be against the tarball, not the working tree —
// the working tree has files that `files[]` may legitimately exclude.
execFileSync("tar", ["-xzf", tarball, "-C", stage], { stdio: ["ignore", "pipe", "pipe"] });
const pkgRoot = join(stage, "package");

check(existsSync(join(pkgRoot, "package.json")), "tarball unpacks to a package/ root");

// Derived from the working tree rather than written out here. This used to be a
// hand-typed list of five `src/*.ts` files and it had already gone stale:
// `takeover.ts`, the module the whole host-inference mechanism lives in, was
// missing from it. It was not uncovered — the import-graph walk below reaches it,
// transitively — so nothing failed, which is exactly the shape of a list that
// rots quietly: it looks like coverage and is a snapshot. Read the directory
// instead, and the check becomes "every module in src/ ships", which cannot fall
// behind the code.
const shipped = [
	// Same reasoning as `src/` above, and the same field the host loads from: the
	// entry path comes from the manifest, so a rename cannot leave this list
	// pointing at a file that no longer ships.
	...(manifest.pi?.extensions ?? []).map((rel) => rel.replace(/^\.\//, "")),
	...readdirSync(join(REPO, "src"))
		.filter((f) => f.endsWith(".ts"))
		.sort()
		.map((f) => `src/${f}`),
];
for (const rel of shipped) {
	check(existsSync(join(pkgRoot, rel)), `tarball ships ${rel}`);
}
check(shipped.length > 1, "the shipped-module list was derived, not typed", `${shipped.length} modules`);

// --- 3. the entry's own imports must resolve inside the package --------------

// Walk the relative-import graph from the entry. Anything it reaches has to be
// in the tarball; a module that only exists in the working tree (a dev-only
// file, or one dropped from files[]) installs fine and then throws on load.
// The entry is the manifest's first extension path — the same string group 1
// verified — rather than a filename repeated here.
const entry = join(pkgRoot, shipped[0] ?? "");
const seen = new Set<string>();
const missing: string[] = [];
const queue = [entry];
while (queue.length > 0) {
	const file = queue.pop() as string;
	if (seen.has(file)) continue;
	seen.add(file);
	if (!existsSync(file)) {
		missing.push(file.slice(pkgRoot.length + 1));
		continue;
	}
	for (const m of readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]+)"/g)) {
		queue.push(resolve(file, "..", m[1]));
	}
}
check(missing.length === 0, "every relative import of the entry resolves inside the package", missing.join(", "));
check(seen.size >= 6, "the entry graph was actually walked", `${seen.size} modules`);

// --- 3b. the package reaches exactly ONE host package --------------------------
//
// The bug this catches shipped as v0.2.0 and the whole suite was green: on a
// Windows machine, `omp install <git-url>` failed with
//   `Cannot find package '@oh-my-pi/pi-ai' imported from …/src/takeover.ts`
// because that specifier has to be resolved by the host's shim, and a packaged
// install is a *copy* with no `node_modules` of its own. Two of the three pi-ai
// subpaths it needed were not in that package's `exports` map at all — they only
// resolved through its `./*` wildcards, i.e. by luck of the file layout. It worked
// on Linux and it works from the working tree (which has its own `node_modules`),
// which is all this probe had ever exercised.
//
// So: walk the same graph, collect every *bare* specifier, and require that they
// all name the one host package the extension already depends on for `pi.on(…)`.
// Cross-platform, no network, and it fails on the cause rather than on the
// symptom — a probe that merely boots a host would still be green here.
const hostSpecifiers = new Map<string, string>();
for (const file of seen) {
	// Comments are stripped first, and that is not tidiness: the scan's first run
	// reported a package called `tried and`, which is the tail of a sentence in
	// src/audit.ts's header — `distinguishes "wrote 16 MB" from "tried and could
	// not"` — matched because the text between `from` and the next quote spans a
	// wrapped line. A scan that reads prose as specifiers is a scan whose failures
	// cannot be trusted in either direction.
	const text = (existsSync(file) ? readFileSync(file, "utf8") : "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
	for (const m of text.matchAll(/from\s+"([^"\n]+)"/g)) {
		const spec = m[1];
		// Relative specifiers are this package's own modules, already covered by the
		// graph walk above. Counting them here was the second mistake in this scan:
		// it turned `./audit.ts` into a package name and failed on the package's own
		// internals rather than on anything a host has to resolve.
		if (spec.startsWith(".")) continue;
		// node builtins and anything with a subpath still names its package root.
		const pkgName = spec.startsWith("node:") ? spec : spec.split("/").slice(0, 2).join("/");
		if (!hostSpecifiers.has(pkgName)) hostSpecifiers.set(pkgName, file.slice(pkgRoot.length + 1));
	}
}
const nonHost = [...hostSpecifiers.keys()].filter((s) => !s.startsWith("node:") && s !== "@oh-my-pi/pi-coding-agent");
check(
	nonHost.length === 0,
	"the package imports no host package other than @oh-my-pi/pi-coding-agent",
	nonHost.map((s) => `${s} (from ${hostSpecifiers.get(s)})`).join("; "),
);
check(
	hostSpecifiers.size > 0,
	"the host-specifier scan actually saw imports",
	`${hostSpecifiers.size} distinct package(s): ${[...hostSpecifiers.keys()].join(", ")}`,
);

// --- 4. the real host, over the real plugin directory -------------------------

// This is the end-to-end that the previous version of this probe gave up on. It
// is not skipped: the host is started, the bridge is discovered through the
// plugin directory an `omp install` writes to, and the MCP surface is driven as
// a remote client would drive it.
//
// What it does NOT claim: that plugin discovery was redirected. It was not, and
// no env var does that (see the header). The assertions are about the bridge's
// behaviour, which is the thing that can actually regress.
const e2eHome = mkdtempSync(join(tmpdir(), "install-e2e-"));
const e2eAgent = join(e2eHome, ".omp", "agent");
const e2eNote = seedModels(e2eAgent);
console.log(`  ${e2eNote}`);

// Reinstall every run, unconditionally. An earlier version skipped the install
// when something was already present, and that was a real hole: `~/.omp/plugins`
// holds a *copy* when installed from a git URL, so after editing the working tree
// the probe went on to test the frozen copy and reported PACKAGE OK. Demonstrated
// by breaking src/bridge.ts in the tree — the probe stayed green, because it never
// looked at the tree.
//
// `omp install .` is the spec, not the remote one, and the difference is the
// point: it links the working tree, so the host loads whatever is there right
// now. The README's command installs whatever was published, which cannot test
// uncommitted work. A local install is a test fixture here, not a supported
// install method.
//
// Install under `e2eHome`, the HOME the host below boots with: since host
// 18.11.0, and still on 18.12.1, the plugin registry is HOME-scoped, so an
// install under the real HOME is invisible to that host (see the header).
const e2eEnv = { ...process.env, HOME: e2eHome };
// Three places below key on the same string: the plugin directory, the uninstall
// argument, the lock entry. It is the name the host registers under, so it comes
// from the manifest rather than from a copy here — a hardcoded one is how a rename
// leaves this probe checking for a package that no longer exists.
const PKG_NAME = manifest.name ?? "";
const installedPlugin = join(e2eHome, ".omp", "plugins", "node_modules", PKG_NAME);
const lockPath = join(e2eHome, ".omp", "plugins", "omp-plugins.lock.json");
let installNote = "";
try {
	// Uninstall first: a leftover git-URL copy is a real directory, and install
	// would treat it as already present.
	execFileSync("omp", ["plugin", "uninstall", PKG_NAME], { env: e2eEnv, stdio: "ignore" });
} catch {
	// Nothing installed is the normal case on a fresh machine.
}
try {
	const out = execFileSync("omp", ["install", REPO], {
		env: e2eEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	installNote = out.trim().split("\n").pop() ?? "installed";
} catch (e) {
	const err = String((e as { stderr?: string }).stderr ?? "");
	check(false, "omp install links the extension", err.trim() || String(e));
}
// The two halves only work together: the host loads from the lock, so a link with
// no lock entry loads nothing. Kept as one item, and the detail says which half
// is missing.
const linked = existsSync(installedPlugin);
const registered = existsSync(lockPath) && readFileSync(lockPath, "utf8").includes(`"${PKG_NAME}"`);
check(
	linked && registered,
	"omp install links the plugin and registers it in the lock, under the HOME it ran in",
	`link: ${linked ? "present" : "missing"}; lock entry: ${registered ? "present" : "missing"}; omp install said: ${installNote}`,
);
// The host loads whatever the lock points at, so if it is not the working tree
// the assertions below are about a stale copy. A link is the only shape that
// guarantees that; a copy is frozen at install time.
check(
	linked && realpathSync(installedPlugin) === realpathSync(REPO),
	"the plugin directory points at this working tree, not a copy of it",
	linked ? `${installedPlugin} -> ${realpathSync(installedPlugin)}` : `${installedPlugin} is missing`,
);

const host = spawn("omp", ["--mode", "rpc"], {
	env: { ...process.env, HOME: e2eHome },
	stdio: ["pipe", "pipe", "pipe"],
});
let hostOut = "";
let hostErr = "";
host.stdout.on("data", (d) => (hostOut += d));
host.stderr.on("data", (d) => (hostErr += d));

/** Only the fields these assertions read. Keeps a failed check's detail short. */
type JsonRpcBody = {
	result?: { protocolVersion?: string; tools?: { name: string }[]; content?: { text?: string }[]; isError?: boolean };
};

const rpc = async (method: string, params: unknown, sid?: string) => {
	const r = await fetch(baseUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${e2eToken}`,
			...(sid ? { "mcp-session-id": sid } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return { body: (await r.json()) as JsonRpcBody, sid: r.headers.get("mcp-session-id") };
};

let baseUrl = "";
let e2eToken = "";
try {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline && !hostOut.includes("a2mcp listening")) {
		host.stdin.write(""); // the host exits on EOF, so keep stdin open
		await Bun.sleep(300);
	}
	const announced = hostOut.match(/a2mcp listening on (http:\/\/127\.0\.0\.1:\d+\/)/);
	check(
		!!announced,
		"the host announces the bridge (a session needs model config to exist at all)",
		// Passed = the announcement is the evidence. Failed = short lines that
		// explain the silence; the rpc frame log includes multi-KB command
		// manifests that match nothing useful, so anything over 200 chars is
		// dropped rather than printed. One string for both paths, because check()
		// prints it on both.
		announced?.[0] ||
			[...`${hostOut}\n${hostErr}`.split("\n")]
				.map((l) => l.trim())
				.filter((l) => l.length > 0 && l.length < 200)
				.filter((l) => /error|no model|not available|failed|refus|announc/i.test(l))
				.slice(0, 3)
				.join(" | ") ||
			"no announcement and no short error line",
	);
	baseUrl = announced?.[1] ?? "";
	const cfg = JSON.parse(readFileSync(join(e2eAgent, "a2mcp.json"), "utf8"));
	e2eToken = cfg.token as string;
	check(
		Object.keys(cfg).sort().join(",") === "host,host_llm,port,token,xfer",
		"first start writes only host/host_llm/port/token/xfer — no path sandbox fields",
		JSON.stringify(cfg),
	);

	if (baseUrl && e2eToken) {
		const init = await rpc("initialize", { protocolVersion: "2025-11-25" });
		check(
			init.body?.result?.protocolVersion === "2025-11-25",
			"initialize returns the protocol version",
			JSON.stringify(init.body).slice(0, 200),
		);
		const sid = init.sid ?? "";

		const list = await rpc("tools/list", {}, sid);
		const names: string[] = (list.body?.result?.tools ?? []).map((t: { name: string }) => t.name);
		check(names.length > 0, "tools/list returns the host registry", `${names.length} tools`);
		// This line used to read `!names.some(n => n.startsWith("a2a_"))` under the label
		// "the bridge contributes no tools of its own". The label went false when the
		// transfer tools landed — this same probe calls `xfer_share` further down — and
		// the assertion could not fail, since nothing registers an `a2a_*` name. Renaming
		// the prefix here would have rebuilt the same decoration under a new spelling, so
		// what gets checked is the positive: the bridge's own tools are appended to the
		// installed catalog, with their names taken from src/xfer.ts rather than from a
		// second list in this probe.
		const owned = XFER_TOOL_NAMES.filter((n) => names.includes(n));
		check(
			owned.length === XFER_TOOL_NAMES.length,
			"the installed copy appends the tools the bridge owns",
			`${owned.join(",")} of ${XFER_TOOL_NAMES.length}`,
		);
		check(
			!names.includes("xd://") && !names.some((n) => n.startsWith("xd://")),
			"mounted devices are not exposed as tool names",
			names.filter((n) => n.startsWith("xd://")).join(", "),
		);

		// The promise the README makes: a remote agent reaches a local toolchain.
		const called = await rpc("tools/call", { name: "bash", arguments: { command: "echo bridge-e2e-ok" } }, sid);
		const text = (called.body?.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
		check(
			called.body?.result?.isError !== true && text.includes("bridge-e2e-ok"),
			"a remote tools/call runs on the local machine and returns output",
			JSON.stringify(called.body).slice(0, 200),
		);

		const dev = await rpc("tools/call", { name: "xd://debug", arguments: {} }, sid);
		// Assert *which* refusal, not just that there was one. With the exposure
		// gate removed this call reaches the host and the device rejects it with
		// its own message ("Unsupported debug action: undefined") — still
		// isError, so a bare isError check would stay green for the wrong reason.
		const devText = (dev.body?.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join(" ");
		check(
			dev.body?.result?.isError === true && devText.includes("is not exposed by this bridge"),
			"tools/call on a device name is refused by the bridge's exposure gate",
			JSON.stringify(dev.body).slice(0, 160),
		);

		const noAuth = await fetch(baseUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		check(noAuth.status === 401, "an unauthenticated request is rejected", `got ${noAuth.status}`);
	}
} finally {
	host.kill("SIGTERM");
	rmSync(e2eHome, { recursive: true, force: true });
}

// --- 5. a host that has to fetch the file server -----------------------------

// `bun run test:obtain` runs the resolver against real downloads, and `bun test`
// stubs the fetch whole. So the shape the feature actually needs — one tool call,
// nothing on PATH, the bridge fetching the pinned build and serving it through its own
// `/xfer/` route — was demonstrated once by a throwaway script and by nothing that gets
// committed. This is that script, promoted.
//
// The PATH handed to this host is the directory `omp` lives in plus the system
// bins, and the first fact the group depends on is that `dufs` answers from nothing in
// it. Without it, "the bridge installed dufs" would just as likely mean "dufs was
// already there". `cloudflared` is not part of this group any more: `xfer_share` opened
// a tunnel of its own when this was written and opens none now, so the only binary a
// share needs is the file server.
//
// What is hard, and what is only reported:
//
//   HARD   the pinned dufs in the host's own HOME at 0755, the ledger carrying its row
//          at the pinned version, and one `install` audit record. The resolver runs
//          before anything is spawned, so all three hold whether or not the share comes
//          up.
//   REPORTED  the share itself and the requests that follow it. A quick tunnel needed
//          Cloudflare's edge and made that a report; now the only network in the way is
//          the download, and a share that still fails after installing is printed with
//          its reason rather than asserted, because a download that timed out on a slow
//          link says nothing about the proxy.
//
// The fetch-failure check *is* hard in both outcomes: it asks that whatever the tool
// answered, the answer was not about fetching — so a regression in `src/obtain.ts`
// reddens this group even when the network is the thing that stopped the share.
const xferHome = mkdtempSync(join(tmpdir(), "install-xfer-"));
const xferAgent = join(xferHome, ".omp", "agent");
const xferAudit = join(xferHome, "xfer-audit.log");
const xferBinDir = join(xferHome, ".local", "bin");
const xferShareDir = join(xferHome, "shared");
console.log(`\n--- a host with nothing to answer for the file server ---`);
// This host runs in its own HOME, so it gets the extension the same way the other
// host probes do — a symlink under `agent/extensions/`, which the host resolves
// against HOME (see the header). Sections 1-4 install with `omp install .` because
// the install itself is what they are checking; here it is not.
linkExtension(xferAgent);
seedModels(xferAgent);
mkdirSync(xferShareDir, { recursive: true });
const xferPayload = "install-probe-payload\n";
writeFileSync(join(xferShareDir, "file.txt"), xferPayload);

// Not `OMP_BIN`: the rest of this probe runs `omp install` and a host against the
// same binary on PATH, and this group is the same host. One rule for the whole file.
const ompBin = Bun.which("omp");
if (!ompBin) fail("section 5 needs `omp` on PATH");
// Whatever `omp` resolves to on this machine, it is usually a launcher whose script
// runs `#!/usr/bin/env bun`, so the tight PATH needs the interpreter's directory too
// or the host dies before the bridge loads. Both are read from what this run has.
const ompReal = realpathSync(ompBin);
const bunDir = Bun.which("bun") ? dirname(Bun.which("bun") as string) : "/usr/local/bin";
const tightDirs = [...new Set([dirname(ompReal), bunDir, "/usr/bin", "/bin"])];
const tightPath = tightDirs.join(":");
// A dufs already on that PATH makes this group meaningless here, so the whole of it is
// skipped rather than failed: that is a fact about the machine, not about the bridge.
const answers = (b: string) => tightDirs.filter((d) => existsSync(join(d, b)));
const dufsAnswers = answers("dufs");
const answeredFor = dufsAnswers.length > 0;
// Snapshotted rather than asserted false: a machine that already keeps a dufs in the
// operator's HOME is not a machine where the bridge did something wrong.
const realDufsBefore = existsSync(join(process.env.HOME ?? "", ".local", "bin", "dufs"));

const xferHost = answeredFor
	? null
	: spawn(ompReal, ["--mode", "rpc"], {
			env: { ...process.env, HOME: xferHome, PATH: tightPath, A2MCP_AUDIT: xferAudit },
			stdio: ["pipe", "pipe", "pipe"],
		});
let xferOut = "";
let xferErrText = "";
xferHost?.stdout?.on("data", (d) => (xferOut += d));
xferHost?.stderr?.on("data", (d) => (xferErrText += d));

try {
	// When the tight PATH already has a dufs there is no host and nothing to assert: that
	// is a fact about this machine, not a failure of the bridge, and where the dufs is
	// hiding is in the skip line below.
	if (!xferHost) {
		console.log(
			`info: the fetch group is skipped here — ${dufsAnswers.join(", ")} has a dufs, so nothing was left for the bridge to install`,
		);
	} else {
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline && !xferOut.includes("a2mcp listening")) {
			xferHost.stdin.write("");
			await Bun.sleep(300);
		}
		const announced = xferOut.match(/a2mcp listening on (http:\/\/127\.0\.0\.1:(\d+)\/)/);
		check(
			!!announced,
			"the host comes up on a PATH that has no dufs on it",
			announced?.[1] ??
				[...`${xferOut}\n${xferErrText}`.split("\n")]
					.filter((l) => l.length > 0 && l.length < 200)
					.slice(-3)
					.join(" | "),
		);

		if (announced) {
			const url = announced[1];
			const xferToken = JSON.parse(readFileSync(join(xferAgent, "a2mcp.json"), "utf8")).token as string;
			const call = async (method: string, params: unknown, sid?: string, ms = 300_000) => {
				const r = await fetch(url, {
					signal: AbortSignal.timeout(ms),
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${xferToken}`,
						...(sid ? { "mcp-session-id": sid } : {}),
					},
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
				});
				return (await r.json()) as {
					result?: { content?: { text?: string }[]; isError?: boolean; tools?: { name: string }[] };
				};
			};
			const init = await fetch(url, {
				signal: AbortSignal.timeout(30_000),
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${xferToken}` },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-11-25" },
				}),
			});
			const sid = init.headers.get("mcp-session-id") ?? "";

			const shareText = (
				(await call("tools/call", { name: "xfer_share", arguments: { path: xferShareDir, ttlSeconds: 300 } }, sid))
					.result?.content ?? []
			)
				.map((c) => c.text ?? "")
				.join("");
			const fetchFailed = /cannot fetch|sha256|larger than the|timed out|no pinned|not an executable/.test(shareText);
			// Nothing in this answer is a credential any more, so nothing here needs
			// redacting; the newlines are flattened only to keep this probe one line per
			// check. That the token is absent is asserted below, not assumed.
			const redacted = shareText.replace(/\s+/g, " ");
			check(!fetchFailed, "nothing about the fetch is what stopped this share", redacted.slice(0, 200));

			const target = targetKey();
			const wantDufs = pinsFor("dufs")[target]?.version ?? "";
			const dufsBin = join(xferBinDir, "dufs");
			const dufsThere = existsSync(dufsBin);
			check(
				dufsThere && (statSync(dufsBin).mode & 0o777) === 0o755,
				"the bridge fetched dufs into its own HOME at 0755",
				dufsThere ? `${(statSync(dufsBin).size / 1048576).toFixed(1)} MB, pinned ${wantDufs}` : `${dufsBin} is missing`,
			);

			// Both files are read through a presence check: a bridge that never got as far
			// as writing them has to answer with FAIL lines here, not with an exception from
			// `readFileSync` that ends the group and hides the checks after it.
			const ledgerPath = join(xferAgent, "a2mcp.installs.json");
			const rows = existsSync(ledgerPath)
				? Object.values(
						JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, { version: string; target: string }>,
					)
				: [];
			check(
				rows.length === 1 && rows[0]?.target === target && rows[0]?.version === wantDufs,
				"the ledger carries one row, the file server at the pinned version",
				`${ledgerPath}: ${rows.length ? rows.map((r) => `${r.version}/${r.target}`).join(" ") : "no rows"}`,
			);

			const installs = (existsSync(xferAudit) ? readFileSync(xferAudit, "utf8") : "")
				.split("\n")
				.filter((l) => l.length > 0)
				.map((l) => JSON.parse(l) as { tool: string; isError: boolean; args: string })
				.filter((r) => r.tool === "xfer" && JSON.parse(r.args).action === "install");
			check(
				installs.length === 1 &&
					installs.every((r) => !r.isError) &&
					JSON.parse(installs[0]?.args ?? "{}").version === wantDufs,
				"the audit holds one successful install record, for the file server",
				installs
					.map((r) => `${JSON.parse(r.args).name} ${JSON.parse(r.args).version}${r.isError ? " (isError)" : ""}`)
					.join(" ") || "no install record",
			);

			// Parsed defensively for the same reason the two files above are read through a
			// presence check: a tool that answered with prose (a download that never
			// finished) should skip the byte checks, not throw here and skip the checks
			// after them. A failed share answers with a JSON *string*, which parses without
			// complaint, so what decides whether there is a share to hit is the shape: a
			// numeric port.
			const parsed: unknown = (() => {
				try {
					return JSON.parse(shareText);
				} catch {
					return null;
				}
			})();
			const info =
				parsed !== null && typeof parsed === "object" && typeof (parsed as { port?: unknown }).port === "number"
					? (parsed as {
							port: number;
							url: string;
							route: string;
							installed?: Record<string, string | null>;
						})
					: null;
			if (!info) console.log("info: the share never came up, so the byte checks below are skipped");
			if (info) {
				check(
					info.installed?.dufs === wantDufs && !("cloudflared" in info.installed),
					"one tool call reports the one fetch a share needs",
					JSON.stringify(info.installed),
				);
				check(
					info.url === `${url}xfer/` && info.route === `${XFER_ROUTE}/`,
					"the share is announced as a route on the bridge's own port",
					JSON.stringify({ url: info.url, route: info.route }),
				);
				check(!shareText.includes(xferToken), "the share answer hands out no credential", redacted.slice(0, 160));

				const routeAuth = { authorization: `Bearer ${xferToken}` };
				const fileUrl = `${url}xfer/file.txt`;
				const got = await fetch(fileUrl, { signal: AbortSignal.timeout(15_000), headers: routeAuth });
				const served = got.status === 200 ? await got.text() : "";
				check(
					served === xferPayload,
					"the bridge's /xfer route serves the file the tool was given",
					`HTTP ${got.status}`,
				);
				const wrong = await fetch(fileUrl, {
					signal: AbortSignal.timeout(15_000),
					headers: { authorization: "Bearer not-the-bridge-token" },
				});
				check(wrong.status === 401, "a wrong token is refused at the route", `got ${wrong.status}`);

				// The listing is what a browser or a WebDAV client opens first, and every
				// absolute reference in it has to name the prefix — follow one that does not
				// and the caller leaves the route. That is what `--path-prefix` buys, and this
				// is real dufs confirming it holds.
				const listing = await fetch(`${url}xfer/`, { signal: AbortSignal.timeout(15_000), headers: routeAuth });
				const page = await listing.text();
				const refs = page.match(/(?:href|src)="\/[^"]*"/g) ?? [];
				check(
					listing.status === 200 && refs.length > 0 && refs.every((r) => r.includes(`"${XFER_ROUTE}/`)),
					"the listing renders with every reference under the prefix",
					`HTTP ${listing.status}, ${refs.slice(0, 3).join(" ") || "no absolute references"}`,
				);
				const asJson = await fetch(`${url}xfer/?json`, {
					signal: AbortSignal.timeout(15_000),
					headers: routeAuth,
				});
				const meta = (await asJson.json().catch(() => ({}))) as { uri_prefix?: string };
				check(
					asJson.status === 200 && meta.uri_prefix === `${XFER_ROUTE}/`,
					"the JSON listing prefixes its own URIs",
					`HTTP ${asJson.status}, uri_prefix ${meta.uri_prefix ?? "missing"}`,
				);

				await call("tools/call", { name: "xfer_stop", arguments: {} }, sid, 60_000);
				await Bun.sleep(400);
				const after = await fetch(fileUrl, { signal: AbortSignal.timeout(15_000), headers: routeAuth });
				check(after.status === 404, "after stop the route says nothing is shared", `got ${after.status}`);
				const stillUp = await fetch(`http://127.0.0.1:${info.port}${XFER_ROUTE}/file.txt`, {
					signal: AbortSignal.timeout(3_000),
					headers: routeAuth,
				})
					.then(() => true)
					.catch(() => false);
				check(!stillUp, "stop releases the file server's own port", stillUp ? "still answering" : "nothing listening");
			}
		}
	}

	check(
		existsSync(join(process.env.HOME ?? "", ".local", "bin", "dufs")) === realDufsBefore,
		"the operator's own ~/.local/bin is exactly as it was",
		`before: ${realDufsBefore ? "a dufs was there" : "no dufs"}, after: ${
			existsSync(join(process.env.HOME ?? "", ".local", "bin", "dufs")) ? "a dufs is there" : "no dufs"
		}`,
	);
} finally {
	xferHost?.kill("SIGTERM");
	rmSync(xferHome, { recursive: true, force: true });
}

rmSync(stage, { recursive: true, force: true });

// --- 6. what the README's one command puts on disk ----------------------------
// The npm name is a reserved shape, not an available one: the package is not
// published, and the README teaches the git URL. What this group still proves
// when the registry does answer is the size-and-shape claim behind that
// reservation — a git spec installs a whole checkout of this repo (measured
// 2.3 MB, docs/ and test/ and website/ included — bun's git path ignores the
// `files` field), a published package installs the packed tarball. The group
// runs the real `omp install a2mcp` in a throwaway HOME and asserts the shape
// that landed. Network is this group's business, not CI's: a registry that does
// not answer (or does not carry the package yet) skips the whole group as info.
{
	const npmHome = mkdtempSync(join(tmpdir(), "install-npm-"));
	const npmEnv = { ...process.env, HOME: npmHome };
	try {
		execFileSync("omp", ["plugin", "uninstall", PKG_NAME], { env: npmEnv, stdio: "ignore" });
	} catch {
		// A fresh HOME has nothing installed; the uninstall is just a guard.
	}
	let npmNote = "";
	let npmError = "";
	try {
		const out = execFileSync("omp", ["install", SPEC], {
			env: npmEnv,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		npmNote = out.trim().split("\n").pop() ?? "installed";
	} catch (e) {
		npmError =
			String((e as { stderr?: string }).stderr ?? e)
				.trim()
				.split("\n")[0] ?? "install failed";
	}
	if (npmError !== "") {
		console.log(`info: skipped the npm-install group — \`${SPEC}\` did not install (${npmError})`);
	} else {
		const pkgDir = join(npmHome, ".omp", "plugins", "node_modules", PKG_NAME);
		const npmLock = join(npmHome, ".omp", "plugins", "omp-plugins.lock.json");
		check(
			existsSync(npmLock) && readFileSync(npmLock, "utf8").includes(`"${PKG_NAME}"`),
			"the npm install registers in the lock under the HOME it ran in",
			existsSync(npmLock) ? "lock present" : "no lock file",
		);
		const entries = existsSync(pkgDir) ? readdirSync(pkgDir).sort() : [];
		check(
			entries.includes("package.json") && entries.includes("extensions") && entries.includes("src"),
			"the installed package carries what the host loads",
			entries.join(", ") || "directory missing",
		);
		check(
			!entries.some((e) => ["docs", "brain", "test", "website", ".github", "scripts"].includes(e)),
			"what landed is the packed tarball, not a checkout of the repo",
			entries.join(", "),
		);
		const servedVersion = entries.includes("package.json")
			? ((JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version?: string }).version ?? "")
			: "";
		check(
			/^[0-9]+\.[0-9]+\.[0-9]+$/.test(servedVersion),
			"the installed version reads as an exact semver (it is what serverInfo prints)",
			`version: ${servedVersion || "unreadable"}`,
		);
		console.log(`  npm install said: ${npmNote}`);
	}
	rmSync(npmHome, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nPACKAGE: ${failures} check(s) failed`);
	process.exit(1);
}
console.log(`\nPACKAGE OK: the published tarball is self-contained (${SPEC})`);
