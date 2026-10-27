/**
 * dist/llms.txt — an index of the site for LLM crawlers.
 *
 * The site's readers are, in part, agents: a2mcp exists so that a remote agent
 * can drive a local machine, and the people searching for it are the ones
 * wiring one up. A crawler that reads the site's pages in order has to guess
 * which of them are relevant; this file says what each one is, in one line,
 * with a link. It is the same map the site is built from
 * (scripts/pages.mjs), so it cannot describe a page that does not exist.
 *
 * Format: https://llmstxt.org — an H1, a blockquote summary, then one section
 * per group, each entry a link with a one-line description.
 *
 * Run after `vitepress build`:  node scripts/llms.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS, PAGES } from "./pages.mjs";
import { siteUrl } from "./site-url.mjs";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(SITE, ".vitepress", "dist");
const BASE = siteUrl();

const home = PAGES.find((p) => p.path === "");
const lines = [
	`# ${"a2mcp"}`,
	"",
	`> ${home.description}`,
	"",
	"本文件是这个站点的索引：每一页一行说明，链接指向对应的页面。",
	"",
];

for (const group of GROUPS) {
	const pages = PAGES.filter((p) => p.group === group);
	if (pages.length === 0) continue;
	lines.push(`## ${group}`, "");
	// The home page belongs to the first group: it is where the walk starts.
	const listed = group === GROUPS[0] ? [home, ...pages] : pages;
	for (const page of listed) {
		const url = `${BASE}${page.path}`;
		lines.push(`- [${page.title}](${url}): ${page.description}`);
	}
	lines.push("");
}

writeFileSync(join(DIST, "llms.txt"), lines.join("\n"));
console.log(`llms.txt: ${PAGES.length} pages -> ${BASE}llms.txt`);
