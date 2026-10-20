---
id: a2a-mcp-bridge
title: A2A MCP bridge architecture
category: decision
status: active
tags: [omp, extension, mcp]
created: "2026-09-10T09:16:34"
updated: "2026-10-20T17:13:05"
---

<!-- compiled_truth -->
## 网站构建链（2026-10-01 修订）

站点是 VitePress 1.6.4 单语言中文站，GitHub Pages 部署，构建链为 `website/scripts/sync.mjs`（从 `README_ZN.md` / `CHANGELOG.md` / `docs/**` 生成 `content/`）→ `vitepress build` → `scripts/sitemap.mjs`。

**Mermaid 不能用 `withMermaid`**。该插件的 Vite transform 把 Mermaid 组件**静态**注入 `vitepress/dist/client/app/index.js`（app entry），mermaid 及其约 40 个 diagram 类型因此进入 entry 的 import graph；而 VitePress 的 `resolvePageImports` 会把 `appChunk.imports + appChunk.dynamicImports + pageChunk.*` 全部输出为 `modulepreload`，于是**每个页面**首屏前都要拉 1.58 MB，包括四页根本没有图的页面。弃用 `withMermaid`，保留其 `MermaidMarkdown` fence 渲染（它只负责把 ```mermaid 转成 `<Mermaid>` 标签），组件改由 `.vitepress/theme/index.ts` 里 `defineAsyncComponent` 注册、`virtual:mermaid-config` 用一个 8 行自写 Vite 插件提供。实测阻塞预载 1.58 MB → 1–2 KB，空闲预取 169 KB，app entry 684 KB → 1 KB。

**`transformHead` 的 script 是三元组，不是带 `innerHTML` 键的对象**。`["script", { type, innerHTML }]` 会把 `innerHTML` 当 HTML 属性序列化，`<script>` 体为空——标签在 review 里看着齐全，爬虫读到零结构化数据。正确写法 `["script", attrs, innerHTML]`。此错已随站发布布过，修复于 2026-10-01。

**`og:image` 不能是 SVG**：Twitter/X、Facebook、Slack 都不渲染，社交卡片等于不存在。已改 1200×630 PNG（`public/img/og.png`，源 `og.svg`）。

**sitemap `lastmod` 必须取源文件的最后提交日期**，不能取构建产物 mtime（那是 CI 运行时间，等于宣称每页每次都变，搜索引擎直接忽略）。源文件映射在 `sitemap.mjs` 的 `SOURCE_OF`；`deploy.yml` 的 `actions/checkout` 必须 `fetch-depth: 0`，否则浅克隆下 git 对所有页面返回同一个 commit，正是要避免的信号。站点地址由 `GITHUB_REPOSITORY` 推导（与 `config.ts` 同一套逻辑），不再有第二处硬编码。

**`website/scripts/render-check.mjs`（`bun run check`，28 项）是网站侧唯一能证明「图能画出来」的东西**。Mermaid 是客户端渲染，构建通过与图能否显示无关。探针用 headless chromium 载入构建产物，断言 SVG 内的中文标签文本（mermaid 把非 ASCII 转成实体，须先解码），并检查 canonical / og:image 为位图 / twitter:card / 每页 JSON-LD 类型。已接入 `deploy.yml`。

**写这个探针时踩的三个 harness 假阴性——都不是站点缺陷，但症状与真缺陷无法区分**：(1) `cleanUrls` 下 VitePress 写的是 `protocol.html` 而服务路径是 `/protocol`，静态服务器不做 `.html` 兜底就 404；(2) Pages 的 base 前缀（`/pi-a2a-ext/`）必须从 index.html 里读出来并剥掉，否则 entry JS 404、页面不 hydrate，**症状与「Mermaid 组件坏了」完全一样**；(3) `parse error` 正则命中的是 `protocol.md` 正文里作为 JSON-RPC 错误码讲解的 `parse error`，须只扫 SVG 段。**教训与既有方法论一致：探针自己会骗人，必须先证明它在故障时 FAIL**（本轮已验：组件提前 return → 两页 FAIL；og 改回 SVG / JSON-LD 改回属性写法 → 对应两项 FAIL）。

**`vitepress-plugin-mermaid` 的 `Mermaid.vue` 直接在 `onMounted` 里 `await import("mermaid")`**——它本身就是懒的，问题全在 entry 那一侧的静态注册。
## Q1 Execution target (decided)
Remote tools/call executes IN the host's live session via AgentRegistry.global().get("Main").session.getToolByName(name).execute(...). No headless subprocess for v1.

## Q2 Transport (decided — supersedes early "stdio" note)
Streamable HTTP on 127.0.0.1 via Bun.serve, single process inside the host omp. stdio was rejected: a stdio MCP server needs exclusive stdin/stdout which collides with the running TUI, and TUI approval forwarding requires same-process. Verified against host client: protocol 2025-11-25, Accept: application/json, text/event-stream; plain JSON responses suffice; GET SSE optional (405 tolerated); notifications accept 200/202 (src/mcp/transports/http.ts).

## Q3 Approval (decided; protocol behavior reversed 2026-09-24)
Reuse the host's built-in approval gate. Registry tools ARE ExtensionToolWrapper instances (sdk.ts:2922) which run resolveApproval internally: yolo passes, deny throws -> isError, per-tool prompt raises ui.select. The bridge must inject the REAL session.settings and the ExtensionContext ui into the AgentToolContext it builds; it implements no approval logic itself.
REVERSED (approval probes on omp 18.2.10, --mode rpc): prompt tier with NO interactive UI does NOT return isError — the tools/call request hangs indefinitely (>=90s observed; src/ contains no setTimeout/AbortSignal/timeout anywhere). Execution is still blocked (side-effect probe never fired), so fail-closed holds only in the security sense, not the protocol sense: the README section 「审批 / Approval」 (was line 105; corrected 2026-09-24 to document the hang, the caller-timeout requirement, and the start-without-done audit trace; the discriminating probe is committed as test/approval-probe.ts (expected verdict B). Host mechanism: hasUI=false in plain rpc (host sets hasUI=f||r==="rpc-ui"), so ui.select has no answerer; the host's 600000ms input timeout belongs to login, not approval. The TUI prompt path is unaffected.

## Q4 Exposure ~~(decided; tightened 2026-09-23)~~ — **SUPERSEDED 2026-10-01**

> **已作废。** `deny` / `denyMCPTools` 全部删除，`tools/list` 改为 `pi.getAllTools()` 原样透传不过滤。理由见文末「极简化」一节。以下保留为历史记录。
pi.getAllTools() -> full tool list (name/description/parameters via toolWireSchema -> JSON Schema 2020-12), config deny list removes tools from both tools/list and tools/call. No whitelist in v1.
Exposure semantics (2026-09-23 review): the catalog is the session tool REGISTRY as-is — getAllToolInfos() filters neither `hidden` tools nor tools the host currently disabled for its own model, so it is deliberately NOT a mirror of what the host model can see. tools/call intersects with the catalog (name survives deny AND appears in pi.getAllTools()), so aliases like xd://bash and guessed hidden names are rejected; denied and not-in-catalog share one message so a token holder cannot probe name existence.

## Q5 Auth (decided)
Static Bearer token, 32 random bytes base64url, generated on first start, persisted 0600 in ~/.omp/agent/a2a-bridge.json together with port/host/deny. Constant-time compare. /a2a rotate regenerates. No OAuth/TLS in v1 (loopback default; SSH forwarding documented).

## Q6 Config & audit (decided 2026-09-23; audit redesigned two-phase 2026-09-24)
Config validation is fail-closed: a present-but-malformed field (port/deny/host/denyMCPTools) aborts extension startup with a named error instead of running with a wrong exposure surface. `token` self-healing is limited to the field being ABSENT or not a string (amended 2026-10-10): a present string shorter than 32 characters or containing whitespace is refused like any malformed field — the bridge never swaps a token somebody typed for one it generated, because the remote mcp.json would break with no explanation anywhere; the floor (MIN_TOKEN_CHARS) sits below generateToken's own 43-character output, so it catches placeholders, not copied secrets. Config writes are 0600 at creation (writeFile mode), closing the pre-chmod window. External edits to a2a-bridge.json apply on next host restart; only `/a2a rotate` is live.
Every remote tools/call writes TWO JSONL audit records paired by id — auditStart at dispatch ({ts,id,sid,phase:"start",tool,args truncated to 1KB}) and auditDone on completion ({ts,id,sid,phase:"done",tool,isError,args}) — to <agentDir>/a2a-bridge.log: 0600, rotates to .1 past 512KB, $A2A_BRIDGE_AUDIT overrides the path, audit failures never affect the call. 2026-10-20: the id is now also the join key between the two halves of one call's record. The host's session transcript (<agentDir>/sessions/**.jsonl) keeps the full arguments and never the outcome (a remote call does not touch the message stream, so that transcript carries no tool_execution_end and no isError), while the audit log keeps the outcome and the remote attribution but folds long arguments to <len,sha256>; the bridge used to mint two UUIDs per call — one for the audit pair, one for the host — so the halves could only be paired by a timestamp guess, which on a busy host is a guess (measured on a real host: the same call was 30012d7d-… in the transcript and 138f5ab0-… in the audit log). One call now mints one id, and it is both the audit pairing key and the host's toolCallId. Design reversal 2026-09-24 (supersedes the completion-only amendment): a call that never settles (prompt tier in no-UI mode) leaves start-without-done, so hangs are visible in the log. sid (the Mcp-Session-Id) was added to both records 2026-09-24, closing the attribution gap: under one shared token a call is attributable to its client session (asserted in unit tests and the hardening probe). POST /blob's sid counts only when this bridge issued that session id and it is still live; anything else records null (2026-10-10) — a caller-chosen value is a claim, not attribution, and rejecting instead would make the bridge decide who may upload. Three 2026-10-10 additions: audit write failures are swallowed but no longer silent (first failure per log path prints to host stderr, then every 100th, counter auditWriteFailures() — an unwritable log looks exactly like a bridge that was never called); the blob:write record lands BEFORE the response reads the file's size back, since evidence an endpoint depends on as its only trace may not sit behind a throwable response-decoration step (a failed read then costs the `size` field, not the record, and the response stays 200 because 5xx would send a chunking client into a double-append retry); and unauthorized attempts are deliberately never written to the audit file — rotation is the only lever pre-auth traffic could use to age real records out of the one-generation window — they go to host stderr instead, first one and every 50th.

## Q7 Session & protocol (decided 2026-09-23)
Mandatory sessions: every non-initialize message must carry Mcp-Session-Id — missing returns 400, unknown or idle past 24h returns 404, and every hit refreshes the idle TTL (header omission is not a bypass). The map is bounded at 64 sessions with least-recently-seen eviction, because abandoned clients never return to be purged. Auth runs before every state-touching branch, so an unauthenticated DELETE cannot terminate sessions. initialize always answers protocolVersion 2025-11-25 instead of echoing whatever the client asked for, and jsonrpc must be exactly "2.0" (else 400). A configured port already in use falls back to an ephemeral port WITH a warning, since remote mcp.json pins the old port. POST /blob consults the same map for attribution only (2026-10-10): an id this bridge never issued does not reject the upload, it just records as `sid: null` in the audit; a live issued id refreshes the idle timer like an MCP-path hit.

## Notable verified facts
- MCP SDK not installed anywhere: bridge hand-writes JSON-RPC on Bun.serve, zero deps.
- AgentToolContext required fields (sessionManager/modelRegistry/model/isIdle/hasQueuedMessages/abort) are all reachable from public surfaces: AgentSession.settings/.sessionManager/.modelRegistry/.model + ExtensionContext ui/hasUI/isIdle/hasPendingMessages/abort.
- Main is registered into AgentRegistry.global() by createAgentSession in ALL modes (sdk.ts:1745,3321), so tools/call works in TUI and headless alike (headless prompt tier fails closed when policy requires UI — see Q3 reversal for exact protocol behavior).
- Host MCP client pages tools/list with do-while on nextCursor (mcp/client.ts:233); omitting nextCursor is valid.
- @oh-my-pi/* specifiers in extensions are rewritten at runtime by omp's `omp:legacy-pi-shim` Bun onResolve plugin (regex ^@(oh-my-pi|mariozechner|earendil-works)/(pi-agent-core|pi-ai|pi-coding-agent|pi-natives|pi-tui|pi-utils)(/.*)?$) to the host's bundled modules. AgentRegistry.global() is a MODULE-level static, so a second copy loaded from node_modules would fork the registry and tools/call would see no Main session — hence those packages belong in devDependencies only, pinned to the host omp version, never relied on at runtime.
- omp's Streamable HTTP client throws Transport not connected from notify() unless a session id exists, and attaches Mcp-Session-Id to every post-initialize request: strict session enforcement cannot break omp's own client.
- Approval probes (2026-09-24, omp 18.2.10, --mode rpc, default settings): default approvalMode yolo -> remote bash EXECUTED in 0.03s (README 「审批 / Approval」 yolo bullet confirmed). With --approval-mode=always-ask: read auto-approved (17-30ms), bash hung >=90s, side-effect file never appeared, server answered ping 200 afterwards. Probe committed as test/approval-probe.ts (exit 1 on fail-open/unexpected return/audit-invisible); hardening probe committed as test/hardening.ts (29 checks incl. two-phase pairing and sid-attribution assertions).
- Version state 2026-09-24 (corrected): host omp is 18.2.10 (omp --version + global pi-coding-agent/pi-ai all agree); devDep pin + bun.lock + node_modules are 18.2.10 — the "pin == host" invariant HOLDS. The earlier "host 18.2.11" claim was wrong: 18.2.11 is the registry latest, not the installed version. The real anomaly was repo node_modules at 18.2.11, desynced from its own lock, healed via bun install (tsc + tests green under both versions). Guard added: test/versions.test.ts hard-asserts exact pins and installed==pin, warns when omp --version != pin.
- Typing the execute() context against the host SDK depends on pi-coding-agent's AgentToolContext augmentation being loaded: the `import type {} from "@oh-my-pi/pi-coding-agent/tools/context"` in src/bridge.ts merges the CustomToolContext required fields (sessionManager/modelRegistry/model/isIdle/hasQueuedMessages/abort) plus ui/hasUI into the interface. Mutation-verified 2026-09-24 (deleting abort from the literal fails tsc); deleting that empty import silently degrades the check to vacuous (the pi-agent-core base interface is all-optional), so keep it. Related: pi-ai Static<TSchema> = unknown (execute args need no cast) and ToolInfo.parameters is TSchema (flows typed into toolWireSchema) — the three historical `as never` casts were removed 2026-09-24.

- Version state 2026-09-28: host omp upgraded to 18.4.0; node_modules again drifted ahead of lock via the same unknown mechanism (installed 18.4.0 vs lock/pin 18.3.2). Guard caught it; pins synced to 18.4.0, lockfile rewritten. Regression on 18.4.0 all green: tsc 0 errors, unit 59/59, biome clean, SMOKE OK (21 tools), HARDEN OK 29/29, approval probe VERDICT B (bash hung 90s, no side effect, server alive, audit start=1 done=0). pin==host invariant current value = 18.4.0.

## Q8 修订 — 文件面代码评审修复（2026-09-30）~~ — **SUPERSEDED 2026-10-01**

> **已作废。** 整个文件传输面（`filetools.ts` / `fileguard.ts` / 6 个 `a2a_file_*`）已删除。以下保留为历史记录——那些 P1 缺陷本身是真实的，它们说明的是「这个状态机不该存在」，而不是「该修好它」。

评审发现 4 项文件面缺陷 + 1 项版本漂移，全部修复并加了回归测试。逐项的「为什么」比「改了什么」更重要，因为它们都是**评审读不出来、只有探针能抓**的：

- **分块写入必须串行 + 重传必须幂等**（P1，唯一的数据完整性问题）。旧实现读 `expectedSeq` 校验、却在 `await appendPart` 之后才自增——同一 seq 的两个并发请求都能过校验并都写入；未声明 `totalBytes` 时 `put_end` 报**成功**而文件已是双倍内容。**根因是需求自身矛盾**：README 要求调用方自设超时（无 UI 时 `prompt` 审批挂起 ≥90s），而超时重试正好并发打出两个相同 seq。修法不是「拒绝重试」，而是承认重试是常规动作：同一 transfer 的变更步骤（`put_chunk`/`put_end`）走一条 Promise 链串行化，同 seq 同字节按已收处理（返回 `duplicate: true`），同 seq 换内容才 `bad_chunk_order`。队列吞掉拒绝，单步失败不卡死后续分块。**教训：「调用方必须自设超时」这个文档承诺，同时规定了幂等性要求**——写下前一句就得写下后一句。
- **串行化自己又带进第二个竞态：排队中的步骤必须重验活性**（P1，评审修复之后才由对抗探针抓到）。`requireTransfer` 在**同步**阶段取出记录，而变更本体稍后才在队列上跑；两者之间若一次 `put_end` 成功提交并已 `rename` 走暂存文件，排队中的 `put_chunk` 就往一条**已被改名掉的死路径**上 append——`appendFile` 会重新创建该文件，返回 `{"ok":true,"receivedBytes":12}` 而已提交文件仍只有前 8 字节：**字节静默丢失**，且在 `.tmp` 留下一份永远无人回收的孤儿 `.part`。修法：`Transfer` 自带 `id`，串行步骤内先 `requireLive(tr)`（比对 map 里仍是同一条记录）再动手。**教训：把「检查」与「动作」拆到两个时序阶段（同步取记录 / 异步执行动作）时，前者的结论会过期——凡是这种形状，异步动作开头都要重验一次。修完 P1 要立刻重新对抗，因为修复本身会制造新的竞态。**
- **状态受会话约束 ≠ 字节受会话约束**（P2）。传输绑定 `Mcp-Session-Id`，但暂存字节就是 `<root>/.tmp/<uuid>.part` 普通文件；`.tmp` 只在 `list(".")` 被过滤，直接按路径访问不受限，于是任何客户端都能枚举他人 `transferId`、读取在途字节、`put` 改写其暂存文件让对方 `put_end` 落成攻击者字节。修法：首段为 `.tmp` 一律 `invalid_path`（嵌套 `sub/.tmp/x` 合法）。**凡是「按 id 授权」的状态，旁边一定还挂着一条按路径可达的数据路径**——两者都要封。
- **错误码契约必须覆盖兜底分支**（P2）。`guarded` 只翻译 `FileOpError`，其余原样抛出并被 `bridge.ts` 当工具结果文本返回，于是 `ENOTDIR`/`EISDIR` + 宿主绝对路径直达调用方：既违反本项目自己的「500 body 不得泄露宿主内部」立场，又让按 `a2a_file_error <code>` 解析的客户端失效。修法：兜底码 `io_error` + 固定无路径文案，细节只进宿主 stderr。**协议里承诺了「一律是 `<code>`」，就必须给「非预期异常」也留一个码。**
- **`get` 的 sha256 语义要选对层**（P3）。旧实现每页重算**整文件**哈希：100MB（默认 `maxFileBytes`）实测 30.4s 纯哈希 / 400 页，而每页只传 256KB——读放大 400 倍且随文件平方增长，正好卡在协议自己宣传的大文件场景上。改为**本次区间**摘要（0.9s）。`totalBytes` 仍表整文件大小，两者分工写进 protocol.md。
- **`list` 也要拒符号链接**（P3）。只过滤了子项，目标本身用 `stat`（跟随）检查，根外目录的文件名/大小/mtime 因此泄露；内容始终被 `resolveInRoot` 的 realpath 包含性挡住，故此前仅元数据泄露。

## 版本漂移的第四次复发与强制关口（2026-09-30）

node_modules 漂移同一未知机制再次复发（宿主已到 18.4.4，pin 仍 18.4.0），版本守卫如期捕获，pin+lock 同步至 18.4.4。三次复发后加了 `.github/workflows/ci.yml`（`bun install` + typecheck + lint + test）：CI 下 frozen-lockfile 安装把「pin 与 lockfile 不一致」提前到**提交时**失败，而不是等到某人下次跑 `bun test` 才发现。**靠单测事后捕获一个反复复发的不变量，是把守卫放在了太靠后的位置。**

## 方法论：这份代码要靠探针评审，不能靠读

100 个单测全绿时，上述缺陷**全部存在**。逐条静态阅读都能自圆其说——`.tmp` 只在 `list(".")` 过滤看起来是「已隐藏」，`stat` 看起来是「常规存在性检查」，每页算哈希看起来是「顺手给出完整性」。它们只在**跨进程/并发的实际调用**下暴露。这与既有记录一致（`put_end` 不建父目录也是真实宿主探针抓到的，单测当时全绿）。更要紧的是第二轮的教训：**P1 修完立刻又用对抗探针（8 路同 seq、200 块长传输、40 路并发 start、排队 vs 提交）打了一遍，才抓到修复自身引入的活性竞态**——第一轮的全绿并不代表修复没有副作用。评审这类文件面/并发代码：先写复现探针再下结论，修完再打一轮对抗，单测全绿不构成正确性证据。

## 文档语言分工（2026-09-30 决定）

`README.md` = **英文**（GitHub 默认展示、_ZN 惯例下的基础名即默认语言），`README_ZN.md` = 中文。顶部互相链接：英文版 `[简体中文](README_ZN.md)`，中文版 `[English](README.md) | 简体中文`。

**文档站仍然渲染中文**：`website/scripts/sync.mjs` 改为读 `README_ZN.md`（不是 README.md），并剥掉那行语言切换（站点单语言，站点内不需要切换入口）；标题仍是「使用指南」。若改成读 README.md，站点会在中文导航「指南」下显示英文，且 `[English](README.md)` 会指向站外不存在的路径。

**教训（与 brain 里那 3 处 README 行号引用同源）**：文档之间**不要用行号互引**——README 改一次行号就全断。Q3 段落里原有 `README:103` / `README:105` 两处硬编码行号，已在 compiled_truth 内改为章节引用（「审批 / Approval」）。但 timeline 里的 3 处（append-only，历史证据）**故意保留行号不改**：timeline 记录的是「当时的事实」，改它就是篡改证据；这 3 处的失效不影响任何人，因为它们描述的是 2026-09-24 那天的状态。

## 安装方式（2026-09-30 更正）

**跨机器安装用 `omp install https://github.com/adam-ikari/pi-a2a-ext.git`**（装到 `~/.omp/plugins/node_modules/pi-a2a-ext`，`omp plugin uninstall pi-a2a-ext` 卸载）；本地开发用 `omp install .`，但它是**测试夹具、不是受支持的安装方式**；`scripts/install.sh` 已于 2026-10-02 删除（自己维护一份模块图校验正是它的病灶），不要再当它是等效替代。`scripts/bootstrap.sh`（2026-10-18）是**引导**，不是第二条安装路径：它先按 `package.json` 的 pin 用上游官方安装器（`omp.sh/install`，`--binary --ref v<版本>`）把宿主编上——PATH 上已有 `omp` 就报告版本不动它——最后执行的就是上面那条 git URL 原文，连插件登记好不好都问宿主自己的 `omp plugin doctor`，脚本不重新发明判据。2026-10-19 起它有一个写在安装器之外的例外，条件压得很窄：只有这一趟真的由脚本装了宿主、且 `<HOME>/.omp/agent/models.yml` 不存在，才写那份占位文件（create-only，见「零模型配置的机器」一节）；PATH 上已有 `omp` 的机器一个字都不碰。

`omp install` 的 spec 限制（实测）：接受**本地目录或 git URL**，**不接受 `.tgz`**（报 `ENOTDIR: ... .tgz/package.json`）；GitHub `owner/repo` 简写被当作非法包名（`Invalid package name`），必须用完整 `https://….git` URL。装的是**远端代码**，所以本地提交未推送时，装到的是旧版本——2026-09-30 就因此先装到 `@undefined` 再重装才拿到 `0.1.0`。

**包必须自包含才能跨机器安装**：`package.json` 需要 `version`（缺了 `npm pack` 直接失败、`omp plugins list` 显示 `@undefined`）、`pi.extensions`（加载开关）、`files: ["extensions/", "src/"]`（入口 import 的是 `../src/*.ts`，两者缺一则装上也起不来）。不需要打包 `node_modules`：`@oh-my-pi/*` 由宿主 `omp:legacy-pi-shim` 在运行时重定向到宿主内嵌副本。tarball 实测 12 文件 25.8kB。

**验证方式**：用独立 `HOME`（无 config/token/沙箱）+ 复制一份 `models.yml` 模拟另一台机器，装完启动宿主确认起桥并自建独立 token 与沙箱。（`--status` / `--uninstall`，`OMP_AGENT_DIR` 可改位置）。原句「omp 在无模型配置时会先退出、根本不加载扩展」2026-10-19 在 18.12.1 上重测（临时 HOME、无 `models.yml`、无 `agent.db`），只对一半：**无头 `--mode rpc`** 确实在扩展代码之前就死在 `resolveModelDiscoveryFallback`，磁盘上没有模型配置救不了它；**交互式 TUI** 照样创建 session、扩展照常加载、桥照常广播，那句 `No model selected` 是提示时刻的闸门（agent-session 的 `if (!this.model) throw`），拦的是操作者自己的 prompt。探针照常给 `models.yml`（harness 播种不可达 provider）；必须给文件才测得到的是无头那半程。

**此前 README 的 `ln -s "$PWD/extensions/a2a-bridge.ts" ...` 是错的**：该写法依赖调用者的 `$PWD` 恰为仓库根目录，换个目录执行就会链到不存在的路径（实测 `cd /tmp` 后链成 `/tmp/extensions/a2a-bridge.ts`），宿主加载失败但**没有任何用户可见报错**——桥只是永远不出现。**教训：文档里给出的命令若隐含「你得先 cd 到某处」这个前提而不校验，用户会踩到静默失败；安装脚本应自己推导路径并在结束时校验。**

### 更正一：`omp install .` 才是首选，`pi.extensions` 是它的开关（我曾误删）

**`omp install .` 从仓库根执行即可**（等价于 `plugin install`/`plugin link`），把仓库软链到 `~/.omp/plugins/node_modules/pi-a2a-ext` 并注册；`omp plugin uninstall pi-a2a-ext` 卸载。**它依赖 `package.json` 的 `"pi": { "extensions": ["./extensions/a2a-bridge.ts"] }`**——删掉该字段后 `omp install --json` 的 `manifest` 变成 `{}`，宿主**完全不加载**任何扩展（实测）。

**我一度把该字段删掉并写进 CHANGELOG 说它「无效」，那是错的，已回滚。** 错因：我拿 `omp plugins list` 的输出当判据（它只列**已安装 npm 插件**，与 manifest 解析无关，我这个仓库不是 npm 插件所以查不到），而**真正的判据是 `omp install --json` 的 `manifest` 字段 + 宿主是否真的加载**。同款错误此前已在版本漂移那轮出现过一次（拿 `omp --version` 与 registry latest 混淆）——**同一个错误模式：拿「列表里没有」当「机制不支持」。**

对照证据：可用插件 `@better-compact/pi` 的 package.json 同时有 `pi.extensions` / `omp.extensions` / `main` / `exports` / `files` / `keywords:["pi-package",...]`。

### 更正二：单文件软链不构成障碍（曾误判）

扩展入口 import 的是 `../src/*.ts`，但 Bun 解析相对导入前先 `realpath` 软链，因此软链能正确落到仓库的 `src/`（实测宿主正常起桥）。曾误判此处会断链，**靠实际安装 + 启动宿主才确认可用**。`scripts/install.sh` 连同它那份模块齐备检查已于 2026-10-02 删掉，齐备性由 `test:install` 走相对 import 图守着。

脚本自身的两个非显然细节：`--status` 判活必须用 `readlink` 原始目标 + `[ -e ]`，**不能用 `readlink -f`**——后者对悬空软链输出空串并非零退出，会让断链显示成「已安装」。安装目标若是真实文件（用户自己的扩展）一律拒绝覆盖。
## 守卫失效的两种形态（2026-10-01）

本仓库的 CI 从 `5107bad` 起就是红的，持续 9 天没人处理——`bun run lint` 报的是 `.agents/skills/design-doc-mermaid/.claude-plugin/plugin.json` 与 `skills-lock.json` 两个文件的 **format**（上游用空格缩进，`biome.json` 配的是 `indentStyle: "tab"`），**零逻辑缺陷**。已定位到引入提交：`5107bad` 之前 `biome check .` 是 25 文件 0 错误，之后 3 错误。

**这与版本漂移是同一个模式。** 那次的教训是「靠单测事后捕获一个反复复发的不变量，是把守卫放在了太靠后的位置」；这次更靠前一步——**守卫彻底失效，且因为它一直红，反而没人发现**。一个必然失败的检查等于没有检查：它不提供信息，只提供噪音，人看久了就学会无视红灯。**「CI 一直红」和「CI 一直是绿的但没检查该查的东西」是同一种失效，都表现为「没人发现问题」。**

修法不是格式化那两个文件（下次重装 skill 会被覆盖），而是**把它们移出 biome 管辖范围**：`biome.json` 的 `files.includes` 加 `!.agents` 与 `!skills-lock.json`。依据是 gitignore 与 biome 划的是**两个不同维度**——gitignore 管「不该进版本库」，biome 管「该由本仓库负责」。`.agents/` 与 `skills-lock.json` 是外部 skill 安装器的产物，和 `node_modules/` 同类，只是恰好被提交进了版本库；提交进 git 只改变它被追踪的状态，不改变它的来源。`!.agents` 按目录排除，覆盖将来安装的任何 skill（已实测：新建 `.agents/skills/fake-skill/plugin.json` 后 lint 仍绿）。注意 biome 2.2.0 起忽略目录**不写** `/**`，写成 `!.agents/**` 会触发 `lint/suspicious/useBiomeIgnoreFolder`。

**教训：发现守卫失效时，先问「它为什么失效」，而不是逐个修它报出的错。** 逐个修是治标，且下次重装即复发。

## 极简化（2026-10-01 决定，推翻 Q4 与 Q8）

四条原则：**极简 / 不重复造轮子 / 不替 omp 实现沙盒 / 不替 omp 管权限。** 桥缩回接口转换器，源码 1460 → 655 行。

**Q4 的 `deny` / `denyMCPTools` 取消。** `tools/list` 就是 `pi.getAllTools()`，**原样透传不过滤**——含 `hidden` 工具、也含宿主当前对自己模型禁用的工具。**omp 是什么权限，桥就是什么权限。** 理由不是「更简单」，而是 `deny` 是第二套权限名单：它与宿主自己的工具配置可以互相矛盾，而代码里没有定义冲突时谁优先（`src/bridge.ts` 只做 `isDenied` 短路，宿主侧管不到）。配置只剩 `port` / `host` / `token`。

**Q8 整个文件传输面删除**（`src/filetools.ts` 460 行 + `src/fileguard.ts` 215 行 + 6 个 `a2a_file_*` + 11 个错误码 + 37 处传输状态机）。三条理由：**(1) 重复造轮子**——远程本来就能调宿主 `bash`，`cat` / `base64 -d >` / `ls` / `dd` 分别覆盖 get / put / list / 分块。**(2) 沙盒是替 omp 做的**，而桥自带工具**绕过宿主审批门**（`src/bridge.ts` 原注释：bridge tools bypass the host's approval gate）——绕过审批就得自带隔离，两者同源，所以要一起删；只删沙盒会留下「谁都不管」的洞。**(3) 代价可量化**——675 行实现 + 1216 行测试（测试是实现两倍），且状态机自己生产了两个 P1：seq 校验 TOCTOU 致并发重试静默写坏文件、串行化修复自身引入的活性竞态。

保留的有价值判断（不随删除作废）：**执行必须走宿主原生 `getToolByName().execute()`，注入真实 `session.settings` 与 `ExtensionContext ui`**，这样宿主的 `ExtensionToolWrapper` 审批门照常生效——桥自己一套审批逻辑都不实现。**调用与列表同源**（`tools/call` 只接受出现在 `tools/list` 的名字，别名 `xd://bash` 与未注册名一律 `not exposed`，且不区分「被过滤」与「不存在」）这条不依赖 `deny`，仍然成立。

代价（如实）：100MB 文件不走 MCP 通道（走 SSH/`scp`，README 早已这么建议）；原子落盘（`.tmp` + `rename` + 0600）没有了，远程写文件用宿主的 `edit`/`bash`；远程会看到 `hidden` 工具——这是「不过滤」的必然结果。

**教训：桥自带工具绕过宿主审批门，所以不得不自带沙箱——这是一个决定的两个后果，要一起删。** 只删其中一个，会得到一个比原来更糟的中间态。



## 传文件的两个外部二进制：从「只命名」改为「缺的自己按钉值拉」（2026-10-17 修订，2026-10-19 补上 win32）

`xfer_share` / `xfer_status` / `xfer_stop`（`src/xfer.ts`）由桥自己服务，追加在宿主注册表之后，因此绕过宿主审批门；字节走普通 HTTP——dufs 在 `127.0.0.1` 上以随机端口和随机 basic auth 起服务，cloudflared quick tunnel 给它一个公网主机名。

这条 2026-10-17 翻了面：原先的契约是「二进制只命名、不内置、也不下载」，现在是**缺的那一个由桥自己拉进它自己的安装目录**：POSIX 是 `~/.local/bin`，Windows 是 `%LOCALAPPDATA%\a2mcp\bin`。unix 那一支一个字没改，因为它是文档写死的位置、也是 `test:obtain` 断言的一部分；Windows 选 `LOCALAPPDATA` 而不是 `USERPROFILE\.local\bin`，因为那才是 Windows 上放东西的地方，而且与官方安装器写宿主的 `%LOCALAPPDATA%\omp` 同处。（操作者定死，dufs 与 cloudflared 都要，触发点是首次 `xfer_share`）。解析顺序四步：配置里的值含 `/` **或 `\`** 就原样用且**绝不下载**（这是「这台机器永远不许下载」的唯一出口，裸写 `"dufs"` 不是出口；只认 `/` 的那一版会把 `C:\tools\dufs.exe` 当裸名字送去查 PATH，等于把一句「不许下载」读成「去下载」）→ 在 `PATH` 上逐段找可执行文件（不起 shell、不 `which`，机器有就别抢；Windows 按 `PATHEXT` 的后缀逐个试，取不到就用 `.EXE;.CMD;.BAT;.COM`）→ 安装目录里那个文件（Windows 上叫 `<name>.exe`）已存在、且它自己的 sha256 等于登记里桥为这一条写下的那一行，就复用 → 下载。

钉的是版本 + **归档** sha256 的字面量表（GitHub release 资产 `digest` 是归档的哈希，不是解出来那个文件的；对完归档才解包，解出来那份自己的 sha256 另写进登记，所以「哈希等于钉值」这种说法本身是错的，两个哈希不同名）（`src/obtain.ts`，键 `${platform}-${arch}`）：dufs 0.46.0 与 cloudflared 2026.10.1 各**五**行（linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64 / win32-x64）。前四行的哈希取自 GitHub release 资产的 `digest`（cloudflared 那四行是 2026-10-17 出网恢复之后才读回来的，四个 asset 都真下载、哈希对着从头到尾的字节复算过）；**没读到的哈希不写进表**这条仍然照着办：那天之前表里那一半是空的，桥对 cloudflared 就还是只认 PATH。win32-x64 那两行的来历见本节末。形状差别记在 `kind`：dufs 的 unix 四行是 `.tar.gz`、Windows 那行是 zip 里唯一的 `dufs.exe`；cloudflared 的 Linux 是裸 ELF、macOS 是里面只有一个 `cloudflared` 的 `.tgz`、Windows 是裸 `.exe`；取的都是普通构建不是 `-fips`。不变的约束：不请求 `latest`，不向发字节的同一台服务器要校验和，不覆盖别人的文件（目标已存在、它的 sha256 与登记那一行不等就拒绝，并把文件自己的哈希与钉值一起打印），下载有界（64 MB、120 秒。上限按钉表里最大的 asset 留余量这条没变，变的是那个最大的 asset——2026-10-19 之前是 cloudflared 的 Linux 构建 40 MB，之后是 Windows 那个 52.7 MB 的 `.exe`，余量剩 11.7 MB；120 秒没有在它身上重测过，那是本机手跑 Linux 构建 rounded up 来的墙上时钟，53 MB 要在里面走完约需 450 KB/s，Windows 主机网络差就得到一条超时审计而不是一次慢共享。），同一 name 并发单飞，解包分两条：`.tar.gz` 只进新建的临时目录并 realpath 断言包含性，`.zip` 由本仓库自己的读取器（`readZipEntry`）在内存里取出那一个条目、一个字节都不落盘——条目名不参与拼路径，于是 tar 那套越界检查对它不是放松，是问题消失了；代价是自己防 zip 炸弹（方法只收 0 与 8，条目声明的长度与 inflate 出来的实际长度都对着上限过，zip64 与带加密位的条目直接拒），不复算 CRC，因为整包 sha256 已经比对过、那里没有第二个信任源。这一条的由来是判据不是偏好：本机的 GNU tar 打不开 zip，Windows 自带的 bsdtar 读得动，却是这台机器一次也执行不了的调用——把一个本仓库永远走不到的分支写进安全检查里，正是「校验看着在、其实没人跑过」那种洞。安装排在审计之后（`tool: "xfer"`，`action: "install"`，遵守 2026-10-10 那条「唯一痕迹不能排在可能抛错的步骤后面」），每次安装另记一行 `<agentDir>/a2mcp.installs.json`，复用看的是它。平台不由函数自己去读 `process.platform`，而是从 `ObtainDeps.platform` 注入（与 `target`/`pins`/`env`/`binDir` 同一个性质），为的是这台 Linux 机器能把 win32 那几处分支测到；写文件的 `mode: 0o755` 留在原处，它在 Windows 上是 no-op（NTFS 上没有执行位），注释里标明它是 POSIX 位。回包多一个 `installed: {dufs, cloudflared}`，让调用方知道自己为什么多等了几秒；下载就地等完，没有「正在装，稍后再来」的中间态。

判据写在 AGENTS.md 的例外清单里（现在三条），形状与 `POST /host-llm` 一样：桥已经替宿主决定了用 dufs，这次只多一个意见——字节从哪来——而不是多一个权威。代价如实是审计、文档，和那个只有显式路径才成立的出口。升级钉版本就是改这个仓库的一次带哈希的提交，这是刻意的：不要无感漂移。

**钉表按上游 asset 的形状增删，不按对称增删**：`win32-arm64` 不建行，因为 dufs 发 aarch64 的 Windows 构建而 cloudflared 不发 arm64 的 exe；一次 `xfer_share` 要两个二进制，补一半就是造一台装到一半的机器。那句既有的「no pinned build for `<target>`」是这件事的正确说法，代码不替上游的 release 列表编理由。

**没执行过的那一半必须自己站出来**：win32-x64 那两行钉值是 2026-10-19 在这台 Linux 机器上整包下载、本地算 sha256 写下的（dufs 不发校验和，那一行只有本机复算这一个来源；cloudflared 在 release 正文里给 digest，复算与它相等——是「自己算完对上了」，不是「抄来了」；两行都拿 release API 报的 `size` 对过字节数）。`test:obtain` 里四项把它们当字节读（zip 哈希对上、`readZipEntry` 找得到那 4 721 664 字节的 `dufs.exe`、`.exe` 前两个字节是 `4d5a`、总长在 64 MB 之内），可这台机器跑不了 Windows 二进制，所以桥在 win32 上的第一次 `xfer_share` 会发生在别人的机器上。同一形状的第二份是 `scripts/bootstrap.ps1`：2026-10-19 真 Windows 机器头一遍跑了它——`PATH` 上已有宿主那一支，DryRun 与真跑都走完，真跑停在宿主自己的 `plugin doctor` 回 `✔ plugin:a2mcp: v0.4.0`。支级别的边界随之写进文件头、README、`docs/testing.md`：官方安装器那一次调用与占位 `models.yml` 那一次播种至今没有任何地方执行过；`bun test` 那十三项仍只把它当文本读、与 `.sh` 对字面值，真机那遍是手工一次性、不在 CI 里，往里放一个语法错误，十三项照样全绿。

## 零模型配置的机器：桥填占位模型，磁盘那半归引导脚本（2026-10-19 决定）

`src/auto-model.ts`：每个 `session_start` 上，Main 会话的 `session.model` 是空的，就注册一行占位 provider `a2mcp` / 模型 `offline` 并 `agent.setModel` 选它。三条线是这个决定的形状：**只填空位**——宿主已有模型时零动作，不覆盖操作者的选择；**纯运行态**——不写 `agent.db`、不 override settings、一个字节的文件都不写，与 takeover 的 setModel 同性质；**sourceId 是 `a2mcp-auto-model`，不能等于 takeover 的 `a2mcp`**（`TAKEOVER_SOURCE`），否则 restore 的 `clearSourceRegistrations` 会把占位行一并拔走。宿主的 `syncExtensionSources` 每次新建 session 都剪扩展来源的注册，所以这件事每个 `session_start` 重放一次，幂等形状与启动装 deny 的 rearm 同款。

baseUrl 选 `http://a2mcp.invalid/v1`（RFC 6761 保留域），不是 `127.0.0.1:1`：deny 绊线的键集来自快照里各 provider 的 `baseUrl`，loopback 进键等于把桥自己监听地址也放进去。inline `apiKey: not-a-real-key` 算 concrete auth，过了 `getApiKey` 那道第二闸门——pty 真发 prompt 证的（18.12.1）：报错是 `Couldn't connect to a2mcp.invalid (connection refused)`，不是 `No API key found`，transcript 里 `provider=a2mcp model=offline stopReason=error`。与 deny 的同场也测了：`host_llm: "deny"` 且占位行在位时 `test:takeover` 照样全绿——占位行不带 `transport`，不触发那条「拒绝装配」判据。

它翻的是报错的硬度，不是能力：占位模型不产生推理，操作者的 prompt 从提示时刻的硬报错变成连接被拒的软失败，文档按这个措辞写。救不了的那条道是无头启动——扩展代码根本没跑，桥做什么都晚，那一半归 `bootstrap.sh` / `bootstrap.ps1` 的 create-only 占位 `models.yml`（只在脚本自装宿主的分支写）。这推翻了「bootstrap 除调用安装器与宿主自己的命令外不写文件」的定位，timeline 记了 reversal。Windows 一侧的播种未执行：占位模型的运行时形状在本机 Linux 宿主 18.12.1 实测，ps1 真机首跑（2026-10-19）过的只有「已有宿主」那一支，播种那半仍只有十三项字面核对。
## 隧道开着时的公网地址：工具只读，不开（2026-10-20 决定）

0.6.0（a3417df）把隧道收归 `/a2mcp tunnel` 之后，共享回包里就没有公网地址了：`url` 是宿主自己的回环 origin（`http://127.0.0.1:<桥端口>/xfer/`），在远端机器上指向远端自己；公网入口只有操作员那条隧道，而 `xfer_share` / `xfer_status` 都不带它，工具描述只写「公开主机名出现时走同一路径」，不给具体主机名。远端 agent 拼不出文件地址，自己起一条隧道是它能想到的最短路径——那不是桥的漏洞，是回包没给它能用的地址。回包里若还出现 `user` / `secret` / `host`，那是宿主还跑着 0.6.0 之前的版本（那版每次共享自带一条 cloudflared），判据是 `initialize` 回的 `serverInfo.version`。

判据与落点：**工具不自己开隧道**这条不变（持 token 的调用方不能绕过操作员把宿主文件发布出去），但**读一个已经存在的状态**不新增暴露面——隧道是操作员开的，主机名本来就不是秘密（`docs/protocol.md` 的隧道审计里就写着它）。所以 `src/xfer.ts` 的 `XferDeps` 多一个 `publicUrl` getter，`extensions/a2mcp.ts` 把它接到 `mcpTunnel?.url ?? null`；`xfer_share` 与 `xfer_status` 的回包多一个 `publicUrl`（`https://<随机>.trycloudflare.com/xfer/`，隧道没开是 `null`），读的是调用那一刻的状态——隧道在共享期间开或关，`xfer_status` 立刻跟着变。隧道没开时 `usage.public` 不给地址，改成点名两条路：SSH 端口转发到桥端口，或者请操作员跑 `/a2mcp tunnel`。工具描述也按这个改口：隧道开着时 `publicUrl` 就是同一路由在那条主机名下的地址。

**教训与既有那条同源**：一条「不自己开隧道」的边界容易被读成「工具不提隧道」。前者是**不制造新的暴露面**，后者是**不告诉调用方已经存在的暴露面**——后者恰恰让远端 agent 自己去造了一条。回包里少了什么，比多写了什么更容易被当成漏洞。


## Timeline

- time: 2026-09-10T09:16:34
  kind: decision
  summary: "Created this page: A2A MCP bridge architecture"
  source: brainstorming session 2026-09-10
  affects: [a2a-mcp-bridge]

- time: 2026-09-10T09:16:34
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: spec docs/superpowers/specs/2026-09-10-a2a-mcp-bridge-design.md
  affects: [a2a-mcp-bridge]

- time: 2026-09-10T09:56:50
  kind: decision
  summary: "spec approved; implementation plan written to docs/superpowers/plans/2026-09-10-a2a-mcp-bridge.md (T1-T9, zero-dep Bun.serve JSON-RPC, execution via AgentRegistry Main session)"
  source: plan commit 72bc255
  affects: [a2a-mcp-bridge]

- time: 2026-09-10T16:42:33
  kind: evidence
  summary: "implementation complete: T1-T9 done; tsc 0 errors; server_stub 15 assertions; real-host smoke SMOKE OK (omp 18.1.16, 21 tools, tools/call read on real Main session)"
  source: implementation session
  affects: [a2a-mcp-bridge]

- time: 2026-09-23T04:31:03
  kind: decision
  summary: "P1/P2 review hardening folded into Q4/Q5 + new Q6 (config & audit) and Q7 (session & protocol); 3 runtime facts added"
  source: project review 2026-09-23
  affects: [a2a-mcp-bridge]

- time: 2026-09-23T04:31:41
  kind: evidence
  summary: "verification of hardening: tsc 0 errors; bun test 54/54 (protocol/auth/config/exposure/audit, incl. idle-TTL-refresh regression and session-cap eviction); real-host E2E smoke SMOKE OK (21 tools, tools/call read on live Main session)"
  source: test runs 2026-09-23
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T01:26:04
  kind: decision
  summary: "Q3 protocol behavior reversed (prompt+no-UI hangs, not isError); Q6 audit scoped to completed calls; approval-probe and version-drift facts added"
  source: meta-review 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T01:26:04
  kind: reversal
  summary: "Q3 reversed: prompt-tier tools/call in no-UI mode hangs >=90s instead of returning isError, writes no audit line, and src/ has no watchdog — fail-closed holds only in the no-execution sense; README:105 pending correction"
  source: approval probe verify-approval2.ts 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T01:26:04
  kind: evidence
  summary: "approval probes: default yolo executes remote bash in 0.03s; always-ask auto-approves read (17-30ms) and hangs bash >=90s with no side-effect, server alive; host 600000ms timeout belongs to login input not approval"
  source: verify-approval.ts / verify-approval2.ts 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T01:26:04
  kind: evidence
  summary: "version drift: host omp 18.2.11 vs pin/lock 18.2.10; node_modules was 18.2.11 desynced from its lock, healed via bun install; tsc + 54 tests green on both versions"
  source: bun install / tsc / bun test 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T02:02:53
  kind: decision
  summary: "Q3 README correction done; Q6 audit redesigned two-phase (start/done paired by id); host-version claim corrected (18.2.10, invariant holds); version guard + committed probes recorded"
  source: post-review fix session 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T02:03:04
  kind: reversal
  summary: "Meta-review's version finding corrected: host omp is 18.2.10 (omp --version + global pi-* agree), not 18.2.11 — 18.2.11 was registry-latest, not installed; pin==host invariant holds; only the node_modules/lock desync was real (already healed)"
  source: "version recheck 2026-09-24 (omp --version, global node_modules)"
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T02:03:04
  kind: decision
  summary: "Two-phase audit adopted (start at dispatch, done on completion, paired by id) superseding the completion-only amendment; version-guard test added (installed==pin hard-assert, omp --version mismatch warns; pins stay 18.2.10); approval + hardening probes committed under test/; README corrected (approval hang semantics, two-phase audit, yolo token=full tool-execution authority)"
  source: post-review fix session 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T02:03:04
  kind: evidence
  summary: "verification: tsc 0 errors; bun test 59/59 across 5 files (probes not auto-discovered); SMOKE OK; HARDEN OK 28/28 incl. start/pairing audit checks; approval probe VERDICT B — 90s hang, no side effect, server alive, audit start=1 done=0, exit 0"
  source: test runs 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T03:42:16
  kind: decision
  summary: "Second-round P3s implemented: audit records carry Mcp-Session-Id (Q6 attribution gap closed), 500 body genericized, three as never casts removed (ctx mutation-verified), MIT license, Biome lint/format; rate limiting explicitly declined for v1"
  source: P3 follow-up review 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T03:42:16
  kind: evidence
  summary: "verification: tsc 0, bun test 59/59, biome lint clean, SMOKE OK, HARDEN OK 29/29 (incl. sid attribution), approval probe VERDICT B exit 0; 5 commits e7393eb..5b2342f"
  source: verification runs 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T06:11:00
  kind: decision
  summary: "Documentation set completed: docs/protocol.md is the authoritative wire contract (processing order, session lifecycle, error-code table), docs/testing.md owns probe verdict semantics (VERDICT A/B/C) and the 29-check breakdown, CHANGELOG.md uses date sections without tags; README gained a troubleshooting section and doc links, all inserted below the approval section so its README:103/105 references stay valid"
  source: documentation round 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T06:36:14
  kind: decision
  summary: "文档站架构（Docusaurus 3.10.2，website/）：内容不直读仓库 md——scripts/sync.mjs 在构建时把 README.md→content/intro.md（slug /，标题「使用指南」）、CHANGELOG.md→content/changelog.md、docs/** 原样拷入生成目录 website/content（gitignored，禁止手改），并按站点深度重写 6 处相对链接（README 4 + protocol 2，LICENSE 解链）、给 superpowers 子目录生成 _category_.json。关键决策：markdown.format:detect——仓库文档含字面 {}/<>，必须按纯 CommonMark 解析否则 MDX 求值/报错；站点 url 用 localhost（仓库无 git 远端）、首页常量硬编码不引 useDocusaurusContext（3.10 中该包在根 node_modules 不可解析）。源文件零改动，README L103/105 行号约束不受影响。"
  source: "commit: docs 站点轮"
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T13:22:42
  kind: decision
  summary: "站点发布：GitHub Pages（https://adam-ikari.github.io/pi-a2a-ext/），仓库 adam-ikari/pi-a2a-ext（公开，gh 创建，本项目首个 git 远端）。部署链：push master → .github/workflows/deploy.yml（bun 1.3.14 + website build + actions/{configure,upload}-pages + deploy-pages）。docusaurus url/baseUrl 由 GITHUB_REPOSITORY 环境推导（Actions 内 /pi-a2a-ext/，本地 /），预演验证过。坑：用 API 开启 Pages 时仓库默认分支还是 main（空仓库初值），github-pages 环境被自动加了只放行 main 的分支白名单，master 首跑 deploy 被 environment protection 拒——已 PUT environments/github-pages 置 deployment_branch_policy=null 放行；分支保持 master 不改名。Pages build_type=workflow，Pages 源分支字段 main 无实际影响。"
  source: "GitHub Pages 部署轮"
  affects: [a2a-mcp-bridge]

- time: 2026-09-26T16:30:22
  kind: decision
  summary: "E2E 复跑（宿主 omp 18.3.2）：smoke/hardening(29)/approval(VERDICT B) 三件全绿，跨版本运行时兼容确认。node_modules 漂移以同一未知机制复发（实装 18.3.2，lock/package.json 仍 18.2.10）——版本守卫如期捕获，按既定流程同步 pin 到 18.3.2 并重写 lockfile；tsc 对 18.3.2 类型面零破坏，unit 恢复 59/59。pin==host 不变量当前值 = 18.3.2。"
  source: "E2E 复跑 + pin 同步"
  affects: [a2a-mcp-bridge]

- time: 2026-09-28T13:59:58
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "pin sync + E2E rerun on host 18.4.0"
  affects: [a2a-mcp-bridge]

- time: 2026-09-28T13:59:58
  kind: evidence
  summary: "E2E rerun on host 18.4.0: smoke/HARDEN(29)/approval(VERDICT B) all green; node_modules drift recurred (18.4.0 vs pin 18.3.2), guard caught it, pins+lock synced to 18.4.0; tsc 0, unit 59/59, lint clean"
  source: test runs 2026-09-28
  affects: [a2a-mcp-bridge]

- time: 2026-09-28T15:36:47
  kind: evidence
  summary: "docs 站点 GitHub Primer 主题化（2026-09-28）：Docusaurus 3.10 代码块配色的权威路径是根级 themeConfig.prism.theme/darkTheme（preset theme 选项只接受 customCss，根级 prism 被拒）；自定义主题对象必须是 v1 prism-react-renderer 格式 {plain, styles}（含 id/name/type 会被 schema 拒绝）。theme-classic 按该主题运行时注入内联 --prism-background-color/--prism-color，静态 CSS 覆盖必然失效——亮色代码块此前恒为深色的根因。零新增依赖（@primer/primitives 仅设计 token、无 Prism 主题，装后即删）。"
  source: website/prism-light.mjs / website/prism-dark.mjs / CHANGELOG 2026-09-28
  affects: [a2a-mcp-bridge]

- time: 2026-09-29T00:56:07
  kind: decision
  summary: "文件传输面（Q8，decided 2026-09-29）：双向（远程→宿主 push、宿主→远程 pull）走 tools/call，**不新增 JSON-RPC 方法**——桥自带 6 个 a2a_file_* 工具挂进既有管线，免费复用鉴权/会话/deny/两阶段审计。线格式复用 A2A FilePart {name,mimeType,bytes(base64)}，不发明新编码。落盘沙箱根 fileRoot 默认 ~/.omp/a2a-bridge-files（agentDir 的**兄弟目录**，刻意不与 token/审计同父，降低遍历 bug 的爆炸半径；ensureRoot 另拒「根是 config/审计祖先」）；maxFileBytes 默认 100MB。1MB 请求体上限不动：内联与单块 512KiB、单次 get 响应 256KiB，100MB≈200 次 put_chunk，分块写入纳入首版（用户明示「需要支持100M以下的文件」，推翻 Plan agent 砍分块的建议）。路径语义：绝对/~/NUL/控制字符/./.. 段一律词法 invalid_path（先拒），escapes_root 专门留给 realpath 检出的符号链接逃逸——两层职责分明。根内符号链接既不顺着读也不顺着写；写入经 <root>/.tmp 原子 rename、0600；分块状态绑 Mcp-Session-Id（跨 sid 与不存在同文案 unknown_transfer），30 分钟空闲**惰性**回收（每次文件调用入口 sweep，无定时器）、并发上限 16。名字冲突 host-wins + 一次性 stderr 告警（桥工具绕过宿主审批门，故不允许反向遮蔽）。威胁模型明示：token 即 fileRoot 内读写权、桥工具无审批门；pull 回的字节能进远程模型上下文，大件建议 SSH 旁路。审计：>120 字符字符串只记 <len:N,sha256:P8>，put_chunk 整体跳过审计（否则一次上传几百行冲爆轮转）。"
  source: "双向文件传输轮（plan eager-gulf-drum）"
  affects: [a2a-mcp-bridge]

- time: 2026-09-29T00:56:21
  kind: evidence
  summary: "文件传输验证基线（宿主 omp 18.4.0）：单测 59→100/100 绿（fileguard 16、filetools 18、bridge 桥工具与脱敏 4、config fail-closed 3）；新增真实宿主探针 test/file-transfer.ts（bun run test:files，54 项 → FILES OK），smoke（现 27 工具，含 6 个 a2a_file_*）、HARDEN 29/29、approval VERDICT B（挂起语义与两阶段审计跨版本未变）全绿。方法论再次生效：put_end 不创建目标父目录（分块上传到不存在的子目录时 rename ENOENT）是**宿主探针**抓到的，单测当时只用顶层路径故全绿——文件面改动必须跑 test:files，不能只信 bun test。另两处非代码坑：(1) website/scripts/sync.mjs 的链接改写用的是 String.replace（只换首个），README 第二次引用同一文档即留下仓库相对路径 → Docusaurus 断链构建失败，已改 replaceAll；(2) 版本守卫比对宿主版本的用例外设 30s 超时——omp --version 冷启动实测约 8s，恒超 bun 默认 5s 会偶发失败。"
  source: "bun test + 四件宿主探针 2026-09-29"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T02:51:35
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "代码评审修复轮 2026-09-30（探针驱动，含修复自身引入的活性竞态）"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T02:51:51
  kind: evidence
  summary: "第二轮对抗测试（18 项）抓到 1 个**修复自身引入**的 P1：串行化后排队中的 put_chunk 会在 put_end 已 rename 走暂存文件后往死路径 append，报 ok 但字节静默丢失并留下无人回收的孤儿 .part；修法为串行步骤内 requireLive(tr) 重验活性（Transfer 自带 id）。同时发现我自己的 3 处探针断言写错（okPayload 返回 null 非 undefined；传输已满是 size_mismatch 非 bad_chunk_order；串行化后乱序 seq 是被拒而非被吸收），均为断言错非代码错——再次印证探针会纠正评审者。基线：单测 110→114，宿主四件套全绿（FILES OK 62/62、SMOKE OK、HARDEN OK 29/29、approval VERDICT B）。"
  source: "对抗探针 + 四件宿主探针 2026-09-30"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T04:26:25
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "README 语言分工轮 2026-09-30（英文默认 + 中文 _ZN，站点仍渲染中文）"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T04:26:43
  kind: evidence
  summary: "README.md 改写为英文（新增 fileguard/filetools 两行文件布局、补 test:files 命令），README_ZN.md 承接中文并加语言切换；sync.mjs 改读 README_ZN.md 且剥掉切换行（曾因正则未跨行匹配而漏剥，已修 m 标志）。brain compiled_truth 内 2 处 README 硬编码行号改为章节引用，timeline 内 3 处按 append-only 保留。验证：website build SUCCESS 且站点 intro 仍为中文、链接全部 ./ 形式无断链。"
  source: "双语 README + 站点构建 2026-09-30"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T04:46:48
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "安装方式更正轮 2026-09-30（install.sh + 两条无效旧说明作废）"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T05:10:58
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "安装方式定稿：omp install . 为首选，pi.extensions 是其开关（回滚我此前的误删）"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T05:10:58
  kind: reversal
  summary: "更正上一条 decision：package.json 的 pi.extensions 并非无效，已回滚我的删除。该字段是 omp install . 的开关——删掉后 omp install --json 的 manifest 变 {}、宿主完全不加载扩展（正反两向均实测）。我误判的根因是拿 omp plugins list 的输出当判据（那只列已安装 npm 插件），而正确判据是 omp install --json 的 manifest + 宿主是否真加载。"
  source: "omp install --json + 宿主实测 2026-09-30"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T05:46:01
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "跨机器安装定稿：omp install <git-url> + 包自包含三要素"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T05:46:01
  kind: evidence
  summary: "跨机器安装验证：独立 HOME（无 config/token/沙箱）+ models.yml 模拟另一台机器，omp install <git-url> 装到 pi-a2a-ext@0.1.0，宿主起桥并自建独立 token 与沙箱。过程中确认三点：(1) omp install 不接受 .tgz（ENOTDIR）、不接受 owner/repo 简写（Invalid package name）；(2) 装的是远端代码，本地未推送时装到旧版本（先得 @undefined，推送后重装才 0.1.0），9 个提交已推送；(3) omp 在无模型配置时先退出、根本不加载扩展，模拟机必须给 models.yml 才测得到扩展。"
  source: "独立 HOME 模拟机实测 2026-09-30"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T06:25:32
  kind: evidence
  summary: "跨机器安装实验固化为 test/install-probe.ts（bun run test:install，26 项）：独立 HOME 模拟另一台机器 → omp install <git-url> → 以远程 MCP 客户端走完整流程（manifest/打包文件、首次启动自建 config+token+沙箱、initialize、文件往返、沙箱边界、鉴权、审计），全绿。这是唯一验证「任意机器可装」的探针——test:files 自己软链扩展，完全不碰安装链路。写探针时踩了两个 harness 假阴性（非产品缺陷）：omp --mode rpc --print 带 prompt 跑完即退、桥随之消失导致 ConnectionRefused（须不传 prompt 且 stdin 保持打开）；以 proc.exitCode===null 轮询会在最后一个 stdout 分片到达前提前退出，把「桥正常」误报为「没起来」——最终改为直接 HTTP 探测，test:files 一直这么做故未踩到。顺带修正 docs/testing.md 的过期数字（单测 100→114、fileguard 16→17、filetools 18→31）。"
  source: "test:install 26/26 2026-09-30"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T10:47:58
  kind: decision
  summary: "网站构建链定稿：弃用 withMermaid 改异步组件、JSON-LD 三元组写法、og:image 位图、sitemap lastmod 取源文件提交日、render-check 探针"
  source: "网站修复轮 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T10:48:06
  kind: evidence
  summary: "网站侧 4 项修复验证：阻塞预载 1.58MB→1-2KB（app entry 684KB→1KB，空闲预取 169KB）；JSON-LD 由「标签存在但 script 体为空」改为可解析（首页 WebSite+SearchAction，内页 TechArticle）；og:image 改 1200x630 PNG + summary_large_image；sitemap lastmod 改为各源文件最后提交日（testing=09-30、其余=10-01，不再全是当天），deploy.yml 加 fetch-depth: 0。新增 render-check 探针 28 项全绿，并验过它在故障时 FAIL。"
  source: "网站修复轮 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T10:59:22
  kind: decision
  summary: "网站侧收尾两条：robots.txt 由 sitemap.mjs 用同一套推导生成（此前是静态文件里第二处硬编码 origin，仓库改名即失效）；sitemap 源文件映射补上 superpowers 两页（docs/<page>.md 兜底，不再退回全仓最新提交日）。另确认 HEAD 上 lint 早已因 .agents/ 第三方 skill 文件（空格缩进 vs biome tab）失败，本轮 4 错 1 警 → 2 错 0 警，未去改他人文件。"
  source: "网站修复轮 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T11:48:28
  kind: decision
  summary: "新增 docs/computer-use.md（站点 /computer-use，进 nav + 侧边栏 + 首页 feature 卡片）：本桥 vs computer use 的定位对比。论点只写能证的——执行走宿主原生工具实现（五个真实宿主探针均在 --mode rpc 无 UI 下跑通，故不依赖窗口/无头能力）、目录由 tools/list 显式给出（写错得 not exposed）、宿主不推理。明确一处易误解：省的是宿主侧推理与 token，远程模型照旧推理，a2a_file_get 的 base64 仍进远程上下文。README（中英）加指向行，sync.mjs 补链接重写（漏则构建报断链）。"
  source: "与 computer use 的区别页 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T11:56:29
  kind: reversal
  summary: "更正站点文案的主体：此前写成「远程 omp 调用宿主 omp」，是把 README 的一个 mcp.json 示例当成了主体。桥实现的是 MCP 2025-11-25，任意 MCP 客户端均可接入——调用方与宿主同机/异机、是否同为 omp 都成立。hero 改为「让任意 agent 调用本机这个 omp 的工具」。**教训：文档里的单个示例不定义产品主体，主体要看协议层对谁开放。**"
  source: "站点文案校订 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T11:56:34
  kind: decision
  summary: "sync.mjs 补 CHANGELOG 的链接重写（此前完全没有）：条目里的 docs/*.md 仓库相对路径在站点上是死链，VitePress 会构建失败。一直没暴露是因为 CHANGELOG 只引用过站点同名的 protocol/testing，新增 computer-use.md 才触发。另将 config.ts 里重复的 description/兜底值提取为 SITE_DESC 单点引用。"
  source: "站点文案校订 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T13:18:55
  kind: decision
  summary: "恢复被上一次 update-truth 压掉的 Q1–Q8 与方法论全文，并新增「守卫失效的两种形态」一节"
  source: "lint 修复轮 2026-10-01（修正上轮 compiled_truth 的信息损失）"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T13:49:26
  kind: reversal
  summary: "推翻 Q4 的 deny/暴露交集与 Q8 的整个文件传输面——按「极简/不重复造轮子/不替 omp 实现沙盒/不替 omp 管权限」四条，桥缩回接口转换器：源码 1460 → 655 行。删 src/filetools.ts + src/fileguard.ts（675 行）与 6 个 a2a_file_*，删 deny/denyMCPTools 与 fileRoot/maxFileBytes。tools/list 改为 pi.getAllTools() 原样透传不过滤（含 hidden 工具、含宿主对自己模型禁用的工具）——omp 是什么权限桥就是什么权限，删掉的是第二套与宿主可冲突且无优先级的权限名单。**教训一：桥自带工具绕过宿主审批门，所以不得不自带沙箱——这是同一个决定的两个后果，要一起删，只删一个会留下「谁都不管」的洞。教训二：为已有能力（bash 的 cat/base64/ls/dd）造轮子的代价可量化——675 行实现 + 1216 行测试，且状态机自己生产了两个 P1（seq TOCTOU 写坏文件、串行化修复自身引入的活性竞态）。**"
  source: "极简化轮 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T13:56:07
  kind: evidence
  summary: "发现 test:install 的隔离根本不成立（harness 缺陷，与代码无关）：探针只设 HOME=临时目录，但实测用一个全新空目录做 HOME，桥仍起来且仍广播「file transfer」——说明 omp 加载的是**真实 HOME** ~/.omp/plugins/node_modules/pi-a2a-ext 下 9-30 装的那份旧拷贝（grep a2a_file_ 有 1 处命中），而不是探针刚装进临时 HOME 的那份。设 OMP_PLUGIN_DIR 无效。后果：极简化提交后该核验报 FAIL，实际验的是旧插件。**教训：探针声称隔离某样东西时，要用「该物缺席」的反证测，不能只看它指向的目录。** 修复未做（独立议题）。"
  source: "极简化轮 2026-10-01 复跑 install 核验"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T14:44:25
  kind: decision
  summary: "把本质需求与四条原则写进 AGENTS.md 与 README（中英），此前它们只存在于对话里。**本质需求：复用本机已经跑着的那个 omp**——任意 MCP 客户端把 mcp.json 指向端点即可调用它的工具，调用落在宿主 Main 会话的真实文件与 shell 上。桥只负责把调用送到，不在途中加意思。四条原则由这一句推出：不重复造轮子 / 不替 omp 实现沙盒 / 不按权限过滤（tools/list 原样透传）/ 不长出第二个系统。**判断标准：改动是让桥更透明，还是给桥一个自己的意见？后者即第二个 omp。** 写的时候刻意不加解释——原则写长了就成了新的可解释空间。"
  source: "原则落仓 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T14:58:49
  kind: decision
  summary: "test:install 缩小为「发布包自包含」核验（17 项，不再起宿主）。根因实测确认：宿主解析插件目录不受 HOME 影响——往假 HOME 装一个只打印标记的扩展，标记未出现而真实 ~/.omp 那份桥起来了；XDG_DATA_HOME / OMP_PLUGIN_DIR / 改 cwd 三者都无效。新核验只测能观测的边界：manifest + npm pack 产物 + 从入口走相对 import 图（files[] 漏模块会「装得上、加载时才炸」，逐个断言文件名会被新增模块绕过，走图才抓得到），并已验过它会失败。docs 与 README（中英）如实写明 omp install <git-url> 端到端无自动化覆盖。**教训二则：(1) 探针声称隔离某样东西时用「该物缺席」的反证测——这里的反证是装一个只打印标记的扩展；(2) 绕不开宿主的机制时，缩小到能观测的边界并写明缺口，比自己重建一层隔离更诚实——后者正是不重复造轮子的反面。**"
  source: "install 核验修正 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T23:58:33
  kind: reversal
  summary: "推翻本页 2026-10-01 两条 timeline 里的结论「宿主解析插件目录不受 HOME 影响，因此端到端无法自动化」。**方向对，机制错。** 实测：两个目录行为不同——~/.omp/agent/extensions/ 跟随 HOME（往临时 HOME 放只打印标记的扩展，标记出现），~/.omp/plugins/ 不跟随（桥仍从真实插件目录加载；OMP_PLUGIN_DIR / OMP_PLUGINS_DIR / XDG_DATA_HOME 都改不动）。坏探针只试了 agent 目录，且没给临时 HOME 写 models.yml。**真正的拦路虎是第二条：宿主没有模型配置就不创建 session，扩展在 session_start 加载，于是桥永不广播**——这个症状与「插件发现忽略了我的 HOME」完全一样，单独又误判过一次。test:install 已恢复端到端（17 → 32 项，第五组 9 项，已验过移走插件目录会红）。教训升级为三条：(1) 探针声称隔离某物时用「该物缺席」的反证测；(2) **同一个探针两次给出相反结论时，先查最平凡的前提**（这里是没有 models.yml），不要先怀疑被测系统；(3) 探针的失败详情要限长，否则一行几千字符的 frame 会把真正的错误行淹掉。"
  source: "test:install 恢复端到端；上一条 Q 关于插件发现隔离的结论被推翻"
  affects: [testing, tooling]

- time: 2026-10-06T13:07:30
  kind: reversal
  summary: "补记 ：它按决定推翻了「不替 omp 实现沙盒」与「桥不解释路径」两条原则，此前只写在 CHANGELOG 与代码里，本页 timeline 与 compiled_truth 均无记录（read-page grep blob = 0 命中）。取舍本身已在 2026-10-01 那条「桥自带工具绕过宿主审批门，所以不得不自带沙箱——这是一个决定的两个后果」里推出，只是这次选择承担两个后果而不是删掉能力：**(1) 不经宿主审批门**——ExtensionAPI 只有 on(\"tool_approval_requested\")，宿主问扩展答的方向，扩展无法主动发起审批；**(2) 桥自己解释路径**——宿主 resolvePath()/expandPath() 在宿主包内部，BridgeDeps 没有入口，依赖它们会在宿主移动文件时断，于是 src/blob.ts 自实现 ~ 展开与相对/绝对判断，代价是能写宿主能写的任何路径，无根目录无白名单。同时推翻极简化一节记录的代价「100MB 文件不走 MCP 通道（走 SSH/scp，README 早已这么建议）」：实测烧固件这类需求走 tools/call 要 21 次请求（16MB，单块用满 1MB 上限），/blob 省掉 base64 编码（每块少传 33%）。请求体上限 1MB → 128MB（maxRequestBodySize）；实测 100MB 镜像一次请求 0.4s 字节一致，129MB 干净 413，宿主 RSS 空闲 368MB → 一次上传 624MB → 两次并发 846MB（并发非线性叠加，但每个在途大请求仍吃 200MB+）。保住的一样是审计：每次写入留一条 tool=\"blob:write\"，args 只有 path/offset/bytes，内容不进日志。**教训：一次推翻若只落在 CHANGELOG 里，下一轮读到 brain 的人会以为原则从未被动过——推翻也是决定，决定就该进决定页。**"
  source: "补记 2026-10-02 /blob 一轮（本页此前漏记，2026-10-06 补）"
  affects: [a2a-mcp-bridge]

- time: 2026-10-06T13:07:36
  kind: evidence
  summary: "版本漂移第五次复发：宿主 omp 18.6.1、node_modules 18.6.1，pin 与 lockfile 仍 18.4.4，bun test 54 项红 1 项（installed != pin）。pin + lockfile 同步至 18.6.1。全量回归：tsc 0 错误、单测 54/54、biome 干净、SMOKE OK（21 工具）、HARDEN OK（24 项）、BLOB OK（19 项，100MB 一次请求字节一致 0.3s）、PACKAGE OK（28 项）、审批探针 VERDICT B（bash 挂起 90031ms 后由调用方超时抛出，副作用文件未出现，server 存活，审计 start=1 done=0）。pin == host 不变量当前值 = 18.6.1。**注意 CI 的盲区在这里又出现一次**：check job 的 frozen-lockfile 安装下 pin 与 lock 自洽，所以漂移只在本地显形（host-probes job 装的是 pin 本身，比的也是 pin），两个 job 都没法发现 pin 已落后于真实宿主——宿主升级这件事只有版本守卫在有宿主的机器上才看得见，而它 warn-only。**教训：守卫链条的最后一环是「有人在有宿主的机器上跑测试」，不是任何配置项。**"
  source: "宿主 18.6.1 回归 2026-10-06"
  affects: [a2a-mcp-bridge]

- time: 2026-10-07T08:47:53
  kind: evidence
  summary: "版本漂移第六次复发，且这次能说清一半机制：宿主 omp 有 startup.checkUpdate（默认开，启动时查更新），所以宿主升级不需要本仓库做任何事；10-06 同步到 18.6.1 并推完，10-07 宿主与 node_modules 已到 18.6.3，pin 18.6.1，bun test 又红——修复保质期不到一天，「保持现状」的成本从偶发变成跟节奏走。仍未知的是谁在改本仓库的 node_modules，前五次都记成「同一未知机制」，继续不假装知道。另外把 brain 六页 root page 的占位符全部换成实内容（background / architecture / flow / mindmap / stack，加 roadmap），内容只从源码与既有记录推，不补想象出来的里程碑；五张 mermaid 用站点自带的 mermaid 11.17.2 在 jsdom 下 parse 过，并先证明该探针对坏语法确实 FAIL（未闭合节点与双 root 各报一条），否则「全 ok」不算证据。**教训：占位符页比空页更糟——它看起来像个计划；而「探针全 ok」这句话本身也要先反证探针会红。**"
  source: "六页 root page 补实 + 漂移第六次复发 2026-10-07"
  affects: [a2a-mcp-bridge]

- time: 2026-10-07T09:20:09
  kind: decision
  summary: "关闭 roadmap 里那条未决线程，选定第二个选项：test/versions.test.ts 的宿主比较从 warn 改成 **fail**。理由三条，全部实测：(1) 宿主 omp 有 startup.checkUpdate（默认开），自己会升级，节奏不由本仓库定；(2) CI 两个 job 结构上都看不见真实宿主升过——check 用 frozen-lockfile 装（pin 与 lock 自洽），host-probes 装的就是 pin 本身（比的是 pin），所以「宿主已升级」这个事实只存在于有宿主的机器上；(3) 复发六次，最近两次隔了不到一天，warn 的保质期比修复的保质期还短。**没人必须处理的 warn 不是守卫**——这与本页「守卫失效的两种形态」是同一条：必然失败的检查等于没有检查，没人处理的 warn 也一样。配套两条边界：无宿主时跳过（CI check job 就是这种形态，反证过 OMP_BIN 指向不存在路径 → 跳过而非误红）；确实要对着别的宿主跑用 A2A_SKIP_HOST_VERSION_CHECK=1，打印大声的 SKIPPED，不静默。写第一版断言时自己写错——无条件拼了不匹配那句，于是期望值永远不等，表现为「pin 已同步却仍红」，由这个不合理现象自己暴露。教训：断言的失败信息不该由无条件构造决定；两支文案不同的时候，先写清楚「匹配那支长什么样」。pi-* pin 与 lockfile 同步至 18.6.3，全量回归绿（tsc 0 / 54 单测 / biome / SMOKE 21 工具 / HARDEN 29 / BLOB 19 / PACKAGE 28 / 审批 VERDICT B）。"
  source: "版本守卫 warn → fail 2026-10-07"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T01:28:48
  kind: evidence
  summary: "test:install 的 announce 断言通过时打印的是**失败形态**的 detail：「ok: the host announces the bridge …(no announcement and no short error line)」——标签说广播了，括号说没广播。根因是 check() 的 detail 参数两头都打印，而同一仓库有三种写法：hardening.ts 的 check 不带 detail；blob-probe.ts 用 `cond || !detail ? \"\" : detail` 只在失败时打印；只有 install-probe 两头都打印，且恰好有一处两态不成立的调用点。修法是让 detail 两态各自成立（通过时是广播本身，失败时才扫错误行），并在 check 上把契约写死。**教训一：探针的输出必须两态都读得通——断言成立但输出读起来像失败，比没有输出更坏，因为人会按输出下结论而不是按断言。教训二：同一概念在三处有三种写法时，第三种通常就是藏着缺陷的那处——差异本身是线索，不必逐个审。** 反证：改坏正则 → FAIL 且仍打诊断；复原 → ok 且 detail 是真实地址。项数仍 28，五探针与单测全绿。"
  source: "E2E 探针输出自相矛盾 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T01:56:23
  kind: decision
  summary: "新增第六个探针 test/scenario.ts（10 叙事 / 54 步 / 约 45s，接进 CI host-probes），形状与前五个不同：前五个是**平铺断言**（每项一个观察、彼此独立），这个每条是叙事，且**结尾状态从产生它的那条通道之外去验**——远程 bash 看文件系统与审计日志、/blob 写入用宿主 read 读回、会话终止后去连端口、外部改配置看运行中服务器认哪个 token、宿主结束看端口是否还接受。理由是既有的：留在单通道内的推理正是 675 行文件传输面带两个 P1 上线、100 单测全绿的原因，所以「多写测试」不等于「多一条通道」。补上的零覆盖空白：端口占用回落与告警、配置损坏 fail-closed、--approval-mode=write 档（读 25ms 答、bash 挂住、审计 start 无 done）、宿主结束释放端口、两客户端并存与 sid 归因、8 路并发上传互不串扰、xd:// 挂载设备、blob→宿主工具一致性。**每个场景都用注入缺陷反证过会红**，并把边界写进探针文件头：删掉暴露面校验场景套件**不红**（那条归 hardening，实测它红两项）。三条当场揪出的自身缺陷：(1) 场景对「/blob 一律覆盖写」原本是绿的——对不存在的文件追加与截断是同一操作，补显式 offset 追加才咬得住；(2) rpc() 无默认超时，桥没起来会挂在占用端口上（现恒 20s 上限）；(3) 误以为宿主 read 返回裸内容，实际带 [path#hash] 头与行号（像 cat -n）。顺手修 test:install 一项**因错误理由变绿**的断言：设备名被拒只断言 isError，暴露门一去掉就被设备自己以 Unsupported debug action 拒掉而照样绿；改为断言必须是桥的 not exposed。**教训一：一个断言要问「它绿的时候，凭的是什么」——凭另一个原因绿，等于没断言。教训二：探针自身的失败路径也要验，rpc 不设超时就足以让整轮挂死，而挂死不产出信息。**"
  source: "端到端场景核验 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T01:57:17
  kind: evidence
  summary: "架构页补一处不经代码即看出的耦合：/a2a rotate 之所以能立刻生效，是因为 startServer 捕获的是 cfg **对象**而非副本，rotate 改的就是同一对象（extensions/a2a-bridge.ts 的模块级 cfg → startServer(cfg, …) → handler 里 authorize({token: cfg.token})）。改成 startServer({...cfg}) 会让轮换静默退化成「下次重启才生效」，而这种退化没有任何断言会发现——现有测试全部在轮换之后手工重启。test:scenario 的「外部改配置到重启才生效」场景把两侧一起钉住：运行中的服务器只认启动时的 token（外部改写 → 旧 token 仍 200、新 token 401），重启后才读盘上那份。"
  source: "架构页补 cfg 对象耦合 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T02:41:26
  kind: reversal
  summary: "推翻本页 2026-10-06 补记里那组内存数字（空闲 368MB → 一次 100MB 上传 624MB → 两次并发 846MB，据此说「每个在途大请求仍吃 200MB+」）。那组数只在宿主 18.6.1 上量过一次，宿主已到 18.6.3，没人复核。新实测（test:blob 每轮跑，宿主 18.6.3，隔离临时 HOME）：空闲 487MB；单个 8MB 请求安顿增量 −6MB（在途峰值 +13MB）；两个并发 8MB 安顿 +148MB（在途峰值 +248MB）。五轮里单个请求的安顿增量分别是 +11、+26、+171、+165、−6MB——包括负的，即上传完宿主 RSS 比上传前还低。宽度来自 Bun 分配器（arena 增长 + 前一步 100MB 上传延迟归还），不是本桥有没有把 body 留在内存里。文档里的并发告诫因此改由 128MB 请求体上限制推（上限是每个在途请求各自的），不再挂在这组数上。"
  source: "宿主 RSS 实测重做 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T02:41:38
  kind: decision
  summary: "两条一起定下：**(1) 文档里的实测数字必须由某个探针每轮复核并归档**，否则它烂在原地而读者以为它还活着——protocol.md 那组 RSS 就是这么过期的。落法：test:blob 测完覆盖写 test/rss-<宿主版本>.json（表就是文件里那一份，最近一次实测而非稳定值），文档表从它刷新。**(2 分配器主导的指标只记录、不断言。** 原本这条要卡在「两个并发 body 的开销小于两者之和」，实测杀死了它；两版变异体（延迟写、延迟读）的峰值都落在真实路径的噪声带里，不可分辨。所以断言只留确定的一半（并发上传与 100MB 单请求必须被接受），RSS 阈值不设——建在它上面的断言测的是分配器当天的状态，会在忙碌的 CI runner 上因与桥无关的原因变红。峰值采样保留为仪器，但不当判决。附带一条通用形状：仪器诚实 ≠ 结论可信，采样方式改对（安顿值看不到在途 body，改 5ms 同步读 /proc 才看到）也不会让被噪声主导的量变成可断言的对象。"
  source: "内存实测规则定稿 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T02:46:08
  kind: evidence
  summary: "上一条 reversal 里那组 18.6.3 数字只看了两轮，第三轮把它推翻了一半：归档那轮空闲 370MB，单个 8MB 安顿 +18MB，两个并发安顿 +44MB，且峰值与安顿值相等。并发三项至此是 +44、+147、+148MB（峰值 +44、+245、+248MB），最大最小差三倍多——**并发也不可复现**，此前那句「并发那两个数看着比单个那一路稳」作废。单个请求的安顿增量七轮：+11、+26、+171、+165、+10、+18、−6MB。结论不变且更硬：这组数不能设阈值；文档内存表按归档那一轮刷新，protocol.md 与 testing.md 同步改掉「并发更稳」的说法。另一条附带教训：归档文件每轮覆盖，所以文档表必须在同一批改动里跟着刷新，否则表与文件说的是两次测量。"
  source: "RSS 第三轮实测，修正上一条的并发结论 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T03:33:47
  kind: decision
  summary: "/blob 的写语义定死两条：一律以 \"a\" 打开（不按当前大小在 w/a 之间选择），显式 offset 在拿到句柄后再复查一次大小、不符则 409。理由是一次真实缺陷：两个调用方同时写一个新文件时都看到 size 0、都选 w，第二次 open 截断抹掉第一次已落盘的字节，两条请求却都回 200。另外 handle.write 短写（磁盘满、配额）必须回 500 并记一条 bytes:0 的审计，不能报成功。413 由 Bun 挡在 handler 之外，因此既不碰文件也不写审计，这是有意的一致。"
  source: "test/blob-probe.ts + src/blob.ts"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T03:33:53
  kind: decision
  summary: "审计日志的保留语义定死：轮转只留一代（rename 到 <path>.1，下一次轮转覆盖它），所以「只有 start 没有 done」这个挂起信号有保质期，后续流量够多就把证据冲出日志。README 中英与 protocol.md 都要带这句告诫。另记两条读日志的人会踩的空处：日志里的 id 是本桥为配对生成的 UUID，调用方的 JSON-RPC id 从不落盘，按它查不到任何东西；轮转可能把一次调用的两条分处两个文件，配对要两个文件一起看。保留性这条在 test/audit.test.ts 里用直接灌审计模块的方式测（一秒），不在宿主核验里跑（要两千次真实调用）。"
  source: "test/audit.test.ts + src/audit.ts"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T03:34:01
  kind: note
  summary: "核验的取舍记两条：其一，宿主 RSS 那组只打印归档、不设阈值，本轮单个 8 MB 安顿增量 −157 MB、并发峰值 −141 MB，八个轮次从 −157 跨到 +171 MB。负值的成因是基线取样位置：空闲值在探针末尾读，那一刻前一步 100 MB 上传仍有内存未归还，基线自己在衰减，增量于是带着衰减的方向。这坐实了不断言阈值的决定，机理写进 docs/protocol.md 与内存表。其二，写断言时必须问「实现变坏它会不会红」：按 JSON-RPC id 查审计日志那项不会红也不会绿，因为那个 id 从没写进日志；让记录变胖靠 1000 字符的路径也不成立，redact() 会把超过 120 字符的字符串折成约 30 字节的摘要，越过 512 KB 因此要 1241 次调用而不是 213 次。两处都改成了能如实变红的形式。"
  source: "test/hardening.ts + docs/testing.md"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T03:37:10
  kind: evidence
  summary: "RSS 落表以最后那一轮为准：第十轮实测空闲 495 MB，单个 8 MB 安顿 +18 MB，两个并发安顿 +32 MB，在途峰值 +26 / +32 MB，100 MB 一次请求 0.3 秒。十轮的单个 8 MB 安顿增量为 +11、+26、+171、+165、+10、+18、−6、−157、+91、+18 MB（两轮为负），并发的安顿为 +147、+148、+44、−141、+99、+32 MB。连着三轮给出 −157、+91、+18 就是不断言阈值、文档只写「最近一次实测」的实证理由。"
  source: "test/rss-18.6.3.json + docs/protocol.md"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T06:49:52
  kind: reversal
  summary: "推翻「redact 走两层就够，工具参数不会嵌得更深」这条旧结论：宿主自己的 edit 参数就是 {path, edits:[{oldText,newText}]}，文件正文落在第三层，脱敏在那里之外不生效，一次远程 edit 调用把最多 1 KB 正文写进审计日志（只有 MAX_ARGS_CHARS 的截断挡着）。现在的契约是逐层走到叶子，嵌套超过 32 层整个子树换成 <max-depth>。同时记一条测试写法上的教训：原来那条单测断言 args 字段不含完整 5000 字符 payload，而该字段本来就截在 1024 字符，整段永远不可能出现，漏洞开着它也是绿的；要查就查整行日志里的一个 60 字符窗口。"
  source: "src/audit.ts + test/bridge.test.ts"
  affects: [a2a-mcp-bridge]

- time: 2026-10-09T00:51:51
  kind: decision
  summary: "渲染事件不参与判定：src/bridge.ts 里两次 emitExternalEvent 走 emitRenderEvent，构造与发送失败都吞掉。一次带副作用的调用（edit 已落盘）被报成 isError 会诱导调用方重试并重复执行写，这比渲染缺一张卡片严重得多。同一条路径的另两个约束：toolCallId 是每次调用新生成的 UUID（宿主按 id 画卡片，复用会把两次调用合成一张）；signal 与 onUpdate 传 undefined 是 v1 边界，不做取消。"
  source: "session 2026-10-09 渲染事件与判定路径分离"
  affects: [a2a-mcp-bridge]

- time: 2026-10-09T00:52:07
  kind: evidence
  summary: "宿主交接那半条路径不必起宿主：AgentRegistry.register 接受任意对象作 session，resetGlobalForTests 收尾，test/host-call.test.ts 因此能断 text/image 转出、参数按引用、ctx 的 hasPendingMessages→hasQueuedMessages 改名、事件配对与 unknown tool（src/bridge.ts 分支覆盖 49%→99%）。500 的「细节只进日志」、端口退避与 EACCES 不退避、审计的两条不变式（stringify 失败仍落盘、写失败不成 unhandled rejection）、参数 1 KB 上限各有断言。变异核验 12 项，每项只红自己那条；去掉参数截断时原先全绿，这条是被变异发现的。刻意不补单测的三处：/blob 路由分派、auditBlob、src/blob.ts，宿主探针 32 项已在跑真字节进文件系统，单测里再造假磁盘只是写两遍。"
  source: "session 2026-10-09 单测补齐三处空白"
  affects: [a2a-mcp-bridge]

- time: 2026-10-09T01:39:24
  kind: decision
  summary: "服务器是每进程的资源，宿主给的 session_start / session_shutdown 是每会话的（task 子代理、ACP 会话、持久化 revive 各建一套 runner 并重跑扩展工厂，模块图不重新求值所以 server/cfg 共享）。契约定为：第一个 session_start 绑定并广播，后来的静默复用（审批与通知因此归属第一份 ctx，子代理那份没有可用 UI，让它占住引用会一路挂住）；session_shutdown 只在 src/bridge.ts 的 hasMainSession() 说没有 Main 会话时才释放端口。旧的无条件 stop 是缺陷：一次子代理结束就拆掉还在服务的端口，而主会话不再发 session_start。rotate 同决定：先生效后落盘的顺序反过来，先 saveConfig 再改 cfg.token，写失败时运行中的桥仍用旧 token。"
  source: "host sources: modes/runtime-init.ts:212, extensibility/extensions/runner.ts:440-449, sdk.ts loader 重跑工厂 + test/entry.test.ts"
  affects: [a2a-mcp-bridge]

- time: 2026-10-09T01:39:44
  kind: evidence
  summary: "入口层可单测，且不靠 mock：$A2A_BRIDGE_CONFIG 指临时文件、端口写 0、Main 是真注册进 AgentRegistry.global() 的假货，每条断言都从广播文本里解析端口再去连它（200 = 在服务，连不上 = 没在服务）。反面结论：Bun 的 mock.module 是进程级的，用它 stub server/config/bridge 会让同一进程里 test/config.test.ts 的真 loadConfig 被换掉，12 项红掉——所以这条路由只能走真依赖。test/entry.test.ts 16 项 + test/host-call.test.ts 的 hasMainSession 3 项（对真注册表测空表/在册/在册但无会话，入口的判断就靠这个读数，不能被 stub），单测 79 → 98。变异核验七项：拆闸、rotate 顺序、catch 不 stop、catch 不清状态、hasMainSession 恒真（红真注册表那 3 项）与恒假各 1，广播改用配置端口那项红 7 项。"
  source: "test/entry.test.ts + session 2026-10-09 入口生命周期"
  affects: [a2a-mcp-bridge]

- time: 2026-10-09T02:00:09
  kind: evidence
  summary: "入口的绑定不是原子的：loadConfig 与 startServer 都要 await，所以两个 session_start 能在同一个 if (server) 检查上同时通过并各绑一套端口，模块只记住后一个，前一个端口没有名字、谁也停不掉，操作者还会收到两条指向不同端口的广播。这条先写成红的测试（并发用例里第二个 runner 从广播里解析出了一个端口号），再用 bringingUp 这道在途闸修掉：后到的等前一个绑完再复用。变异核验：去掉在途闸只红并发那一条。单测 98 → 99（entry 16 → 17），五连宿主核验复跑全绿（SMOKE / HARDEN 35 / BLOB 32 / SCENARIOS 54 / VERDICT B）。"
  source: "test/entry.test.ts 并发用例 + 变异核验"
  affects: [a2a-mcp-bridge]

- time: 2026-10-09T02:16:32
  kind: evidence
  summary: "绑定的 await 窗口里来的 session_shutdown 手里没有端口可停（server 还是 null），于是它谁也没停，而绑定随后完成，留下一个服务死会话的端口，此后没有第二个 session_start 纠正它。修法是绑完之后按同一条 hasMainSession() 判据复查一次：已经没有 Main 就 stop 并清空，一句广播也不发。这条测试先红过（修复前端口从广播里解析得出来），变异核验去掉复查只红这一条。真宿主冷启动不受影响：Main 在构造时就预注册进 AgentRegistry（sdk.ts 的 pre-register 注释），早于扩展的 session_start，所以「复查时发现没有 Main」不会发生在正常启动路径；smoke / hardening / blob / scenario / approval(VERDICT B) / install 全部复跑全绿。单测 99 → 100（entry 17 → 18）。"
  source: "test/entry.test.ts mid-bind 用例 + 变异核验"
  affects: [a2a-mcp-bridge]

- time: 2026-10-09T02:36:05
  kind: decision
  summary: "「还有没有 Main 可服务」按宿主的哨兵判：AgentRef.session 的类型是 AgentSession | null，注释写着 Null exactly when parked/aborted，所以 hasMainSession() 用 != null 而不是 !== undefined。理由是同一条调用路径（buildCallTool 里 if (!ref?.session)）本来就拒绝这个状态并回 main session not available，两处读同一个字段必须得出同一个结论，否则释放规则说「有 Main，留着端口」而执行说「没有」。随之确立：入口的绑定与释放都以「能不能真的服务」为准，不以槽位是否存在为准。冷启动安全性按宿主源码核对：Main 在 createAgentSession 里预注册（session: null）、构造结束时 attachSession 附上活会话，而 tui / rpc / print 三个模式都是在会话建好之后才 emit session_start（runtime-init.ts:212、extension-ui-controller.ts:320-329），所以绑完之后的复查挡不到正常启动。宿主核验探针只跑 --mode rpc，tui 与 print 那一半是源码核对，不是实测。"
  source: "node_modules/@oh-my-pi/pi-coding-agent/src/registry/agent-registry.ts:69 · src/bridge.ts:108"
  affects: [a2a-mcp-bridge]

- time: 2026-10-09T03:10:20
  kind: evidence
  summary: "释放端口的动作换成非强制 server.stop()（原为 stop(true)）。强制那一半实测：在途请求拿到 ECONNRESET、服务端 handler 抛「The connection was closed.」，tools/call 的审计只剩 start 行，而 /blob 因为 body 先整个 buffer 住才写（src/blob.ts:113），断在半路就是文件没动、auditBlob 也没跑——一次上传无迹可查地消失。非强制那一半实测：监听立刻关（裸 TCP connect 即 ECONNREFUSED），在途那一次照常 200 并落完整审计"
  source: "src/server.ts:251-258, test/server.test.ts「releasing the port」"
  affects: [a2a-mcp-bridge]

- time: 2026-10-09T03:10:36
  kind: evidence
  summary: "Bun 1.3.14 的非强制 stop() 不关释放时已经空闲的 keep-alive 套接字：释放后用同一 HTTP 客户端连接池再发一条请求仍被服务（实测到 3 秒以后），而裸 node:net 新建连接一律 ECONNREFUSED；closeIdleConnections() 在这个版本只有函数名，调用返回 undefined 且 socket 照旧。bun-types 1.4.2 写的「空闲连接立刻关、stop() 返回在所有连接关闭时 resolve 的 Promise」是更新版本的行为。于是「释放后不接受连接」这句话的核验只能用新建连接判，不能走 fetch——后者量到的是这根旧 socket"
  source: "本机实测 /tmp/stopprobe（Bun 1.3.14 与 node_modules/bun-types 1.4.2）"
  affects: [a2a-mcp-bridge]

- time: 2026-10-09T03:10:46
  kind: decision
  summary: "端口释放的取舍定为「保住审计，接受旧连接多活一会儿」：释放那一刻若切断在途请求，/blob 会留下一条既没落盘也没记录的上传，而这条路径本来就在宿主审批门之外，审计是它唯一的痕迹。反过来用非强制 stop() 付出的代价是那根早已连上的 socket 可能继续被服务（Bun 的缺口，不在这里补 closeIdleConnections 的替身——自己记连接数再择机关断是长第二套系统）。判据仍是「新建连接被拒」"
  affects: [src/server.ts, test/server.test.ts]

- time: 2026-10-09T04:49:11
  kind: evidence
  summary: "宿主把 ExtensionAPI 的 pi.getAllTools() 接到的是「这套 runner 自己的会话」：三个接线点都是 () => session.getAllToolInfos()（runtime-init.ts:126、extension-ui-controller.ts:199/427、acp-agent.ts:2581）。所以入口 pin 住第一份 session_start 的 pi，就等于把目录与暴露门绑在那套 runner 的会话上；task 子代理或 ACP 会话先到，那份注册表就不是 Main 的，而执行仍是每次现取 Main——同一个桥里三个读者、两份权威"
  source: "node_modules/@oh-my-pi/pi-coding-agent/src/modes/runtime-init.ts:126, src/modes/acp/acp-agent.ts:2581, session/agent-session.ts getAllToolInfos"
  affects: [a2a-mcp-bridge]

- time: 2026-10-09T04:49:11
  kind: decision
  summary: "目录、暴露门、执行统一读 Main 会话的 getAllToolInfos()（src/bridge.ts 的 servedTools()），常规宿主里它与原先那份 pi.getAllTools() 逐字相同（同一个函数的两个接线点）；AgentRef.session 为 null（parked/aborted 到端口释放之间）退回入口那份 pi，不报空注册表。取舍理由与 AGENTS.md 一致：桥不该有第二份名单，连「工具集合」这份名单也不该有——它应当就是宿主执行时解析的那一份"
  affects: [src/bridge.ts, test/host-call.test.ts]

- time: 2026-10-09T12:06:46
  kind: decision
  summary: "版本漂移第七次复发：宿主 omp 有 startup.checkUpdate（默认开），10-07 同步至 18.6.3 推完，10-09 宿主与 node_modules 已到 18.8.6，pin 仍 18.6.3，bun test 两项红（installed != pin、host != pin）。pin + lockfile 同步至 18.8.6。node_modules 被谁改仍是未知机制（前六次同一条），不假装知道。协议的宿主源码引用逐条对 18.8.6 复核未动：runtime-init.ts:126 与 acp-agent.ts:2581（getAllTools: () => session.getAllToolInfos()）、runtime-init.ts:212、extension-ui-controller.ts:320-329、agent-registry.ts:69（Null exactly when parked/aborted）。18.8.6 全量回归：tsc 0 / 105 单测 / biome 干净；六探针全绿（SMOKE 21 工具、HARDEN 35、BLOB 32、SCENARIOS 54 steps 0 failed、审批 VERDICT B 挂起 90001ms 无副作用审计 start=1 done=0、PACKAGE OK）。协议页内存表按第二十轮重落：空闲 485MB、单个 8MB 安顿 +21MB、两个并发安顿 +51MB、峰值 +22/+51（本轮峰值与安顿几乎相等，三种关系都出现过）；test/rss-18.8.6.json 替换 18.6.3 那份。教训同前：这条不变量的保质期由宿主的升级节奏定，不由修复定。"
  source: "bun test 红两项 + omp --version 18.8.6 + 六探针复跑"
  affects: [a2a-mcp-bridge]

- time: 2026-10-10T14:03:31
  kind: decision
  summary: "证据记录必须先于「响应装饰」步骤落盘（2026-10-10 代码评审确立，适用面超出 /blob）。src/blob.ts 原先在写入成功后先 stat 读回文件大小、再写 auditBlob；那一次 stat 在 close() 之后的窗口里可以抛（文件被 unlink、父目录失可寻），于是出现「500 + 字节已在盘上 + 日志无痕」——对一个以审计为唯一痕迹的端点，这是最坏的组合。现在 auditBlob 先落盘，读尺寸失败只让响应少一个 size 字段，状态照常 200。响应也不能反过来报 500：分块客户端的语义是 5xx 重试，而 /blob 只会追加，重试就是同一段字节写两遍。取舍的通用形式：凡是「这条记录是某类操作唯一痕迹」的场合，痕迹的写入不许排在任何可能失败的锦上添花之后。该修复没有先红后绿的测试——竞态窗口摆不出来，docs/testing.md 按「第三条没有」明说，不冒充变异核验过"
  source: "src/blob.ts · docs/testing.md 失败与边界组"
  affects: [a2a-mcp-bridge]

- time: 2026-10-10T14:04:17
  kind: decision
  summary: "「归属」与「声明」分家（2026-10-10 评审确立）：进审计的 sid 只能是桥自己签发过、还在空闲窗口内的会话 id，外部来历的值一律记 null，而不是拒绝请求。/blob 原先把 mcp-session-id 头照抄进 auditBlob——审计里唯一的归因字段由调用方自报，任何持 token 的人都能把写入登记到别人的会话名下或编一个 id；MCP 路径逐条验这个头，同一个字段在两条路径上不是一个意思。不选拒绝的理由与 AGENTS.md 一脉：拒绝等于桥在决定谁可以上传，这是协议没给过它的位置——只有 token、没有会话头的请求本来就是受理的。签发过的 id 经 /blob 会刷新空闲计时，与 MCP 路径同一语义。核验三条：伪造头照样写得成且审计为 null；桥签发的头原样进审计；无头写为 null。变异（换回照抄）只红归属那条"
  source: "src/server.ts issuedSession · test/blob-probe.ts"
  affects: [a2a-mcp-bridge]

- time: 2026-10-10T14:04:39
  kind: decision
  summary: "鉴权失败的信号走 stderr，不进审计文件（2026-10-10 评审确立）。401 原先在日志里一条痕迹都没有，运维分不清「没人来」与「来的人全敲错门」；现在进程级计数 deniedAttempts，第一次与其后每 50 次打一行宿主 stderr。刻意不落审计的理由是一条攻击面算术：审计文件是 512KB 轮转、只保留一代的滚动窗口，而轮转不认鉴权状态——给鉴权前的流量写记录，等于把「冲掉真实记录的唯一杠杆」交给每一个正在猜 token 的人，他们不需要猜中，只需要灌量。信号强度按这个约束定：stderr 的告警不占磁盘窗口，节流到 1/50 不刷屏。同族决定：这类「用共享状态给失败留痕」的设计，先问留痕本身会不会成为新的写入口"
  source: "src/server.ts · README Troubleshooting"
  affects: [a2a-mcp-bridge]

- time: 2026-10-10T14:04:39
  kind: decision
  summary: "token 下限 fail-closed，不自愈（2026-10-10 评审确立，改 Q6 的自愈边界）。配置里存在但短于 32 字符或含空白的 token 与 port/host 同罪：拒绝启动并报字段名；自愈只剩字段缺失或根本不是字符串这一种。原实现把「非法 token」一律当缺失处理，重写并写回——对 3 字符的占位符这不是宽容，是给一个「能写宿主可写的一切」的端点留了扇没人知道开着的门；反过来若自愈继续，谁手写短 token 就会被桥悄悄换成随机值，远程 mcp.json 对不上号且没有任何地方说明原因。MIN_TOKEN_CHARS=32 压在 generateToken 产出（43 字符）之下，拦的是占位符，不是从别处抄来的密钥，这是它敢做硬拒绝的原因。代价写明：把一个本来能起的桥按死，操作者要去读报错——换到的是「交出去的 token 一定交出去」"
  source: "src/config.ts · test/config.test.ts"
  affects: [a2a-mcp-bridge]

- time: 2026-10-10T14:04:56
  kind: decision
  summary: "审计写失败「吞但不哑」（2026-10-10 评审确立，Q6 的补充）。不变式「日志写失败不影响调用」原样保留——rejection 冒到宿主进程或卡死队列都在这条断言的红名单里；但每个日志路径第一次写失败打一行宿主 stderr（audit record not written to <路径>），此后每满 100 次再打，计数经 auditWriteFailures() 可读。理由：写不成的日志与从没被调用过的桥看起来一模一样，而本项目的安全论证建立在「/blob 的唯一痕迹在这份文件里」上，论证的前提坏了必须说出来。按路径而非按进程记「首次」： 让一个进程可以对着多个路径，全局只报第一次会让第二个路径哑掉。变异（换回空 catch）只红新断言那一条"
  source: "src/audit.ts · test/audit.test.ts"
  affects: [a2a-mcp-bridge]

- time: 2026-10-10T14:04:56
  kind: evidence
  summary: "单测套件的 teardown 与全局审计队列相吃（2026-10-10 排查记录）：test/host-call.test.ts 的 afterAll 原先直接删审计目录，把别的文件此刻还在途的记录一并抹掉——「审计写失败要可见」那条断言在全套件里红、单跑绿，红的是别人的 teardown。修法：afterAll 先向队列投一条哨兵记录并轮询等它落盘（上限 3 秒）再删。可泛化的形状：进程级共享资源（这里是一条 promise 队列加一个路径）在做完断言前必须排空再销毁；跨文件的全局单例测试，先红的那条往往不在改它的人的文件里"
  source: test/host-call.test.ts afterAll
  affects: [a2a-mcp-bridge]

- time: 2026-10-10T14:06:54
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [a2a-mcp-bridge]

- time: 2026-10-10T17:12:00
  kind: decision
  summary: "网站定位（2026-10-10）：站点以「用途」为先。首页 features 从『连上能干什么』讲起——烧板子（bash→adb/idf.py/烧录器）、驱动 xd:// 挂载设备、POST /blob 放固件、接上远程 agent，机制卡「远程能碰到什么」拆成场景卡；协议/测试两张导航卡保留。文案口径：数字、表格、代码块与仓库文档逐字节守恒，改动只落在句子层（sync.mjs 自有文案 + docs 进站页）；CHANGELOG 里带事实宾语的单次「而非」对照暂留，由作者裁决。"
  source: "网站去 AI 味与首页改版（2026-10-10）"
  affects: [a2a-mcp-bridge]

- time: 2026-10-11T03:29:45
  kind: reversal
  summary: "Unit-vs-probe stance overturned (2026-10-11): the earlier 「刻意不补单测」 ruling for server.ts's /blob dispatch + issuedSession and audit.auditBlob claimed those areas need real bytes and belong only to test:blob. Wrong on both counts: unit tests can start the real bridge against tiny real files in /tmp and pin WIRING and record SHAPE (auth-before-payload ordering, DELETE 405 not killing the MCP session, sid attribution states incl. TTL refresh via injected clock, one-done-line blob:write shape, error cut at 200, bytes:0 on failure) — things the 35-item probe cannot localize when red. Byte fidelity stays with the probe. Result: +10 tests (107->117, new test/blob-route.test.ts 8 + auditBlob shape 2), server.ts 93->100%, audit.ts 76->100%, blob.ts 5->78.67% (remaining 162-165 in-flight 409, 173-182 short write, 184 write-failure catch stay probe territory — covering them in units would require injecting an fd or a real full disk, i.e. moving host-only semantics into units). Four mutations, each red under its own test names; src restored to zero diff."
  affects: [a2a-mcp-bridge]

- time: 2026-10-11T03:29:45
  kind: decision
  summary: "Sentinel drain before absence assertions, second recorded use (2026-10-11): audit appends ride one fire-and-forget process-level chain, so any test asserting a record is NOT in the log must first enqueue a sentinel auditStart(marker) and poll until it lands, then read. First established via test/host-call.test.ts afterAll teardown (2026-10-10); reused in test/blob-route.test.ts for the rejected-shapes 'writes nothing, logs nothing' checks."
  affects: [a2a-mcp-bridge]

- time: 2026-10-11T03:30:03
  kind: note
  summary: "Version state 2026-10-11: host omp auto-updated to 18.8.7; test/versions.test.ts guard fired red, pins + bun.lock synced 18.8.6 -> 18.8.7. Full regression green on 18.8.7: tsc, biome, unit 117/117, six host probes (SMOKE, HARDEN 35, BLOB 35, SCENARIOS 54/0, approval VERDICT B hang 90001ms, PACKAGE). RSS round 23 measured on 18.8.7: idle 549 MB, all four 8 MB deltas negative (settled -57/-56, peaks -1/-32) — baseline-sampling artifact, same explanation as prior negatives; protocol.md table refreshed from test/rss-18.8.7.json."
  affects: [a2a-mcp-bridge]

- time: 2026-10-12T04:59:47
  kind: reversal
  summary: "「宿主不做模型推理、不消耗 token」被远程实测推翻其绝对形式，收窄为「桥自身从不请求模型」。链条：远程 bash 超过宿主 300 秒命令超时 → 宿主转成后台任务 bg_1 → 任务完成时 omp 注入 custom_message async-result（\"Background job bg_1 has completed. Resume your work…\"）→ 宿主会话自己的 agent loop 被唤醒，发出真实推理（provider omni、model stack/medium，单轮 input 8,309 起，几十轮）。时间戳：04:35:23 转后台、04:36:27 通知进会话、04:36:31 首批带 usage 消息；此前桥渲染的约 28 次 UUID 工具事件全程未进消息流（会话 0 消息），桥的请求路径确实零模型请求。定性：这是工具执行落在宿主真实会话的会话级副作用，不是桥在推理，与 /blob 同属「桥放弃不碰宿主会话状态」一类代价。文档已同步收窄：README（中英）导语与安全节新增唤醒条目、docs/computer-use.md 表格与「容易误解」节、docs/testing.md 探针边界。"
  affects: [a2a-mcp-bridge]

- time: 2026-10-12T04:59:47
  kind: evidence
  summary: "宿主探针存在结构性盲区：test/harness.ts 播种的 FAKE_MODELS_YML 指向不可达 provider，它证明的是「桥不靠模型回答也能跑」，证不了「宿主零模型请求」——被拒绝的请求静默失败，没有任何计数能看到尝试本身。后台任务唤醒宿主这条链（见前条 reversal）正是从这个盲区漏出去的：现有六个宿主核验没有一条走超时转后台路径（审批探针把 bash 挂住就看结论）。若要补，方向是三文鱼式 sink provider：种一个可达但只记账的 provider，数宿主发出的模型请求次数。待裁决。"
  affects: [a2a-mcp-bridge]

- time: 2026-10-12T11:07:11
  kind: reversal
  summary: "10-12 待裁决的「第七核验」裁决为加，且实现比补盲更大：接管功能（POST /host-llm + host_llm 配置）直接把「宿主零自主推理」变成可执行的不变量，探针从「要不要数」变成「数给接管看」。原 evidence 说的盲区（不可达 provider 静默失败、计数看不见尝试）由计数 sink 关闭：test/takeover-probe.ts 起 Bun.serve 答 503，deny 在位时断言命中恒零，恢复侧负控断言轮次真打到 sink——没有负控，一切零读数都只是「连不上」。同时被推翻的还有绝对化表述的另一半：不是「证不了宿主不发请求」，而是现在可以承诺不发并当场核验。harness 不可达 provider 对其余六个核验仍是正确的默认。"
  source: "test/takeover-probe.ts · docs/testing.md"
  affects: [a2a-mcp-bridge]

- time: 2026-10-12T11:08:05
  kind: decision
  summary: "宿主推理接管（2026-10-12，用户两条裁决：宿主不允许任何自主 LLM 调用；开关本身归远程）。分层保证是并集不是交集：(a) 注册表影子化——枚举 session.modelRegistry 全部 provider，重注册到 deny 实现（api=a2a-deny），并把影子行经 agent.setModel 推进主循环（agent 持捕获的 Model 对象，不换行就拦不到在途会话）；(b) 宿主进程 globalThis.fetch 按目的地绊线，键=models.yml 全部 baseUrl 的 host+port，盖 task/websearch/commit 等自建注册表的旁路；(c) 降噪 override（autoBackground/retry/advisor/ttsr/prewalk/autolearn/cacheWarming/compaction），全运行时不落盘。哨兵文本刻意避开四类重试触发器，实测被拒轮次恰好一次尝试、retryable:false。控制面：host_llm 配置只决定启动状态；POST /host-llm {enabled} 是第二条非工具 HTTP 路（同 /blob 先例，鉴权前判、审计 tool:host_llm、不落盘、重启回配置），刻意不进 tools/list——目录透传宿主注册表，桥对宿主做的事不是宿主的工具。装配在 bind 之前、每次 session_start 重装（新 runner 带新注册表）。诚实边界（残差全部文档化）：pi-native transport 拦不住则拒绝装配、不改任何状态；绊线只在宿主进程内——task 子代理在独立进程实测靠影子行崩溃封死（Unhandled API in mapOptionsForApi，约250ms 退出），是 fail-closed by crash 不是拦截；运行中新加 provider 到下次装配才进 deny；/login 交回所有权即解除 deny；title.generator 枚举无关。AGENTS.md 的例外记录由此变为两条（/blob 与 /host-llm），framing：takeover 限制的是宿主自己，且只在持有 token 者的指令下。"
  source: "src/takeover.ts · docs/protocol.md「宿主推理切换」 · AGENTS.md exceptions"
  affects: [a2a-mcp-bridge]

- time: 2026-10-13T01:22:41
  kind: evidence
  summary: "评审（2026-10-13）用宿主真实 ModelRegistry 在进程内驱动 src/takeover.ts（5457 行目录、73 provider）核出三项读不出来的缺陷：(1) registerProvider(name,…,sourceId) 会把 provider 名字的归属转给调用方，影子化全部 provider 等于抢走别人的注册——别的扩展（含宿主 loadCliExtensionProviders 从 ~/.omp/agent/extensions 注册的）经一次 arm/restore 后该 provider 的行从目录里彻底消失且不恢复；(2) 影子化/推模型行/settings override/fetch 绊线全部在 armed 赋值之前完成，中途抛错留下「宿主已被全量拒绝但状态报 enabled:true、setEnabled(true) 也救不回」的残局；(3) 合成 sourceId \"a2a-bridge\" 会进 #registeredProviderSources，宿主每次建 session 跑 syncExtensionSources(扩展路径表) 就把它当已卸载扩展剪掉——影子层当场消失而桥仍报 deny，只剩 fetch 绊线。顺带：happy path 恢复经 9 字段 × 5457 行逐行比对为 0 missing/0 extra/0 changed，deny 覆盖与 fetch 引用还原成立。"
  source: "review probes 2026-10-13 (.review-tmp, 未入库)"
  affects: [a2a-mcp-bridge]

- time: 2026-10-13T01:56:21
  kind: reversal
  summary: "接管第一层换机制：不再影子化目录里每个 provider。理由是宿主 ModelRegistry 的所有权语义——registerProvider(name,…,sourceId) 把 sourceId 记成名字的所有者，别人拥有时先 #clearRuntimeProviderState 再接管，而公开面唯一的撤销 clearSourceRegistrations 是「这个扩展卸载了」不是「撤销那一次调用」，所以全量影子化等于删掉别的扩展注册过的 provider 且不恢复（实测 2 行 → 0 行）。新机制三层，判据统一为「每条推理请求最后从哪个口出去」：(1) deny api + agent 手里那行的 deny 副本（deny 副本必须摘掉 resolveHeaders，否则 pi-ai 在 api 分派前先跑 !command 取密钥程序）；(2) globalThis.fetch 目的地绊线——pi-ai 取 fetch 是 options?.fetch ?? globalThis.fetch，取全局绑定、每次调用现读，所以这层盖住所有 fetch 道，包括自建注册表的 task 子代理（它们不再靠崩溃封死，而是被绊线按下去）；(3) 只声明不是 fetch 的道，按 api 判两张表：cowork（provider=anthropic + api=anthropic-messages → node:https 直连）与 Codex websocket（api=openai-codex-responses，宿主把 providers.openaiWebsockets 逐次转发给 provider 调用，所以不能按行上的 preferWebsockets 判；默认目录里就有这样一行，按行判会让 deny 开箱装不上）。默认装法声明 2 个名字而不是 73 个，装配 288ms → 16ms。transport 拒绝收到「不在被声明名单里的 provider 带 transport」，被声明的 provider 整份行被换成不带 transport 的 overlay。"
  source: review fix 2026-10-13
  affects: [a2a-mcp-bridge]

- time: 2026-10-13T01:56:21
  kind: evidence
  summary: "评审轮的三条纪律与它们各自的落点。(1) 宿主注册表可以在进程内直接造：AuthStorage.create + new ModelRegistry 对着 /tmp 的临时 agent 目录就是真实内置目录（18.8.7 上 5457 行、七十多个 provider），不起宿主、不连网、秒级——新增的 test/registry-probe.ts（22 项）就是这一档，CI 收在 check job。读不出来的「谁拥有这个 provider 名字」「抛错时留下什么」两个问题，只有这一档能答。(2) 合成 source id 的陷阱：registerProvider 会把 sourceId 放进 #registeredProviderSources，而 createAgentSessionScoped 每次建 session 跑 syncExtensionSources(扩展路径表)，不在表里的 source 被当成已卸载的扩展剪掉——实测一次调用后 deny 行从 5457 变 0 而 enabled 仍读 false。所以桥的装配必须幂等，且入口要在开关开着时（不只看配置值）每次 session_start 重装。(3) 装配是事务：改动之前先把 armed 记下来，抛错时整体回滚再抛——旧顺序留下的是「宿主已全量拒绝但端点回答 enabled:true、setEnabled(true) 救不回」的死局，只有重启宿主能了事。"
  source: review probes 2026-10-13
  affects: [a2a-mcp-bridge]

- time: 2026-10-14T06:13:43
  kind: reversal
  summary: "审计记录改为先于响应落盘：四个入口（auditStart/auditDone/auditBlob/auditHostLlm）返回进程内那条队列的尾部，调用处在应答前 await。**这条推翻了本页此前记的「审计绝不能延迟调用」里的 fire-and-forget 部分**——旧形状下 appendLine 交出队列就返回，响应会跑在记录前面，而队列本来就从不 reject，所以那个形状并没有为调用方挡掉任何失败，只挡掉了「慢盘上响应等一会儿」。代价是每条约 99 µs（stat+appendFile+chmod 串行，2000 行实测），对着一次 bash 调用可忽略；慢盘推迟的是响应而不是记录。定位方式值得记住：那条「十次里红两次、复现不了」的 flake 不是测试问题而是产品问题，用同一个人工慢盘（队列里加 30ms）配旧形状跑，得到的红项与实况观察到的完全一致（audit has a done record / the two phases pair by id），只把 await 放回去即全绿。附带修好的还有两条被旧形状破坏的东西：其一是调用方拿到 200 再读日志读不到自己这次调用；其二是 audit.ts 写明的那个证据设计（start 排在工具执行之前，所以进程死在调用中途会留下 start 无 done）本来是假的——不等队列，工具副作用先落地，那个窗口里崩掉什么痕迹都不留。并把两处被改动掏空的断言补实（expect(() => …).not.toThrow() 在返回 promise 的函数上什么都证明不了），新守卫分两半：行为那半「await 回来记录就在盘上」只能在慢盘上看出来，确定性那半钉住四个入口都返回 Promise。"
  source: audit ordering 2026-10-14
  affects: [a2a-mcp-bridge]

- time: 2026-10-14T06:13:51
  kind: decision
  summary: "仓库形状定成三条子句，且这个守卫必须独立进程跑。(1) 仓库里提交过一个指向仓库根的符号链接 hidden-plugin（mode 120000，目标 /home/gem/project/pi_a2a_ext），是 59a5e60 那次 git add -A 扫进去的调试残留；git status 一直干净、全部核验一直绿，而 find -L 会回答「File system loop detected」，别人 clone 拿到的是他机器上那个路径。npm 没带上它只因为 files 只含 extensions/ 与 src/，是打包的巧合不是决定。(2) 规则不是「不许有符号链接」——.claude/skills/design-doc-mermaid 是被跟踪的合法相对链接（指向被提交的 .agents/skills/design-doc-mermaid），禁掉它就是禁掉仓库自己的约定；所以拆成三条子句各有各的失败：绝对目标、解析出仓库、解析到自己的祖先。第一版守卫把 .agents/.claude/.qoder 放进跳过表，等于不看题面所在目录——它连那个合法链接都没看见，旁边再放一个坏链接同样看不见，而探针报告「0 个链接，干净」。(3) **守卫不能放在 bun test 里**，这条最反直觉且要靠变异才发现：自环一存在，runner 爬目录撞上自己，10.3 秒 98% CPU 后 exit 1、只打 48 字节，没有测试名也没有断言——坏的树形状不是让某个检查变红，是把证据删掉。所以 test/tree-probe.ts 独立进程跑，CI 里排在 bun install 之前，无依赖不需要宿主。同类教训：本轮另有两次「绿灯的变异」也是变异把自己废掉了（把 defineAsyncComponent(() => import(...)) 改成 (await import(...)).default 仍然是动态导入；只静态引入组件而 mermaid 库仍被 shouldPreload 挡在预载之外——要复现那次 1.58MB 得同时拆掉两半防御）。"
  source: repo shape probe 2026-10-14
  affects: [a2a-mcp-bridge]

- time: 2026-10-14T06:13:57
  kind: evidence
  summary: "两条宿主侧边界，都实测过而非读出来的。(1) **ACP 模式不加载扩展**：起 omp --mode acp（临时 HOME、host_llm: deny、配置与其它探针同形），ACP 的 initialize 有正常应答（protocolVersion 1、agentInfo 18.8.7），但 stderr 里一次都没提到 extension、进程一个端口都没在听（ss -ltnp 按 pid 查为空）、/a2a 连不上。acp-agent.ts:2662 虽然是 session_start 的真实发射点，但对桥不可达。结合 rpc 的 new_session 只是 /clear（保留同一会话对象与监听器，不发 session_start），两条路都试过之后，「重建后的 Main 会话」这项覆盖的阻塞不在桥这一侧，而在宿主没为 Main 暴露重建口——要它得宿主加 rpc 或 ACP 钩子。进程内的 stood-in（第二个真实 ModelRegistry）继续算数：重建的实质就是「同一份配置上一个全新的注册表」。(2) **别的扩展占着被声明的那两个名字（anthropic / openai-codex）这一档，定成有意不修**（2026-10-14 操作者判掉）：registerProvider 接管名字时会 #clearRuntimeProviderState，而公开面唯一的撤销 clearSourceRegistrations 重放不了运行时状态，restore 会按 (id, api) 核回来、没回来就在宿主日志点名、要重启才恢复。它只在一种安装下发生——别的扩展接管了宿主自带的名字——不是桥能解决的局面，因此不加专门探针；探针里 myprov rows 2 -> 2 覆盖的是常见情形（扩展占着没被声明的名字，桥根本不碰，73 个名字里 71 个属于这档）。takeover.ts 里那段措辞已从「待修的残余」改成「范围决定」，否则下一个读到注释的人会以为还欠着一项。"
  source: host boundary probes 2026-10-14
  affects: [a2a-mcp-bridge]

- time: 2026-10-14T06:14:04
  kind: evidence
  summary: "网站侧三处「发布过但没人看得见」的坑补上守卫，其中一处是真 bug。sitemap 的 lastmod 曾取构建产物 mtime（等于宣称每页每次部署都变，搜索引擎直接忽略）、robots.txt 与 sitemap 的 origin 各推一遍（漂了无人知）、withMermaid 曾把 mermaid 静态注入 entry 让每页首屏阻塞预载 1.58MB——三条都不报错、不影响构建、评审里看不出来。真 bug 是首页 lastmod 取错源文件：collect() 把 index.html 的 index 后缀去掉，于是首页的 page 名是空串，SOURCE_OF.index 从来没被命中过（死代码），首页落到「无源文件」兜底，lastmod 变成**仓库最新提交**的日期而不是 README_ZN.md 的——两者同一天时看不出来。配套的是页面→源文件映射抽成 website/scripts/sources.mjs 供两处共用（抄两遍正是这个仓库吃过亏的形状，备份里少改一处不会有任何东西失败）。新 sitemap 检查自己第一版就栽在空转上：URL→页面名解析成了 http://localhost:5173/changelog，于是每个 git 查找都指向不存在的文件、整组检查「全过且什么都没验」——所以除了逐页比对，还加了「每个页面必须映射到一个真实存在的源文件」与「git 可用时至少真比对上一条」两条反空转。"
  source: site guard review 2026-10-14
  affects: [a2a-mcp-bridge]

- time: 2026-10-15T09:19:41
  kind: evidence
  summary: "发布包是复制品，只允许依赖一个宿主包；探针必须测用户执行的那个形状（2026-10-15，v0.2.1）。触发：Windows 上 omp install <git-url> 失败 `Cannot find package '@oh-my-pi/pi-ai' imported from …/src/takeover.ts`，本机 Linux 九个核验全绿。机制：git-URL 安装是复制品，落在 ~/.omp/plugins/node_modules/pi-a2a-ext/ 下、没有自己的 node_modules，所以包里的每个 @oh-my-pi/* 都得由宿主 shim 解析；而 v0.2.0 接管新增代码要的三个 pi-ai 符号里有两个（api-registry、utils/event-stream）根本不在那个包的 exports 映射里，只靠 ./* 与 ./utils/* 通配符解析——靠文件布局的运气，不是承诺。修法：三个符号改从 @oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim 取（pi-coding-agent 显式导出的子路径、export * from pi-ai，且扩展为了 pi.on(...) 早就依赖它、shim 在任何机器上必然可解析），整个包现在只依赖一个宿主包；顺带一个类型变化：AssistantMessageEventStream 在 shim 侧是类型不是值，改用它的工厂 createAssistantMessageEventStream。守卫（跨平台、抓根因）：test:install 走同一张 import 图收所有非相对 specifier，要求除 @oh-my-pi/pi-coding-agent 外没有第二个宿主包；变异核验退回 @oh-my-pi/pi-ai/api-registry → 红并点名 src/takeover.ts。一个只起宿主的探针在这里仍然是绿的（Linux 能解析、Windows 不能），所以不能拿「桥起来了」当这条的守卫。探针的结构性盲区单独记：test:install 一直 omp install <工作树>（工作树自带 node_modules），测的是「软链 + 依赖齐备」，而 README 给用户的命令是 git URL = 「复制品 + 没有依赖」——两者不是同一件事，而只有后者是用户执行的；同一个坑此前吃过一次（test:blob 忘了挂扩展、本机假绿）。"
  source: "v0.2.1 · test/install-probe.ts"
  affects: [a2a-mcp-bridge]

- time: 2026-10-15T09:19:41
  kind: reversal
  summary: "版本号从 package.json 读引出的新失败模式（2026-10-15）。v0.2.0 把 serverInfo.version 从字面量改成读 ../package.json 是对的（旧字面量 0.1.0 与 docs/protocol.md 互相背书、没人比对），但那次 readFileSync 在模块顶层且不兜底，于是在 extensions/ 直接躺在 agent 目录下、旁边没有 package.json 的布局里，一个版本号就能让整个扩展加载失败——这是在模拟真实复制品布局时才撞出来的，本机工作树形状暴露不了。改成读不到就报 unknown：一个因为版本号而加载不起来的桥，比一个报 unknown 的桥更糟。"
  source: extensions/a2a-bridge.ts
  affects: [a2a-mcp-bridge]

- time: 2026-10-16T03:18:36
  kind: decision
  summary: "远程经公网 URL + token 访问是一等受支持场景，实测可用（2026-10-16，操作者原话：必须满足这个使用场景）。测法：数据中心这一侧的进程当 MCP 客户端，经 cloudflare quick tunnel（https://…trycloudflare.com）驱动一台 Windows 上跑着的宿主，18 项全过——initialize 回 serverInfo.version=0.2.1（顺带证明该机装的已是修好的 v0.2.1 而非装不上的 v0.2.0）、tools/list 22 个（宿主注册表逐字，含 write/edit/bash）、tools/call bash 真跑出输出、write 建文件、read 读回、edit 改行、POST /blob 15 字节原样落盘、未知工具与未知方法（-32601）都报错、错/缺 token 401、bogus session 404、DELETE 204。机制侧：桥不校验 Host/Origin，绑 0.0.0.0 或经反向代理都通；TLS 由隧道提供，token 是唯一的门。**据此，README「默认只监听 127.0.0.1，跨机器要用 SSH 端口转发」与协议页「真要对外暴露，防火墙自己负责」的措辞，把隧道/公网 URL 当成旁门而非一等路径，需要改**（本页此前的印象也是「只绑回环」，操作者这次纠正为「这个场景必须满足」）。操作者当时只要实测结论，文档改动挂起。附带一条宿主事实：这台机器的 edit 是 Hashline 补丁 DSL（单个 input 字段，[PATH#TAG] + PUT N.=M:），不是 oldString/newString——远端客户端必须按每个宿主工具自己的 schema 说话，桥一个字不加。"
  source: "公网隧道实测 2026-10-16"
  affects: [a2a-mcp-bridge]

- time: 2026-10-16T03:28:42
  kind: decision
  summary: "文档不写公网/隧道这条（2026-10-16，操作者：不用写上）。前一条 decision 里「README 与协议页措辞需要补上一等隧道路径、文档改动挂起」到此关闭：**不改**，对外部署说明维持现状（README 讲 SSH 端口转发，协议页讲「真要对外暴露，防火墙自己负责」）。公网隧道是受支持且实测可用的场景（见前条 18 项），只是不落进文档。"
  source: operator 2026-10-16
  affects: [a2a-mcp-bridge]

- time: 2026-10-16T04:02:22
  kind: decision
  summary: "宿主 omp 18.11.0（2026-10-16，宿主自己升的）：pin 与 bun.lock 同步到 18.11.0（版本守卫如期红两条）。18.11.0 起 ~/.omp/plugins 按 HOME 解析（18.10.4 上不跟随），且加载读 omp-plugins.lock.json 里的登记、不是目录里有什么——临时 HOME 里只放软链不加载，omp install 过才加载。因此 test:install 的端到端改成把 omp install . 装进它自己起的那个临时 HOME：自包含，且不再在真实 HOME 留 pi-a2a-ext 登记。四处写「插件目录不跟随 HOME」的实测结论改成带版本的写法。第一次判定「不跟随」用的是 </dev/null 起的宿主，stdin EOF 即退出、什么都没加载——harness 早已记着这条"
  source: "本地实测三组 + 九个宿主核验与站点守卫重跑；commit e5e8f61"
  affects: [a2a-mcp-bridge]

- time: 2026-10-16T04:18:02
  kind: decision
  summary: "发布卫生：一个装不上的版本从 GitHub Release 撤掉，而不是标 prerelease 或加一句「请用新版」——发布入口里不该留着一个装不上的东西。v0.1.0 与 v0.2.0 的 Release 于 2026-10-16 撤下，三个 tag 全留（gh release delete 不加 --cleanup-tag），可安装入口只留 v0.2.1。CHANGELOG 的历史节不动，开头补一句现状"
  source: "操作者决定（2026-10-16）；commit 88dc4f9"
  affects: [a2a-mcp-bridge]

- time: 2026-10-16T05:29:02
  kind: decision
  summary: "桥把 Bun.serve 的 idleTimeout 显式设成 255（Bun 的上限），并把 body 读取失败收进 /blob 的审计。原因是 Bun 的默认值 10 秒量的是**请求体没有字节到达**的时间，不是请求总时长——Bun 1.3.14 本机 A/B 实测：31.4 MB 的 body 以 1 MB/s 连续传 31.8 秒正常收完；同一个 body 在中途停 15 秒，服务器先打 `[Bun.serve]: request timed out after 10 seconds`，再让 handler 里的 req.arrayBuffer() 抛 `AbortError: The connection was closed.`，客户端 socket 已关。改前那个异常逃出 handleBlob、撞在 server.ts 的兜底上：调用方拿到一个无从接收的 500 internal error，审计（这个端点唯一的痕迹）一条也没有。现在落成一条 `blob:write`（bytes: 0，error `body ended early: …`）并回 400。核验：bun test 162/162；test:blob 新增的「body 中途停 15 秒仍字节一致」通过（这条在旧默认值下必然失败），真实宿主 18.11.0 一轮全绿。"
  source: "2026-10-16 现场：31.6 MB APK 经 cloudflared quick tunnel 上传失败"
  affects: [a2a-mcp-bridge]

- time: 2026-10-16T05:29:52
  kind: evidence
  summary: "2026-10-16 隧道上传失败现场的完整链条与两份线速，记在这里是因为操作者要求这类现场只留在 brain，不写进 README/docs/website。(1) 拓扑：宿主在 Windows（omp 18.11.0，cwd C:\\chenzhaodi\\Repo\\omp_mcp，cloudflared quick tunnel paid-joining-wayne-formed.trycloudflare.com → http://localhost:62133，出口 v4 42.84.234.48 联通、另有原生 v6 2408:…），调用方是本机（Linux，eth0 192.168.1.57/24 → NAT → 119.112.242.125，**无 IPv6**，sshd 听 0.0.0.0:22），源文件是 vimact 的 debug APK 31,597,173 字节。(2) 三次尝试：第一次被 omp 的 60 秒 bash 超时自己掐掉；第二次 curl 27.2 秒传完整个 body 却拿到 502；第三次 size_upload=31597173 time=135.572723s 拿到 524（≈233 KB/s）。cloudflared 端记 `Incoming request ended abruptly: context canceled`（connIndex=0 event=1 ingressRule=0）——时间戳落在第三次开始后约 10 秒，正是桥侧 idleTimeout 掐断的时刻；桥端记 AbortError internal error；文件没落盘、审计无记录。(3) 线速对照：本机上传 Cloudflare 2.0–2.5 MB/s，但下载 Cloudflare 只有 23 KB/s（60 秒超时），同一台机器从 CN 镜像下载 36.6 MB/s，GitHub 归档 0 B/s——说明国际段的快慢是代理/路由在决定，不是这条线本身。宿主方向：从宿主连本机 119.112.242.125 的 22/8899 都是 Could not connect（无端口转发），宿主对本机没有入向路径。(4) 结论：这台机器与宿主之间现在没有点对点通路；隧道替它们当中转，代价就是 Cloudflare 对 origin 的 100 秒窗口 + 本例里宿主的接收速率。点对点选项按代价排序：路由器端口转发 + ssh/rsync（本机已听 22，且是真实公网 IP 而非 CGNAT，所以只差一条转发）；给本机接上 IPv6（宿主已有 v6，两端都通就免转发）；Tailscale/ZeroTier 之类的 mesh；VPS + frp/ssh -R 中继。另外一条零基建的反向做法：让**持有文件的那一侧当 server**（静态服务器 + 自己的 quick tunnel），另一侧 GET——响应可以流式传输，不受 100 秒 TTFB 窗口约束，只受该侧上行限制。"
  source: "2026-10-16 现场 + 经仍存活的 quick tunnel 实测"
  affects: [a2a-mcp-bridge]

- time: 2026-10-16T05:51:11
  kind: evidence
  summary: "2026-10-16 结论：在当前拓扑下「不假定任何基础设施、只走 HTTP 或点对点」不可实现，已逐项实测排除。拓扑与证据：(1) 调用方本机 LAN 192.168.1.57/24、公网 119.112.242.125（NAT 后），**只有 link-local 的 IPv6**（/proc/net/if_inet6 无 global，无 v6 默认路由），其路由器 192.168.1.1 **不应答 SSDP**（UPnP IGD 关）；更要紧的是该路由器在做 fake-ip 分流：trycloudflare.com / cloudflare.com / github.com 都解析到 198.18.x（Clash 风格），mirrors.aliyun.com 才是真实 IP——也就是说经 Cloudflare 那条路**整个走的是路由器上的代理**，不是这条线本身（这条线同机实测 CN 镜像下载 36.6 MB/s）。这解释了本次现场的不稳定：2 MB 分块一次 44.6 秒（约 47 KB/s）、下一次直接 502，而早先整包 31.6 MB 平均 233 KB/s、speed.cloudflare.com 上传 2.0–2.5 MB/s、下载 23 KB/s——同一台机器上这些数字相差五十倍，代理在决定。(2) 宿主 LAN 172.21.201.185/16（网关 172.21.201.17，企业/热点网），公网 v4 42.84.234.48，**有原生全球 IPv6 2408:8430:2000:2cd1:1985:3af7:528a:3196**；其路由器同样不应答 SSDP，Windows 侧 UPnP COM（UPnP.UPnPDeviceFinder / HNetCfg.NATUPnP）在本机不可用（值不在预期范围内），PowerShell 裸 SSDP 也无应答——两端都无法自己开映射。(3) 两条可能的直连通路都差一环：v6 只有宿主一侧有（客户端侧要 PVE/路由器补 v6 配置），打洞则缺 rendezvous 且两端 NAT 行为未知（宿主在企业网 172.21/16 后面，对称 NAT 概率高）。(4) 因此只剩下「制造一条路」的三个选项，各自只差一件事：①本机家用路由器上做一条端口转发（→192.168.1.57），之后全程是宿主主动发起的**纯 HTTP**（宿主 curl 客户端的 /blob 或静态服务器），不引入任何第三方；②给客户端补全球 IPv6，宿主已有公网 v6，之后同样纯 HTTP 直连、免映射；③若①②都不许，则必须有中继，此时最省的是现有隧道，而它不稳的根因在路由器代理策略上——把隧道域名/宿主 IP 放进 DIRECT 旁路（同样是路由器上的一条规则）。操作者 2026-10-16 的约束原话：「不能假定有任何基础设施」「只能使用 http 或者点对点」。"
  source: "2026-10-16 实测：本机路由/DNS/UPnP、宿主 LAN 与 UPnP、分块上传速率"
  affects: [a2a-mcp-bridge]

- time: 2026-10-16T06:19:28
  kind: reversal
  summary: " 现在存在：/blob 由「上传专用」变成双向——POST 写、GET 读，同一 token、同一套路径解析（无根、无白名单）。GET 支持单区间 Range（bytes=a-b / bytes=a- / bytes=-N），206 带 content-range，越界 416，缺文件 404，目录 400，其他动词 405；每次读取落一条 `blob:read`（offset/bytes 是**实际发出的区间**），404/416 同样记录。被推翻的是 docs/protocol.md「没有下载，这是有意的」与 README「Download does not work」那份论证：它列的三条宿主侧限制（read 单行 150 KB 拒绝、bash 输出 768 字节即截断、read artifact 约 150 KB）限制的是**宿主自己的工具**，不是这个端点；而在没有它的时候，调用方照样能靠 bash+base64 分块把任意文件取出来——MCP 侧根本没有二进制通道（JSON-RPC 是文本，image/resource 块也是 base64），所以那次拒绝没有换来机密性，只换来 33% 多传和一条更慢的路。真正变化的是桥现在会**读**它能写的地方，所以每次读取都必须留痕；这也是这次改动的审计理由。边界照旧：不经宿主审批门、桥自己解释路径、内存代价按每个在途请求算（上传仍是 maxRequestBodySize 128 MB 缓冲）。核验：bun test 168/168（新增 6 条：字节一致、206 分槽与续传、416、404/400、401 不落痕、其他动词 405），test:blob 新增「GET 原样取回」「Range 续传」「越界 416」「缺文件 404」与 blob:read 审计断言。"
  source: "2026-10-16：操作者要求「同一条 HTTP 通道走上传下载」并追问「必须 base64 吗，没有二进制通道吗」"
  affects: [a2a-mcp-bridge]

- time: 2026-10-16T08:37:37
  kind: reversal
  summary: "传文件面整体推翻重做，方向由操作者定死（2026-10-16 原话：「文件传输协议全部删除」「不是本机或者局域网就使用quick tunnel创建隧道传输文件」「内置quick tunnel」「选一个适合的文件传输工具 直接集成到mcp端点」）。最终形态：**桥自己不传字节**，而是实现三个 MCP 工具  /  / （src/xfer.ts，在 extensions/a2a-bridge.ts 里追加进 tools/list 并在分派时先于宿主执行器）， 让 dufs 在 127.0.0.1 上以随机端口 + 随机 basic auth 起 HTTP，再用进程内开的 cloudflared quick tunnel（src/tunnel.ts）给它公网主机名，返回带凭据的 URL；默认 TTL 3600，第二个 share 替换第一个，桥停止时带走共享；每次调用落一条  审计（args 只有 action/path/port/ttl）。被推翻的先后有两条：①（当初的理由是「宿主审批门配 prompt 时写会把无头调用方挂住 ≥90s，这是唯一不挂的写路径」）；②我当天刚加的 。推翻的判据是「字节走 JSON-RPC 本来就绕不开 base64 与 tool-result 截断（约 150 KB），而驱动一个成熟 HTTP 文件服务器不需要为每个字节付任何代价，Range/续传/目录列表全都白拿」。工具选 dufs 的理由：单文件静态二进制（Windows/Linux 都有）、无运行时无配置无账号、GET(+Range)/PUT/DELETE/WebDAV/目录列表/内置 basic auth 齐备；排除了 croc（自带第三方中继，与「走 quick tunnel」这条定死的路冲突）、python -m http.server（无 PUT，且宿主机是 Windows Git Bash 没有 python）、miniserve（只读）、rclone（体积与 WebDAV 配置都重）、tusd（等于再造一套协议）。二进制不内置： /  配置项给名字（默认按 PATH 找），缺了报名字不静默退化，也不下载任何东西。**取文件到宿主这一半故意不做**：宿主的 bash+curl 已经能做，而且那条路走宿主的审批门，桥自己写文件正是刚删掉的那种越门写入。"
  source: "2026-10-16 操作者四条指令 + 本轮实现"
  affects: [a2a-mcp-bridge]

- time: 2026-10-16T08:38:39
  kind: reversal
  summary: "（重发：上一条同题 summary 里的反引号被 shell 吃掉了，以本条为准）传文件面整体推翻重做，方向由操作者定死（2026-10-16 原话：文件传输协议全部删除 / 不是本机或者局域网就使用 quick tunnel 创建隧道传输文件 / 内置 quick tunnel / 选一个适合的文件传输工具 直接集成到 mcp 端点）。最终形态：**桥自己不传字节**，而是实现三个 MCP 工具 `xfer_share` / `xfer_status` / `xfer_stop`（src/xfer.ts，在 extensions/a2a-bridge.ts 里追加进 tools/list，并在分派时先于宿主执行器），`xfer_share {path, ttlSeconds?}` 让 dufs 在 127.0.0.1 上以随机端口 + 随机 basic auth 起 HTTP，再用进程内开的 cloudflared quick tunnel（src/tunnel.ts）给它公网主机名，返回带凭据的 URL；默认 TTL 3600 秒，第二个 share 替换第一个，桥停止时带走共享；每次调用落一条 `tool: \"xfer\"` 审计（args 只有 action/path/port/ttl）。被推翻的先后有两条：①`POST /blob`（当初理由：宿主审批门配 prompt 时写会把无头调用方挂住 ≥90s，那是唯一不挂的写路径）；②我当天刚加的 `GET /blob`。推翻的判据是「字节走 JSON-RPC 本来就绕不开 base64（+33%）与 tool-result 截断（约 150 KB），而驱动一个成熟 HTTP 文件服务器不必为每个字节付任何代价，Range/续传/目录列表/WebDAV 全都白拿」。工具选 dufs 的理由：单文件静态二进制（Windows/Linux 都有）、无运行时无配置无账号、GET(+Range)/PUT/DELETE/WebDAV/目录列表/内置 basic auth 齐备；排除了 croc（自带第三方中继，与定死的 quick tunnel 这条路冲突）、`python -m http.server`（无 PUT，且宿主机是 Windows Git Bash 没有 python）、miniserve（只读）、rclone（体积与 WebDAV 配置都重）、tusd（等于再造一套协议）。二进制不内置：`xfer.dufs` / `xfer.cloudflared` 配置项给名字（默认按 PATH 找），缺了报名字、不静默退化，也不下载任何东西。**把远端文件取回宿主这一半故意不做**：宿主的 bash + curl 已经能做，而且那条路走宿主的审批门——桥自己写文件正是刚删掉的那种越门写入。"
  source: "2026-10-16 操作者四条指令 + 本轮实现"
  affects: [a2a-mcp-bridge]

- time: 2026-10-16T08:39:39
  kind: evidence
  summary: "本轮（2026-10-16）实测与未测，按可核验性分开记。**测成了**：(1) 单测 `bun test` 160/160（新增 test/xfer.test.ts 11 项：工具面、路径解析、四种拒绝、共享生命周期——含「服务端校验的凭据就是桥生成的那一份」「stop 释放端口」「第二个 share 替换第一个」「TTL 到期后端口释放」），用以运行时写出的可执行 stub 顶替 dufs、注入隧道开洞器；`lint` / `tsc` 干净。(2) 真机 dufs 0.43.0 二进制直接驱动 src/xfer.ts，8 项全过：GET 字节一致、Range 请求 206 且内容一致、PUT 落盘、错密码 401、根目录列表 200、审计落 `tool: \"xfer\"`、共享关闭后原端口可再绑（即真的释放）。这一步抓到一个真缺陷：dufs 的 `--auth` 语法是 `user:pass@/path:rw`，我最初只传 `user:pass`，二进制直接 exit 1 报 Invalid auth。**没测成**：(3) 经公网隧道端到端。cloudflared 侧确实起得到 `https://<random>.trycloudflare.com`（本机实测打印出主机名），但**这台调用方机器所在网络对代理域名重签 TLS**（其路由器做 fake-ip 分流：trycloudflare/cloudflare/github 都解到 198.18.x），`curl` 与 Bun fetch 走公网 URL 分别报 `unexpected eof while reading` 与 unknown certificate verification error，所以「隧道这一跳 + dufs + 凭据」的端到端从未在这台机器上跑通。要在真机上验，得在一台不做 TLS 中间劫持的机器上起桥（或把这个域名放进路由器的 DIRECT 旁路）再 `curl` 那个 URL。**已知边界**：(4) quick tunnel 主机名与进程同生共死，没有重试与监督，`stop()` 之外没有生命周期管理；(5) 共享的 URL 是能力凭证，谁拿到谁能读写那个路径，只有 basic auth 一层（随机 16 字符口令）+ TTL（默认 1 小时）兜着；(6) 文档侧只写契约与用法，决策全部留在 brain（操作者 2026-10-16 明确要求），AGENTS.md 的「Don t grow a second system」按 /host-llm 的先例补了一条例外。"
  source: "2026-10-16 本轮核验"
  affects: [a2a-mcp-bridge]

- time: 2026-10-17T03:21:54
  kind: reversal
  summary: "「二进制只命名、不内置、不下载」这条 2026-10-16 定的契约，2026-10-17 由操作者推翻：缺 dufs 或 cloudflared 时，桥在首次 `xfer_share` 自己把它拉到 `~/.local/bin`，版本与 sha256 钉在 `src/obtain.ts` 的字面量表里（按 `${platform}-${arch}` 键）。推翻的直接起因是这台机器上 `dufs` 根本不在 PATH 上——契约在这里等于传文件功能不可用，而报错要求人手去 GitHub 拖包。留下的出口只有一条且必须是形状：配置里 `xfer.dufs` / `xfer.cloudflared` 写成含 `/` 的路径，那条路径原样使用、绝不下载；裸写名字不是出口。不变的边界：不请求 `latest`，不向发字节的同一台服务器要校验和，cloudflared 的钉表行是空的（取不到 release 元数据就没读到的哈希不写），目标位置已有别人的文件就拒绝并打印那个文件自己的 sha256，下载 32 MB / 90 秒有界，并发单飞，解包进新建临时目录并 realpath 断言，`install` 记录排在 `spawn` 之前。判据写进 AGENTS.md 例外清单第三条（与 `POST /host-llm` 同形）：桥已经替宿主决定了用 dufs，这次只多一个意见——字节从哪来——不是多一个权威。"
  source: "2026-10-17：操作者定「宿主自动安装 dufs」，范围=桥内置自动安装，落点 ~/.local/bin，触发=首次 xfer_share 按需，dufs 钉 0.46.0（跑完实测才写进文档），cloudflared 也自动装"
  affects: [a2a-mcp-bridge]

- time: 2026-10-17T03:21:54
  kind: evidence
  summary: "2026-10-17 本轮实测与未测，按可核验性分开记。**测成了**：(1) `bun run test:obtain`（`test/obtain-probe.ts`，18 项）真下载钉表的 linux-x64 那行 → 解到临时 binDir → `--version` 自报 0.46.0 → 账本落哈希 → 第二次调用不重下；再用**拉来的那个二进制**经 `xfer_share`（空 PATH + 空安装目录，所以获取确实发生在工具里面，回包 `installed.dufs = \"0.46.0\"`）起真共享：GET 字节一致、Range 206、PUT 201 且落盘、错密码 401、目录列表 200、`xfer_stop` 后端口释放、下一次共享复用安装而 `installed` 回 `null`。**这一步的门是 `--auth user:pass@/:rw` 在 0.46.0 上重测**——那条语法当年只在 0.43.0 上验过，门过了版本号才进 README。(2) 单测 `bun test` 184/184（14 文件），新增 `test/obtain.test.ts` 18 项（本地 `Bun.serve` 扮 GitHub：哈希不符、哈希长度不对、tar slip、解出多余条目、目标是别人的文件时拒绝、单飞只下载一次、超上限截断、超时、不支持的平台、PATH 命中不下载、显式路径不下载）与 `test/tunnel.test.ts` 4 项；`lint` / `tsc` 干净；CI 的 `host-probes` 里那条指向已删除的 `test:blob` 的步骤换成 `test:obtain`。**没测成**：(3) 经公网隧道端到端照旧——真 cloudflared 起得到 `https://<random>.trycloudflare.com`，但从发布它的那台机器 curl 回去报 unknown certificate verification error（本机路由器对代理域名做 fake-ip 分流并重签 TLS），所以探针的断言全部打在 `127.0.0.1:<port>` 上、隧道用注入的开洞器。(4) cloudflared 的自动装只有代码路径没有钉值：这台机器此刻取不到 GitHub release 元数据，表里那行是空的，报错点名「拿不到可验证的构建」。(5) 一处现象记在探针文件头而没有归因：探针自己同时握住真 cloudflared 与那次公网取回时，两次都是本地各项全绿、之后不再返回，满核空转、无系统调用（读 156 MB、写 59 MB，都没归因）。它不进断言也不进结论，因为没归因的事两者都不配。**夹具的两条教训**（写进 `test/tunnel.test.ts` 的文件头，下一个改的人会重新发明）：子进程不加节奏地写，到父进程这边是十来个体积不等的读事件，实测有一次把 200 KB 塞进第一个事件，于是「满了就不再追加」这个错写法也不会红，每行之间要 `await Bun.sleep(5)` 才真是一行一个事件；`process.stdout.write` 循环后接 `console.log`，Bun 会让那句同步写越过排队的异步写，主机名直接跑到第一个 chunk 里。"
  source: "2026-10-17 现场：bun run test:obtain 全过（真下载真共享）+ bun test 184/184"
  affects: [a2a-mcp-bridge]

- time: 2026-10-17T03:22:08
  kind: decision
  summary: "compiled_truth 增一节「传文件的两个外部二进制」：契约由「只命名、不下载」改为「缺的自己按钉值拉到 ~/.local/bin」，含四步解析顺序、钉表边界与 AGENTS.md 例外清单的判据"
  source: "2026-10-17：src/obtain.ts 落地 + bun run test:obtain 真下载真共享"
  affects: [a2a-mcp-bridge]

- time: 2026-10-17T03:50:56
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "2026-10-17 出网恢复：cloudflared 四个 asset 真下载并复算哈希后填进钉表，下载上限随之从 32 MB/90 秒改成 64 MB/120 秒"
  affects: [a2a-mcp-bridge]

- time: 2026-10-17T17:18:37
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "2026-10-17 两个二进制都缺的端到端：钉的是归档 sha256、登记存的是解出来那份二进制的 sha256，此前真值页写成「复用看钉值」是错的"
  affects: [a2a-mcp-bridge]

- time: 2026-10-17T17:18:54
  kind: evidence
  summary: "订正一处说法：钉的是**归档**的 sha256，登记（a2a-bridge.installs.json）存的是解出来那个二进制自己的 sha256，两者不同名，所以「~/.local/bin 已存在且哈希等于钉值就复用」这句是错的——复用比对的是登记那一行，失败消息里两个哈希都打印。代码从一开始就是对的，错的是文档与 CHANGELOG 的措辞。差点被当成校验失效：那次 e2e 里 dufs 装成功后 cloudflared 下载超时，登记写的是 2c91337a…，钉值是 817769f7…。"
  source: "端到端 e2e（两个二进制都缺、隔离 HOME、PATH 只剩三条）跑出来的核对"
  affects: [a2a-mcp-bridge]

- time: 2026-10-17T17:36:13
  kind: evidence
  summary: "两个二进制都由一次 xfer_share 拉，实测 14.0 秒返回：installed 同时点名 dufs 0.46.0 与 cloudflared 2026.10.1，两份都落进桥自己的 HOME（6.4 MB / 38.4 MB，0755），登记各一行，审计 install 两条加 share/stop；loopback GET 字节一致、PUT 201 落盘、错密码 401、停止后端口释放，操作者真正的 ~/.local/bin 依然没有 dufs。出网差时的另一遍留下对照：dufs 装成功、cloudflared 的 40 MB 卡在流里、120 秒到点回 isError 带失败原文，共享没开成、dufs 服务被收走、无孤儿进程，整趟 229 秒。冷装的最坏值与正常值就此各有一个实测数，不需要再猜。"
  source: "2026-10-17 端到端跑绿那一遍（真宿主、隔离 HOME、PATH 削到只剩宿主）"
  affects: [a2a-mcp-bridge]

- time: 2026-10-18T01:05:30
  kind: decision
  summary: "两个二进制都缺那条端到端从一次性脚本升格为提交里的核验：test/install-probe.ts 第五组（13 项，整个探针 35 → 48）。维护者批准的成本是每轮 CI 约 46 MB 出网。形状是硬证据的边界所在——test:obtain 里 cloudflared 走写明路径那一侧，bun test 把获取整个 stub 掉，「一次 xfer_share 拉两个」谁都没管。硬的是文件/登记/审计三样（dufs 先解析再起服务，cloudflared 先解析再开洞，隧道成不成都该在），共享本身与 GET 只报告，与 quick tunnel 那条既有定性一致。反证两遍：下载上限 64MB → 1024B 红五项其余全绿；往削过的 PATH 塞 stub dufs 整组跳过。顺带修探针两处「把红报成炸」（登记缺席 readFileSync 抛异常；失败回包是 JSON 字符串，parse 得动而 port 是 undefined）。"
  source: "bun run test:install 48/48 2026-10-18；变异两遍见 CHANGELOG 2026-10-18"
  affects: [a2a-mcp-bridge]

- time: 2026-10-18T08:19:39
  kind: decision
  summary: "安装方式一节里两条关于 scripts/install.sh 的过期结论改掉（那句「等效替代」和那句「保留模块齐备检查作纵深防御」）：该脚本 2026-10-02 已删，齐备性由 test:install 走 import 图守。新增 scripts/bootstrap.sh 的定位一并写进去——它是引导（把宿主编上再执行那条唯一路径），不是第二条安装路径；代价是多一个脚本、多一个探针（test:bootstrap 28 项）、README 中英多一段，以及宿主那一支在开发机上永远走不到、要靠 stub 覆盖加一行诚实的边界说明。"
  source: "2026-10-18 bootstrap.sh + pin 18.12.1 这轮；判据沿用 2026-10-02 删 install.sh 那条决定"
  affects: [a2a-mcp-bridge]

- time: 2026-10-18T08:19:54
  kind: evidence
  summary: "宿主 omp 18.12.1（2026-10-18，宿主自己从 18.11.0 升上来的，pin 与 bun.lock 跟着同步；版本守卫按设计红两条之后修对）。中间跨四个版本，两处 breaking 实测与本仓库无关：18.11.3 改的是 ui.approve() 宿主收到可选 session 标签并回 once/session/deny 而不是布尔，桥从不自己调 approve，审批探针仍是 VERDICT: B（挂起 >=90031ms、不是 isError）；18.12.1 去掉的是 eval 的 display()。~/.omp/plugins 跟随 HOME 这件事在 18.12.1 上重测仍是同一种行为——test:install 48 项与 test:bootstrap 第五组都在临时 HOME 里真装真登记跑绿。真实注册表行数 5490 -> 5497（registry 探针 28 项全过，装配 15.4ms），这是这台机器配置的数，不是产品的数。takeover 34 项 64.0 秒（推理 POST 1、元数据 1）、smoke 22 tools、hardening 34 项、scenario 41 步 0 失败、obtain 31 项 PASS（公网那半程仍是本机网络对代理域名重签 TLS，量不了）。"
  source: "18.12.1 上全量重跑（bun test 186/186 + 九个宿主侧核验），日志 /tmp/18121-*.log"
  affects: [a2a-mcp-bridge]

- time: 2026-10-18T09:02:11
  kind: decision
  summary: "发布位的判据定下来：进 minor 位的是「远程调用方拿到的东西变了」，不是「提交数多了」或「行数大了」。v0.3.0 覆盖的 19 个提交里三件都满足这条——/blob 撤掉换成 xfer_* 三个工具（调用方看到的工具名与传字节的方式都变了）、缺的 dufs/cloudflared 由桥按钉值自装（同一句 xfer_share 在两台机器上的行为不再取决于有没有人手动拖过包）、bootstrap.sh 补上「机器上没有 omp」这一档。保守发 0.2.2 的话，Release 与 CHANGELOG 就得解释为什么加了三个工具却只进 patch 位，那个解释本身是噪音。另一条同时定下：v0.2.1 的 GitHub Release 保留不撤——2026-10-16 那条发布卫生判据针对的是装不上的版本，撤掉一个仍然装得上的入口不在它里面，四个 tag 全留、可安装入口指向 v0.3.0。附带一条实测：initialize 回的 serverInfo.version 是发布包自证的唯一途径（读自 package.json，test:install 端到端那一行回包打印的就是它），所以版本号进 package.json 之后必须重跑一遍 install 探针，光看字段改了不够。"
  source: "v0.3.0 发布这轮（gh release list 现为 v0.3.0 Latest + v0.2.1 保留；tag annotated 全留四个）"
  affects: [a2a-mcp-bridge]

- time: 2026-10-18T15:30:38
  kind: reversal
  summary: "名字要说机制，不说隔壁协议：a2a-bridge / pi-a2a-ext 这一套自指名字全部撤掉，改成 a2mcp（Agent2MCP）。触发事实是 A2A 与 Agent2MCP 不等价——A2A 的调用单位是 intent 加 task，对端有 agent card、任务有自己的状态机、contextId 与 taskId 跟着走、结果可流式回推可挂 webhook；本仓库一个都没实现，传输是 MCP Streamable HTTP 2025-11-25，语义是调用方点名工具、宿主在活的 Main 会话里执行，初始设计稿的非目标第一条就写着「不是 A2A/Agent2Agent 协议实现」。旧结论「名字里的 A2A 是对外品牌，可以留着」就此作废：品牌要讲的是机制，挂协议名会让调用方按 A2A 的形状来要这条桥没有的东西。改的是全表面且不留兼容——包名与入口文件名（宿主的加载开关 pi.extensions 同一提交跟上）、三个磁盘文件名（a2mcp.json / a2mcp.log / a2mcp.installs.json）、九个环境变量前缀、命令 /a2a → /a2mcp、日志前缀、serverInfo.name、takeover 的三个内部标识、临时目录前缀。"
  source: "2026-10-18 改名三个提交 + test/naming.test.ts 6 项（按形态匹配，不 blanket ban 字符串 a2a）；v0.4.0 发布"
  affects: [a2a-mcp-bridge]

- time: 2026-10-18T15:30:49
  kind: decision
  summary: "无兼容的代价是 token 直接换代，接受它：配置本来就要人手工抄一次 announce，改名同时换 token 多出来的成本接近零。装着 v0.3.0 的机器上，旧 a2a-bridge.json 里那个 token 不再被读，桥在 a2mcp.json 里生成一份新的，远程侧要重看 announce 或在宿主里跑 /a2mcp；旧 a2a-bridge.log 与旧 a2a-bridge.installs.json 留在原地不动、桥不读它们，新审计与新账本另起一代；还留在 shell 里的 A2A_BRIDGE_* 变成没人读取的普通变量。双登记那条边界定在文档层：插件 lock 按 package.json:name 记账，只装新 URL 而没卸载旧的，机器上会同时挂着 pi-a2a-ext 与 a2mcp 两份登记——两个端口、两个 token、两条命令、两次 takeover 装载而 TAKEOVER_SOURCE 不同，第二次的快照盖掉第一个的影子，restoreTakeover 拿不回它认领的那个 provider 名。处理是 README 与 Release 正文把 omp plugin uninstall pi-a2a-ext 写成前置命令，不加检测代码。「发现兄弟插件就往 stderr 打一行警告」要读宿主的 lock，是新行为，按 AGENTS.md「Don't grow a second system」需要 maintainer 点头，这轮不做。"
  source: "2026-10-18 改名这轮 maintainer 选的「全改、无需兼容」；v0.4.0 的 Release 正文就是那条迁移指令"
  affects: [a2a-mcp-bridge]

- time: 2026-10-19T10:33:53
  kind: decision
  summary: "引导脚本可以不带仓库跑：脚本单独一份（curl | sh）且 PATH 上没有宿主时，钉值从 --spec 指向的那个仓库的 package.json 读（github.com 形状派生 raw.githubusercontent.com/<owner>/<repo>/HEAD/package.json，一次 GET，--max-time 20）；取不到就装 latest 并说清是哪一种（无 curl / 里面没有那一行 / spec 不是 github.com）。判据：钉值存在的理由是「本仓库核验最后跑绿的那个宿主版本」，而无克隆是最可能被新机器用上的路，掉钉值等于这条路上脚本的第一个决定就是错的。代价接受：raw 不可达时装的是未钉宿主，宁可输出里多一行 warn 也不让一条 one-liner 卡在取版本上——要自己定版本的人有 --host-version。同时定下：给了 --host-version 或 PATH 上已有宿主就不发这次请求（不装东西就没有要钉的版本），这一条由假 curl 记 argv 的探针守着，因为它的失败模式是一次无害的 GET，看不出来。"
  affects: [a2a-mcp-bridge]

- time: 2026-10-19T11:26:46
  kind: decision
  summary: "把「传文件的两个外部二进制」那一节改到 win32 落地后的形状：安装目录分 POSIX 与 Windows 两套、逃生门认两种分隔符、PATH 扫描按 PATHEXT、钉表五行并注明 win32 那两行的哈希来历、zip 改由内存读取并注明为什么不用 tar、上限余量与 120 秒的未重测状态、以及两条新的判据（钉表按上游 asset 形状增删；未执行的那一半必须在文件头、README、测试文档三处标注）"
  source: "2026-10-19：Windows 引导脚本与 xfer 的 win32 支持"
  affects: [a2a-mcp-bridge]

- time: 2026-10-19T11:26:46
  kind: decision
  summary: "上游 omp.sh/install.ps1 的陷阱记一条： 单独给会被翻成 bun 源码构建，一个开关都不给时机器上有 bun 也走源码，所以钉版本的调用必须每次都带 （读的是安装器自己的主块，2026-10-19）。同族决定：Windows 主机上  原先为什么拒绝下载（钉表只有四个 unix 平台， 查不到行），现在从哪取字节（GitHub release 的两个 Windows asset，本机整包下载复算 sha256 写进表）；以及  为什么留空——dufs 发那个构建而 cloudflared 不发，补一半就是造一台装到一半的机器。"
  source: "2026-10-19 Windows 轮次"
  affects: [obtain, bootstrap]

- time: 2026-10-19T11:27:12
  kind: note
  summary: "上一条 decision 被 shell 咬掉了一部分：那段文字里用反引号包住的 token 全被当成命令替换执行掉了，所以它读起来缺主语缺宾语。这里补完整的三条，内容不变。其一，上游 omp.sh/install.ps1 的陷阱：-Ref 单独给会被翻成 bun 源码构建，一个开关都不给时机器上装了 bun 也走源码，所以钉版本的调用必须每次都带 -Binary（这一条读的是安装器自己的主块，2026-10-19，不在它的文档里）。其二，Windows 主机上 xfer_share 原先为什么拒绝下载：src/obtain.ts 的钉表只有四个 unix 平台，win32-x64 查不到行就直接抛 no pinned build；现在那两个字节从 GitHub release 的两个 Windows asset 来，本机整包下载、算 sha256 写进表。其三，win32-arm64 为什么留空：dufs 发 aarch64 的 Windows 构建而 cloudflared 不发 arm64 的 exe，一次 xfer_share 要两个二进制，补一半就是造一台装到一半的机器。"
  source: "2026-10-19 Windows 轮次（对同一条 11:26 的 decision 的订正）"
  affects: [a2a-mcp-bridge]

- time: 2026-10-19T14:34:06
  kind: decision
  summary: "compiled_truth 增一节「零模型配置的机器」：占位模型的三条线（只填空位、纯运行态、sourceId 区别于 takeover）、a2mcp.invalid 的绊线键理由、getApiKey 二闸实测与 deny 同场；修正「omp 无模型配置先退出」为两条道（rpc 死在扩展前、TUI 是提示时刻闸门）；bootstrap 定位补上 create-only 播种例外；ps1 字面核对九项改十三项"
  source: brain update-truth
  affects: [a2a-mcp-bridge]

- time: 2026-10-19T14:34:13
  kind: reversal
  summary: "翻面：bootstrap 脚本「不写宿主配置文件」的定位（2026-10-18 立的规矩，删 install.sh 后连插件登记都只问宿主）。2026-10-19 起两个脚本各写一个文件：占位 models.yml，条件只有两条——这一趟真的由脚本装了宿主，且该文件不存在（create-only，存在就一个字不碰）；PATH 上已有宿主的机器不写。动机是实测分工：交互式 TUI 下桥自己能在 session_start 填占位模型（运行态），无头 --mode rpc 死在扩展代码之前、只有启动前磁盘上已有的模型配置救得了，而写文件这件事在扩展一侧没有任何授权形状，所以归引导分支。探针补齐：test:bootstrap 39→46 项（自装分支用假 curl 替换下载驱动出来），ps1 字面核对 9→13 项；反向变异去掉 create-only 守卫，探针如实红。同场修正：「宿主没有模型配置就不创建 session、桥永不广播」这条旧结论只对无头成立，TUI 实测创建 session 且桥照常广播，No model selected 是提示时刻闸门。"
  source: "零模型配置占位模型这一轮（plan winter-heath-falcon）"
  affects: [a2a-mcp-bridge]

- time: 2026-10-19T15:06:01
  kind: decision
  summary: "bootstrap.ps1 真机首跑（2026-10-19，已有宿主分支）改写未执行边界：安装器调用与 models.yml 播种仍未真跑，十三项仍是字面核对"
  source: brain update-truth
  affects: [a2a-mcp-bridge]

- time: 2026-10-19T15:06:12
  kind: reversal
  summary: "bootstrap.ps1「没有一行被解释过」翻面：2026-10-19 真 Windows 首跑已过已有宿主分支，安装器与播种两支仍未真跑"
  affects: [a2a-mcp-bridge]

- time: 2026-10-19T16:37:51
  kind: decision
  summary: "/a2mcp tunnel (2026-10-19): the bridge may hold a public listener, as the operators fourth opinion path. Operator-only host-session command (never a tool, never an HTTP route) piping openQuickTunnel + resolveBinary onto server.port; runtime state like the takeover switch (no config, no restart survival); idempotent reuse on second call, deliberately NOT xfer_shares replace semantics; torn down with the port so a trycloudflare hostname cannot outlive the bridge; audited as tool tunnel with sid null; the Bearer token is the only gate and the docs say so in the notification itself."
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T02:01:03
  kind: decision
  summary: "v0.5.0 发布（2026-10-20，commit 297eb55 + annotated tag，GitHub Release 已立）。minor 位的套用：2026-10-18 立的判据是「远程调用方拿到的东西变了进 minor」，这版命中四条——零配置机器从连不上变成连得上（auto-model 占位）、Windows 上同一句 xfer_share 的行为不再取决于手动拖包（win32-x64 钉行 + 自解 zip）、桥多了一条操作员可开的公网入口（/a2mcp tunnel，工具面没变但端点可达面貌变了）、全新机器那条引导路补上 Windows 一支（bootstrap.ps1 + create-only 播种）。发布形状照 v0.4.0：发布提交只动 package.json 与 CHANGELOG 两个文件；版本号唯一真相在 package.json，协议页样例是占位写法所以没有第二份要跟。发版后核远程那条路（先例 bae9d01 的单文件 follow-up，commit e3ab3fa）：临时 HOME 从公开 git URL 装到 a2mcp@0.5.0，initialize 回包打印 0.5.0 即版本号自证，一次 tools/call read 200 并落 start/done 两条审计。"
  source: "v0.5.0 发布轮（plan winter-heath-falcon）"
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T04:44:35
  kind: decision
  summary: "2026-10-20 二进制取回的下载预算换门：维护者 Windows 真机报 cloudflared-windows-amd64.exe 下载超时，把旧代码里没在目标平台量过的 120 秒总墙上时钟量穿（52.7MB 裸 exe 要约 450KB/s 持续吞吐才能跑赢）。换成进度感知两道门：30 秒收不到字节判断流（每收到数据重置，请求发出前武装），10 分钟总期限兜底滴流；两类失败各报已收字节，并把既有逃生门（PATH 或 xfer 配置里写绝对路径）点名进错误文案。不加快照镜像、不加断点续传。慢网新预算的 Windows 首跑读数待维护者回测。"
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T05:14:49
  kind: reversal
  summary: "2026-10-20 安装主路回退：同日「切 npm 包名」的翻面再翻回去。维护者判据「保持 git 安装、不发包」，npm publish 不再排期；v0.5.1 的 README 曾写着 omp install a2mcp 而该名字在 registry 上是 404，命令停在依赖解析——文档不许躺会静默失败的命令，主路回到 omp install 加 git URL，v0.5.2 是这份文档纠偏（代码与 0.5.1 同源）。保留的不是话术是机制：两份引导脚本的 spec 形状二选一与 registry 读钉分支、tarball 打包与 files 治理、install 探针的预留形态组（不发不跑、如实 info 跳过）原样在树里，哪天发包哪天启用，compiled_truth 未为 npm 翻过面所以无需回改。两条免 git 的路量过并否掉：tgz 直装是宿主 link 路径的 ENOTDIR 死路（复核成立），把 dufs 与 cloudflared 打进发布物全五目标约 200 MB、单 Windows 一对约 60 MB，与「发布物是代码包」的定位不合。"
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T06:33:59
  kind: decision
  summary: "接入面在文档里收成两条路：会说 MCP 的客户端直接填 mcp.json 接桥、不要自写客户端；不会说 MCP 但能跑代码的调用方取一个官方参考实现 scripts/mcp-call.py，零依赖 Python 3 单文件，替它处理会话头、404 重握手、每次调用超时与退出码——正是手搓 mcp_call.py 最容易写错的两处。起因是接到桥上的 agent 反复各自手搓一个握手脚本：桥答 plain JSON 谁都能打，但握手有状态，被贴进提示词而非注册成 MCP 客户端的 agent 就每次从零重推。语言定 Python 标准库（与 agent 已自发产出的形状同源，CI 镜像近乎标配），Go 跨平台二进制讨论后否掉——那会翻成第二套二进制分发系统加 CI 编译链，而调用方要能读能抄的代码。脚本不进 package.json 的 files（仍 extensions/ 加 src/），与 bootstrap.sh 同路走 raw URL 交付，不进安装 tarball。新增独立探针 test:mcp-call：真宿主驱动 list/call/错 token/不存在工具，加一只第一次 tools/call 回 404 的假 Bun.serve 验重握手自愈；缺 python3 整段 info 跳过退 0。协议面与装法不变（git URL 主路），进 patch v0.5.3。"
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T08:47:58
  kind: decision
  summary: "传文件面第二次重做（2026-10-20，v0.6.0）：宿主/桥是一个 server，同一个端口出两张面。维护者定方向「宿主除了提供 mcp 端点，还要提供文件传输端点，走 http 协议通过 tunnel 转发」，在两个方案里选 B，并加一条边界「只交操作员开关」。落点：dufs 仍在 127.0.0.1 的随机端口上，桥把它反代成自己端口的 /xfer/ 路由（src/server.ts 的 XFER_ROUTE + proxyXfer），公网那一面统一由操作员的 /a2mcp tunnel 决定——quick tunnel 只接受一个 --url，一条隧道顶一个 origin，所以从前「一次共享一条隧道 + 操作员一条隧道」那两个公网主机名合成一个，同一个主机名同一个 Bearer token 同时带工具调用与文件。代理那一跳的形状：路径逐字转发（不剥前缀）、query 保留、调用方的 Authorization 被这次共享生成的 basic-auth 覆盖而不是合并（赋值排在 header 拷贝之后）、accept-encoding identity、host 删除、hop-by-hop 双向剥掉、回程删 www-authenticate、redirect manual、没共享 404 点名 xfer_share、上游不回话 502 而原因只进宿主 stderr；鉴权排在路由之前，DELETE 那支不再把删文件当成结束会话。xfer_share 不再开隧道也不交出凭据：回包 url 是路由、多一个 route 字段、user/secret/host 三个字段撤掉而不是留空、usage 三条改成 Bearer <TOKEN> 形态并多一条 public、installed 只剩 dufs。那对凭据照旧每次生成一份，只是永远不出进程。maxRequestBodySize 回到 128 MB（第三次含义：一次 PUT 就是这个端口上的一个请求体，注释写明）。代价：桥多了一段有主张的代码（代理），换来的是公网入口只剩操作员那一处，而操作员开关公网这条既有原则没被工具绕过。"
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T08:48:06
  kind: reversal
  summary: "推翻一条本轮方案里写死的禁令：「不用 dufs 的 --prefix，代理自己剥前缀就行」。真机读数把它否了——不带 --path-prefix 时 dufs 的目录页 CSS/JS、?json 的 uri_prefix、PROPFIND 的 href 全是根绝对路径（实测 /__dufs_v0.46.0__/index.css、/up.txt），跟着一个链接就掉出 /xfer/ 路由，而路由之外那一侧是 MCP 处理器的 405；代理要么改写字节，要么把前缀告诉服务器。现在的做法是同一个常量喂两头：src/server.ts 的 XFER_ROUTE 既做匹配条件也作为 --path-prefix /xfer 传给子进程，所以两者不可能漂，路径逐字转发就是全部的改写量。0.46.0 上验过（test:obtain 与 test:install 每轮各一次：列表每个绝对引用带前缀、uri_prefix 是 /xfer/、不带前缀的路径 dufs 自己回 400）。教训与既有那条同源：一条「不做 X」的禁令如果是按省事推出来的、没有在目标版本上量过，它就成了下一轮的实现约束——写禁令时要把它的判据一起写清。"
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T08:48:19
  kind: decision
  summary: "两条随之改口的边界（2026-10-20）。其一，AGENTS.md 例外清单从三条变四条之后再改措辞：第二条 xfer_* 现在写的是「把路径交给绑回环的 dufs，再作为桥自己端口上的 /xfer/ 路由端出去，门就是同一个 Bearer token」，并且明写工具不再交出凭据或公网主机名；第四条 /a2mcp tunnel 写的是「顶的是整个端口，所以那张主机名和那个 token 同时是 MCP 端点与 /xfer/ 路由的公网面目」。例外清单的理由句没变：给桥加主张的路径都要用审计与文档付账。其二，win32-arm64 那半行留空的条件换了主人：从前是「一次 xfer_share 要两个二进制，补一半就是造一台装到一半的机器」，现在共享只需要 dufs 而 dufs 发 aarch64 的 Windows 构建，缺的只是操作员的隧道——单独钉一行技术上可做，本轮没做，src/obtain.ts 的注释按此改口，避免下一个人以为那半行是必需的。配套一条发布判据：这版进 minor（v0.6.0），因为调用方经协议拿到的东西变了——回包少三个字段、一次共享少一个二进制、公网可达的前提从工具自己给 URL 变成操作员先开隧道；真正要改代码的是按回包 user/secret 拼 curl 的调用方，在这一版读到 undefined。"
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T11:32:15
  kind: decision
  summary: "共享回包带上操作员那条隧道的公网地址（publicUrl）：工具只读现成状态、不开隧道；隧道没开就点名 SSH 转发与请操作员开隧道两条路。远端 agent 拼不出文件地址、自己起隧道那条路就此断掉。"
  source: "2026-10-20：远端 agent 拿到回包却拼不出文件地址"
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T11:32:51
  kind: reversal
  summary: "翻的是 0.6.0 那条「工具不交出公网主机名」的一半：工具仍然不开隧道、也不把一条自己的隧道交给调用方（持 token 的调用方不能绕过操作员把宿主文件发布出去），但隧道开着时它会把那条已经存在的主机名作为 publicUrl 报出来——读一个现成状态，不新增暴露面。翻掉的另一半是它的推论「回包不提隧道」：远端 agent 拿回包拼不出文件地址，于是自己起了第二条隧道。AGENTS.md 例外清单第二条与 docs/protocol.md 的「工具不再交出公网主机名」按此改口。"
  source: "2026-10-20：远端 agent 拿到回包却拼不出文件地址"
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T12:06:27
  kind: decision
  summary: "v0.7.0 发布（2026-10-20，commit 581acd4 + annotated tag v0.7.0，GitHub Release 已立）。minor 位的套用：2026-10-18 立的判据是「远程调用方拿到的东西变了进 minor」，这版命中一条——xfer_share 与 xfer_status 的回包多一个 publicUrl 字段（操作员那条 /a2mcp tunnel 开着时是同一条 /xfer/ 路由在那个公网主机名下的地址，没开是 null，usage.public 改口点名 SSH 转发与请操作员开隧道两条路）。工具仍然不开隧道也不关它，读的是一个已经存在的主机名；这是把 0.6.0 那条「工具不交出公网主机名」翻掉一半（timeline 里那条 reversal 记了）。发布形状照 v0.6.0：发布提交只动 package.json 与 CHANGELOG 两个文件，package.json 的 description 没动（插件的面貌没变，那句话是 omp plugin list 上显示的）。发版后核远程那条路（先例 bae9d01 的单文件 follow-up、commit e3ab3fa）：临时 HOME 从公开 git URL 装到 a2mcp@0.7.0，initialize 回包打印 0.7.0 即版本号自证，一次 tools/call read 200 并落 start/done 两条审计。回归：bun test 254 项 751 断言、lint/tsc 干净、tree 3、registry 5497 行、BOOTSTRAP OK 47、MCP-CALL OK 6、SMOKE OK（22 个工具）、HARDEN OK 34、SCENARIOS 41 步 0 失败、takeover 34 项 65.8 秒、审批 VERDICT B、test:obtain PASS 41、test:install PACKAGE OK 55、站点 build + check 全过。"
  source: "v0.7.0 发布轮"
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T17:12:37
  kind: decision
  summary: "审计的 id 现在也是去宿主 transcript 取参数正文的钥匙（一次调用一个 id）"
  source: "2026-10-20 远程审计日志实读 + 第一性重推"
  affects: [a2a-mcp-bridge]

- time: 2026-10-20T17:13:05
  kind: evidence
  summary: "2026-10-20 远程审计日志实读（Windows 宿主，C:\\Users\\user\\.omp\\agent\\a2mcp.log，216 KB / 864 行 / 423 次调用 / 217 个 MCP 会话 / 44 次失败，窗口 09:46:32Z–16:32:06Z）：审计记录本身是干净的——0 次挂起（每条 start 都有配对的 done）、start/done 的 args 100% 一致、时间戳 0 次回退、token 不在日志里（搜不到任何一个片段，也没有 Bearer 字样）、宿主 stderr 无 unauthorized attempt 也无 audit record not written。但读出四个洞：(1) 隧道 3 条记录全是 action=start、0 条 stop——extensions/a2mcp.ts:249 的 session_shutdown 已经 mcpTunnel?.stop() 了，注释写着「No audit here」，而同一次退出里 xfer 走 src/xfer.ts:445 的 close(\"bridge stopped\") 会写一条 close 记录，同一次退出两套规则；三次 port 不同（55850→51007→58354）而 a2mcp.json 里 port=0，说明桥至少重启过两次，而桥的生命周期在审计里没有任何痕迹。(2) 44 次失败的 done 记录里带 error 字段的是 0 条（auditDone 只传 isError；xfer/tunnel 的失败记录反而带 error 原文，三种记录形状不一致）。(3) 423 次调用里 219 次（51.8%）的 command 被折成 <len,sha256>——120 字符那个阈值本是给文件正文设的，bash 的 command 超长也照折，44 次失败里 22 次因此读不出跑的是什么；最刺眼的一条是 15:00:30 那次：命令是从另一条公网隧道 curl 脚本进宿主磁盘，在审计日志里只剩 <len:548,sha256:e8efae20>。(4) 宿主 transcript（~/.omp/agent/sessions/**.jsonl）与审计日志是同一次调用的两半，且没有连接键：transcript 侧 98 条 tool_execution_start 带完整参数、0 条 tool_execution_end、0 条 isError（远程调用不走消息流），审计日志侧的 toolCallId 在 transcript 里一次都没出现（grep 命中 0），同一次调用两边是 30012d7d-… 与 138f5ab0-…。"
  source: "2026-10-20 远程审计日志实读（Windows 宿主，经 omp-host MCP）"
  affects: [a2a-mcp-bridge]
