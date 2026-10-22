/**
 * Headless render check: does the mermaid diagram actually become an inline
 * <svg> in a browser?
 *
 * A green `vitepress build` does NOT prove this — the diagram is rendered
 * client-side, so a broken component ships a blank box that only a real
 * browser load can catch. This is the probe that says so.
 *
 * Run after `bun run build`:  node scripts/render-check.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES, sourcesOf } from "./pages.mjs";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(SITE, ".vitepress", "dist");
const MIME = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".json": "application/json",
	".txt": "text/plain",
};

// VitePress serves this site at a base path on GitHub Pages (e.g. /a2mcp/),
// where every asset URL is prefixed. The probe has to speak whatever base the
// build used, or the page loads its HTML but 404s on the entry JS and nothing
// hydrates — which looks exactly like a broken diagram.
const BASE = (() => {
	const html = readFileSync(join(DIST, "index.html"), "utf8");
	const m = html.match(/(?:src|href)="(\/[^"/]+\/)assets\//);
	return m ? m[1] : "/";
})();

// cleanUrls: VitePress writes intro.html but serves it at /intro, so an
// extensionless request has to try the .html file. Getting this wrong makes
// the probe serve "not found" and report a false failure.
const srv = createServer((req, res) => {
	let path = decodeURIComponent(req.url.split("?")[0]);
	if (BASE !== "/" && path.startsWith(BASE)) path = path.slice(BASE.length - 1);
	const direct = join(DIST, path);
	const file =
		existsSync(direct) && statSync(direct).isDirectory()
			? join(direct, "index.html")
			: existsSync(`${direct}.html`)
				? `${direct}.html`
				: direct;
	if (!existsSync(file) || !statSync(file).isFile()) {
		// Serve the real 404 page, as GitHub Pages does, so the control request
		// below distinguishes "browser works" from "browser returned nothing".
		const notFound = join(DIST, "404.html");
		res.writeHead(404, { "content-type": "text/html" });
		return res.end(existsSync(notFound) ? readFileSync(notFound) : "not found");
	}
	res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
	res.end(readFileSync(file));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

// The binary is named differently everywhere: `chromium-browser` on this
// machine, `chromium` on Debian-ish systems, and GitHub's runner images ship
// Google Chrome under /opt/hostedtoolcache — which is not on PATH-lookup's
// usual prefixes, so a hardcoded /usr/bin scan misses it entirely. Search the
// paths each of them actually lives in, and let PATH decide too.
const CANDIDATE_DIRS = [
	"/usr/bin",
	"/usr/local/bin",
	"/opt/google/chrome",
	"/opt/hostedtoolcache/stable/google-chrome",
	"/snap/bin",
];
const BROWSER =
	process.env.CHROME ||
	["google-chrome", "chromium-browser", "chromium", "chrome"].find((bin) =>
		[...CANDIDATE_DIRS.map((d) => `${d}/${bin}`), bin].some((p) => existsSync(p)),
	);
if (!BROWSER) {
	console.error(
		"render-check: no chrome/chromium binary found (tried chromium-browser, chromium, google-chrome).\n" +
			"  set CHROME=/path/to/binary, or skip this check.",
	);
	process.exit(1);
}

function dumpDom(path) {
	return new Promise((resolve) => {
		const proc = spawn(BROWSER, [
			"--headless",
			"--no-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			`--user-data-dir=/tmp/vp-render-check-${process.pid}-${path.replace(/\W/g, "")}`,
			"--dump-dom",
			"--virtual-time-budget=15000",
			`http://127.0.0.1:${port}${BASE.slice(0, -1)}${path}`,
		]);
		let dom = "";
		proc.stdout.on("data", (d) => (dom += d));
		proc.on("close", () => resolve(dom));
		// A wrong CHROME (or a binary that cannot exec) throws ENOENT/EACCES as an
		// unhandled 'error' event, which prints a Node stack and hides the cause.
		proc.on("error", (err) => {
			console.error(`render-check: cannot run ${BROWSER}: ${err.message}`);
			process.exit(1);
		});
		setTimeout(() => {
			proc.kill();
			resolve(dom);
		}, 90000);
	});
}

// Pages carrying a ```mermaid fence, each with a label that must survive into
// the rendered SVG. mermaid entity-encodes non-ASCII, so decode before looking.
const PAGES_WITH_DIAGRAM = [
	{ path: "/start", label: "远程 omp" },
	{ path: "/protocol", label: "受控端 TUI" },
];
// A page with no diagram: it must load clean and carry no stray diagram.
const PLAIN = "/testing";

/** Decode mermaid's numeric entities and pull out CJK label text from the SVG. */
function diagramText(dom) {
	const start = dom.indexOf('<div class="mermaid">');
	const end = dom.indexOf("</svg>", start);
	if (start < 0 || end < 0) return "";
	const svg = dom.slice(start, end).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
	return [...svg.matchAll(/>([^<>]{1,60})</g)].map((m) => m[1]).join(" ");
}

let failed = 0;
// Control: a page with no JavaScript at all. If this comes back empty, the
// browser or the static server is the problem and every diagram result below is
// meaningless — say that instead of reporting three phantom diagram failures.
{
	const control = await dumpDom("/__no_such_page__");
	const ok = control.length > 0 && control.includes("Not Found");
	if (!ok) {
		console.error(
			`render-check: harness is broken (control page returned ${control.length}B). ` +
				"The browser or the static server did not run, so the diagram results below prove nothing.",
		);
		process.exit(2);
	}
	console.log(`OK   control    browser + static server respond (${control.length}B)\n`);
}

for (const { path, label } of PAGES_WITH_DIAGRAM) {
	const dom = await dumpDom(path);
	const hasSvg = /<div class="mermaid">[\s\S]*?<svg[\s\S]*?<\/svg>/.test(dom);
	const text = diagramText(dom);
	// A diagram can render as an empty SVG shell (markers and a viewBox but no
	// nodes) if the component breaks, so assert on real label text, not on <svg>.
	const hasLabel = text.includes(label);
	// Scoped to the diagram on purpose: protocol.md documents the JSON-RPC error
	// code "parse error" in its own prose, so a whole-page scan false-positives
	// on a page whose diagram is fine.
	const err = /Syntax error|Parse error|mermaid version/i.test(text);
	const ok = dom.length > 5000 && hasSvg && hasLabel && !err;
	if (!ok) failed++;
	console.log(
		`${ok ? "OK  " : "FAIL"} ${path.padEnd(10)} dom=${String(dom.length).padStart(6)}B  ` +
			`svg=${hasSvg}  label(${label})=${hasLabel}  parseError=${err}`,
	);
	if (!ok && !hasSvg) {
		const m = dom.match(/<div class="mermaid">[\s\S]{0,160}/);
		if (m) console.log(`      got: ${m[0].slice(0, 160)}`);
		else console.log("      got: no .mermaid div at all — component never mounted");
	}
}

const plain = await dumpDom(PLAIN);
const plainOk = plain.length > 5000 && !/<div class="mermaid">/.test(plain);
if (!plainOk) failed++;
console.log(
	`${plainOk ? "OK  " : "FAIL"} ${PLAIN.padEnd(10)} dom=${plain.length}B  no stray diagram=${!/<div class="mermaid">/.test(plain)}`,
);

srv.close();

/*
 * Head-tag checks, read straight from the built HTML. These guard a failure
 * mode that no build error reports: a tag that is emitted but wrong. The
 * JSON-LD one is not hypothetical — it shipped for a whole release with
 * `innerHTML` passed as an attribute, so the <script> body was empty and every
 * crawler read zero structured data while the tag looked present in review.
 */
const headChecks = [];
const titles = new Map();
const descriptions = new Map();
// The page list comes from the map the site is built from, not from a list
// written here: a page added to pages.mjs and forgotten here would be checked
// by nothing, and a page removed from the map would still be checked here.
for (const entry of PAGES) {
	const file = entry.path === "" ? "index.html" : `${entry.path}.html`;
	const html = readFileSync(join(DIST, file), "utf8");
	const page = entry.path;

	const title = html.match(/<title>([^<]+)<\/title>/)?.[1] ?? "";
	const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
	const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
	const ogUrl = html.match(/property="og:url" content="([^"]+)"/)?.[1];
	const ogImage = html.match(/property="og:image" content="([^"]+)"/)?.[1];
	const ogType = html.match(/property="og:type" content="([^"]+)"/)?.[1];
	const card = html.match(/name="twitter:card" content="([^"]+)"/)?.[1];
	const robots = html.match(/<meta name="robots" content="([^"]+)"/)?.[1] ?? "";
	const logoAlt = html.match(/<img class="VPImage logo"[^>]*\balt="([^"]*)"/)?.[1] ?? "";
	const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;

	// Every JSON-LD block must parse. The first one is the page's primary node;
	// the second is what the page adds on top of it (the software on the home
	// page, the breadcrumb on an article).
	const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const parsed = [];
	for (const raw of blocks) {
		try {
			parsed.push(JSON.parse(raw));
		} catch {
			parsed.push(null);
		}
	}
	const ld = parsed[0];
	const extra = parsed[1];
	const ldValid = parsed.length === 2 && parsed.every(Boolean) && ld["@context"] === "https://schema.org";

	// og:image must be a raster format: Twitter/X, Facebook and Slack all drop
	// an SVG, so the card silently never appears.
	const raster = /\.(png|jpe?g|gif|webp)$/i.test(ogImage ?? "");
	const isHome = entry.path === "";
	const expectedType = isHome ? "WebSite" : "TechArticle";
	const expectedExtra = isHome ? "SoftwareApplication" : "BreadcrumbList";

	titles.set(title, [...(titles.get(title) ?? []), page]);
	descriptions.set(description, [...(descriptions.get(description) ?? []), page]);

	headChecks.push(
		[Boolean(title) && title.includes("a2mcp"), `${page}: title names the site (${title})`],
		[title.length >= 10 && title.length <= 60, `${page}: title is 10-60 chars (${title.length})`],
		// Chinese characters take roughly twice the width of Latin ones, so a
		// description written for a Chinese SERP lands near 80, not 150-160.
		// The bound is characters, not display width; 120 is the upper guard.
		[
			description.length >= 40 && description.length <= 120,
			`${page}: description is 40-120 chars (${description.length})`,
		],
		[Boolean(canonical) && canonical === ogUrl, `${page}: canonical matches og:url`],
		[raster, `${page}: og:image is raster (${ogImage?.split("/").pop() ?? "missing"})`],
		[card === "summary_large_image", `${page}: twitter:card (${card})`],
		[Boolean(ogType), `${page}: og:type (${ogType})`],
		[
			robots.includes("index") && robots.includes("max-image-preview:large"),
			`${page}: robots allows indexing and large previews`,
		],
		[logoAlt.length > 0, `${page}: logo has alt text (${logoAlt || "empty"})`],
		[h1Count === 1, `${page}: exactly one h1 (${h1Count})`],
		[
			ldValid && ld["@type"] === expectedType,
			`${page}: JSON-LD parses as ${expectedType} (got ${ld?.["@type"] ?? "unparseable"})`,
		],
		[
			extra?.["@type"] === expectedExtra,
			`${page}: JSON-LD carries ${expectedExtra} (got ${extra?.["@type"] ?? "missing"})`,
		],
	);
}
for (const [label, seen] of [
	["titles", titles],
	["descriptions", descriptions],
]) {
	const dupes = [...seen].filter(([, pages]) => pages.length > 1);
	headChecks.push([
		dupes.length === 0,
		`${label} unique across ${seen.size} pages${dupes.length ? `: ${dupes.map(([v, p]) => `${p.join("/")} share "${v.slice(0, 30)}"`).join("; ")}` : ""}`,
	]);
}
{
	const notFound = readFileSync(join(DIST, "404.html"), "utf8");
	headChecks.push([
		/<meta name="robots" content="[^"]*noindex/.test(notFound) &&
			!notFound.includes('rel="canonical"') &&
			!notFound.includes("application/ld+json"),
		"404: noindex, no canonical, no structured data",
	]);
}

/*
 * Every internal link must land on a page that exists, and every anchor must
 * exist on that page.
 *
 * The site's cross-references are built by sync.mjs from the section names in
 * the README, and the anchor part of a link is a slug of a heading — neither
 * the build nor VitePress's dead-link check looks at the fragment. So a
 * renamed heading leaves a link that goes nowhere: the page renders, the build
 * passes, and the reader lands at the top of a page they meant to be inside.
 * This reads the built HTML and checks the fragments against the ids that are
 * actually there.
 */
{
	const pages = PAGES.map((p) => ({
		path: p.path,
		file: p.path === "" ? "index.html" : `${p.path}.html`,
		html: readFileSync(join(DIST, p.path === "" ? "index.html" : `${p.path}.html`), "utf8"),
	}));
	const idsOf = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
	const broken = [];
	let checked = 0;
	for (const from of pages) {
		for (const m of from.html.matchAll(/href="(\/[^"]*)"/g)) {
			const href = m[1];
			if (href.startsWith("//")) continue;
			const [pathPart, rawAnchor] = href.split("#");
			// A file with an extension is an asset (the theme's own CSS, an
			// image), not a page. Only page links have an anchor to check.
			if (/\.[a-z0-9]+$/i.test(pathPart)) continue;
			// The built HTML percent-encodes the fragment; the ids in the page
			// are the raw heading text.
			const anchor = rawAnchor ? decodeURIComponent(rawAnchor) : "";
			checked++;
			const target = pages.find((p) => `/${p.path}` === pathPart || (p.path === "" && pathPart === "/"));
			if (!target) {
				broken.push(`${from.path || "index"} -> ${href} (no such page)`);
				continue;
			}
			if (anchor && !idsOf(target.html).has(anchor)) {
				broken.push(`${from.path || "index"} -> ${href} (no such anchor on /${target.path})`);
			}
		}
	}
	headChecks.push([
		broken.length === 0,
		`internal links: ${checked} checked, ${broken.length} broken${broken.length ? `: ${broken.slice(0, 6).join("; ")}` : ""}`,
	]);
}

/*
 * llms.txt is the index an LLM crawler reads instead of crawling the site.
 * It is generated from the page map, so it cannot list a page that does not
 * exist — but it can be missing altogether, or stale, and nothing else on this
 * site would notice. Check that it exists, names every page, and links to the
 * published origin.
 */
{
	const llmsPath = join(DIST, "llms.txt");
	const exists = existsSync(llmsPath);
	const llms = exists ? readFileSync(llmsPath, "utf8") : "";
	const listed = [...llms.matchAll(/^- \[(.+?)\]\((.+?)\):/gm)].map((m) => m[2]);
	const missing = PAGES.filter(
		(p) => !listed.some((url) => url.endsWith(`/${p.path}`) || (p.path === "" && url.endsWith("/"))),
	);
	headChecks.push([exists, `llms.txt: ${exists ? "present" : "missing"}`]);
	headChecks.push([
		missing.length === 0,
		`llms.txt: lists ${listed.length} entries, ${missing.length} page(s) unlisted${missing.length ? `: ${missing.map((p) => p.path || "index").join(", ")}` : ""}`,
	]);
	headChecks.push([llms.startsWith("# "), "llms.txt: starts with an H1"]);
}

/*
 * Page weight, read from the modulepreload hints the build emits.
 *
 * VitePress resolves `appChunk.imports + appChunk.dynamicImports + pageChunk.*`
 * into modulepreload tags on every page, so anything statically imported by the
 * app entry is blocking on first paint. That is how a page with no diagram
 * shipped 1.58 MB of mermaid on all seven: `withMermaid` injected the component
 * into the *entry* rather than registering it lazily. Every check above stays
 * green through that — the diagrams render, the tags are right, the site works —
 * so the only witness is the size itself. Measured now: 3.6 KB on the heaviest
 * page (index); the budget below is 64 KB, which is 17x the current weight and
 * 25x under the regression.
 */
const PRELOAD_BUDGET_BYTES = 64 * 1024;
for (const file of ["index.html", "start.html", "files.html", "testing.html"]) {
	const html = readFileSync(join(DIST, file), "utf8");
	const preloads = [...new Set([...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]))];
	let total = 0;
	const missing = [];
	for (const href of preloads) {
		// hrefs are base-prefixed (/a2mcp/assets/x.js); dist is not.
		const asset = join(DIST, href.replace(/^.*\/assets\//, "assets/"));
		try {
			total += statSync(asset).size;
		} catch {
			missing.push(href);
		}
	}
	headChecks.push([
		missing.length === 0 && total <= PRELOAD_BUDGET_BYTES,
		`${file.replace(/\.html$/, "")}: blocking preloads ${(total / 1024).toFixed(1)}KB of ${PRELOAD_BUDGET_BYTES / 1024}KB budget (${preloads.length} chunks${missing.length ? `, ${missing.length} missing` : ""})`,
	]);
}

/*
 * robots.txt is written by sitemap.mjs rather than committed, precisely so the
 * repo moving cannot leave a stale absolute URL behind — which means the origin
 * in it is derived twice (once for the sitemap, once for robots) and a drift
 * between them is invisible: the site builds, robots points somewhere else.
 */
{
	const robots = readFileSync(join(DIST, "robots.txt"), "utf8");
	const sitemap = readFileSync(join(DIST, "sitemap.xml"), "utf8");
	const robotsUrl = robots.match(/^Sitemap:\s*(\S+)/m)?.[1] ?? "";
	const loc = sitemap.match(/<loc>([^<]+)<\/loc>/)?.[1] ?? "";
	const origin = (u) => {
		try {
			return new URL(u).origin;
		} catch {
			return "";
		}
	};
	const locPage = loc.replace(/\/[^/]*$/, "/");
	headChecks.push([
		Boolean(robotsUrl) &&
			origin(robotsUrl) === origin(loc) &&
			robotsUrl.endsWith("/sitemap.xml") &&
			robotsUrl === `${locPage}sitemap.xml`,
		`robots: Sitemap is absolute and shares the sitemap's origin (${robotsUrl || "missing"})`,
	]);
}

/*
 * sitemap lastmod must be the source file's last commit date.
 *
 * It used to be the built file's mtime, i.e. the CI run time — every page
 * claimed to change on every deploy, which search engines are instructed to
 * ignore, so the whole field was worth nothing. Nothing asserted it: the sitemap
 * builds, the site works, and the wrong date is invisible in review. A shallow
 * clone (`fetch-depth` without 0) has the same effect by a different route — git
 * answers one commit for every file. So this compares each `<lastmod>` against
 * git, and skips rather than fails when git cannot say (the same rule
 * sitemap.mjs follows: no git → omit lastmod, never invent one).
 */
{
	const sitemap = readFileSync(join(DIST, "sitemap.xml"), "utf8");
	const entries = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)].map((m) => ({
		url: m[1],
		lastmod: m[2],
	}));
	const repo = dirname(SITE);
	const lastCommit = (rel) => {
		try {
			return execFileSync("git", ["log", "-1", "--format=%cs", "--", rel], {
				cwd: repo,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return "";
		}
	};
	headChecks.push([entries.length > 0, `sitemap: has ${entries.length} url(s) with a lastmod`]);

	// A URL is an absolute origin plus a base-prefixed path; the page name is what
	// is left after both. Getting this wrong makes every git lookup name a file that
	// does not exist, and the check below then passes on every page while verifying
	// nothing — so the "verified at least one" tail check is not decoration.
	const pageOf = (url) => {
		let path;
		try {
			path = new URL(url).pathname;
		} catch {
			return "";
		}
		if (BASE !== "/" && path.startsWith(BASE)) path = path.slice(BASE.length - 1);
		return path.replace(/^\/|\/$/g, "");
	};

	// The bound must be expressed in git's convention, not this process's wall
	// clock: `%cs` is the committer's local date, and the two disagree here (node
	// runs in UTC, the commits are +0800), so a commit made after 16:00Z looks
	// future-dated and the check fails with both printed dates identical. The
	// newest commit in the tree is the latest date a lastmod can legitimately claim.
	const headDate = (() => {
		try {
			return execFileSync("git", ["log", "-1", "--format=%cs", "HEAD"], {
				cwd: repo,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return "";
		}
	})();
	const gitWorks = lastCommit("README_ZN.md") !== "";
	let verified = 0;
	for (const { url, lastmod } of entries) {
		const page = pageOf(url);
		const sources = sourcesOf(page);
		const srcExists = sources.length > 0 && sources.every((s) => existsSync(join(repo, s)));
		headChecks.push([
			srcExists,
			`sitemap ${page || "index"}: maps to an existing source file (${sources.join(", ") || "no mapping"})`,
		]);
		const plausible = /^\d{4}-\d{2}-\d{2}$/.test(lastmod) && (headDate === "" || lastmod <= headDate);
		// A page rendered from more than one file claims the newest of their
		// dates, so the comparison is against that same newest date.
		const claimed = srcExists
			? (sources
					.map((s) => lastCommit(s))
					.filter(Boolean)
					.sort()
					.at(-1) ?? "")
			: "";
		if (claimed) verified++;
		headChecks.push([
			plausible && (claimed === "" ? true : claimed === lastmod),
			`sitemap ${page || "index"}: lastmod ${lastmod} vs ${sources.join(", ") || "(unmapped)"} ${claimed || "(git silent)"}`,
		]);
	}
	// Anti-vacuity: with git available, at least one page must actually have been
	// compared against a real commit date, and the rest must not be a single
	// uniform date when their sources disagree.
	const dates = new Set(entries.map((e) => e.lastmod));
	headChecks.push([
		!gitWorks || verified > 0,
		`sitemap: ${verified}/${entries.length} lastmod compared against git${gitWorks ? "" : " (git silent, dates unchecked)"}`,
	]);
	headChecks.push([
		dates.size > 1 ||
			new Set(
				entries.map((e) =>
					sourcesOf(pageOf(e.url))
						.map((s) => lastCommit(s))
						.filter(Boolean)
						.sort()
						.at(-1),
				),
			).size <= 1,
		`sitemap: ${dates.size} distinct lastmod across ${entries.length} pages (one date only when every source shares it)`,
	]);
}

for (const [ok, label] of headChecks) {
	if (!ok) failed++;
	console.log(`${ok ? "OK  " : "FAIL"} head  ${label}`);
}

if (failed) {
	console.error(`\nrender-check: ${failed} check(s) failed`);
	process.exit(1);
}
console.log("\nrender-check: all pages OK");
