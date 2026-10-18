/**
 * Where the binaries behind `xfer_*` come from.
 *
 * ## Why this file exists
 *
 * `xfer` used to name programs and nothing else: `xfer.dufs` and
 * `xfer.cloudflared` were looked up on PATH, and a missing one was the operator's
 * problem. That contract cost exactly what it looks like on a machine where
 * `dufs` is not installed — the transfer tools are present in `tools/list` and
 * every call answers "put it on your PATH", so the feature is unusable until
 * somebody goes and fetches a 2.9 MB tarball by hand.
 *
 * So the bridge fetches it. That is a third opinion the bridge did not used to
 * have, and the honest way to state it is not "convenience": the bridge already
 * decided *which* program serves the file, so this adds only *where its bytes
 * come from*. It is not a second authority — it runs nothing the host would not
 * have run, and it writes nothing outside the one path it installs to.
 *
 * ## What "pinned" means here
 *
 * Every row in `PINS` is a version nobody can drift into and two hashes nobody
 * has to fetch: the version and the archive's sha256 are literals in this file,
 * read off the release metadata and re-checked by `bun run test:obtain` on the
 * bytes that actually landed. The bridge never asks for `latest`, and never takes
 * a checksum from the same server that gave it the bytes — a checksum from the
 * download host proves only that the download host was consistent.
 *
 * Upgrading is therefore a commit in this repository, with the hash in the diff.
 * That is the trade: no silent drift, no surprise old binary.
 *
 * A row whose hash has not been read from the release metadata does not exist.
 * Filling one in from memory would be worse than leaving it out, because the hash
 * is the only thing between "the bridge downloaded bytes" and "the bridge executed
 * them".
 *
 * ## The three ways out of a missing binary
 *
 * `xfer.dufs: "/srv/bin/dufs"` is the escape hatch: a value that contains a `/` is
 * used verbatim and never downloaded from. A bare name is not that — a bare name
 * is the request to look, and to fetch if looking finds nothing. Nothing here
 * touches a file it did not install: an existing `~/.local/bin/dufs` that is not
 * the build this bridge wrote (per its own ledger) is reported with its hash and
 * left alone.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	access,
	chmod,
	constants,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

import { auditXfer } from "./audit.ts";

/** The two programs `xfer` drives. Keys of `PINS`, and of `cfg.xfer`. */
export type BinaryName = "dufs" | "cloudflared";

/** `binary` is the raw executable, `tar.gz` an archive holding it at the top level. */
export type Kind = "tar.gz" | "binary";

export interface Pin {
	/** Release tag as it appears in the download URL, e.g. `v0.46.0`. */
	tag: string;
	/** Human-facing version, reported in the tool result and the audit. */
	version: string;
	/** Release asset name. Built into a URL by table lookup, never from input. */
	asset: string;
	kind: Kind;
	/** sha256 of the asset, lower-case hex. */
	sha256: string;
}

const RELEASE_BASE: Record<BinaryName, string> = {
	dufs: "https://github.com/sigoden/dufs/releases/download",
	cloudflared: "https://github.com/cloudflare/cloudflared/releases/download",
};

/** What this bridge will fetch for each binary, per `${platform}-${arch}` target. */
export type Pins = Record<BinaryName, Record<string, Pin>>;

/**
 * Keyed `${platform}-${arch}`, the same shape Node reports.
 *
 * Every hash here was read from the release asset's own `digest` field, never
 * computed from a checksum the download host offered. Four of the eight were then
 * downloaded and hashed by hand — cloudflared's four on 2026-10-17, dufs' linux-x64
 * on 2026-10-16 — and `bun run test:obtain` re-checks this machine's row against the
 * bytes GitHub actually serves, `HEAD`s all eight URLs so a mistyped tag on a target
 * nobody here can run still fails a check. Each dufs row is the musl build on Linux
 * because it is a fully static binary, which is the one thing that makes it safe to
 * run on a glibc host. Each cloudflared row is the ordinary build and not the
 * `-fips` one: a FIPS build is for a host that asked, and none has. Linux publishes
 * cloudflared as a bare executable, macOS as a tarball holding one file called
 * `cloudflared`, which is the difference `kind` records.
 */
const PINS: Pins = {
	dufs: {
		"linux-x64": {
			tag: "v0.46.0",
			version: "0.46.0",
			asset: "dufs-v0.46.0-x86_64-unknown-linux-musl.tar.gz",
			kind: "tar.gz",
			sha256: "817769f726613194bcff9d0e3e481eaccc86ac11208857614f36a8c02f410977",
		},
		"linux-arm64": {
			tag: "v0.46.0",
			version: "0.46.0",
			asset: "dufs-v0.46.0-aarch64-unknown-linux-musl.tar.gz",
			kind: "tar.gz",
			sha256: "1472123ae3aa07e49404d16b20305c2dec90c59883ebda9308717f7205e6511b",
		},
		"darwin-x64": {
			tag: "v0.46.0",
			version: "0.46.0",
			asset: "dufs-v0.46.0-x86_64-apple-darwin.tar.gz",
			kind: "tar.gz",
			sha256: "f494db0de9e95764199781754147c4a341227d4794b1bcf5dac862bd21c1216a",
		},
		"darwin-arm64": {
			tag: "v0.46.0",
			version: "0.46.0",
			asset: "dufs-v0.46.0-aarch64-apple-darwin.tar.gz",
			kind: "tar.gz",
			sha256: "2c73fa330447c344111aea9159621af5e2d4460b9227562e09138e5c01d3becf",
		},
	},
	cloudflared: {
		"linux-x64": {
			tag: "2026.10.1",
			version: "2026.10.1",
			asset: "cloudflared-linux-amd64",
			kind: "binary",
			sha256: "3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586",
		},
		"linux-arm64": {
			tag: "2026.10.1",
			version: "2026.10.1",
			asset: "cloudflared-linux-arm64",
			kind: "binary",
			sha256: "2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46",
		},
		"darwin-x64": {
			tag: "2026.10.1",
			version: "2026.10.1",
			asset: "cloudflared-darwin-amd64.tgz",
			kind: "tar.gz",
			sha256: "3b0dbaf378337e9d7fb6cd235a76d1d6a7dee434c2d8edf9281164fb6a3837ab",
		},
		"darwin-arm64": {
			tag: "2026.10.1",
			version: "2026.10.1",
			asset: "cloudflared-darwin-arm64.tgz",
			kind: "tar.gz",
			sha256: "647615df99d49cd179ea5e13ef760b9bbfb33630f6ae62f87e33dfadda60adcc",
		},
	},
};

/**
 * Bytes accepted for one download, and the wall clock allowed to fetch it.
 *
 * The cap clears the largest pinned asset (cloudflared's Linux binary, 40 MB) with
 * room for a version bump and still stops a stream that never ends; the deadline is
 * that asset's download at the slowest rate this host has measured off a working
 * connection, rounded up. `xfer_share` waits for both halves inline, so a fetch that
 * is merely slow is a tool call that is merely slow — one that stalls is the case
 * these two numbers exist for.
 */
const MAX_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export interface InstallInfo {
	name: BinaryName;
	version: string;
	target: string;
	sha256: string;
	dest: string;
}

export interface Resolved {
	/** Absolute path to spawn. Every branch returns one, including the PATH hit. */
	path: string;
	/** Set only when this call downloaded and wrote the binary. */
	installed: InstallInfo | null;
}

export interface ObtainDeps {
	env?: NodeJS.ProcessEnv;
	/** Where to install. Default `~/.local/bin`, the same place cloudflared lives. */
	binDir?: string;
	/** Ledger of what this bridge installed. Default `<agentDir>/a2mcp.installs.json`. */
	ledger?: string;
	/** Test seam: a local server standing in for the release host. */
	fetchImpl?: typeof fetch;
	base?: string;
	/** Test seam: pretend to be another platform, to reach the unsupported branch. */
	target?: string;
	/**
	 * Test seam: the pin table itself.
	 *
	 * The bytes a test serves cannot match a hash that was read off a real release,
	 * so the verification paths are only testable if the table is data the caller
	 * can hand in. Production never passes this: `PINS` above is the authority.
	 */
	pins?: Pins;
	timeoutMs?: number;
	maxBytes?: number;
}

/** `${platform}-${arch}` as `PINS` keys it. */
export function targetKey(): string {
	return `${process.platform}-${process.arch}`;
}

/**
 * The real table, for the tests that check its shape.
 *
 * A truncated hash literal is a 63-character string that compares unequal to
 * everything, which is a failure an operator hits and nobody reads as a typo. This
 * is the only way to say "every row is well formed" without downloading four assets.
 */
export function pinsFor(name: BinaryName): Record<string, Pin> {
	return PINS[name];
}

/**
 * The URL a pin downloads from.
 *
 * Exported for `bun run test:obtain`, which `HEAD`s every row of the table — the
 * targets this machine cannot run are otherwise checked by nobody, and a tag or
 * asset name typed wrong reads as a slow share rather than a broken table.
 */
export function pinnedUrl(name: BinaryName, pin: Pin, base?: string): string {
	return `${base ?? RELEASE_BASE[name]}/${pin.tag}/${pin.asset}`;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function isExec(p: string): Promise<boolean> {
	try {
		await access(p, constants.X_OK);
		return (await stat(p)).isFile();
	} catch {
		return false;
	}
}

/**
 * PATH, walked by hand.
 *
 * No shell and no `which`: the answer has to be the file this process will spawn,
 * and a lookup that spawns something else to ask about it inherits whatever that
 * program decides to say about an empty or relative PATH entry.
 */
async function findOnPath(wanted: string, env: NodeJS.ProcessEnv): Promise<string | null> {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const cand = isAbsolute(dir) ? join(dir, wanted) : resolve(dir, wanted);
		if (await isExec(cand)) return cand;
	}
	return null;
}

/** What this bridge installed where, so a later call can tell ours from somebody else's. */
interface LedgerEntry {
	version: string;
	target: string;
	/** sha256 of the bytes written, which is not the archive's. */
	sha256: string;
	at: string;
}

type Ledger = Record<string, LedgerEntry>;

function ledgerPath(deps: ObtainDeps, env: NodeJS.ProcessEnv): string {
	return deps.ledger ?? obtainLedgerPath(env);
}

/**
 * Where the bridge keeps its record of what it installed.
 *
 * Exported because the install is only half of what an operator wants to find
 * later: the binary is in `~/.local/bin`, the account of it is here.
 */
export function obtainLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.A2MCP_INSTALLS ?? join(getAgentDir(), "a2mcp.installs.json");
}

async function readLedger(file: string): Promise<Ledger> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed as Ledger;
	} catch {
		// Absent or unreadable is "this bridge has installed nothing", which is the
		// honest reading: a ledger nobody can parse cannot vouch for a file, and the
		// refuse-to-clobber rule has to fail closed rather than fail permissive.
		return {};
	}
}

async function writeLedger(file: string, dest: string, entry: LedgerEntry): Promise<void> {
	const ledger = await readLedger(file);
	ledger[dest] = entry;
	await mkdir(dirname(file), { recursive: true });
	// `mode` on create plus `chmod` after: the same two steps `src/config.ts` uses,
	// because a mode that only applies at creation leaves a restored file world-readable.
	await writeFile(file, `${JSON.stringify(ledger, null, "\t")}\n`, { mode: 0o600 });
	await chmod(file, 0o600).catch(() => {});
}

function runTar(args: string[]): Promise<string> {
	return new Promise((res, rej) => {
		execFile("tar", args, { maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
			if (!e) {
				res(stdout);
				return;
			}
			rej(
				new Error(
					e.code === "ENOENT"
						? "cannot unpack the download: 'tar' is not on the host's PATH"
						: `tar ${args[0]} failed: ${String(stderr || e.message).slice(0, 300)}`,
				),
			);
		});
	});
}

/**
 * Pull the executable out of a `tar.gz`, or hand back the bytes.
 *
 * The archive is listed before anything is written, because the entry names are
 * the only part of an untrusted file this code has to reason about: one top-level
 * entry called `wanted`, no absolute paths, no `..`. Extraction then goes into a
 * fresh temp directory whose `realpath` the result has to still be inside — GNU
 * and BSD tar both strip a leading `../` on their own, and this check is the
 * reason we do not have to trust them doing it.
 */
async function extract(bytes: Buffer, wanted: string, kind: Kind): Promise<Buffer> {
	if (kind === "binary") return bytes;
	const stage = await mkdtemp(join(tmpdir(), "a2mcp-obtain-"));
	try {
		const file = join(stage, "archive.tar.gz");
		await writeFile(file, bytes);
		const names = (await runTar(["-tzf", file]))
			.split("\n")
			.map((n) => n.replace(/^\.\//, "").replace(/\/$/, "").trim())
			.filter(Boolean);
		for (const n of names) {
			if (isAbsolute(n) || n.split("/").includes("..")) {
				throw new Error(`archive entry '${n}' is not a path inside the archive`);
			}
		}
		if (!names.includes(wanted)) {
			throw new Error(`no '${wanted}' at the top level of the archive (contains: ${names.join(", ") || "nothing"})`);
		}
		await runTar(["-xzf", file, "-C", stage]);
		const found = join(stage, wanted);
		const [real, root] = await Promise.all([realpath(found), realpath(stage)]);
		if (real !== join(root, wanted) && !real.startsWith(root + sep)) {
			throw new Error(`'${wanted}' unpacked outside the staging directory`);
		}
		return await readFile(real);
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

/**
 * Fetch with a size cap and a deadline.
 *
 * Both are load-bearing, not hygiene: this host has measured GitHub archives
 * stalling at 0 B/s behind a TLS-intercepting network, and `xfer_share` answers
 * inline. An unbounded read is a tool call that never returns.
 */
async function download(url: string, limit: number, timeoutMs: number, f: typeof fetch): Promise<Buffer> {
	let res: Response;
	try {
		res = await f(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
	} catch (e) {
		throw new Error(`cannot fetch ${url}: ${(e as Error).message}`);
	}
	if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
	if (!res.body) throw new Error(`${url} answered with no body`);
	const reader = res.body.getReader();
	const parts: Buffer[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > limit) throw new Error(`download is larger than the ${limit} byte cap`);
			parts.push(Buffer.from(value));
		}
	} catch (e) {
		await reader.cancel().catch(() => {});
		throw new Error(`downloading ${url.split("/").pop()} failed: ${(e as Error).message}`);
	}
	return Buffer.concat(parts);
}

/**
 * One share at a time is `xfer`'s rule; one install at a time is this module's.
 *
 * Two concurrent `xfer_share` calls that both find nothing on PATH would
 * otherwise fetch twice and rename twice over each other. The key includes the
 * configured name and target dir so an explicit-path caller can never be handed
 * somebody else's resolution.
 */
const inflight = new Map<string, Promise<Resolved>>();

export async function resolveBinary(
	name: BinaryName,
	configured: string,
	sid: string | null,
	deps: ObtainDeps = {},
): Promise<Resolved> {
	const env = deps.env ?? process.env;
	const target = deps.target ?? targetKey();
	const binDir = deps.binDir ?? join(env.HOME || homedir(), ".local", "bin");
	const key = `${name}|${configured}|${target}|${binDir}`;
	const running = inflight.get(key);
	if (running) return running;
	const job = resolveOnce(name, configured, sid, env, target, binDir, deps).finally(() => inflight.delete(key));
	inflight.set(key, job);
	return job;
}

async function resolveOnce(
	name: BinaryName,
	configured: string,
	sid: string | null,
	env: NodeJS.ProcessEnv,
	target: string,
	binDir: string,
	deps: ObtainDeps,
): Promise<Resolved> {
	// An explicit path is the operator's answer to "where is it", so it is used as
	// given and a missing one is an error rather than a cue to download.
	if (configured.includes("/")) {
		if (!(await isExec(configured))) {
			throw new Error(
				`'${configured}' is not an executable file — a path in xfer.${name} is used as given, the bridge downloads nothing for one`,
			);
		}
		return { path: configured, installed: null };
	}

	const hit = await findOnPath(configured, env);
	if (hit) return { path: hit, installed: null };

	const pin = (deps.pins ?? PINS)[name][target];
	if (!pin) {
		throw new Error(
			`no pinned ${name} build for ${target}: the bridge will not download bytes it cannot verify. Put '${configured}' on the host's PATH, or name a path in the config's xfer block`,
		);
	}

	const dest = join(binDir, configured);
	const there = await readFile(dest).catch(() => null);
	if (there) {
		const got = sha256(there);
		const ours = (await readLedger(ledgerPath(deps, env)))[dest];
		if (ours && ours.sha256 === got) return { path: dest, installed: null };
		throw new Error(
			`${dest} already exists and is not the build this bridge installs (its sha256 is ${got}, the pinned ${name} ${pin.version} is ${pin.sha256}). Remove it, put a ${name} on PATH, or point xfer.${name} at one`,
		);
	}

	let install: InstallInfo;
	let bin: Buffer;
	try {
		const url = pinnedUrl(name, pin, deps.base);
		const bytes = await download(
			url,
			deps.maxBytes ?? MAX_BYTES,
			deps.timeoutMs ?? TIMEOUT_MS,
			deps.fetchImpl ?? fetch,
		);
		const got = sha256(bytes);
		if (got !== pin.sha256) {
			throw new Error(`${pin.asset} has sha256 ${got}, not the pinned ${pin.sha256} — refusing to install it`);
		}
		bin = await extract(bytes, configured, pin.kind);
		install = { name, version: pin.version, target, sha256: pin.sha256, dest };
	} catch (e) {
		const why = (e as Error).message;
		await auditXfer(sid, "install", { name, version: pin.version, target, asset: pin.asset }, why);
		throw new Error(why);
	}

	try {
		await mkdir(binDir, { recursive: true });
		// Same directory as the target, so the rename is same-filesystem and the
		// binary either exists complete or does not exist at all.
		const part = join(binDir, `.${configured}.${randomBytes(6).toString("hex")}.part`);
		await writeFile(part, bin, { mode: 0o755 });
		await chmod(part, 0o755);
		await rename(part, dest);
	} catch (e) {
		const why = `downloaded ${pin.asset} but cannot write ${dest}: ${(e as Error).message}`;
		await auditXfer(sid, "install", { name, version: pin.version, target, dest }, why);
		throw new Error(why);
	}

	await writeLedger(ledgerPath(deps, env), dest, {
		version: pin.version,
		target,
		sha256: sha256(bin),
		at: new Date().toISOString(),
	});
	// On disk before the caller spawns it: this record is the only account of a
	// binary that appeared in a home directory, and `xfer`'s own `share` record
	// follows it.
	await auditXfer(sid, "install", { name, version: pin.version, target, sha256: pin.sha256, dest }, null);
	return { path: dest, installed: install };
}
