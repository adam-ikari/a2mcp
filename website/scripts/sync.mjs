/**
 * Sync the repo's source-of-truth markdown into website/content/ (generated,
 * gitignored). VitePress never reads README/CHANGELOG/docs/ directly:
 *
 *   docs/**            -> content/**            (verbatim copy)
 *   README_ZN.md       -> content/intro.md      (frontmatter + link rewrites)
 *   CHANGELOG.md       -> content/changelog.md  (frontmatter, H1 re-emitted)
 *   protocol.md        -> link rewrites (repo-relative -> site-relative)
 *   index.md (home)    -> content/index.md      (VitePress home layout)
 *
 * Repo-relative links must be rewritten because content/ sits at a different
 * depth; links that only make sense in the git repo are unlinked instead.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  name: omp A2A Bridge
  text: 文档站正在重写
  tagline: 扩展的形态还没定下来，现在发布出来的内容可能改掉。仓库里的 README 与 docs 是准绳，改完再上线。
  actions:
    - theme: alt
      text: 看仓库
      link: https://github.com/adam-ikari/pi-a2a-ext
features: []
---
`,
	);
	process.stdout.write("sync: DRAFT=1 — 只出占位页，未发布正文\n");
	process.exit(0);
}

cpSync(join(REPO, "docs"), CONTENT, { recursive: true });

// Per-page descriptions. `transformHead` already prefers `pageData.description`
// over the site-wide one, but nothing set it — so every page carried the same
// string, which is how a search engine sees near-duplicate pages. Each is taken
// from what that page actually says.
const PAGE_DESCRIPTIONS = {
	"protocol.md":
		"桥实现的 MCP 2025-11-25 Streamable HTTP 子集：处理顺序、会话生命周期、错误码总表、POST /blob 的原始字节上传、POST /host-llm 的宿主推理切换，以及它们各自放弃的东西。",
	"testing.md":
		"核验矩阵：3 项仓库形状（无依赖，排在 bun test 之前）、160 单测、28 项真实模型注册表（不起宿主）、35 项原始字节上传、34 项加固、28 项发布包与端到端、34 项宿主推理 deny/restore、10 个端到端场景，另有审批边界判别。顺手量的还有宿主 RSS、审计轮转与逐层脱敏；插件发现与 HOME 的实测结论在正文。",
	"computer-use.md":
		"computer use 让模型看屏幕猜坐标去点按，本桥让调用方按名字调工具。执行走的是本机工具自己的实现，目录由 tools/list 一条条给出名字和参数。",
};
for (const [file, description] of Object.entries(PAGE_DESCRIPTIONS)) {
	const target = join(CONTENT, file);
	const body = readFileSync(target, "utf8");
	if (body.startsWith("---")) continue; // already has frontmatter
	// Keep the H1 and re-emit it under the frontmatter. Dropping it left these
	// pages starting at h2 — the same defect /intro had. The page title in
	// frontmatter is what the nav and <title> use; the H1 is what the page shows.
	const h1 = body.match(/^# (.+)\n/);
	const rest = body.replace(/^# .*\n+/, "");
	const heading = h1 ? `\n# ${h1[1]}\n` : "";
	writeFileSync(target, `---\ndescription: ${description}\n---\n${heading}\n${rest}`);
}

// README_ZN.md -> intro.md. The site is the Chinese one: README.md is the
// English default and README_ZN.md the translation, so sync the translation
// and strip its language-switch line (the site has a single locale).
// replaceAll, not replace: the README links to the same page more than once,
// VitePress resolves its public dir to <srcDir>/public = content/public, so
// copy the tracked website/public assets there as part of generation.
cpSync(join(SITE, "public"), join(CONTENT, "public"), { recursive: true });
// and a half-rewritten link is a broken link in the site build.
const intro = readFileSync(join(REPO, "README_ZN.md"), "utf8")
	.replace(/^# omp A2A Bridge\n/, "")
	.replace(/^\[English\]\(README\.md\) \| 简体中文\n+/m, "")
	.replaceAll("](docs/protocol.md)", "](./protocol.md)")
	.replaceAll("](docs/testing.md)", "](./testing.md)")
	.replaceAll("](docs/computer-use.md)", "](./computer-use.md)")
	.replaceAll("](CHANGELOG.md)", "](./changelog.md)")
	.replaceAll("[LICENSE](LICENSE)", "LICENSE 文件");
// The README's own H1 is the repo name, which the site's `title` already
// carries, so it goes. That left the page with 15 h2 and no h1 at all — the one
// page where that matters most, since it is what the nav sends people to. Give
// it its own h1 rather than promoting a section.
writeFileSync(
	join(CONTENT, "intro.md"),
	`---\ntitle: 使用指南\n---\n\n# 装上它，远程 agent 就能用你本机的工具\n\n${intro}`,
);

// CHANGELOG -> changelog.md (H1 replaced, add frontmatter). The link rewrites
// are the same: entries link to repo files by repo-relative path, which does
// not resolve from content/changelog.md.
// Same treatment: keep an H1 and give the page its own description, so the six
// pages do not all ship one string.
const changelog = readFileSync(join(REPO, "CHANGELOG.md"), "utf8")
	.replace(/^# Changelog\n+/, "")
	.replaceAll("](docs/computer-use.md)", "](./computer-use.md)")
	.replaceAll("](docs/protocol.md)", "](./protocol.md)")
	.replaceAll("](docs/testing.md)", "](./testing.md)");
writeFileSync(
	join(CONTENT, "changelog.md"),
	`---\ntitle: 变更日志\ndescription: 从 v0.1.0 起的改动记录：POST /blob 为什么收原始字节、宿主推理为什么靠 POST /host-llm 整体关掉、哪些端到端核验被推倒重测、安装方式怎么收到一条，每条都写明实测数字与代价。\n---\n\n# 变更日志\n\n${changelog}`,
);

// protocol.md: repo-relative links -> site form
const protocolPath = join(CONTENT, "protocol.md");
writeFileSync(
	protocolPath,
	readFileSync(protocolPath, "utf8")
		.replace("[`src/server.ts`](../src/server.ts)", "`src/server.ts`")
		.replace("[README](../README.md)", "[README](./intro.md)"),
);

// VitePress home page: default hero + features. The site UI lives here, not
// in the repo docs, so the frontmatter is hard-coded in the sync script.
// Sidebar category labels for the design docs are configured in
// .vitepress/config.ts instead of per-folder _category_.json.
const home = `---
layout: home

hero:
  name: omp A2A Bridge
  text: 把本机的工具开给远程的 agent
  tagline: 一个 omp 扩展。装上后，本机 omp 多开出一个 MCP 接口，别的 agent 从远程调用这台机器上的 read、bash、edit——命令在本机真跑，文件在本机真改。推理归调用方，桥自己从不请求模型。
  actions:
    - theme: brand
      text: 接上远程 agent
      link: /intro
    - theme: alt
      text: 协议参考
      link: /protocol

features:
  - title: 远程烧一块板子
    details: adb、idf.py、串口工具、烧录器都是本机 PATH 上的命令。远程 agent 调 bash，命令就在这台机器的 shell 里跑；装了 Android SDK 就调得到 adb，装了 ESP-IDF 就能 idf.py flash。
    link: /intro#设备
  - title: 驱动接在本机上的设备
    details: DAP 调试器（xd://debug）、LSP（xd://lsp）这类设备不进工具目录，远程 agent 用 read/write 的 path 参数就能读写和执行。有什么设备，跟着本机 omp 装了哪些扩展走。
    link: /intro#设备
  - title: 把固件传上这台机器
    details: POST /blob 收原始字节，而它的价值是「不会挂」——宿主把审批配成 prompt 而调用方无 UI 时，走 write/bash 会一直等不到应答（实测挂起 ≥90s），这条是唯一不挂的写入路径。实测 100 MB 的镜像一个请求传完，落盘字节一致。这个端点只做上传，GET 一律 405，理由写在协议页。
    link: /intro#传文件
  - title: 宿主推理可以整体关掉
    details: 远程调用可能唤醒宿主自己的 agent，花宿主的 token。host_llm 配置与 POST /host-llm 把这件事变成开关：deny 在位时宿主的会话发不出任何模型请求，核验探针对着一个真在听的计数 sink 数过——零是数出来的。
    link: /intro#宿主推理接管
  - title: 接上远程 agent
    details: 本机 omp 首次启动时广播接口地址并生成 token，抄进远程客户端的 mcp.json 就连上。默认只监听 127.0.0.1，跨机器走 SSH 端口转发。
    link: /intro
  - title: 与 computer use 的区别
    details: computer use 让模型看屏幕猜坐标去点按；本桥的请求直接带着工具名和参数，执行走本机工具自己的实现。推理也在调用方的模型里做。
    link: /computer-use
  - title: 协议参考
    details: 客户端要实现的全部约定：处理顺序、会话生命周期、错误码总表。
    link: /protocol
  - title: 测试与核验
    details: 160 项单测之外，七个核验全都拉起真实的 omp 跑完整流程；宿主推理那一个让宿主真连进计数 sink，发布包那一个装回去跑通才算过，第八个把接管架在宿主真实的模型注册表上跑、连宿主都不用起。各项覆盖什么、怎么判读，测试页写着。
    link: /testing
---
`;
writeFileSync(join(CONTENT, "index.md"), home);

console.log("synced content ->", CONTENT);
