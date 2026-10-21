import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { linkExtension } from "./harness.ts";

/**
 * Naming guard.
 *
 * The project is called a2mcp. It used to be called pi-a2a-ext, and the bridge
 * called itself a2a-bridge, which named the protocol this code does not
 * implement (no agent card, no task state machine, no contextId). A rename that
 * lives in one commit rots in the next one — the old spellings come back through
 * a copied doc line, a new probe, a hand-written `serverInfo`. This file is the
 * thing that notices.
 *
 * It matches FORMS, not the string "a2a": talking about A2A as the other protocol
 * is legitimate and docs/protocol.md does exactly that. What is not allowed is a
 * self-reference in the old shape — a hyphenated identifier, an env-var prefix, a
 * slash command, a package name.
 *
 * Weaker than a blanket ban by design, and paid for with the allowance table
 * below: `a2a-` has to be listed as a form to catch a tmp-directory prefix, and
 * that same form is what the two historical design-doc filenames look like.
 */

const root = resolve(import.meta.dir, "..");

const FORMS: { label: string; re: RegExp }[] = [
	{ label: "the bridge's own old name", re: /a2a-bridge/i },
	{ label: "the package's old name", re: /pi[-_]a2a[-_]ext/i },
	{ label: "the old env-var / tool prefix", re: /a2a_/i },
	{ label: "the old slash command", re: /\/a2a(?![\w./-])/ },
	{ label: "an a2a-prefixed identifier", re: /(?<![0-9a-z])a2a-[a-z0-9]/i },
	{ label: "the old name in prose", re: /a2a[\s_-]+(?:bridge|takeover|listening)/i },
	{ label: "the old package keyword", re: /"a2a"/ },
];

/**
 * Paths skipped outright. Two kinds. History that is not rewritten: the changelog
 * records what the thing used to be called, the brain belongs to its CLI, the
 * design drafts are named by their own filenames. And generated output: a lockfile
 * records the name of the directory it was made in (this checkout keeps
 * `pi_a2a_ext` on disk, which is a working directory, not a published name), and
 * the site's `dist`/`content` are rebuilt from the sources that are scanned here.
 */
const SKIP_PATHS = [
	"CHANGELOG.md",
	"LICENSE",
	"bun.lock",
	"node_modules",
	"__pycache__",
	".qoder",
	"brain",
	join("docs", "superpowers"),
	join("website", ".vitepress", "dist"),
	join("website", ".vitepress", "cache"),
	join("website", "content"),
	// The guard carries the old spellings as data — in FORMS and in the allowance
	// table — so it cannot also be one of the files scanned for them.
	join("test", "naming.test.ts"),
];

/**
 * Old names that survive on a live surface because the sentence is *about* the
 * old name. File-scoped, not line-scoped: an allowance here covers its whole
 * file, which is a real hole — it is accepted because these files only have one
 * reason each to spell the old name, and because an unused allowance fails the
 * test below, so the table cannot quietly grow stale.
 */
const ALLOWED: { file: string; text: string; why: string }[] = [
	// Migration instructions must say what to uninstall; the rest of the rename
	// history lives in the CHANGELOG, off the live surfaces.
	{ file: "README.md", text: "pi-a2a-ext", why: "the upgrade note names the entry to remove" },
	{ file: "README_ZN.md", text: "pi-a2a-ext", why: "the upgrade note names the entry to remove" },
	// Quoted history: the text being discussed is the assertion that was replaced.
	{ file: join("test", "hardening.ts"), text: "a2a_file_", why: "names the tool prefix that guard defended" },
	{ file: join("test", "install-probe.ts"), text: 'a2a_"', why: "quotes the assertion line it replaced" },
	{
		file: join("test", "install-probe.ts"),
		text: "a2a_*",
		why: "quotes the name space that assertion could not fail in",
	},
	{
		file: join("test", "install-probe.ts"),
		text: "pi-a2a-ext",
		why: "names the registration the incident left behind",
	},
	{
		file: join("test", "tree-probe.ts"),
		text: "pi_a2a_ext",
		why: "the absolute path of the checkout in the story it tells",
	},
	{ file: join("docs", "testing.md"), text: "a2a_file_", why: "names the tool prefix that guard defended" },
	// The two design drafts keep their filenames, so the site's sidebar links do too.
	{
		file: join("website", ".vitepress", "config.ts"),
		text: "a2a-mcp-bridge",
		why: "links a historical document by its filename",
	},
	// The same two documents, named by the scripts that copy and check them.
	{
		file: join("website", "scripts", "sync.mjs"),
		text: "a2a-mcp-bridge",
		why: "names a historical design document by its filename",
	},
	{
		file: join("website", "scripts", "render-check.mjs"),
		text: "a2a-mcp-bridge",
		why: "names a historical design document by its filename",
	},
	// The site's structured data keeps the old package name as an alternate name,
	// so a search for it still lands here.
	{
		file: join("website", ".vitepress", "config.ts"),
		text: "pi-a2a-ext",
		why: "the alternateName in the site's structured data",
	},
];

const SCAN_DIRS = ["src", "extensions", "test", "scripts", ".github", "docs", "website"];
const SCAN_FILES = ["package.json", "README.md", "README_ZN.md", "AGENTS.md", "BRAIN.md"];

/** A skip entry is a path, matched by whole segments wherever it appears. */
function skipped(rel: string): boolean {
	const segs = rel.split("/");
	return SKIP_PATHS.some((skip) => {
		const parts = skip.split("/");
		return segs.some((_, i) => parts.every((p, j) => segs[i + j] === p));
	});
}

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(resolve(root, dir))) {
		const rel = join(dir, name);
		if (skipped(rel)) continue;
		const st = statSync(resolve(root, rel));
		if (st.isDirectory()) walk(rel, out);
		else out.push(rel);
	}
	return out;
}

function scannedFiles(): string[] {
	const files = [...SCAN_FILES];
	for (const dir of SCAN_DIRS) walk(dir, files);
	return files;
}

describe("naming: nothing on a live surface calls itself the old name", () => {
	const files = scannedFiles();

	test("the scan surface is what it claims to be", () => {
		// A guard that scans nothing is green forever, so the surface is asserted
		// rather than trusted: every directory listed has files in it, and the
		// READMEs, the manifest and the site config are all in the list.
		for (const dir of SCAN_DIRS)
			expect(
				files.some((f) => f.startsWith(`${dir}/`)),
				dir,
			).toBe(true);
		for (const f of SCAN_FILES) expect(files, f).toContain(f);
		expect(files.length).toBeGreaterThan(40);
	});

	test("no live surface carries an old self-reference", () => {
		const findings: string[] = [];
		const used = new Map<string, number>();

		for (const rel of files) {
			const content = readFileSync(resolve(root, rel), "utf8");
			let redacted = content;
			for (const a of ALLOWED.filter((x) => x.file === rel)) {
				const parts = redacted.split(a.text).length - 1;
				if (parts > 0) {
					used.set(`${rel}::${a.text}`, parts);
					redacted = redacted.split(a.text).join("·".repeat(a.text.length));
				}
			}
			redacted.split("\n").forEach((line, i) => {
				for (const form of FORMS) {
					const m = line.match(form.re);
					if (m) findings.push(`${rel}:${i + 1}: ${form.label} — \`${m[0]}\` in: ${line.trim().slice(0, 100)}`);
				}
			});
		}

		// An allowance nobody uses is a hole kept open for nothing.
		const stale = ALLOWED.filter((a) => !used.has(`${a.file}::${a.text}`)).map(
			(a) => `${a.file}: ${a.text} (${a.why})`,
		);
		expect({ findings, stale }).toEqual({ findings: [], stale: [] });
	});
});

describe("naming: the load chain and the identity are one name", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		name?: string;
		pi?: { extensions?: string[] };
	};
	const NAME = manifest.name ?? "";

	test("every entry the manifest declares exists, and extensions/ declares nothing else", () => {
		const entries = manifest.pi?.extensions ?? [];
		expect(entries.length, "pi.extensions is the host's load switch").toBeGreaterThan(0);
		for (const entry of entries) expect(existsSync(resolve(root, entry)), `${entry} is a real file`).toBe(true);
		const onDisk = readdirSync(join(root, "extensions")).filter((f) => f.endsWith(".ts"));
		// A second file in extensions/ that the manifest does not name is dead code
		// that reads like an entry — and after a rename it may be the old one.
		expect(onDisk.sort()).toEqual(entries.map((e) => basename(e)).sort());
	});

	test("the probes link exactly what the manifest loads", () => {
		// harness.linkExtension() is what every real-host probe uses; if it ever
		// reads the entry name from somewhere else, the probes test a different
		// file than the host does.
		const dir = mkdtempSync(join(tmpdir(), "a2mcp-naming-"));
		try {
			linkExtension(dir);
			const linked = readdirSync(join(dir, "extensions"));
			expect(linked).toEqual([basename(manifest.pi?.extensions?.[0] ?? "")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the package name, the slash command and the MCP serverInfo name are the same word", () => {
		// v0.3.0 answered `initialize` as `omp-a2a-bridge` while the package was
		// `pi-a2a-ext` and the command was `/a2a` — three names for one thing, and
		// the rename only lands if nothing is left to drift back.
		expect(NAME).toBe("a2mcp");
		const entry = readFileSync(resolve(root, manifest.pi?.extensions?.[0] ?? ""), "utf8");
		const command = entry.match(/pi\.registerCommand\("([^"]+)"/)?.[1] ?? "";
		expect(command).toBe(NAME);
		const serverName = entry.match(/serverInfo:[^\n]*?name:\s*"([^"]*)"/)?.[1] ?? "";
		expect(serverName).toBe(NAME);
	});

	test("the protocol page quotes the same word in its sample response", () => {
		// A reader copies the `initialize` sample out of docs/protocol.md. The page
		// and the code each carried a name until now, and the version number in that
		// same object is why test/server.test.ts reads the page at all.
		const protocol = readFileSync(join(root, "docs", "protocol.md"), "utf8");
		const quoted = protocol.match(/"serverInfo":\s*\{[^}]*"name":\s*"([^"]*)"/)?.[1] ?? "";
		expect(quoted).toBe(NAME);
	});
});
