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
 * `xfer.dufs: "/srv/bin/dufs"` is the escape hatch: a value containing a `/` or a
 * `\` is used verbatim and never downloaded from. A bare name is not that — a bare
 * name is the request to look, and to fetch if looking finds nothing. Nothing here
 * touches a file it did not install: an existing `~/.local/bin/dufs` (on Windows,
 * `%LOCALAPPDATA%\a2mcp\bin\dufs.exe`) that is not the build this bridge wrote (per
 * its own ledger) is reported with its hash and left alone.
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
import { inflateRawSync } from "node:zlib";

import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

import { auditXfer } from "./audit.ts";

/** The two programs `xfer` drives. Keys of `PINS`, and of `cfg.xfer`. */
export type BinaryName = "dufs" | "cloudflared";

/**
 * `binary` is the raw executable, `tar.gz` an archive holding it at the top level,
 * `zip` an archive holding it at the top level read without touching the disk.
 *
 * `zip` exists because that is how dufs publishes its Windows build, and it is read
 * by this file rather than by a program: Windows ships `tar.exe` (bsdtar) and it
 * does open a zip, but no check in this repository can run it, and GNU tar — the
 * `tar` every other path here assumes — cannot. An unpack step nobody can execute
 * is not a checked unpack step.
 */
export type Kind = "tar.gz" | "binary" | "zip";

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
 * A hash lives here as a literal, so bytes that come back different are a refusal
 * rather than a swap. Where each literal came from differs by project, and the
 * difference is worth recording: cloudflared publishes a sha256 per asset in its
 * release notes, and its five rows are those digests. dufs publishes no checksums
 * at all — eight assets, no digest in the release body — so its five rows are
 * hashes this machine computed over the bytes it pulled from the release URL. Both
 * Windows rows went in on 2026-10-19 after being downloaded and hashed here; the
 * cloudflared one then equalled the published digest, and the dufs zip equalled the
 * release API's `size` (2 323 817 B). The rows that went in before them were
 * checked the same way — cloudflared's four on 2026-10-17, dufs' linux-x64 on
 * 2026-10-16 — and `bun run test:obtain` re-checks this machine's own row against
 * the bytes GitHub actually serves and `HEAD`s all ten URLs, so a mistyped tag on a
 * target nobody here can run still fails a check.
 *
 * Each dufs row is the musl build on Linux because it is a fully static binary,
 * which is the one thing that makes it safe to run on a glibc host. Each cloudflared
 * row is the ordinary build and not the `-fips` one: a FIPS build is for a host that
 * asked, and none has. Linux publishes cloudflared as a bare executable, macOS as a
 * tarball holding one file called `cloudflared`, Windows as a bare `.exe` — which is
 * the difference `kind` records, and why dufs needs both a packed (`tar.gz`) and an
 * unpacked (`zip`) reading.
 *
 * `win32-arm64` is absent on purpose: dufs publishes an aarch64 Windows build and
 * cloudflared does not — its release list has `windows-386.exe` and
 * `windows-amd64.exe` and nothing for arm64 (read from the GitHub release API on
 * 2026-10-19). One binary is not a working `xfer_share`, so the pair is not pinned
 * and a Windows-on-ARM host gets the "no pinned build" answer instead of a partial
 * table.
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
		"win32-x64": {
			tag: "v0.46.0",
			version: "0.46.0",
			asset: "dufs-v0.46.0-x86_64-pc-windows-msvc.zip",
			kind: "zip",
			sha256: "21d829653ac1f178b124ed384e2a57df19b99ae404935cba9a1a5719c199b0bf",
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
		"win32-x64": {
			tag: "2026.10.1",
			version: "2026.10.1",
			asset: "cloudflared-windows-amd64.exe",
			kind: "binary",
			sha256: "4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6",
		},
	},
};

/**
 * Bytes accepted for one download, and the wall clock allowed to fetch it. Why
 * both exist is at `download()`.
 *
 * The cap clears the largest pinned asset — cloudflared's Windows `.exe`, 52.7 MB
 * as of 2026-10-19 — with room for a version bump, and still stops a stream that
 * never ends. The deadline is not re-measured for that asset: 120 s is the wall
 * clock this host rounded up from the Linux build it had fetched by hand, and 53 MB
 * inside it asks for roughly 450 KB/s sustained. A Windows host on a slower
 * connection gets a timeout in the audit log rather than a slow share, which is the
 * honest shape of a limit nobody has run on the target platform.
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
	/** Where to install. Default `~/.local/bin` on unix, `%LOCALAPPDATA%\a2mcp\bin` on Windows. */
	binDir?: string;
	/** Ledger of what this bridge installed. Default `<agentDir>/a2mcp.installs.json`. */
	ledger?: string;
	/** Test seam: a local server standing in for the release host. */
	fetchImpl?: typeof fetch;
	base?: string;
	/** Test seam: pretend to be another `${platform}-${arch}`, to reach an unpinned target. */
	target?: string;
	/**
	 * Test seam: pretend to be another platform, for the file-name shape only.
	 *
	 * Whether the installed file carries `.exe`, whether a PATH lookup tries
	 * `PATHEXT`, whether a backslash means "this is a path" and where the default
	 * install directory is — all four are Windows decisions, and the machine these
	 * tests run on is not one. A branch nothing reaches is a branch nothing checks.
	 */
	platform?: string;
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
 * The file name a program has on disk, on this platform.
 *
 * Windows will not `CreateProcess` a file called `dufs` when the bytes it installed
 * are `dufs.exe`, and the release publishes them that way. On unix the name is the
 * name, which is why only the Windows branch appends anything.
 */
function exeName(wanted: string, platform: string): string {
	if (platform !== "win32") return wanted;
	return wanted.toLowerCase().endsWith(".exe") ? wanted : `${wanted}.exe`;
}

/** The extensions Windows is willing to run out of a bare `dufs` request. */
const WINDOWS_PATHEXT = ".EXE;.CMD;.BAT;.COM";

/**
 * PATH, walked by hand.
 *
 * No shell and no `which`: the answer has to be the file this process will spawn,
 * and a lookup that spawns something else to ask about it inherits whatever that
 * program decides to say about an empty or relative PATH entry.
 *
 * Windows resolves a bare command through `PATHEXT`, so the plain name is tried
 * first and each extension after it — the order `where.exe` uses, without spawning
 * `where.exe`.
 */
async function findOnPath(wanted: string, env: NodeJS.ProcessEnv, platform: string): Promise<string | null> {
	const suffixes = platform === "win32" ? ["", ...(env.PATHEXT ?? WINDOWS_PATHEXT).split(";").filter(Boolean)] : [""];
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const s of suffixes) {
			const cand = isAbsolute(dir) ? join(dir, wanted + s) : resolve(dir, wanted + s);
			if (await isExec(cand)) return cand;
		}
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

/**
 * Where the bridge installs, on this platform, when nobody said otherwise.
 *
 * Exported for the unit tests: the Windows shape is asserted here rather than by
 * letting an install write into `%LOCALAPPDATA%` on somebody's machine.
 */
export function defaultBinDir(env: NodeJS.ProcessEnv, platform: string): string {
	// Unix: `~/.local/bin`, the path the README names and the one cloudflared's own
	// installer would have used. Windows: under `%LOCALAPPDATA%`, the same root the
	// host's installer writes to, because `%USERPROFILE%\.local\bin` is a unix
	// directory shape dropped onto a Windows box. Nothing here needs to be on PATH
	// for a share to work — `xfer` spawns the absolute path this result was written
	// to — so the choice is about where an operator looks, not about resolution.
	if (platform === "win32") return join(env.LOCALAPPDATA || homedir(), "a2mcp", "bin");
	return join(env.HOME || homedir(), ".local", "bin");
}

/**
 * The one entry a `zip` holds, read out of the bytes with nothing written to disk.
 *
 * `tar` cannot be the answer here. Windows does ship `tar.exe` (bsdtar) and it opens
 * a zip, and GNU tar — the `tar` every other path in this file assumes — does not;
 * an unpack step no check in this repository can execute is not a checked unpack
 * step. So the archive is parsed directly, and one consequence is that the
 * tarball's safety dance disappears instead of being reimplemented: no entry name is
 * ever joined onto a path, because the only thing an entry name is used for here is
 * comparison.
 *
 * The entry's CRC is not re-checked: the whole archive has just been compared
 * against a hash in the pin table, and a second checksum over a slice of bytes
 * already proven identical adds a way to be wrong, not a way to be right.
 *
 * What it refuses, each with the reason in the message: no end-of-central-directory
 * record, a zip64 structure (the extra field carrying the real offsets is not parsed,
 * and no pinned asset needs one), an encrypted entry, a compression method other than
 * stored or deflate, an entry declaring more than the download cap, a central
 * directory or data start pointing outside the archive, and output whose length is not
 * the declared one.
 */
export function readZipEntry(bytes: Buffer, wanted: string, limit: number): Buffer {
	const eocd = findEndOfCentralDirectory(bytes);
	const count = bytes.readUInt16LE(eocd + 10);
	const cdSize = bytes.readUInt32LE(eocd + 12);
	const cdOffset = bytes.readUInt32LE(eocd + 16);
	if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
		throw new Error("this zip is zip64, which is not read: the extra field holding the real offsets is not parsed");
	}
	if (cdOffset + cdSize > bytes.length) {
		throw new Error("the central directory of this zip points outside the archive");
	}
	for (let p = cdOffset, i = 0; i < count; i++) {
		if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== 0x02014b50) {
			throw new Error(`zip central-directory record ${i} is not where the archive said it would be`);
		}
		const flags = bytes.readUInt16LE(p + 8);
		const method = bytes.readUInt16LE(p + 10);
		const csize = bytes.readUInt32LE(p + 20);
		const usize = bytes.readUInt32LE(p + 24);
		const nameLen = bytes.readUInt16LE(p + 28);
		const extraLen = bytes.readUInt16LE(p + 30);
		const commentLen = bytes.readUInt16LE(p + 32);
		const localOff = bytes.readUInt32LE(p + 42);
		const name = bytes.toString("utf8", p + 46, p + 46 + nameLen).replace(/^\.\//, "");
		p += 46 + nameLen + extraLen + commentLen;
		if (name !== wanted) continue;
		if (flags & 0x1) throw new Error(`zip entry '${wanted}' is encrypted, and no password is in the pin table`);
		if (method !== 0 && method !== 8) {
			throw new Error(
				`zip entry '${wanted}' uses compression method ${method}; only stored (0) and deflate (8) are read`,
			);
		}
		if (csize === 0xffffffff || usize === 0xffffffff) {
			throw new Error(`zip entry '${wanted}' is zip64, which is not read`);
		}
		if (usize > limit) {
			throw new Error(`zip entry '${wanted}' declares ${usize} bytes, over the ${limit} byte cap for one install`);
		}
		if (localOff + 30 > bytes.length || bytes.readUInt32LE(localOff) !== 0x04034b50) {
			throw new Error(`zip entry '${wanted}' has no local header where its central directory says one would be`);
		}
		const dataAt = localOff + 30 + bytes.readUInt16LE(localOff + 26) + bytes.readUInt16LE(localOff + 28);
		if (dataAt + csize > bytes.length) {
			throw new Error(`zip entry '${wanted}' runs past the end of the archive`);
		}
		const raw = bytes.subarray(dataAt, dataAt + csize);
		const out = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: limit });
		if (out.length !== usize) {
			throw new Error(`zip entry '${wanted}' came out as ${out.length} bytes, not the ${usize} it declared`);
		}
		return out;
	}
	throw new Error(`no '${wanted}' entry in the archive`);
}

function findEndOfCentralDirectory(bytes: Buffer): number {
	// The record is 22 bytes plus a comment of at most 65 535, and the signature is
	// four little-endian bytes: the only honest way to find it is to look back.
	const floor = Math.max(0, bytes.length - 22 - 0xffff);
	for (let p = bytes.length - 22; p >= floor; p--) {
		if (bytes.readUInt32LE(p) === 0x06054b50) return p;
	}
	throw new Error("not a zip archive: no end-of-central-directory record in the last 64 KB");
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
 * Hand back the bytes, or the one program inside the archive.
 *
 * A `tar.gz` is listed before anything is written, because the entry names are the
 * only part of an untrusted file this code has to reason about: one top-level entry
 * called `wanted`, no absolute paths, no `..`. Extraction then goes into a fresh
 * temp directory whose `realpath` the result has to still be inside — GNU and BSD
 * tar both strip a leading `../` on their own, and this check is the reason we do
 * not have to trust them doing it.
 *
 * A `zip` never reaches any of that. It is read by `readZipEntry`, whose entry name
 * is only compared and never used as a path, so there is nothing to escape from.
 */
async function extract(bytes: Buffer, wanted: string, kind: Kind, limit: number): Promise<Buffer> {
	if (kind === "binary") return bytes;
	if (kind === "zip") return readZipEntry(bytes, wanted, limit);
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
	const platform = deps.platform ?? process.platform;
	const binDir = deps.binDir ?? defaultBinDir(env, platform);
	const key = `${name}|${configured}|${target}|${binDir}`;
	const running = inflight.get(key);
	if (running) return running;
	const job = resolveOnce(name, configured, sid, env, target, binDir, platform, deps).finally(() =>
		inflight.delete(key),
	);
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
	platform: string,
	deps: ObtainDeps,
): Promise<Resolved> {
	// An explicit path is the operator's answer to "where is it", so it is used as
	// given and a missing one is an error rather than a cue to download. Both
	// separators count: `C:\tools\dufs.exe` is a path on the one platform where a
	// backslash means that, and reading it as a bare name would send a machine that
	// said "never download" out to fetch bytes.
	if (configured.includes("/") || configured.includes("\\")) {
		if (!(await isExec(configured))) {
			throw new Error(
				`'${configured}' is not an executable file — a path in xfer.${name} is used as given, the bridge downloads nothing for one`,
			);
		}
		return { path: configured, installed: null };
	}

	const hit = await findOnPath(configured, env, platform);
	if (hit) return { path: hit, installed: null };

	const pin = (deps.pins ?? PINS)[name][target];
	if (!pin) {
		throw new Error(
			`no pinned ${name} build for ${target}: the bridge will not download bytes it cannot verify. Put '${configured}' on the host's PATH, or name a path in the config's xfer block`,
		);
	}

	// What the program is called on this platform's disk, and what the archive calls
	// its only entry — the same name, because the release publishes the entry under
	// the name the OS runs.
	const entry = exeName(configured, platform);
	const dest = join(binDir, entry);
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
		bin = await extract(bytes, entry, pin.kind, deps.maxBytes ?? MAX_BYTES);
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
		// The mode is a POSIX bit; on Windows both calls are accepted and ignored, and
		// what protects the file there is the directory's own ACL.
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
