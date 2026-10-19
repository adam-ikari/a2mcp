/**
 * `src/obtain.ts` — the pinned fetch, the verification, and the install.
 *
 * What these tests can honestly claim: every hash in here is a hash of bytes the
 * test itself made, and the release host is a real local server rather than a stubbed
 * `fetch` (the house rule — this suite does not fake the transport, it moves it to
 * 127.0.0.1). The tarballs are packed by the system `tar` at run time, so the
 * listing-and-extracting path is the same one production takes. The zip is written
 * field by field by a fixture below, and the Windows branches are reached through the
 * `platform` seam — this is not a Windows machine, so the file-name shape is asserted,
 * not executed.
 *
 * What they cannot claim: that the pinned hashes in `src/obtain.ts` are the bytes
 * GitHub actually serves for those assets, dufs or cloudflared. That is real-machine
 * work and it is `bun run test:obtain`'s job; the one thing pinned here is the URL
 * shape, so a typo in a tag or an asset name fails a unit test instead of a user's
 * share.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { auditStart } from "../src/audit.ts";
import {
	defaultBinDir,
	type ObtainDeps,
	obtainLedgerPath,
	type Pin,
	pinsFor,
	readZipEntry,
	resolveBinary,
	targetKey,
} from "../src/obtain.ts";

const work = mkdtempSync(join(tmpdir(), "a2mcp-obtain-"));
const auditFile = join(work, "audit.log");
process.env.A2MCP_AUDIT = auditFile;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const textOf = async (p: Promise<{ path: string }>) => (await p).path;

/** The bytes a "binary" is made of in these tests: a bun script, like the xfer stub. */
const PAYLOAD = `#!/usr/bin/env bun
console.log("stub binary");
`;
const payloadDir = join(work, "payload");
mkdirSync(payloadDir, { recursive: true });
writeFileSync(join(payloadDir, "dufs"), PAYLOAD, { mode: 0o755 });

/** Pack `entries` out of `root` the way a release asset is packed: with real tar. */
function tarball(root: string, entries: string[]): Buffer {
	const out = join(work, `t-${Math.random().toString(36).slice(2)}.tar.gz`);
	execFileSync("tar", ["-czf", out, "-C", root, ...entries]);
	return readFileSync(out);
}

const good = tarball(payloadDir, ["dufs"]);

/**
 * A single-entry zip, written out field by field.
 *
 * Built by hand because the alternative is circular: `unzip` is not a precondition
 * of this suite the way `tar` is, and a fixture packed by some other tool would
 * still leave `readZipEntry`'s own offsets unexamined. The layout is the format's —
 * local header, deflated data, central directory, end record, little-endian
 * throughout — over bytes `deflateRawSync` produced, with the CRC the format asks
 * for so the fixture is a legitimate archive rather than one only this reader
 * tolerates.
 */
function zipFixture(name: string, data: Buffer, o: { method?: number; usize?: number } = {}): Buffer {
	const method = o.method ?? 8;
	const payload = method === 0 ? data : deflateRawSync(data);
	const crc = crc32(data);
	const usize = o.usize ?? data.length;
	const nm = Buffer.from(name, "utf8");

	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(0, 6);
	local.writeUInt16LE(method, 8);
	local.writeUInt16LE(0, 10);
	local.writeUInt16LE(0, 12);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(payload.length, 18);
	local.writeUInt32LE(usize, 22);
	local.writeUInt16LE(nm.length, 26);
	local.writeUInt16LE(0, 28);

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(0, 8); // flags: not encrypted
	central.writeUInt16LE(method, 10);
	central.writeUInt32LE(crc, 14);
	central.writeUInt32LE(payload.length, 20);
	central.writeUInt32LE(usize, 24);
	central.writeUInt16LE(nm.length, 28);
	central.writeUInt16LE(0, 30);
	central.writeUInt16LE(0, 32);
	central.writeUInt32LE(0, 42); // the entry starts at offset 0

	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8);
	eocd.writeUInt16LE(1, 10);
	eocd.writeUInt32LE(46 + nm.length, 12);
	eocd.writeUInt32LE(30 + nm.length + payload.length, 16);

	return Buffer.concat([local, nm, payload, central, nm, eocd]);
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[i] = c >>> 0;
	}
	return t;
})();

function crc32(b: Buffer): number {
	let c = 0xffffffff;
	for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

// ── the fake release host ────────────────────────────────────────────────────────
interface Plan {
	status?: number;
	bytes?: Buffer;
	chunkDelayMs?: number;
	chunkBytes?: number;
	totalBytes?: number;
}
let plan: Plan = {};
let hits: string[] = [];

const stream = (p: Required<Omit<Plan, "status" | "bytes">>) =>
	new Response(
		new ReadableStream({
			async start(ctrl) {
				for (let sent = 0; sent < p.totalBytes; sent += p.chunkBytes) {
					await Bun.sleep(p.chunkDelayMs);
					ctrl.enqueue(new Uint8Array(Math.min(p.chunkBytes, p.totalBytes - sent)));
				}
				ctrl.close();
			},
		}),
	);

let base = "";
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => {
			const path = new URL(req.url).pathname;
			hits.push(path);
			if (plan.status) return new Response("not found", { status: plan.status });
			if (plan.bytes) return new Response(new Uint8Array(plan.bytes));
			return stream({
				chunkDelayMs: plan.chunkDelayMs ?? 5,
				chunkBytes: plan.chunkBytes ?? 64 * 1024,
				totalBytes: plan.totalBytes ?? 2 * 1024 * 1024,
			});
		},
	});
	base = `http://127.0.0.1:${server.port}/`;
});

afterAll(() => {
	server?.stop(true);
	delete process.env.A2MCP_AUDIT;
	rmSync(work, { recursive: true, force: true });
});

const pin = (asset: string, bytes: Buffer, kind: Pin["kind"] = "tar.gz"): Pin => ({
	tag: "v9.9.9",
	version: "9.9.9",
	asset,
	kind,
	sha256: sha256(bytes),
});

/**
 * Deps with every seam already pointed at this test's own temp paths and fake host.
 * A fresh `bin-<n>` per call, because the tests below include "nothing was written",
 * and that claim means nothing if they share a directory with one that wrote.
 */
let seq = 0;
function deps(
	over: Partial<ObtainDeps> & { pin?: Pin; realPins?: boolean } = {},
): ObtainDeps & { binDir: string; ledger: string } {
	const { pin: p, realPins, binDir: wantBin, ledger: wantLedger, ...rest } = over;
	const id = `${++seq}`;
	const binDir = wantBin ?? join(work, `bin-${id}`);
	const ledger = wantLedger ?? join(work, `ledger-${id}.json`);
	return {
		env: {},
		binDir,
		ledger,
		target: "test-target",
		base,
		fetchImpl: globalThis.fetch,
		// `realPins` leaves the key off entirely, which is the only way to put the table
		// in `src/obtain.ts` under test.
		...(realPins
			? {}
			: {
					pins: p ? { dufs: { "test-target": p }, cloudflared: { "test-target": p } } : { dufs: {}, cloudflared: {} },
				}),
		...rest,
	};
}

const lines = () => (existsSync(auditFile) ? readFileSync(auditFile, "utf8").split("\n").filter(Boolean) : []);
async function flush(): Promise<void> {
	const marker = `obtain-sentinel-${Math.random()}`;
	await auditStart(marker, "flush", "flush", {}, process.env);
	if (!lines().some((l) => l.includes(marker))) throw new Error("audit record missing right after its own await");
}

const dufs = (over: ObtainDeps = {}, configured = "dufs") => resolveBinary("dufs", configured, "sid-obtain", over);

describe("fetching a pinned build", () => {
	test("installs the archive's binary, records the install, and says it did", async () => {
		plan = { bytes: good };
		const d = deps({ pin: pin("dufs-9.9.9.tar.gz", good) });
		const r = await dufs(d);
		expect(r.path).toBe(join(d.binDir, "dufs"));
		expect(r.installed).toEqual({
			name: "dufs",
			version: "9.9.9",
			target: "test-target",
			sha256: sha256(good),
			dest: join(d.binDir, "dufs"),
		});
		expect(readFileSync(r.path)).toEqual(Buffer.from(PAYLOAD));
		expect(existsSync(r.path) && (readFileSync(r.path).length ?? 0) > 0).toBe(true);

		const ledger = JSON.parse(readFileSync(d.ledger, "utf8")) as Record<string, { sha256: string }>;
		expect(ledger[r.path]?.sha256).toBe(sha256(Buffer.from(PAYLOAD)));

		await flush();
		// `args` is stored as a serialized string, so its quotes arrive escaped: match
		// the word, not the JSON shape.
		const rec = lines().filter((l) => l.includes("install"));
		expect(rec.length).toBe(1);
		expect(rec[0]).toContain("9.9.9");
	});

	test("a `binary` asset is written as the bytes it is", async () => {
		plan = { bytes: Buffer.from(PAYLOAD) };
		const d = deps({ pin: pin("dufs-9.9.9", Buffer.from(PAYLOAD), "binary") });
		const r = await dufs(d, "dufs");
		expect(readFileSync(r.path)).toEqual(Buffer.from(PAYLOAD));
	});

	test("bytes that do not match the pinned sha256 are refused and nothing lands", async () => {
		plan = { bytes: good };
		const d = deps({ pin: pin("dufs-9.9.9.tar.gz", Buffer.from("other bytes entirely")) });
		await expect(dufs(d)).rejects.toThrow(/sha256 .* not the pinned .* refusing to install/);
		expect(existsSync(d.binDir)).toBe(false);
		await flush();
		expect(
			lines()
				.filter((l) => l.includes("install"))
				.at(-1),
		).toContain('"isError":true');
	});

	test("an archive without the binary at its top level is refused by name", async () => {
		const deep = join(work, "deep");
		mkdirSync(join(deep, "sub"), { recursive: true });
		writeFileSync(join(deep, "sub", "dufs"), PAYLOAD);
		const bytes = tarball(deep, ["sub"]);
		plan = { bytes };
		const d = deps({ pin: pin("nested.tar.gz", bytes) });
		await expect(dufs(d)).rejects.toThrow(/no 'dufs' at the top level of the archive/);
	});

	test("an archive member that points outside the staging directory is refused", async () => {
		const slip = join(work, "slip");
		mkdirSync(slip, { recursive: true });
		symlinkSync(join(work, "escape-target"), join(slip, "dufs"));
		writeFileSync(join(work, "escape-target"), "not a binary\n");
		const bytes = tarball(slip, ["dufs"]);
		plan = { bytes };
		const d = deps({ pin: pin("slip.tar.gz", bytes) });
		await expect(dufs(d)).rejects.toThrow(/unpacked outside the staging directory/);
		// The symlink's target was never touched, which is the whole point of the check.
		expect(readFileSync(join(work, "escape-target"), "utf8")).toBe("not a binary\n");
	});

	test("an answer that is not 2xx is the release host's own failure", async () => {
		plan = { status: 404 };
		const d = deps({ pin: pin("gone.tar.gz", good) });
		await expect(dufs(d)).rejects.toThrow(/answered HTTP 404/);
	});

	test("a body bigger than the cap is cut off, not buffered", async () => {
		plan = { chunkDelayMs: 0, chunkBytes: 64 * 1024, totalBytes: 4 * 1024 * 1024 };
		const d = deps({ pin: pin("big.tar.gz", good), maxBytes: 200_000 });
		await expect(dufs(d)).rejects.toThrow(/larger than the 200000 byte cap/);
	});

	test("a body that stops moving hits the deadline instead of the caller", async () => {
		plan = { chunkDelayMs: 60, chunkBytes: 16, totalBytes: 8 * 1024 * 1024 };
		const d = deps({ pin: pin("slow.tar.gz", good), timeoutMs: 300 });
		await expect(dufs(d)).rejects.toThrow(/timed out|timeout|aborted/i);
	});

	test("two concurrent shares fetch once", async () => {
		// Both calls start before the first one awaits anything, so the second must ride
		// the first's promise instead of racing it onto the same file.
		plan = { bytes: good };
		const d = deps({ pin: pin("race.tar.gz", good) });
		hits = [];
		const [a, b] = await Promise.all([dufs(d), dufs(d)]);
		expect(hits.length).toBe(1);
		expect(a.path).toBe(b.path);
		expect(a.installed).toEqual(b.installed);
	});

	test("no pin row for this target means no download at all", async () => {
		hits = [];
		plan = { bytes: good };
		await expect(dufs(deps())).rejects.toThrow(/no pinned dufs build for test-target/);
		expect(hits.length).toBe(0);
	});
});

describe("what the bridge does not fetch", () => {
	test("a name found on PATH is used as it stands", async () => {
		const onPath = join(work, "pathdir");
		mkdirSync(onPath, { recursive: true });
		writeFileSync(join(onPath, "dufs"), PAYLOAD, { mode: 0o755 });
		hits = [];
		plan = { bytes: good };
		const d = deps({ pin: pin("dufs-9.9.9.tar.gz", good), env: { PATH: onPath } });
		const r = await dufs(d);
		expect(r.path).toBe(join(onPath, "dufs"));
		expect(r.installed).toBe(null);
		expect(hits.length).toBe(0);
	});

	test("an explicit path is used verbatim, and a missing one says it will not download", async () => {
		const d = deps({ pin: pin("dufs-9.9.9.tar.gz", good) });
		expect(await textOf(dufs(d, join(payloadDir, "dufs")))).toBe(join(payloadDir, "dufs"));
		await expect(dufs(d, join(payloadDir, "nothing-here"))).rejects.toThrow(
			/is used as given, the bridge downloads nothing/,
		);
	});

	test("a file already at the install path that is not ours is reported, not overwritten", async () => {
		const binDir = join(work, "foreign-bin");
		mkdirSync(binDir, { recursive: true });
		const dest = join(binDir, "dufs");
		writeFileSync(dest, "somebody else's dufs\n", { mode: 0o755 });
		hits = [];
		plan = { bytes: good };
		const d = deps({ pin: pin("dufs-9.9.9.tar.gz", good), binDir, ledger: join(work, "empty-ledger.json") });
		await expect(dufs(d)).rejects.toThrow(
			new RegExp(`is not the build this bridge installs .+ ${sha256(readFileSync(dest))}`),
		);
		expect(readFileSync(dest, "utf8")).toBe("somebody else's dufs\n");
		expect(hits.length).toBe(0);
	});

	test("a build this bridge installed is reused without a second download", async () => {
		plan = { bytes: good };
		const binDir = join(work, "reuse-bin");
		const ledger = join(work, "reuse-ledger.json");
		const first = await dufs(deps({ pin: pin("dufs-9.9.9.tar.gz", good), binDir, ledger }));
		expect(first.installed).not.toBe(null);
		hits = [];
		const second = await dufs(deps({ pin: pin("dufs-9.9.9.tar.gz", good), binDir, ledger }));
		expect(second.path).toBe(first.path);
		expect(second.installed).toBe(null);
		expect(hits.length).toBe(0);
	});
});

describe("the shape Windows insists on", () => {
	test("a zip's one entry becomes the installed file, named the way Windows runs it", async () => {
		const zip = zipFixture("dufs.exe", Buffer.from(PAYLOAD));
		plan = { bytes: zip };
		const d = deps({ pin: pin("dufs-9.9.9.zip", zip, "zip"), platform: "win32" });
		const r = await dufs(d);
		expect(r.path).toBe(join(d.binDir, "dufs.exe"));
		expect(readFileSync(r.path)).toEqual(Buffer.from(PAYLOAD));
	});

	test("readZipEntry returns deflate bytes, and stored bytes when that is how they are kept", () => {
		const data = Buffer.from("dufs on windows ".repeat(400));
		expect(readZipEntry(zipFixture("dufs.exe", data), "dufs.exe", 1 << 20)).toEqual(data);
		expect(readZipEntry(zipFixture("dufs.exe", data, { method: 0 }), "dufs.exe", 1 << 20)).toEqual(data);
	});

	test("an entry is chosen by its exact name, and a near miss is not close enough", () => {
		const z = zipFixture("dufs.exe", Buffer.from(PAYLOAD));
		expect(() => readZipEntry(z, "dufs", 1 << 20)).toThrow(/no 'dufs' entry in the archive/);
	});

	test("a compression method this reader does not implement is a refusal, not a guess", () => {
		const z = zipFixture("dufs.exe", Buffer.from(PAYLOAD), { method: 12 });
		expect(() => readZipEntry(z, "dufs.exe", 1 << 20)).toThrow(
			/uses compression method 12; only stored \(0\) and deflate \(8\) are read/,
		);
	});

	test("an entry declaring more than the cap is refused before a single byte is unpacked", () => {
		const z = zipFixture("dufs.exe", Buffer.alloc(1000), { usize: 9_999_999 });
		expect(() => readZipEntry(z, "dufs.exe", 1024)).toThrow(/declares 9999999 bytes, over the 1024 byte cap/);
	});

	test("output that is not the declared length is a refusal", () => {
		const z = zipFixture("dufs.exe", Buffer.from(PAYLOAD), { usize: Buffer.byteLength(PAYLOAD) + 7 });
		expect(() => readZipEntry(z, "dufs.exe", 1 << 20)).toThrow(/came out as \d+ bytes, not the \d+ it declared/);
	});

	test("bytes that are not a zip have no end record to find", () => {
		expect(() => readZipEntry(Buffer.from("this is not an archive"), "dufs.exe", 1 << 20)).toThrow(
			/no end-of-central-directory/,
		);
	});

	test("a bare name is found through PATHEXT, without asking the release host", async () => {
		const dir = join(work, "pathext-bin");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "dufs.EXE"), PAYLOAD, { mode: 0o755 });
		plan = { status: 404 };
		const before = hits.length;
		const d = deps({ pin: pin("dufs-9.9.9.zip", Buffer.from("unused"), "zip"), platform: "win32", env: { PATH: dir } });
		const r = await dufs(d);
		expect(r.path).toBe(join(dir, "dufs.EXE"));
		expect(r.installed).toBe(null);
		expect(hits.length).toBe(before);
	});

	test("a backslash is a path on Windows, and a path is never downloaded", async () => {
		plan = { status: 404 };
		const before = hits.length;
		const d = deps({
			pin: pin("dufs-9.9.9.zip", Buffer.from("unused"), "zip"),
			platform: "win32",
			env: { PATH: join(work, "definitely-empty") },
		});
		await expect(dufs(d, "C:\\tools\\dufs.exe")).rejects.toThrow(/is not an executable file/);
		expect(hits.length).toBe(before);
	});

	test("the Windows install directory is under LOCALAPPDATA, not under a unix home", () => {
		const appdata = "C:\\Users\\adam\\AppData\\Local";
		expect(defaultBinDir({ LOCALAPPDATA: appdata }, "win32")).toBe(join(appdata, "a2mcp", "bin"));
		expect(defaultBinDir({ HOME: "/home/adam" }, "linux")).toBe(join("/home/adam", ".local", "bin"));
		// Windows with no `LOCALAPPDATA` in the injected env: the profile answers, and
		// the layout under it is still the bridge's own rather than a unix one.
		expect(defaultBinDir({}, "win32")).toBe(join(homedir(), "a2mcp", "bin"));
	});
});

describe("the table production actually uses", () => {
	test("every dufs row is a well-formed pin, and the five targets are all there", () => {
		const rows = pinsFor("dufs");
		expect(Object.keys(rows).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
		for (const [target, p] of Object.entries(rows)) {
			// A 63-character literal is a pin that can never match, and reads as a network failure.
			expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(p.tag).toBe(`v${p.version}`);
			expect(p.asset).toContain(p.version);
			// Windows is the one platform dufs publishes as a zip, and `kind` is what
			// tells the unpack step which reader to use.
			expect(p.kind).toBe(target === "win32-x64" ? "zip" : "tar.gz");
			expect(target.endsWith("-x64") || target.endsWith("-arm64")).toBe(true);
		}
	});

	test("every cloudflared row is a well-formed pin, and the five targets are all there", () => {
		const rows = pinsFor("cloudflared");
		expect(Object.keys(rows).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
		for (const p of Object.values(rows)) {
			expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
			// cloudflared's tags are the date-version itself, with no `v` to strip — the
			// tag goes into the URL verbatim, so a typo here is a 404 at share time.
			expect(p.tag).toBe(p.version);
			expect(p.kind).toBe(p.asset.endsWith(".tgz") ? "tar.gz" : "binary");
			// Linux publishes the bare executable, macOS publishes it inside an archive
			// whose only entry is the name the bridge then spawns, Windows publishes the
			// executable with the extension on it.
			if (p.kind === "tar.gz") expect(p.asset).toMatch(/^cloudflared-darwin-(amd64|arm64)\.tgz$/);
			else expect(p.asset).toMatch(/^cloudflared-(linux-(amd64|arm64)|windows-amd64\.exe)$/);
		}
	});

	test("there is no half-pinned Windows target", () => {
		// dufs publishes an aarch64 Windows build and cloudflared does not, so a
		// `win32-arm64` row would be a share that gets one binary and fails at the
		// other. Both tables answer nothing for that target, which is the honest
		// shape: the `no pinned build` message says what is missing.
		expect(pinsFor("dufs")["win32-arm64"]).toBeUndefined();
		expect(pinsFor("cloudflared")["win32-arm64"]).toBeUndefined();
	});

	test("the ledger lives where the docs say it does", () => {
		expect(obtainLedgerPath({})).toMatch(/a2mcp\.installs\.json$/);
		expect(obtainLedgerPath({ A2MCP_INSTALLS: join(work, "elsewhere.json") })).toBe(join(work, "elsewhere.json"));
	});

	test("a dufs download asks the release host for the tagged asset, not for `latest`", async () => {
		// No `pins` in deps: the real table builds the real URL, and the fake host only
		// reports which path it was asked for.
		plan = { status: 404 };
		hits = [];
		const t = targetKey();
		const assetByTarget: Record<string, string> = {
			"linux-x64": "dufs-v0.46.0-x86_64-unknown-linux-musl.tar.gz",
			"linux-arm64": "dufs-v0.46.0-aarch64-unknown-linux-musl.tar.gz",
			"darwin-x64": "dufs-v0.46.0-x86_64-apple-darwin.tar.gz",
			"darwin-arm64": "dufs-v0.46.0-aarch64-apple-darwin.tar.gz",
			"win32-x64": "dufs-v0.46.0-x86_64-pc-windows-msvc.zip",
		};
		if (!assetByTarget[t]) return; // an unusual host, not a broken table
		const d = deps({ realPins: true, target: t, env: { PATH: join(work, "definitely-empty") } });
		await expect(dufs(d)).rejects.toThrow(/answered HTTP 404/);
		expect(hits[0]).toBe(`/v0.46.0/${assetByTarget[t]}`);
	});

	test("a cloudflared download asks for its tag the way its releases are actually laid out", async () => {
		// The tag is in the URL path and the asset is not versioned, so both halves of
		// this URL come from the table alone. A 404 here is a share that never opens.
		plan = { status: 404 };
		hits = [];
		const t = targetKey();
		const assetByTarget: Record<string, string> = {
			"linux-x64": "cloudflared-linux-amd64",
			"linux-arm64": "cloudflared-linux-arm64",
			"darwin-x64": "cloudflared-darwin-amd64.tgz",
			"darwin-arm64": "cloudflared-darwin-arm64.tgz",
		};
		if (!assetByTarget[t]) return;
		const d = deps({ realPins: true, target: t, env: { PATH: join(work, "definitely-empty") } });
		await expect(resolveBinary("cloudflared", "cloudflared", "sid-obtain", d)).rejects.toThrow(/answered HTTP 404/);
		expect(hits[0]).toBe(`/2026.10.1/${assetByTarget[t]}`);
	});
});
