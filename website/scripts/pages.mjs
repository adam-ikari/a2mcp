/**
 * The site's page map — one place that says which pages exist, what each one
 * is called, and which repo file it is rendered from.
 *
 * ## Why a map and not the repo's file layout
 *
 * The site used to have exactly one page per repo file: README → /intro, three
 * docs → three pages, CHANGELOG → /changelog. That answers "where is the
 * file", and a visitor never arrives with that question. They arrive with a
 * task — install it, move a file, find out whether it is safe, write a client
 * against the protocol — and each task wants its own URL, its own title and
 * its own description. One README-shaped page gave seventeen intents a single
 * address, so only one of them could ever match a search.
 *
 * So the README is rendered in task-shaped pieces. This map says which README
 * sections land on which page; sync.mjs splits the README by that map and
 * fails loudly when a section is missing from the map or claimed twice. The
 * prose stays in the README — one source, many entry points — and only the
 * rendering is split.
 *
 * Consumers: sync.mjs (frontmatter + the split), sitemap.mjs and
 * render-check.mjs (which pages exist, what they are called, where they came
 * from), llms.mjs (the index for LLM crawlers).
 */

/** The repository the site documents. One copy: the pages link into it. */
export const REPO_URL = "https://github.com/adam-ikari/a2mcp";

/**
 * The one site-wide description. It is the site's own sentence and the home
 * page's meta description, so it lives here rather than in two places.
 */
export const SITE_DESC =
	"omp 扩展：把本机的 read、bash、edit 开成 MCP 接口，远端 agent 经 Streamable HTTP 调用，命令和文件改动真实落在本机。推理在调用方。";

/**
 * Sidebar and nav groups, in reading order. The order is the site's argument:
 * start here, then use it, then know its limits, then integrate against it,
 * then trust it, then read its history.
 */
export const GROUPS = ["起步", "用起来", "边界", "集成", "核验与历史", "历史"];

/**
 * Every page on the site.
 *
 * `path` is the URL segment ("" for the home page). `nav` is the short label
 * in the nav and the sidebar; `title` is the page's own title, which is what
 * a search result shows; `description` is its meta description. `group` is
 * where it sits in the reading order. `source` is the repo file it is rendered
 * from — the sitemap's lastmod and the render check's page→source mapping both
 * read it. `sections` lists the README's H2 sections on this page, in order;
 * `h1` is the page's own headline.
 */
export const PAGES = [
	{
		path: "",
		kind: "home",
		title: "把本机 omp 的工具开成远程 MCP 接口",
		description: SITE_DESC,
		// The README's own tail: the license line belongs at the end of the
		// landing page, the way it sits at the end of the README.
		sections: ["许可"],
		// The home page is the one page with two sources: the README supplies
		// its prose, and the sync script supplies the hero and the feature
		// cards. Its lastmod is the newer of the two — a page that changed
		// yesterday must not claim it last changed when the README did.
		source: "README_ZN.md",
		alsoSources: ["website/scripts/sync.mjs", "website/scripts/pages.mjs"],
	},
	{
		path: "start",
		nav: "快速开始",
		title: "快速开始：装上它，接上第一个远程 agent",
		description:
			"a2mcp 装到本机 omp 的两条路（git URL 与一键脚本）、配置文件与 token、mcp.json 与参考客户端两条接入路，以及给远程 agent 的提示词。",
		group: "起步",
		source: "README_ZN.md",
		h1: "装上它，远程 agent 就能用你本机的工具",
		sections: ["什么时候用哪个", "工作原理", "安装", "配置", "远程连接示例", "两条接入路", "给远程 agent 的提示词"],
	},
	{
		path: "files",
		nav: "传文件",
		title: "传文件：把宿主路径开成 HTTP 路由",
		description:
			"xfer_share 把宿主路径交给 dufs，桥反代成 /xfer/ 路由，同一 token 授权，Range 续传；用 curl / rclone 搬，公网侧单请求受 Cloudflare 100 MB 限制。",
		group: "用起来",
		source: "README_ZN.md",
		h1: "传文件",
		sections: ["传文件"],
	},
	{
		path: "commands",
		nav: "本机命令",
		title: "本机命令与挂载工具：bash 与 xd:// 路径",
		description:
			"远程 agent 怎么用本机 PATH 上的命令与宿主挂载的工具：命令走 bash，挂载工具走 read/write 的 xd:// 路径，不进 tools/list；桥不假设这台机器上有什么。",
		group: "用起来",
		source: "README_ZN.md",
		h1: "本机命令与挂载工具",
		sections: ["本机命令与挂载工具"],
	},
	{
		path: "reach",
		nav: "跨机转发",
		title: "跨机转发：SSH 端口转发与公网隧道",
		description:
			"默认只绑回环。跨机用 SSH 端口转发；想要公网主机名，宿主会话里跑 /a2mcp tunnel，工具与 /xfer/ 一起出去。",
		group: "用起来",
		source: "README_ZN.md",
		h1: "跨机转发",
		sections: ["跨机转发"],
	},
	{
		path: "safety",
		nav: "安全与边界",
		title: "安全与边界：token、审批、宿主推理与审计",
		description:
			"token 即工具执行全权（默认 yolo）；审批门照宿主自己的走，无 UI 时会挂起；接管开关能把宿主自己的推理整体关掉；审计写两条 JSONL，未鉴权的尝试不进日志。",
		group: "边界",
		source: "README_ZN.md",
		h1: "安全、审批与宿主推理",
		sections: ["审批", "宿主推理接管", "安全与边界"],
	},
	{
		path: "troubleshoot",
		nav: "故障排查",
		title: "故障排查：401、端口对不上与不返回的调用",
		description:
			"a2mcp 常见报错的判据：401 token 不匹配、missing mcp-session-id、端口回退、配置改动不生效、无 UI 审批导致调用挂起，以及零模型配置机器上的占位模型。",
		group: "边界",
		source: "README_ZN.md",
		h1: "故障排查",
		sections: ["故障排查"],
	},
	{
		path: "protocol",
		nav: "协议参考",
		title: "MCP 协议参考：Streamable HTTP、会话与文件路由",
		description:
			"a2mcp 实现的 MCP 2025-11-25 Streamable HTTP 子集：处理顺序、会话生命周期、错误码总表、xfer_* 工具、/xfer/ 文件路由与宿主推理切换。",
		group: "集成",
		source: "docs/protocol.md",
	},
	{
		path: "computer-use",
		nav: "与 computer use 的区别",
		title: "与 computer use 的区别：按名字调工具",
		description:
			"computer use 让模型看屏幕猜坐标点按；a2mcp 让调用方按名字调本机工具，参数由 tools/list 逐条给出，执行走本机工具自己的实现，推理在调用方。",
		group: "集成",
		source: "docs/computer-use.md",
	},
	{
		path: "testing",
		nav: "测试与核验",
		title: "测试与核验：单测、真机探针与审批边界",
		description:
			"a2mcp 的核验矩阵：281 项单测、真实模型注册表、加固探针、发布包端到端、外部二进制获取、宿主推理 deny/restore、端到端场景与审批边界，附判据与实测数字。",
		group: "核验与历史",
		source: "docs/testing.md",
	},
	{
		path: "dev",
		nav: "开发",
		title: "开发：命令、文件布局与依赖钉",
		description:
			"a2mcp 仓库自己的开发命令：单测与十二个探针（七个起真宿主）、文件布局表、@oh-my-pi 依赖为什么钉死到宿主版本，以及版本守卫的判据。",
		group: "核验与历史",
		source: "README_ZN.md",
		h1: "开发",
		sections: ["开发"],
	},
	{
		path: "changelog",
		nav: "变更日志",
		title: "变更日志：设计取舍与实测记录",
		description:
			"a2mcp 从 v0.1.0 起的改动记录：名字从 a2a 改到 a2mcp、宿主推理开关、传文件面三次重做、安装方式收敛到一条 git URL，每条都带实测数字与代价。",
		group: "核验与历史",
		source: "CHANGELOG.md",
	},
	{
		path: "superpowers/specs/2026-09-10-a2a-mcp-bridge-design",
		nav: "初始设计稿（2026-09）",
		title: "初始设计稿（2026-09）：omp 作为 MCP 服务器",
		description:
			"2026-09 的初始设计稿：为什么让 omp 当宿主、为什么只做 Streamable HTTP、工具如何暴露与审批，以及当时定下、后来改掉的边界。",
		group: "历史",
		source: "docs/superpowers/specs/2026-09-10-a2a-mcp-bridge-design.md",
	},
	{
		path: "superpowers/plans/2026-09-10-a2a-mcp-bridge",
		nav: "初始实施计划（2026-09）",
		title: "初始实施计划（2026-09）",
		description:
			"2026-09 的初始实施计划：扩展入口、JSON-RPC 服务器、工具转发、审批与配置的分步任务，以及每一步当时的验收方式。",
		group: "历史",
		source: "docs/superpowers/plans/2026-09-10-a2a-mcp-bridge.md",
	},
];

/**
 * VitePress's anchor rule, copied so the site can build links to its own
 * headings. It is github-slugger's: strip combining marks, turn whitespace
 * and punctuation into hyphens, lowercase. CJK is left alone, so
 * 「安全与边界」 becomes `#安全与边界` and 「给远程 agent 的提示词」 becomes
 * `#给远程-agent-的提示词`.
 *
 * Copied rather than imported because the rule lives inside VitePress's
 * bundle. render-check.mjs asserts every link this builds against the anchors
 * in the built HTML, so a drift between the two shows up as a failed check
 * rather than as a link that goes nowhere.
 */
export function slugify(str) {
	const normalized = str.normalize("NFKD").replace(/[\u0300-\u036F]/g, "");
	// The control-character strip is a rule VitePress follows too, so a heading
	// that had one would slug differently here than there.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: parity with VitePress
	const cleaned = normalized.replace(/[\u0000-\u001F]/g, "");
	return cleaned
		.replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/^(\d)/, "_$1")
		.toLowerCase();
}

/** The page at a URL path ("" for the home page), or undefined. */
export function pageAt(path) {
	return PAGES.find((p) => p.path === path);
}

/**
 * The repo file a page is rendered from, or undefined when nothing maps to it.
 * The home page arrives here as an EMPTY name — the sitemap's collector
 * strips the `index` suffix off `index.html` — so it is normalized to the
 * home page's own path before the lookup.
 */
export function sourceOf(path) {
	return pageAt(path === "" ? "" : path)?.source;
}

/**
 * Every repo file a page is rendered from, the primary one first. A page with
 * more than one (the home page: the README's prose plus the sync script's
 * hero) claims the newest of their commit dates, because that is when the
 * page last changed.
 */
export function sourcesOf(path) {
	const page = pageAt(path === "" ? "" : path);
	if (!page?.source) return [];
	return [page.source, ...(page.alsoSources ?? [])];
}

/** Every page that is a guide page (rendered from a slice of the README). */
export const GUIDE_PAGES = PAGES.filter((p) => p.kind !== "home" && Array.isArray(p.sections));
