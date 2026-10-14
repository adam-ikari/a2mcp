/**
 * Repo-shape probe: no symlink may point at a path that only exists on the
 * machine that made it. Runs before `bun test`, in its own process, on purpose.
 *
 * Why it cannot be a test *inside* `bun test`: it was one, and the mutation
 * proved the guard useless in the case that matters. `hidden-plugin` was
 * committed by an over-broad `git add -A` in 59a5e60 — the commit that added
 * `harness.linkExtension()`, so it was a debugging leftover from the same
 * session. It pointed at `/home/gem/project/pi_a2a_ext`, the repo root
 * containing it, and nothing here could see it: `git status` was clean, every
 * check was green. Then the probe's own mutation (`ln -s ..`) produced this:
 *
 *     bun test test/tree.test.ts
 *     bun test v1.3.14 (0d9b296a)
 *     test/tree.test.ts:
 *     exit 1, 48 bytes, 10.3s at 98% cpu — no test names, no assertion
 *
 * The runner crawls the tree, hits its own loop, and dies before any test
 * reports. So a broken shape does not fail a check, it *deletes* the evidence.
 * This probe runs standalone and exits with a verdict, and CI puts it ahead of
 * `bun test` so the loop is named instead of swallowed.
 *
 * The rule is not "no symlinks". `.claude/skills/design-doc-mermaid` is a
 * tracked one and is legitimate — the skill manager materializes it pointing at
 * the committed `.agents/skills/design-doc-mermaid`, relatively, inside the
 * repo. Banning it would ban the repo's own convention. Three clauses instead:
 *
 *   1. absolute target          — not portable, and the shape that made the loop
 *   2. resolves outside root    — dangling on every other machine
 *   3. resolves to an ancestor  — a filesystem loop, by construction
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

// Dependency trees, VCS metadata, and build output. Deliberately does NOT skip
// `.agents` / `.claude` / `.qoder`: those hold the skill manager's artifacts, so
// they are exactly where an unmanaged link turns up — and the first version of
// this guard skipped them, which meant it never saw the one legitimate symlink
// and would equally have missed a bad one sitting beside it. A skip list that
// hides the subject is the vacuous-pass shape this repo keeps paying for.
const SKIP = new Set(["node_modules", ".git", "dist", "content"]);
const MAX_DEPTH = 12;
// Unreachable in practice (~500 tracked files, node_modules skipped). It exists
// so a walk that stops early says so instead of reporting a clean tree it never
// finished reading.
const MAX_ENTRIES = 50_000;

let failed = 0;
function check(cond: unknown, label: string, detail = ""): void {
	if (!cond) failed++;
	console.log(`${cond ? "OK  " : "FAIL"} shape ${label}${detail ? ` — ${detail}` : ""}`);
}

interface Link {
	/** Repo-relative path of the link itself. */
	rel: string;
	/** The link text, verbatim — absolute or relative, as stored. */
	target: string;
	/** Where the target actually points, resolved. */
	absolute: string;
	/** Repo-relative form of `absolute`. */
	resolvedRel: string;
}

/** Why this link is a portability or loop defect, or null when it is fine. */
function clause(link: Link): string | null {
	if (isAbsolute(link.target)) return "absolute target";
	if (link.resolvedRel.startsWith("..")) return `resolves outside the repo (${link.resolvedRel})`;
	// Does the target contain the link? Then following it re-enters the tree at
	// or above itself, which is the loop `find -L` refuses to walk. "" means the
	// target is the repo root, which contains every link in the repo.
	if (link.resolvedRel === "" || link.rel === link.resolvedRel || link.rel.startsWith(`${link.resolvedRel}/`)) {
		return `resolves to an ancestor of itself (${link.resolvedRel || "."})`;
	}
	return null;
}

function collect(dir: string, depth = 0): Link[] {
	if (depth > MAX_DEPTH) throw new Error(`walk exceeded depth ${MAX_DEPTH} at ${dir}`);
	const found: Link[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return found; // unreadable: not a link finding
	}
	for (const name of entries) {
		if (SKIP.has(name)) continue;
		visited++;
		if (visited > MAX_ENTRIES) throw new Error(`walk exceeded ${MAX_ENTRIES} entries at ${dir}`);
		const full = join(dir, name);
		const st = lstatSync(full);
		if (st.isSymbolicLink()) {
			const target = readlinkSync(full);
			const absolute = isAbsolute(target) ? target : resolve(dirname(full), target);
			found.push({ rel: relative(root, full), target, absolute, resolvedRel: relative(root, absolute) });
		} else if (st.isDirectory()) {
			found.push(...collect(full, depth + 1));
		}
	}
	return found;
}

let visited = 0;

const links = collect(root);
console.log(`repo shape: ${links.length} symlink(s), ${visited} entries walked\n`);

const broken = links.map((l) => ({ l, why: clause(l) })).filter((x) => x.why !== null);
check(
	broken.length === 0,
	"no symlink points outside the repo or at its own ancestor",
	broken.map((b) => `${b.l.rel} -> ${b.l.target} (${b.why})`).join("; "),
);

const dangling = links.filter((l) => !existsSync(l.absolute));
check(dangling.length === 0, "every symlink resolves", dangling.map((d) => `${d.rel} -> ${d.target}`).join("; "));

// The walk sees only this working copy, and existsSync only what is on this
// disk. This reads link text out of the index, so a link that was committed and
// then deleted locally — or that exists only in someone else's clone — is still
// reported. Skips when git cannot answer, the rule the sitemap probe follows.
let tracked: string[] = [];
try {
	tracked = execFileSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" })
		.split("\n")
		.filter((line) => line.startsWith("120000 "))
		.map((line) => line.slice(line.indexOf("\t") + 1));
} catch {
	console.log("(git unavailable — the tracked check is skipped)\n");
}
const trackedAbsolute = tracked.filter((p) => {
	try {
		return isAbsolute(execFileSync("git", ["cat-file", "-p", `:${p}`], { cwd: root, encoding: "utf8" }).trim());
	} catch {
		return false;
	}
});
check(trackedAbsolute.length === 0, "no tracked symlink has an absolute target", trackedAbsolute.join("; "));

if (failed) {
	console.error(`\ntree-probe: ${failed} check(s) failed`);
	process.exit(1);
}
console.log("\ntree-probe: repo shape OK");
