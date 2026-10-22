/**
 * Sync the repo's source-of-truth markdown into website/content/ (generated,
 * gitignored). VitePress never reads README/CHANGELOG/docs/ directly:
 *
 *   docs/**            -> content/**            (verbatim copy + frontmatter)
 *   README_ZN.md       -> content/<page>.md     (one page per task, see below)
 *   CHANGELOG.md       -> content/changelog.md  (frontmatter, H1 re-emitted)
 *   (home)             -> content/index.md      (VitePress home layout)
 *
 * ## The README is one document; the site is several pages
 *
 * The README answers seventeen questions in one file. On the site they are
 * split by task, because a visitor arrives with a task and a search matches a
 * page, not a file: 快速开始 / 传文件 / 设备 / 跨机转发 / 安全与边界 /
 * 故障排查 / 开发 (see scripts/pages.mjs for the map and why it exists).
 *
 * The split is mechanical — sections are cut out of the README by name — so
 * the prose stays in one place. Two invariants make that safe, and both are
 * checked here rather than trusted:
 *
 *   1. every H2 in the README lands on exactly one page (nothing is dropped,
 *      nothing is rendered twice), and
 *   2. every page the map names exists as a section (a renamed section breaks
 *      the build instead of silently emptying a page).
 *
 * Repo-relative links must be rewritten because content/ sits at a different
 * depth; links that only make sense in the git repo are unlinked instead.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GUIDE_PAGES, PAGES, REPO_URL, slugify } from "./pages.mjs";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(SITE);
const CONTENT = join(SITE, "content");

rmSync(CONTENT, { recursive: true, force: true });
mkdirSync(CONTENT, { recursive: true });

// DRAFT=1 publishes a single holding page instead of the site. The extension's
// shape is still being decided, so the docs describe something that may change —
// publishing them now would have readers build against a form that gets revised.
// The repo's markdown stays the source of truth and untouched; only the built
// site changes, and dropping the env var brings the whole site back.
if (process.env.DRAFT === "1") {
	cpSync(join(SITE, "public"), join(CONTENT, "public"), { recursive: true });
	writeFileSync(
		join(CONTENT, "index.md"),
		`---
layout: home
hero:
  name: a2mcp
  text: 文档站正在重写
  tagline: 扩展的形态还没定下来，现在发布出来的内容可能改掉。仓库里的 README 与 docs 是准绳，改完再上线。
  actions:
    - theme: alt
      text: 看仓库
      link: https://github.com/adam-ikari/a2mcp
features: []
---
`,
	);
	process.stdout.write("sync: DRAFT=1 — 只出占位页，未发布正文\n");
	process.exit(0);
}

cpSync(join(REPO, "docs"), CONTENT, { recursive: true });
// VitePress resolves its public dir to <srcDir>/public = content/public, so
// copy the tracked website/public assets there as part of generation.
cpSync(join(SITE, "public"), join(CONTENT, "public"), { recursive: true });

/** A YAML scalar, quoted so a colon or a hash in the text cannot end it. */
const yaml = (value) => JSON.stringify(String(value));

/**
 * Apply a rewrite to everything outside fenced code blocks.
 *
 * The README's code blocks are commands and JSON; a link-shaped string inside
 * one is not a link. Rewriting inside them would produce a command that points
 * at a page.
 */
function outsideCode(text, fn) {
	return text
		.split(/(```[\s\S]*?```)/g)
		.map((part) => (part.startsWith("```") ? part : fn(part)))
		.join("");
}

/**
 * Split the README into its preamble and its H2 sections.
 *
 * The preamble is the two paragraphs before the first heading: what this is
 * and what the name means. It goes on the home page, where a visitor lands
 * first and where "what is this" is the question being asked.
 */
function parseGuide(md) {
	const body = md.replace(/^# .+\n/, "").replace(/^\[English\]\(README\.md\) \| 简体中文\n+/m, "");
	const headings = [...body.matchAll(/^## (.+)$/gm)];
	if (headings.length === 0) throw new Error("the README has no H2 sections to split");
	const preamble = body.slice(0, headings[0].index).trim();
	const sections = new Map();
	headings.forEach((m, i) => {
		const start = m.index + m[0].length;
		const end = i + 1 < headings.length ? headings[i + 1].index : body.length;
		sections.set(m[1].trim(), body.slice(start, end).trim());
	});
	return { preamble, sections };
}

const guide = parseGuide(readFileSync(join(REPO, "README_ZN.md"), "utf8"));

/*
 * The two invariants, checked before anything is written. A section that moved
 * in the README and a map that still points at the old name are both silent
 * failures otherwise: the build succeeds and a page quietly loses a chapter.
 */
const claimed = new Map();
for (const page of PAGES.filter((p) => Array.isArray(p.sections))) {
	for (const name of page.sections) {
		if (!guide.sections.has(name)) {
			throw new Error(
				`pages.mjs: the README has no section named 「${name}」 (page /${page.path}) — rename it there or in the map`,
			);
		}
		if (claimed.has(name)) {
			throw new Error(`pages.mjs: the section 「${name}」 is claimed by both /${claimed.get(name)} and /${page.path}`);
		}
		claimed.set(name, page.path);
	}
}
for (const name of guide.sections.keys()) {
	if (!claimed.has(name)) {
		throw new Error(`pages.mjs: the README section 「${name}」 is on no page — add it to the map or the site drops it`);
	}
}

/*
 * Where a section lives, so 「见「传文件」」 can become a link. A reference the
 * reader can follow is the whole difference between a page that explains a
 * boundary and a page that mentions it.
 */
const sectionTarget = new Map();
for (const page of PAGES.filter((p) => Array.isArray(p.sections))) {
	for (const name of page.sections) {
		// A page whose only section is its headline renders that section AS the
		// h1, so the anchor is the h1's — which is the same string.
		const path = page.path === "" ? "/" : `/${page.path}`;
		sectionTarget.set(name, { path, anchor: slugify(name) });
	}
}

/** Rewrite the repo-relative links the README carries into site-relative ones. */
const linkRewrites = [
	["](docs/protocol.md)", "](./protocol.md)"],
	["](docs/testing.md)", "](./testing.md)"],
	["](docs/computer-use.md)", "](./computer-use.md)"],
	["](CHANGELOG.md)", "](./changelog.md)"],
	["[LICENSE](LICENSE)", `[LICENSE](${REPO_URL}/blob/master/LICENSE)`],
];

/** Rewrite one page's body: repo links out, section references into links. */
function rewrite(text) {
	const linked = outsideCode(text, (part) => {
		let out = part;
		for (const [from, to] of linkRewrites) out = out.replaceAll(from, to);
		return out;
	});
	return outsideCode(linked, (part) =>
		part.replace(/「([^」]+)」/g, (whole, name) => {
			const target = sectionTarget.get(name);
			return target ? `[${name}](${target.path}#${target.anchor})` : whole;
		}),
	);
}

// The guide pages, one file per task.
for (const page of GUIDE_PAGES) {
	const body = page.sections
		.map((name) => {
			const text = guide.sections.get(name);
			// A page that is one section renders it as its headline: "## 传文件"
			// under an h1 called 传文件 would say the same thing twice.
			const heading = page.sections.length === 1 && page.h1 === name ? "" : `## ${name}\n\n`;
			return heading + rewrite(text);
		})
		.join("\n\n");
	writeFileSync(
		join(CONTENT, `${page.path}.md`),
		`---\ntitle: ${yaml(page.title)}\ndescription: ${yaml(page.description)}\n---\n\n# ${page.h1}\n\n${body}\n`,
	);
}

// The docs pages: copied verbatim above, now with their frontmatter.
for (const page of PAGES) {
	if (!page.source?.startsWith("docs/")) continue;
	const target = join(CONTENT, `${page.path}.md`);
	const body = readFileSync(target, "utf8");
	if (body.startsWith("---")) continue; // already has frontmatter
	// Keep the H1 and re-emit it under the frontmatter. Dropping it left these
	// pages starting at h2 — the same defect /intro had. The page title in
	// frontmatter is what the nav and <title> use; the H1 is what the page shows.
	const h1 = body.match(/^# (.+)\n/);
	const rest = body.replace(/^# .*\n+/, "");
	const heading = h1 ? `\n# ${h1[1]}\n` : "";
	writeFileSync(
		target,
		`---\ntitle: ${yaml(page.title)}\ndescription: ${yaml(page.description)}\n---\n${heading}\n${rest}`,
	);
}

// protocol.md: repo-relative links -> site form
const protocolPath = join(CONTENT, "protocol.md");
writeFileSync(
	protocolPath,
	readFileSync(protocolPath, "utf8")
		.replace("[`src/server.ts`](../src/server.ts)", "`src/server.ts`")
		.replace("[README](../README.md)", "[使用指南](./start.md)"),
);

// CHANGELOG -> changelog.md (H1 replaced, add frontmatter). The link rewrites
// are the same: entries link to repo files by repo-relative path, which does
// not resolve from content/changelog.md.
// Same treatment: keep an H1 and give the page its own description, so the
// pages do not all ship one string.
const changelogPage = PAGES.find((p) => p.path === "changelog");
const changelog = readFileSync(join(REPO, "CHANGELOG.md"), "utf8")
	.replace(/^# Changelog\n+/, "")
	.replaceAll("](docs/computer-use.md)", "](./computer-use.md)")
	.replaceAll("](docs/protocol.md)", "](./protocol.md)")
	.replaceAll("](docs/testing.md)", "](./testing.md)");
writeFileSync(
	join(CONTENT, "changelog.md"),
	`---\ntitle: ${yaml(changelogPage.title)}\ndescription: ${yaml(changelogPage.description)}\n---\n\n# 变更日志\n\n${changelog}`,
);

// VitePress home page: hero + features + the README's own opening paragraphs.
// The site UI lives here, not in the repo docs, so the frontmatter is hard-coded
// in the sync script; the prose under it is the README's, so "what is this" is
// answered in the project's own words rather than in a tagline.
const home = `---
layout: home
title: 把本机 omp 的工具开成远程 MCP 接口

hero:
  name: a2mcp
  text: 把本机的工具开给远程的 agent
  tagline: 一个 omp 扩展。装上后，本机 omp 多开出一个 MCP 接口，别的 agent 从远程调用这台机器上的 read、bash、edit——命令在本机真跑，文件在本机真改。推理归调用方，桥自己从不请求模型。
  actions:
    - theme: brand
      text: 快速开始
      link: /start
    - theme: alt
      text: 协议参考
      link: /protocol

features:
  - title: 装上它
    details: 机器上已经有 omp，就一条 omp install 加仓库的 git URL；新机器走一键脚本，它先装宿主，再执行同一条命令。两条路装完是同一个样子：通知栏报出监听地址，配置与 token 桥自己生成。
    link: /start
  - title: 接上第一个远程 agent
    details: 客户端会说 MCP 就直接填 mcp.json，别自己造客户端；不会说 MCP 但能跑代码的（贴进提示词的 agent、CI 任务、自写脚本），取 scripts/mcp-call.py——零依赖的 Python 3 参考客户端，握手、会话头与重连都写好了。
    link: /start#两条接入路
  - title: 传文件走 WebDAV
    details: xfer_share 收一条宿主路径，交给 dufs 服务，挂在桥自己端口的 /xfer/ 路由下；字节不经过 JSON-RPC，要的还是那个 Bearer token。公网那一面是操作员的 /a2mcp tunnel：一条 quick tunnel 只顶一个 origin，所以文件路由和工具调用走同一个主机名、同一个 token。隧道开着时回包带 publicUrl，远端 agent 拿得到就能直接拼地址。
    link: /files
  - title: 驱动接在本机上的设备
    details: adb、idf.py、串口工具、烧录器都是本机 PATH 上的命令。远程 agent 调 bash，命令就在这台机器的 shell 里跑；宿主把工具挂成虚拟设备时，read/write 的 path 参数就能读写和执行。
    link: /devices
  - title: 跨机转发
    details: 默认只监听 127.0.0.1，跨机器用 SSH 端口转发接进来。要一个公网主机名，宿主会话里跑 /a2mcp tunnel——它顶的是整个端口，MCP 端点与开着共享的 /xfer/ 路由一起出去，token 是唯一的闸门。
    link: /reach
  - title: 宿主推理可以整体关掉
    details: 远程调用可能唤醒宿主自己的 agent，花宿主的 token。host_llm 配置与 POST /host-llm 把这件事变成开关：deny 在位时宿主的会话发不出任何模型请求，核验探针对着一个真在听的计数 sink 数过——零是数出来的。token 即工具执行全权，这是默认配置下的事实，文档里写清楚。
    link: /safety
  - title: 协议参考
    details: 客户端要实现的全部约定：处理顺序、会话生命周期、错误码总表、xfer_* 工具与 /xfer/ 文件路由、宿主推理切换。协议面与代码冲突时以代码为准。
    link: /protocol
  - title: 测试与核验
    details: 279 项单测之外，几个探针大多拉起真实的 omp 跑完整流程：deny 那一个对着真在听的计数 sink 数出零，发布包那一个装回去跑通才算过。各项覆盖什么、怎么判读，测试页写着。
    link: /testing
---

${rewrite(guide.preamble)}

---

${rewrite(guide.sections.get("许可"))}

## 接下来

- [快速开始](/start)：装上它，配置 token，把 mcp.json 填给远程 agent。
- [安全与边界](/safety)：token 就是工具执行全权，默认配置下没有第二道门。
- [协议参考](/protocol)：要自己写客户端的话，wire 契约在那里。
`;
writeFileSync(join(CONTENT, "index.md"), home);

console.log("synced content ->", CONTENT);
