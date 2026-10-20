# Changelog

首个发布版：`v0.1.0`（git tag 与 GitHub Release）。**安装主路是 `omp install <git-url>`，不发布到 npm** —— 2026-10-20 曾把主路切到包名 `omp install a2mcp`（见那两节），同一天判据改口：不发包，主路回到 git URL；那段切 npm 的尝试记在历史里不重写，包名成为预留形态。可安装的 Release 现在是 `v0.5.3`（2026-10-20，协议面与装法都与 v0.5.2 相同，这一版给不会说 MCP 的调用方补了一个官方参考客户端）：v0.1.0 与 v0.2.0 的 Release 已于 2026-10-16 撤下，`v0.2.1` 那份留着（它装得上，撤一个能用的入口不在那条发布卫生的判据里），历史 tag 全部保留（见 2026-10-16 那一节）。

本文按日期倒序分节（组内按依赖顺序）；面向使用者与开发者的变更，纯内部记忆提交（`brain:`）不收录。括号内为 commit 短 sha。已发布的版本有 `## v<版本>` 总览节；未发布的逐日演进全部平铺在上面。

## 2026-10-20 — 接入面收成两条路，给不会说 MCP 的调用方一个官方参考客户端

接到桥上的 agent 反复各自手搓一个 `mcp_call.py`。桥没有错——它答 plain JSON、无 SSE，任何会发 HTTP 的程序都打得到。错在握手有状态：`initialize`（不带会话头，`mcp-session-id` 从响应头回）→ `notifications/initialized`（带头、202）→ `tools/list`/`tools/call`（两带头），漏头即 400、会话过期统一 404，每次调用还得自设超时（无 UI 宿主上等审批的工具挂着不返回）。一个被贴进提示词、而不是注册成 MCP 客户端的通用 coding agent，运行时里没有原生 `tools/call`，能跑代码就自己补一段，于是这套握手每次从零重推。

维护者定调两句：有 MCP 能力的客户端不要重复造轮子，直接 `mcp.json` 接；没有的，发一个最小客户端。于是这轮把「两条接入路」在文档里分开写清，给第二条一条官方参考实现。语言定 Python 3 标准库单文件（`urllib`+`json`+`argparse`，零第三方依赖），与 agent 已自发产出的形状同源，mac/linux/CI 镜像里 python3 近乎标配。Go 跨平台二进制讨论过并否掉：那要把交付形态翻成二进制资产矩阵（第二个 obtain 式分发系统）、CI 添一套编译链，而调用方要的是一段能读、能抄、能改的代码，不是一个不透明的可执行文件。

- scripts: 新增 `scripts/mcp-call.py`——`--url`/`--token`（也读 `A2MCP_URL`/`A2MCP_TOKEN`）、`list`、`call <名字> [json]`、`--timeout` 默认 30、`--keep-session`；一个 `Client` 走 initialize→抓响应头 sid→notifications/initialized，遇 404 重握手再重试一次，401 点名 token 不匹配，`isError` 或非零 JSON-RPC error 打到 stderr 并非零退出。它不读本地 `a2mcp.json`（那是宿主侧的，会误导远程用法）。不进 `package.json` 的 `files`（仍 `extensions/`+`src/`），与 bootstrap.sh 同路走 raw URL 交付。
- test: 新增 `test/mcp-call-probe.ts`（`bun run test:mcp-call`，6 项）——A 组起真宿主驱动脚本验 `list`（三个 `xfer_*` 在列，名字读 `src/xfer.ts` 不抄第二份）、`call bash`、不存在的工具、错 token；B 组对一只第一次 `tools/call` 回 404 的假 `Bun.serve` 验重握手自愈（真会话 24 小时才过期，探针等不起）。缺 `python3` 整段 `info:` 跳过退 0——仓库对 python 零假设、CI 不装 python。
- docs: 两份 README 加「两条接入路」/「Two ways in」，提示词段补一句「没注册成 MCP 客户端就用这脚本、别自己重推握手」；`docs/protocol.md` 客户端接入时序末尾点明该脚本是这段时序的可执行参考；`docs/testing.md` 加一行、起宿主前置从六个改七个并写明多一条 python3 前置与 info-skip；站点首页卡补两条路与脚本名、链到 `#两条接入路`；开发命令列表两份各加 `bun run test:mcp-call`。
- 版本位: 协议面没动（同一 Streamable HTTP、同一 token、`tools/list` 照旧），新增的是操作员侧一个官方脚本加一条被文档化的接入路，按 2026-10-18 判据进 patch 位（v0.5.3）。

## 2026-10-20 — 安装主路回退到 git URL：npm 切出去一天就收回，包名转预留

维护者对着「先发 GitHub、npm 等登录」的实况拍了板：「不发 npm 了」「保持 git 安装」，随后又问过两条免 git 的路并否掉——把 dufs 与 cloudflared 打进发布物（全五目标约 200 MB、单 Windows 一对约 60 MB，与「发布物是代码包」的定位不合），以及 `.tgz` 直装（实测宿主把本地路径一律走 link，报 `ENOTDIR …tgz/package.json`，死路复核成立）。于是 v0.5.1 的文档面翻回 git URL 主路：那份 Release 写着 `omp install a2mcp` 而这个名字在 registry 上是 404，命令停在依赖解析——文档里不许躺一条会静默失败的命令，这是仓库自己的判据。npm 那一轮的机制原样保留：两份脚本的 spec 形状二选一与 registry 读钉分支、探针的 npm 真装组（不发包就每天如实 info 跳过）、tarball 打包与 `files` 治理；哪天决定发包，包名哪天可用，文档不必再翻一次面。

- scripts: `bootstrap.sh` / `bootstrap.ps1` 的默认 spec 回到 `https://github.com/adam-ikari/a2mcp.git`；形状推导两支都不动，git 前置条件跟着 spec 形状走回原处。
- docs: 两份 README 主命令行翻回 git URL（探针行首读取点自动跟），加「包名是预留、不是可用」一段；站点首页卡同句翻回；`.github/workflows/ci.yml` 两处注释改口（第六组是预留形态的核验、live 项读的是 README 那行推出来的 manifest URL）。
- test: `bootstrap-probe.ts` 前置组两条对调——默认（git 形态）缺 git 要红，显式 `--spec a2mcp` 缺 git 要过；`install-probe.ts` 第六组头注释改「预留形态的核验」。项数不变（47 / 52），`bun test` 计数不动。
- docs: `docs/testing.md` 六处跟改（组表两处、端到端那句「对外受支持的只有包名」改口、`--dry-run` 计划行的字面量、出处行示例 URL 回到 raw 形态并写明翻面痕迹、脚本存在理由句）；上面那节「安装形态切到 npm」加同日追加，正文不重写。
- release: v0.5.1 的 GitHub Release 不撤——隧道修复真实在里面，撤它就把能用的入口也撤了；正文开头已改成装法以 git URL 为准，CHANGELOG 的 v0.5.1 总览节同句翻面，纠偏由 v0.5.2 这份文档更正版承担。

## 2026-10-20 — 取回改进度感知：Windows 真机把 120 秒墙上时钟量穿了

维护者的 Windows 机器第一次真跑 `/a2mcp tunnel`，回来的报错是 `downloading cloudflared-windows-amd64.exe failed: The operation timed out.`。撞上的不是隧道，是 `src/obtain.ts` 的第一次安装：`download()` 用一道 `AbortSignal.timeout` 管整条响应体，默认 120 秒——那 52.7 MB 的裸 `.exe` 要在里面走完，约需 450 KB/s 持续吞吐。这条限制此前写在代码注释与 `docs/protocol.md` 里，原话是「没在目标平台上跑过的限制该有的样子」，这次它第一次在目标平台上跑了，样子正是注释预言的那样：慢但活的连接与根本不答的连接，拿到的是同一句 `The operation timed out.`，操作者无从分辨该等一等还是该绕行。`xfer_share` 的两个二进制走同一条 `download()`，隧道只是第一个把这条撞出来的入口。

- fix: `download()` 换成三道门——64 MB 体积上限不动，新增 **30 秒无字节空闲窗**（计时器在请求发出前武装，覆盖 connect/headers/首字节；每来一块字节重置，死了 30 秒内报死，不再拖满总时长）与 **10 分钟总期限**（一直滴但不收敛的流仍要有终点）；两类超时各有名字（`stalled … no bytes for …` 带已收字节数 / `gave up after … ms with only … bytes received`）。超时类失败的消息尾上点名既有逃生门：把二进制放上 PATH，或配置 `xfer.<name>` 写绝对路径——桥按原样用、一个字节都不下载。测试缝 `deps.timeoutMs` 拆成 `deps.idleMs` + `deps.totalMs`，默认值生产侧生效，`resolveBinary` 的调用面貌不变。
- test: `bun test` 231 → 233（`test/obtain.test.ts` 30 → 32）。旧的那条「停住的 body 撞 deadline」重写成三条形状：小步滴流的**真钉字节**（假发布机新增按块发真内容的形态）总时长远超空闲窗照样装成——这是旧墙上时钟 denial 的那台 Windows 的形状；块间一个超过空闲窗的停顿 → `stalled` 并带出逃生门句子；永不收敛的滴流 → 总期限消息。变异一道：删掉每块的 `armIdle()` 重置 → 滴流与停顿两条红、恢复全绿。
- docs: `docs/protocol.md` 取回一节那句「64 MB 与 120 秒墙上时钟」改成三道门的形状与这次读数的来历；`docs/testing.md` 第五组那段 2026-10-17 的 229 秒读数原文保留、段尾补一句这条限制被真机量穿与换代（历史不重写）；单测计数三份文档与站点卡同步 233。
- 边界：这台 Linux 测不了 Windows 的真执行，新预算下的真机首跑要等维护者那侧回读；持续低于约 90 KB/s 的连接在 10 分钟里也放不进 52.7 MB——那不是这里的洞，是逃生门的地盘，错误消息现在直接把它指给操作者（浏览器手动下载那份 `.exe`，配置写绝对路径，`/a2mcp tunnel` 立刻能开）。断点续传不做：为一条连接加半个下载器，违背这个包管理器「最小」的定位。
- 回归：`bun test` 233/233（660 expect）、`tsc` / `lint` 干净；`test:obtain` 真网络复跑与站点 `build` + `check` 随发布门禁跑（见 v0.5.1 总览节）。

## 2026-10-20 — 安装形态切到 npm：`omp install a2mcp`，落盘的是 tarball 不是整棵仓库

维护者的判据是「安装的内容应该精简，不要整个 git 安装」。量先把话坐实：`omp install <git-url>`（带 `#tag` 也一样）落盘的是整棵仓库的 checkout，2.3 MB，`docs/`、`brain/`、`test/`、`website/` 全带上——bun 的 git 安装路不读 `files` 字段，git 形态没有只装子集的办法；宿主对 tarball URL 直接拒收（实测 `Invalid package name`），本地 `.tgz` 走 link 报 `ENOTDIR`。宿主认的远程形态因此只剩两种，其中受 `files` 控制的只有 npm 包名那一种：`bun pm pack` 出的 tarball 63.6 KB、15 个文件，加载真正读的 `extensions/` 与 `src/` 都在里面。这一轮把安装切到 `omp install a2mcp`，git URL 降为兼容写法——开头的「不发布到 npm」那条旧决定跟着翻面，brain 三页同句的旧话与 timeline 一条 reversal 同步改。

- scripts: `bootstrap.sh` / `bootstrap.ps1` 的默认 spec 换成包名 `a2mcp`。钉值的来源原则不变——「钉值必须来自插件将被取来的同一个地方」——按原则扩一支：spec 是 npm 包名就从 `https://registry.npmjs.org/<name>/latest` 读（tarball 里那份 package.json 保留 `devDependencies`，`tar -xzOf` 验过），github URL 形状维持原有的 raw 推导；包名形态不再要 git，git 的要求收到「spec 是 URL 形状」那条分支上。
- docs: 两份 README 的安装主命令换成 `omp install a2mcp`（探针从行首读它，git URL 改成行内代码，不再占行首）；加一段为什么（2.3 MB 对 64 KB）；老用户从 git 形态换过来要先 `omp plugin uninstall` 再装，旧检出不会被原地替换。Windows 一键行改成经典形态 `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm <raw> | iex"`（维护者：「更像一键安装风格」），传开关的 scriptblock 形态保留。
- test: `bootstrap-probe.ts` 的清单 URL 从 README 那行现推，两条分支与脚本同一对；假 curl 那组现在喂 registry 的 body；live 项按版本门控——registry 上那份与本分支同版本才断言钉相等，bump 之后、publish 之前的窗口只断言读数合法，CI 不为这个窗口红。`install-probe.ts` 新增第六组：临时 `HOME` 里真跑 `omp install a2mcp`，核登记落进 lock、落盘有 `package.json`/`extensions`/`src` 而没有 `docs`/`brain`/`test`/`website`/`.github`/`scripts`（「精简」这条就断言在这里），版本只断言合法 semver；registry 答不到整组 `info:` 跳过。`test:bootstrap` 46 → 47 项（git 要求拆成 URL 形态要、包名形态不要两条），`test:install` 48 → 52 项。
- fix: `docs/testing.md` 里那句「git 抓取由 `test:install` 前三组覆盖」是错的——那三组从 manifest 到 import 图都在本地，一次网都不出；每天真出网的远程安装只有新加的 npm 那一组，改对了。
- 边界：Windows 上的 npm 装法这一轮没有真机读数（宿主同一条 bun 解析路，ps1 只过字面核对）；registry `latest` 缓存陈旧是宿主自己的已知问题（manager 注释 #11634），`--no-cache` 在宿主侧，不是这里新加的洞；npm 发布之后不撤 git tag 与 GitHub Release，旧装法的机器照常工作。
- **同日追加**：这一节切出去的主路在同一天被收回——维护者判据改口「保持 git 安装、不发包」。机制与测试原样保留，改口的逐条落在下面 2026-10-20 的「回退」一节；这一节按历史保留，不重写。

## 2026-10-19 — `/a2mcp tunnel`：一条命令把公网 URL 架在桥的端口上

维护者的需求是一句话：「需要有一个命令启动隧道 并且显示公网 url」。跨机访问此前只有 SSH 端口转发一条路，而隧道那套机器其实早就在仓库里——`src/tunnel.ts` 抓 `*.trycloudflare.com` 主机名，`src/obtain.ts` 按钉值找 `cloudflared`——只是它们一直只被 `xfer_share` 用在文件共享那一侧。这一轮把它们接到桥自己的 MCP 端口上，新立的是第四条给桥加主意的路径（AGENTS.md 例外清单同步改成 four paths）：隧道一开，Bearer token 就是这个端点对公网的唯一闸门。

- feat: `extensions/a2mcp.ts` 的 `a2mcp` 命令加 `tunnel` 与 `tunnel stop` 两个分支。形状三条线：**操作员专属**——它是宿主会话里的命令，不进 `tools/list`、不是 HTTP 端点，持 token 的远程调用方打不开它；**纯运行态**——与 takeover 开关同款，不落盘、不进配置、重启即无，`session_shutdown` 拆端口时子进程一起收（SIGTERM→2s→SIGKILL），公网主机名不活得比开它的桥久；**幂等**——第二次 `tunnel` 复用已开的那条并重报 URL，不顶掉、不再 spawn，两个命令同时在途由在途保护（`tunnelOpening`，镜像 `bringingUp` 的规则）合并成一个子进程。状态行在隧道开着时追加 ` tunnel=<url>`。
- feat: `src/audit.ts` 的 `auditTunnel`——开与关各一条 `tool: "tunnel"` 记录，`sid: null`（操作员发起，没有调用方会话可归属，同启动期 host_llm 记录的先例），`args` 带 `action`、公网 URL 与本地端口，token 不进记录。
- test: `bun test` 226 → 231（`test/entry.test.ts` 19 → 23、`test/audit.test.ts` +1 形状项并把 `auditTunnel` 挂进「每个入口都返回队列尾巴」那组）。四项对着假 cloudflared 跑：配置的 `xfer.cloudflared` 写绝对路径走 obtain 逃生门（不查 PATH、零下载），脚本 announce 固定主机名并把 spawn/SIGTERM 各记一行——「一个子进程而不是两个」「子进程随桥而死」数这些行。手工一遍里撞出夹具的一处真问题：入口的 `ping` 之前不带 `connection: close`，把桥的非强制 `stop()` 不关空闲 keep-alive 这条已知偏差（`docs/protocol.md`「一个进程，一套端口」末条）用成了假 200——夹具改为每次新建连接，断言的才是「监听」本身。
- 真宿主一遍（omp 18.12.1 TUI，临时 HOME，真 `cloudflared` 来自钉值安装目录）：`/a2mcp tunnel` 公告 URL 与「token 是唯一闸门」；二次打开回 `already open` 且只有一个子进程；**公网半程这次真回来了**——经隧道 `initialize` 得 200（此前记录的 TLS 重签没有拦住这一趟，按实测记）；`/a2mcp tunnel stop` 后同一 URL 得 530（边缘没了 origin）；审计落 start/stop 两条、`sid` 为 null；kill 宿主后子进程随 `session_shutdown` 收掉。
- docs: 两份 README 的命令节加两条 bullet、「跨机转发」加第二种形态一段（面貌写在脸上：公网、token 唯一闸门、运行态、随桥拆）；`docs/protocol.md` 新增「操作员的隧道：`/a2mcp tunnel`」小节（与 xfer 共用机器、各自的家、幂等为什么与 `xfer_share` 的顶替刻意相反）；`docs/testing.md` 改 231/23 并记假二进制那套判据；站点 sync.mjs 两处计数。
- 边界：隧道可用性取决于 Cloudflare 边缘，30 秒等不到 announce 即报错；Windows 一侧，`cloudflared` 此前「验到字节没验到执行」，本功能把它第一次推到桥自己真 spawn 的分支上——那条支级的真执行仍未在 Windows 机器上验过。
- 回归: `bun test` 231/231（17 文件）、`tsc` / `lint` 干净（1 info 基线）、站点 `build` + `check` 全过、真宿主一遍如上。

## 2026-10-19 — 指南原位瘦身：README 把机制细节交还给 docs

维护者的判据是「指南应该是简单的」。刀法选了原位瘦身：/intro 仍是一页，每个机制段收到「是什么、怎么用」几句为止，展开的细节交还给 `docs/protocol.md` 与 `docs/testing.md`。中文版从 367 行到 326 行，「宿主推理接管」一节从 3139 字到 1352 字；英文版同形镜像。守住不动的东西：mermaid 图逐字节、JSON 样例、H2 锚点名（站点卡的四个链接依赖它们）、`^omp install <url>$` 那行（两份探针测试拿它当安装 URL 的读取点），以及全部受守事实——18.12.1 的连接被拒实测、≥90s 审批挂起、300s 转后台、512KB/0600/一代轮转、`<len,sha256 前 8>` 不分层、2026-10-13 注册表实测、win32 验到字节没验到执行、`test:obtain` 37 项。

- docs: 删内容有家的纪律在英文侧多跑了一遍回查，查出一条没家的：「print 同为无 UI 路径，未实测」这句在中文瘦身时被顺手删掉，而 `docs/` 里没有任何地方接住它。它退回两份 README——实测边界不该有个没有的家。其余被删段逐一核过落点：唤醒链的时间戳与 8,309 token 在 `docs/computer-use.md`，arm 行与 `/login` 交回所有权在 `docs/protocol.md`，570/572 与 99 µs 在 `docs/testing.md` 与变更记录，`xd://debug` 实测清单在变更记录，warn→fail 守卫史在 2026-10-07 那一节。
- docs: 英文版「什么时候用哪个」「工作原理」「配置」「审批」「传文件」「设备」「安全与边界」「故障排查」「开发」九节与中文版逐节对齐；`xfer.dufs` 表行补上了中文版早就有的 Windows 安装目录（`%LOCALAPPDATA%\a2mcp\bin`），takeover 装配失败条目补回 `pi-native` 的例子。
- 回归: `bun test` 226/226、`lint` 干净（1 info）、`tsc` 干净、站点 `build` + `check` 全过（锚点与 lastmod 照旧核对）。

## 2026-10-19 — `bootstrap.ps1` 真机首跑；README 的 Windows 装法不落盘；站文压缩一轮

维护者在真 Windows 机器上跑了 `bootstrap.ps1` 的第一遍：DryRun 打出计划，真跑走完——`PATH` 上已有 `omp 18.12.2`、扩展已登记，脚本问宿主、宿主答 `✔ plugin:a2mcp: v0.4.0`。这一遍过的是「已有宿主」那一支；官方安装器那一次调用与占位 `models.yml` 那一次播种仍然没有任何地方执行过。控制台里的 `鈼?`/`鉁?` 是宿主自己的输出字形被 GBK 码页读串，不是脚本的字节——脚本照旧纯 ASCII，`chcp 65001` 后原样显示。所有「没有一行被解释过」的句子（两份 README、`docs/testing.md`、脚本头注释、站点卡）都按这次首跑的实际范围改窄，改成支级别的边界。

- docs: README 的 Windows 指令从 `iwr ... -OutFile bootstrap.ps1` 改成了不落盘的 `& ([scriptblock]::Create((iwr -UseBasicParsing <raw-url>).Content)) -DryRun`（维护者：「不要保存安装脚本」）。这不是脚本机制的变更，是文档补上脚本一直支持的形态：`$PSCommandPath` 为空时它跳过旁边的 `package.json`、只在 `PATH` 上没有宿主时才去 spec 仓库读 raw pin，两条都成立才需要落盘。
- docs: 安装一节按维护者要求重排成「omp 安装命令 + 一键安装命令，分 Linux / macOS / Windows」——正文只留命令与一句级的提醒（旧名迁移与 `mcp.json` 重抄、URL 形态、开关一行、占位 `models.yml` 的 create-only 条件）。被删掉的段落都有别的家：迁移细节在下面的改名一节，核验边界在 `docs/testing.md` 与脚本头注释，首跑事实就在本节上面。`test/naming.test.ts` 的 allowance 表跟着缩——README 不再念旧配置文件名，六条白名单成了空开的洞，删。
- docs: 站文压缩一轮——首页 install/xfer/testing 三张卡、testing 页描述、中英 README 的一键安装与 Windows 两节全部收紧，量砍了约四成；被守的事实一个字没丢（git URL 原文、pin 语义、create-only 条件、46/226/十三这些数字、每处诚实边界）。
- fix: 两份脚本结尾那条 models.yml 提示改成按分支说话。第二遍真机记录（同日，不落盘的 scriptblock 形态，DryRun 计划原文纯 ASCII）暴露了那句的歧义：宿主已在的机器上脚本碰都没碰 `models.yml`，句子里却出现「wrote one when it installed the host」，读起来像这台机器被写了。现在写了就报路径，没写就明说「这台没写、只有自装宿主且文件缺席才写」。真机那遍的 `-File` 与内存形态至此都过了；安装器与播种两支仍未真跑，边界不变。
- 回归: `bun test` 226/226（项数未动，ps1 头注释改写字面仍过十三项）、`lint` / `tsc` 干净、站点 `build` + `check` 全过。推送后的 CI（含 host-probes）与 Pages 部署两个 run 均 success。

## 2026-10-19 — 零模型配置的机器：桥自己填占位模型，引导脚本给无头启动补 `models.yml`

Windows 宿主来的第一条真实反馈是这句报错：`Error: No model selected. Use /login, set an API key environment variable, or create C:\Users\user\.omp\agent\agent.db. Then use /model to select a model.` 第一轮只把它写进故障排查（手工放一份占位 `models.yml`），随后在钉住的宿主 18.12.1 上把两条启动路各量了一遍，判据翻了面：**交互式 TUI 在零配置机器上照样创建 session**，那句报错是提示时刻的闸门（`agent-session.ts` 的 `if (!this.model) throw`），拦的是操作者的 prompt，桥那时已经在广播——临时 `HOME` 实测 `initialize` 回 200；**无头启动起不来**，`omp --mode rpc` 死在 `createAgentSession > resolveModelDiscoveryFallback`，扩展代码一行都没跑过，磁盘上有模型配置才救得了它。原先那句「宿主没有模型配置就不创建 session」因此是半句对的：它对 rpc 成立，对 TUI 不成立。自动化据此分两半，范围由维护者确认「两半都做」。

- feat: `src/auto-model.ts`——桥在每个 `session_start` 检查 `Main` 会话的模型槽，槽是空的你注册一个不可达的占位 provider（`a2mcp/offline`）并选中它，槽里有模型就一步都不做。三条线：只填空槽（操作员的选择永远压过桥的占位）；纯运行态（不写 `agent.db`、不写 `models.yml`、不下 override——「接管是运行态」那条规则不破）；sourceId 是 `a2mcp-auto-model`，不等于接管用的 `a2mcp`，否则 restore 的 `clearSourceRegistrations` 会把这张行连账一起拔走。宿主每个新会话做扩展来源对账（`syncExtensionSources`）会剪掉扩展名下的注册，所以它在每个 `session_start` 重放：行在只补选中，被剪才重注册。
- feat: baseUrl 选 `http://a2mcp.invalid/v1`（RFC 6761 保留域），不是探针夹具用的 `127.0.0.1:1`。绊线按注册表行的主机收键，占位行不该把 `127.0.0.1` 收进 deny 的键集——桥自己就监听在那个地址上。第二道 `getApiKey` 闸门是被量的，不是被推的：`registerProvider` 的内联 `apiKey` 经 authStorage 解析后放行，pty 真发一条 prompt 得到的是 `Couldn't connect to a2mcp.invalid (connection refused)`（会话记录 `provider=a2mcp model=offline stopReason=error`），不再是硬报错。占位行没有 `transport`，deny 装配照常规避，`host_llm: "deny"` 与占位同场由 `bun run test:takeover` 守——34 项全绿。
- feat: 两份引导脚本在「自己装了宿主且 `models.yml` 不存在」这一条窄分支上播种同一张占位行（create-only：已存在的文件一个字不碰、一句都不提；PATH 上本来有宿主的机器不写）。这是对「bootstrap 不写 models.yml」旧定位的翻面，脚本头注释、README、docs、本节都按新条件写。无头那条路只有磁盘文件来得及，而运行态占位行救不了它——两半各守一道门。
- fix: `test/entry.test.ts` 的假 `Main` 会话补上 `model` 字段。占位接线进 `session_start` 后，那两只没有模型的假会话第一次真把桥的兜底路径走了一遍：两项红，红的是提示文本挤掉了它们数通知的断言。修夹具不修判据——那两组测的是已配置宿主的行为，未配置那半由 `test/auto-model.test.ts` 八项守。
- test: `bun test` 214 → 226 项（16 → 17 文件）。新增 `test/auto-model.test.ts` 八项（有模型 → 零调用；空槽 → 恰好一次注册一次选中；行的字面值、sourceId 与接管名的不等、选中的是注册表自己的行、剪枝后逐次重放、注册表不吐行就抛错）；`test/bootstrap-ps1.test.ts` 九项 → 十三项（播种正文逐行相等、`InstalledHost` 各只赋值一次且紧跟「No omp on PATH」、两边 create-only 且落在各自 profile 路径、dry-run 同一句计划）。`test:bootstrap` 39 → 46 项：第七组把自装宿主那条分支从头走到尾——假 `curl` 顶掉安装器那一次下载，二进制预先躺在 `PI_INSTALL_DIR`，于是文件写出、字节、`Wrote` 回声、已有文件不动、dry-run 只打计划、已有宿主不写，全都有了一条断言。变异五道：删「有模型就不动」守卫 → 单项红二；sourceId 写成 `a2mcp` → 红一；删 `.sh` 的 create-only 守卫 → 探针红一（`exit 0: claimed a write`）；删 `.ps1` 的 `Test-Path` 守卫 → 红一；把 `$InstalledHost = $true` 写两处 → 红一。
- docs: 中英 README 的故障排查条目重写成两条门的分法（桥自动补位；无头靠脚本那份文件；更早宿主报的 `No models available` 也点名），一键安装一节补「安装器之外它只写一个文件」一段；`docs/protocol.md` 新增「占位模型」一节（形状、三条线、与 deny 同场、无头为什么救不了、那份 YAML 全文）；`docs/testing.md` 按实测改 226/46/十三，播种组与 pty 实测记录各成一小节，「宿主没有模型配置就不创建 session」那句旧判据就地改对。站点三处数字跟着 sync.mjs 改。
- 边界（写于本节发布时，当天下午被下一节改窄）：Windows 一侧两半都没执行过——没有 PowerShell、没有 Windows，`.ps1` 的播种只有那四条字面核对；Linux 侧的运行态是 pty 真量，磁盘侧是探针真跑（下载除外）。占位模型把「这台机器没配模型」从启动期硬报错变成运行期连接失败，它不产生推理，也不该被当成能用的模型。
- 回归: `lint` / `tsc` 干净、`bun test` 226/226（17 文件）、`test:bootstrap` 46 项 `BOOTSTRAP OK`、`test:takeover` 34 项全绿、pty 真宿主一遍、站点 `build` + `check` 全过。数字全出自这一遍。

## 2026-10-19 — 安装一节分成两条路：omp 安装与一键安装

README 的「安装」原来是一条命令接一段脚本，读的人得自己判断哪一段轮到自己。「已经有宿主」与「机器上还没有 omp」是两台机器，改成一节一条路：`### omp 安装（机器上已经有 omp）` 收 git URL、卸载、v0.3.0 迁移、URL 形态与那条手工软链的警告；`### 一键安装（机器上还没有 omp）` 收 bootstrap 的两种形态、钉值来历、39 项核验与 Windows 那一支。开头一句话给出分界，结尾一句「两条路装完都一样」接首次启动的 token 生成。站点读的是 `README_ZN.md`，所以这一节先动它，`README.md` 同形镜像。

- docs: 挪段落挪出两个既有缺陷，顺手都修了。`test:install` 那段「上面这些是实测过的」盖的本来就是 git URL 那条路的核验，改结构前它压在 bootstrap 小节的尾巴上，指错了对象；英文版更糟——「Nor hand-symlink」那段悬在「这一支一次都没跑过」之后，离它要接的「只有这一条安装路径」隔了整段 Windows。两段各归其位，那个 `Nor` 改成了不依赖前句否定的写法。
- site: 首页卡从八张变九张，新的一张「装它分两条路」链到 `/intro#安装`，文案把两条路的分界与「`.ps1` 一次都没被执行过」一起写在卡上——这句约束不该只在正文里。锚点是构建后对着 `dist/intro.html` 的 `id` 验的，不是猜的 slug 规则。
- 回归: `bun test` 214/214，`lint` 干净（1 info），站点 `build` + `check` 全过。

## 2026-10-19 — Windows：引导脚本一份，加上 `xfer` 在 win32 上真能取到二进制

`bootstrap.sh` 管不了 Windows：POSIX `sh`、`command -v`、`$HOME/.local/bin` 在 PowerShell 环境里一条都不成立。但比脚本更大的洞在桥自己身上——`src/obtain.ts` 的钉表只有四个 unix 平台，Windows 主机上 `targetKey()` 算出 `win32-x64`、查不到行，于是 `xfer_share` 直接回一句「no pinned dufs build for win32-x64」。光有引导脚本只是把人带到门前，门后那句拒绝还在。

上游发不发 Windows 构建是先量的，不是猜的（2026-10-19 取 release API）：`dufs` v0.46.0 有 `dufs-v0.46.0-x86_64-pc-windows-msvc.zip`，zip 里唯一那个条目是 `dufs.exe`；`cloudflared` 2026.10.1 只发 `cloudflared-windows-amd64.exe`（外加 `.msi`），**没有 windows/arm64 的 exe**。所以只加 `win32-x64` 一对，不加半对的 `win32-arm64`——一次 `xfer_share` 要两个二进制，缺一个就是缺一个，既有的那句「no pinned build for \<target\>」本来就是这个事实的正确说法。

- feat: 钉表加 `win32-x64` 两行。`dufs` 那 2 323 817 字节的 zip 与 `cloudflared` 那 55 325 120 字节的 `.exe` 都在这台 Linux 机器上整包下下来、本地算 sha256 写进表里：`21d82965…9b0bf` 与 `4d2490e7…c891b6`。dufs 不发校验和，这一行只有本机的复算；cloudflared 在 release 正文里给 digest，复算结果与它相等——是「自己算完对上了」，不是「抄来了」。字节的条数也对过 release API 报的 `size`，两处一致才敢写：第一次读 size 时 `grep | paste` 把两行粘成一行，dufs 的 zip 看着像 2 764 841 字节，那个数哪儿都不对。
- fix: `.zip` 不再交给 `tar` 解。本机的 GNU tar 打不开它（实测 `This does not look like a tar archive`），Windows 自带的是 bsdtar、读得动，但那是这台机器上一次也执行不了的调用——把一个本仓库永远走不到的分支写进安全检查里，正是上一轮文档点名的那种洞。改成自己读 zip 的那一个条目：从末尾的 End of Central Directory 找中央目录，按条目名取偏移，方法只收 0（stored）与 8（deflate），deflate 走 `inflateRawSync`。这条路顺带更紧：一个字节都不往磁盘上解，条目名不参与拼路径，tar 那套「条目不能是绝对路径、不能含 `..`、解出来得留在 staging 目录内」的检查对它不是放松，是问题消失了。换来的代价是自己防 zip 炸弹——条目声明的长度与 inflate 出来的实际长度都对着 64 MB 上限过，方法不是 0/8 直接拒。CRC 不复算：整包 sha256 已经比对过，那里没有第二个信任源。
- feat: 平台从依赖注入（`ObtainDeps.platform`，默认 `process.platform`），与既有的 `target`/`pins`/`env`/`binDir` 同性质——为的是 win32 那几处在 Linux 上也进得去。受影响的是三处形状判断，不是下载逻辑：落地名要带 `.exe`，否则 Windows 不认；`PATH` 扫描按 `PATHEXT` 的后缀逐个试（取不到就用 `.EXE;.CMD;.BAT;.COM`）；`HOME` 在 Windows 通常为空，装不下的那份 unix home 换成 `env.LOCALAPPDATA` 下的 `a2mcp\bin`，POSIX 那一支的 `~/.local/bin` 一个字没动（它是文档写死的位置，也是 `test:obtain` 断言的一部分）。桥 spawn 用的是 `resolveBinary` 返回的绝对路径，这个目录不在 PATH 上也能用。`mode: 0o755` 留在原处，注释里写清它是 POSIX 位、在那边是 no-op。
- fix: 逃生门原先判「值里含 `/`」。Windows 的路径用反斜杠，`C:\tools\dufs.exe` 会漏进下载分支去查 PATH——把「这台机器不许下载」的写法变成会下载的写法。判据改成 `/` 或 `\`，`xfer_share` 那句缺二进制的提示跟着把目录与两个分隔符都改对（目录名从代码里读，不在消息里抄第二份）。
- fix: 下载上限 64 MB 原先是照着 cloudflared 那 38.4 MB 定的，Windows 的 `.exe` 是 52.7 MB，余量剩 11.7 MB。120 秒那道没有在真资产上重测，注释按实写：它是本机手跑 Linux 构建 rounded up 来的，53 MB 要在里面走完约需 450 KB/s——Windows 主机网络差就得到一条超时审计，而不是一次慢共享。这是没在目标平台上跑过的限制该有的样子。
- feat: `scripts/bootstrap.ps1`，与 `.sh` 同一套判断：`-DryRun` / `-Uninstall` / `-Reinstall` / `-Upgrade` / `-HostVersion` / `-Spec`，插件名、仓库 spec、宿主包名、确切版本那道门的正则逐项对齐，钉值同样先从旁边的 `package.json` 读、没有就按 `-Spec` 推 raw URL。两处形状是 shell 那边没有的：`Invoke-WebRequest` 前要把 `SecurityProtocol` 设到 Tls12/Tls13（PowerShell 5.1 的默认能让 GitHub 拒掉，这一行决定读不读得回钉值），以及整个文件纯 ASCII（5.1 按 ANSI 码页读无 BOM 的 UTF-8，一个非 ASCII 字符就是一条乱码注释）。**它不查 `tar`**——`.sh` 那一句警告是给桥解包用的，Windows 上解 zip 的是桥自己那段代码，不依赖 PATH 上的解压器。
- 上游那个坑：`https://omp.sh/install.ps1` 里 `-Ref` 单独给会翻成 bun 源码构建，一个开关都不给时如果机器上有 bun 也走源码。这是读它自己那 375 行的主块读出来的，不是文档写的。所以这个脚本每一次调用安装器都带 `-Binary`——钉一个版本却又从源码构建，那不叫钉。
- 验收门用两个不含图形符号的信号：`omp plugin list` 里有 `a2mcp@` 那一行，外加 `omp plugin doctor` 里 `plugin:a2mcp` 那一行存在且不带失败词。`.sh` 那种 `case "$ROW" in ✔*)` 的判法没照抄——Windows 控制台把 `✔` 打成 `?` 只需要一个码页，那种红不是我们要的门。
- test: `bun test` 194 → 214 项（15 → 16 文件）。`test/obtain.test.ts` 里「the shape Windows insists on」十项 + 一张「两张表都不给 `win32-arm64` 留半行」：测试自己用 `deflateRawSync` 造最小 zip（本地头、中央目录、EOCD，CRC 真算，那份夹具对过 `unzip -t`），断言解出的字节等于原文，再造三条坏的（方法 12、声明长度超上限、条目名差一点）各断失败原文；`platform: "win32"` 注入那几条断 `dufs.exe` 落地、`PATHEXT` 命中且零请求、`C:\…` 走「按给定路径用」且零请求、`binDir` 默认落 `LOCALAPPDATA` 下。`test:obtain` 31 → 37 项：钉表 `HEAD` 遍历从八次变十次，另四单项把 Windows 那两行按字节读——zip 在本机算出的哈希与表里一致、`readZipEntry`（win32 安装走的同一段代码）在那个 zip 里找到 4 721 664 字节的 `dufs.exe`、`.exe` 前两个字节是 `4d5a`（HTTP 206 拿的，不是归档）、报回的总长在上限之内。新增 `test/bootstrap-ps1.test.ts` 九项，把 `.ps1` 当文本读跟 `.sh` 对：两处都写着「这不是覆盖，往脚本里放一个语法错误，九项照样全绿」。
- 变异四处，跑完恢复。zip 那边把 `cdOffset` 读错一位（`eocd + 16` 多加一个字节）：六项红——`dufs.exe` 那条装不出来、deflate 与 stored 两条读不出、精确条目名、方法拒绝、上限拒绝都不成立；只有「不是 zip 的字节找不到 EOCD」照样绿，它本来就是要失败的那一个。去掉「`\` 也算路径」那半边：一项红（`C:\…` 那条），`bun test` 其余 29 项全绿，说明这台机器上除了这条断言没人替 Windows 用户守着这道门。`.ps1` 里删掉钉值那次调用的 `-Binary`：一项红。改掉 `$Plugin` 一个字符：一项红（与 `package.json:name` 对不上）。第一处还顺手暴露探针自己的毛病——那条 Windows 哈希的 detail 原先把两个哈希都截到 12 字符，真不匹配时看不出差在哪，现在打全值。
- 本机对 Windows 那两行能做到的最后一件实测：zip 整包 2 323 817 字节的 sha256 就是表里那一行；zip 里那个 `dufs.exe` 是 4 721 664 字节、自己的 sha256 是 `3e443496f7811f931232e1f79eeca23d7d7ff1ea0c9dcac67b6586d69b47e11e`，同一个值由 `unzip -p` 与本仓库的 `readZipEntry` 各算一遍对上了——那台机器上要落盘的就是这份字节。`.exe` 本身在这台机器上不可执行，不假装。
- docs: README 中英各加 Windows 那一支（落盘再跑的形态，不是管道；`iex` 里 `$PSCommandPath` 为空会丢旁边的 `package.json`），紧接一句事实：**这一支从来没有被执行过**，写它的机器上没有 PowerShell，`bun run test:bootstrap` 那 39 项测的是 `.sh`。「传文件」一节的平台从四个改五个，写明 `win32-arm64` 为什么空、以及那两行「查到的/没查到的」各是什么；`docs/protocol.md` 那段跟着改（`/` 或 `\`、`.tar.gz` 交给 tar 而 `.zip` 在内存里读、十个 asset、`.exe`、`%LOCALAPPDATA%\a2mcp\bin`、`0755` 是 POSIX 位）；`docs/testing.md` 的 obtain 一节按实测改成 37 项并加一组 Windows 字节项，`test:bootstrap` 一节新增那九项的小节、并把「未执行」这句话写进测试文档而不是只写进 README。
- 回归: `lint` 干净（1 info）、`tsc` 干净、`bun test` 214/214（16 文件）、`test:obtain` 37 项 PASS、`test:bootstrap` 39 项 `BOOTSTRAP OK`、站点 `build` + `check` 56 项全过。数字全出自这一遍。

## 2026-10-19 — 引导脚本可以不带仓库跑：钉值改从 spec 那个仓库读

`curl -fsSL …/scripts/bootstrap.sh | sh` 这一支昨天就能走完插件那半程，掉的是钉值。脚本按 `$SCRIPT_DIR/../package.json` 找 pin，管道里没有这层目录关系，于是它知道要装宿主却不知道装哪一版，最后打印一行 `no pin available … installing latest` 把宿主按最新装上。钉值存在的理由（那是本仓库所有核验最后一次跑绿的宿主版本）恰好在这条最可能被新机器用上的路上失效。

- feat: PATH 上没有 `omp`、旁边没有 `package.json`、也没给 `--host-version` 时，脚本从它接下来要克隆的那个仓库读 `package.json`：`--spec` 是 `https://github.com/<owner>/<repo>[.git]` 就派生出 `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/package.json`，`curl -fsSL --max-time 20` 取回来交给同一条 `sed`。取不到就装 latest，并在 stderr 说清是哪一种：没有 curl 可用、取回来的里面没有那一行、`--spec` 不是 `github.com` 的 URL（这一种不猜也不发请求）。`--host-version` 给了值就不出网，PATH 上已有宿主也不出网：既然不打算装，就没有要钉的版本。URL 里写的是 `HEAD` 而不是分支名，GitHub 按默认分支解析它。
- fix: `--help` 原先用 `sed -n '2,10p' "$0"` 读自己的文件头，管道形态下 `$0` 是 `sh`，那条命令去读一个二进制。选项表搬进 `usage()` 的 here-doc，文件头那两行 Usage 删掉，文案还是只有一处。
- test: `test:bootstrap` 28 项 → 39 项。新增九项把脚本拷进一个上面没有 `package.json` 的目录（`bareScript()`），PATH 前置一只记录 argv 的假 `curl`（`fakeCurl()`：回我们指定的那份 `package.json`，或者按 `curl -f` 的方式退 22），于是每条断言都能同时说清取到了什么、以及它到底有没有出网。其中一项真去问一次 GitHub：派生出的那条 URL 取回的钉值等于本地 `package.json` 的 `PIN`，够不着时打印 `info:` 不计项。前置那组加两条：没有 curl 且脚本单独一份 → 读钉值先如实告警，停仍停在安装器对 curl 的要求上；`sh -s -- --help` 从管道进去 → 打出选项表并退 0。两道变异跑过：把派生 URL 里的 `HEAD` 换成 `main`，红三条，红的是出处那行与「真走了网络」那两条（假 curl 对 URL 不敏感，所以拦住它的是断言盯着字面 URL）；去掉「已有宿主就不出网」那个条件，红一条，argv 日志里多出一次请求。
- 实测: 无克隆那一支真跑一次。`HOME` 是临时目录，`PI_INSTALL_DIR` 也指进同一个目录，PATH 上没有宿主：脚本从 raw 读到 `18.12.1`，安装器按 `--binary --ref v18.12.1` 把二进制写进那个临时目录，`omp install https://github.com/adam-ikari/a2mcp.git` 真克隆真登记，自检出 `✔ plugin:a2mcp: v0.4.0`，`--uninstall` 把登记从 lock 里拿掉。那个目录 353 MB，跑完删掉；机器上原有的宿主（`~/.bun/bin/omp`）、`~/.local/bin` 与已装的插件都没动。这一次不在探针里。
- docs: README 中英各加无克隆那条命令与「钉值从哪来」的说明，读不到时装 latest 这个选择照实写，不写成「自动跟随最新」；`docs/testing.md` 的 `test:bootstrap` 一节改成六组 39 项，新增小节写清那九项的夹具为什么是一只假 curl 而不是一次真网络，边界那段把「第一次真执行发生在别人的新机器上」换成上面那次实测，同时保留「探针不跑宿主那一支」；站点描述里的项数跟着改。
- 回归: `lint` / `tsc` 干净，`bun test` 194/194（15 文件），`bootstrap` 39 项 `BOOTSTRAP OK`，站点 `build` + `check` 56 项全过。数字全出自这一遍。

## 2026-10-18 — 一键装宿主与扩展：`scripts/bootstrap.sh`；宿主 pin 先升到 18.12.1

README 教的安装方式只有一条：`omp install <git-url>`。那句话假设机器上已经有 `omp`，而宿主这一层怎么来，仓库一个字没写——新机器上手的人第一步就卡在这儿。卡的这一步恰好不是本仓库该重新发明的：上游有官方安装器（`omp.sh/install`，12 KB POSIX sh，取预编译二进制并自己核 sha256，`--binary --ref v<版本>` 是它唯一的钉版本写法）。所以这个脚本的定位是**引导**：把宿主编上，最后执行那条已有的扩展安装路径。它不是第二条安装路径，2026-10-02 删掉 `scripts/install.sh` 那条决定也不翻面——那次的错是自己维护一份模块图校验，这次连插件登记好不好都问宿主的 `omp plugin doctor`。

pin 是撞上来的一件事：本机宿主自己升到了 18.12.1，`package.json` 还钉 18.11.0，`bun test` 因此红两项。版本守卫存在就是为了这一刻。脚本的默认版本要读这个 pin，所以它先修对——不然脚本的第一个决定就是错的。

- chore: `@oh-my-pi/pi-coding-agent` 与 `@oh-my-pi/pi-ai` 的 pin `18.11.0` → `18.12.1`，`bun.lock` 跟着重写。中间跨四个版本，两处对本仓库有直接影响：18.11.3 的 breaking 是 `ui.approve()` 的宿主收到可选的 `session` 标签并回 `"once" | "session" | "deny"` 而不是布尔；18.12.1 的 breaking 是 `eval` 去掉 `display()`。实测两者都到不了桥：桥从不自己调 `approve`，审批探针在 18.12.1 上仍是 `VERDICT: B`（挂起 ≥90031ms、不是 `isError`），`test:takeover` 34 项 64.0 秒、推理 POST 1
- feat: `scripts/bootstrap.sh`，POSIX sh、`set -eu`、不要 bash。四步：前置（`curl`/`git` 缺了致命，`tar` 缺了只告警——它是桥自己解包用的，不影响安装；`$HOME` 不可写致命）→ 宿主（`command -v omp` 命中就报告版本**不动它**，与 `src/obtain.ts` 对目标文件「不等于登记那一行就拒绝」是同一条规矩；`--upgrade` 才重跑官方安装器；没命中就按 `package.json` 的 pin 装 `--binary --ref v<pin>`，读不到 pin 就装 latest 并说明为什么没钉）→ 扩展（`omp plugin list` 已登记就跳过，`--reinstall` 先卸载；否则执行且只执行那条 git URL）→ 自检（`omp plugin doctor` 的 `pi-a2a-ext` 那一行要见 ✔，再报一次宿主版本与 pin 是否一致，只报告不替你改）。参数 `--dry-run` / `--uninstall` / `--reinstall` / `--upgrade` / `--host-version` / `--spec`。不软链、不 `omp install .`、不自建模块图校验、不生成 token、不写 `models.yml`、不 `sudo`、不加跳过 TLS 校验的开关、不改任何 rc 文件（`~/.local/bin` 不在 PATH 上时只打印该加的那一行）
- test: 新增 `test/bootstrap-probe.ts` → `bun run test:bootstrap`（28 项，五组 6/5/5/7/5，约 9 秒）。`PATH` 是探针自己造的软链目录，只放点名的真二进制，所以「没有 curl」是真没有；`omp` 换成一个只往文件追加 argv 的记账 stub。两道变异写在组里：把 `package.json` 的钉值换成 9.9.9，stub 收到的 `--ref` 跟着变；把 doctor 那行改成 ✗，脚本如实红。第五组用 PATH 上那份真 omp 在临时 `HOME` 里跑真一遍，登记落 `omp-plugins.lock.json`、`--uninstall` 收干净
- 回归: 反证之外探针自己也修了三处。拿掉 `curl` 那个场景原本留着 stub 宿主，脚本走「已有宿主」那一支，`curl` 检查根本没跑到，还顺手把扩展「装」进了 stub 的登记，于是下一个场景读到已登记、跳过安装、两条都绿；`badHome` 的 `spawnSync` cwd 就是那个不存在的 `HOME`，退出码是 -1；`farm()` 从没把 stub `omp` 链进去。都记在 `docs/testing.md` 那一节里
- docs: README 中英 Install 段前各加「机器上还没有 omp？」一小段（脚本一行命令、它做哪三步、一句限定「**扩展的安装仍然只有原来那一条**」，另加一句宿主默认开机自更新，脚本给的是装上时与钉值一致、不是一直停在钉值）；`docs/testing.md` 总览表加一行、新增 `test:bootstrap` 一节、统一前置那段说明它前四组不起真宿主；插件目录跟随 `HOME` 那张表补 18.12.1（`test:install` 48 项与 `test:bootstrap` 第五组都是在临时 `HOME` 里真装真登记跑绿的）；`test/harness.ts` 与 `test/install-probe.ts` 的版本注释跟着重测；README 开发命令列表补 `test:bootstrap`，单测项数 160 → 186（这个数字在 HEAD 就已经过期）
- ci: `host-probes` 加一步 `bun run test:bootstrap`（不出网、不起宿主，秒级）；顺手把 `test:install` 那步上方一段写于 18.10.4 时代的过期注释换成现状

- 回归：`lint` / `tsc` 干净，`bun test` 186/186（14 文件）。18.12.1 上全量重跑：`tree` 形状 OK、`registry` 5497 行（18.11.0 是 5490）、`SMOKE OK`（22 tools）、`HARDEN OK` 34 项、`obtain` 31 项 PASS（公网那半程仍是证书报错，本机网络对代理域名重签 TLS）、`install` 48 项 `PACKAGE OK`、`SCENARIOS: 41 steps, 0 failed`、`takeover` 64.0 秒全过、审批 `VERDICT: B`、`bootstrap` 28 项 `BOOTSTRAP OK`

## 2026-10-18 — 「两个二进制都缺」那一遍端到端升格成提交里的核验：`test:install` 第五组，35 项 → 48 项

`xfer_share` 在 PATH 上什么都没有的那条路径，昨天是靠一个用完即删的脚本证明的：`test:obtain` 里 cloudflared 是写明路径那一侧，`bun test` 把获取整个 stub 掉，两边都碰不到这条形状。今天把它放进 `test:install`，代价是每轮 CI 多约 46 MB 出网。

- test: `test/install-probe.ts` 新增第五组（13 项，整个探针 35 → 48）。宿主跑在自己的临时 `HOME`，`PATH` 削到只剩 `omp` 所在目录、bun 所在目录、`/usr/bin`、`/bin`，头两项断言 `dufs` 与 `cloudflared` 都不应答——这两条不成立就整组跳过并说明原因（这台机器证不了，不是桥做错什么）。硬的是文件、登记、审计三样：`xfer_share` 先解析 dufs 再起服务，起好了才解析 cloudflared，再开洞，所以隧道成不成它们都该成立；共享本身与它后面的 GET 只报告，本仓库对 quick tunnel 的定性没变。跑顺的实测：整个探针 23 秒，6.4 MB 与 38.4 MB 落进桥自己的 `HOME`（`0755`），`installed` 同时点名 0.46.0 与 2026.10.1，操作者真正的 `~/.local/bin` 前后一样
- fix: 探针在两处会把「红」报成「炸」。登记文件不存在时 `readFileSync` 抛异常，后面的审计项与「操作者 `HOME` 没被动过」就此不跑；工具失败时回的正文是一个 JSON 字符串，`JSON.parse` parse 得动，`info.port` 却是 `undefined`，于是炸在下一步的 `fetch`。现在两处外部文件先查在不在，共享回包先看形状（`port` 得是数字），跳过就打印一行 `info:`
- fix: 第五组的宿主用 `PATH` 上那份 `omp`，不认 `OMP_BIN`——这个文件的其余部分跑的就是 `PATH` 上那份，一条规矩就够了；扩展用软链进它自己那个 `HOME`（前四组走 `omp install .`，因为那里要验的正是 install 本身）
- fix: 回包文本进日志前把 basic-auth 口令打码（URL 里内嵌一份，`secret` 字段又一份），多行 JSON 压成一行——这个探针是一项一行
- 变异：把 `src/obtain.ts` 的下载上限从 64 MB 改成 1024 字节，第五组红五项、其余四组全绿；往削过的 `PATH` 里塞一个 stub `dufs`，第五组如实跳过
- 回归：`lint` / `tsc` 干净，`bun test` 186/186（14 文件）。`bun run test:install` 48 项全过，含两个二进制真下载与真共享

## 2026-10-17 — 缺的外部二进制桥自己按钉值拉：`src/obtain.ts`，dufs 钉 0.46.0、cloudflared 钉 2026.10.1

`xfer_*` 在这台机器上其实不可用：`dufs` 不在 PATH 上，而契约写的是「二进制只命名、不内置、不下载」，报的错误要求人手去 GitHub 拖包。这条契约今天翻面——缺的自己拉，版本与哈希钉死，唯一的出口是配置里写路径。诚实的说法不是「图方便」：桥已经替宿主决定了用 dufs，这次只多一个意见（字节从哪来），不是多一个权威。

- feat: `src/obtain.ts` 的 `resolveBinary(name, configured, sid, deps)`，四步：配置里的值含 `/` 就原样用（`access(X_OK)` 检查，**绝不下载**）→ 在 `PATH` 上逐段找可执行文件（不起 shell、不 `which`，机器有就别抢）→ `~/.local/bin/<name>` 已存在、且它自己的 sha256 等于登记里桥为这一条写下的那一行，就复用 → 下载
- feat: 钉表是模块里的字面量，键 `${platform}-${arch}`，两个二进制各四行（linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64）：dufs 0.46.0 的哈希取自 GitHub release 资产的 `digest`，cloudflared 2026.10.1 那天出网通了才读回来。哈希一律不向发字节的那一步要：cloudflared 四行、dufs 的 linux-x64 一行是手动下载复算的，其余由 `bun run test:obtain` 每轮把八个 URL 全 `HEAD` 一遍、本机那一行真下真跑。形状差别记在 `kind` 里：dufs 四行都是归档，cloudflared 的 Linux 是裸 ELF、macOS 是里面只有一个 `cloudflared` 的 `.tgz`；取的是普通构建不是 `-fips`，没有宿主要过 FIPS。钉的是**归档**的 sha256——GitHub release 资产的 `digest` 就是归档的，不是解出来那个文件的——所以回来先对归档，解包，再把解出来那份自己的 sha256 写进登记；两哈希不同名这件事端到端那一遍才暴露，此前文档写成「复用看的是钉值」，实际看的是登记那一行
- fix: 下载有界——64 MB 上限、120 秒墙上时钟、边流式边哈希；上限按钉表里最大的那个 asset（cloudflared 的 Linux 构建 40 MB）留了升级的余量。不请求 `latest`，也不向发字节的同一台服务器要校验和
- fix: 解包只进新建的 `mkdtemp`，`tar -tzf` 先点名条目，解完 `realpath` 断言还在那个目录里；落盘是同目录 `.part` + `rename`，`0o755`；同一个 name 的并发调用单飞，第二个人等同一条 promise；平台不在表里就报错点名 `platform/arch`
- fix: 目标位置已有文件时，先哈希再决定——等于登记里那一行才复用，不等就拒绝并打印那个文件自己的 sha256，同时把钉值一并摆出来。桥不覆盖别人的文件，也不留 marker
- fix: 安装记录在 `spawn` 之前落审计（`tool: "xfer"`，`action: "install"`），每次安装另记一行到 `<agentDir>/a2a-bridge.installs.json`（`A2A_BRIDGE_INSTALLS` 可指走），复用看的是它
- fix: `xfer_share` 的回包多一个 `installed: {dufs, cloudflared}`，让调用方知道自己为什么多等了几秒；下载就地等完，没有「正在装，稍后再来」的中间态
- fix: `xfer_stop` 对着真隧道不返回——端到端跑出来的，25 秒客户端超时。关闭那条路径先给 dufs 发 `SIGTERM`，等隧道拆完，然后才 `once("exit")` 去听那个子进程；dufs 回 `SIGTERM` 只用几毫秒，事件在订阅之前就发过了，那个 await 永远等不到，第二次 `xfer_share` 顶替旧共享时卡的是同一处。等待现在在发信号之前登记，并且先读 `exitCode`：孩子已经不在了就当场过。共享实际早就关干净了，卡的只是答复
- fix: `test:install` 那条「首次启动只写哪些键」的形状断言按 `xfer` 块补齐——昨天加默认块时没动它，`bun run test:install` 一直红着这一项（`PACKAGE` 1 check failed），今天全量回归才撞上。测试页的项数跟着按实测改：探针 35 项（总览表原写 33、节标题原写 28，两处都过期），内容那组 8 → 15 并把「只依赖一个宿主包」那两条补进断言清单
- test: 补跑「两个二进制都缺」那一遍端到端（真宿主、隔离 `HOME`、`PATH` 削到只剩宿主自己）——这一条此前谁都没覆盖：探针里 cloudflared 是写明路径那一侧，单测把获取整个 stub 掉。跑绿的那遍 14.0 秒返回，`installed` 同时点名 0.46.0 与 2026.10.1，两个文件都装进桥自己的 `HOME`（6.4 MB / 38.4 MB，`0755`）、登记各一行、审计 `install` 两条加 `share`/`stop`，loopback GET 字节一致、PUT 201 落盘、错密码 401、停止后端口释放，操作者真正的 `~/.local/bin` 依然没有 `dufs`。同一趟在出网差的那几遍也留下了数：dufs 装成功后 cloudflared 的 40 MB 在流里停住、120 秒到点回 `isError` 带失败原文，共享没开成、dufs 被收走、没有孤儿进程，整趟 229 秒——冷装两个二进制的最坏值与正常值各量到一次
- fix: 端到端那一遍顺手纠正一处措辞。登记里 dufs 的 sha256 是 `2c91337a…` 而钉值是 `817769f7…`，看着像校验没对上却装了：其实钉的是**归档**的 sha256（release 资产的 `digest` 本来就是归档的），登记存的是解出来那个二进制自己的。**复用比对的是登记那一行，不是钉值**——CHANGELOG 与 brain 真值页那句「哈希等于钉值才复用」写错了，代码一直是对的，失败消息也同时打印两个哈希
- test: 新增 `test/obtain.test.ts`（19 项，本地 `Bun.serve` 扮 GitHub，不靠外网）：哈希不符、哈希长度不对、tar slip、解出多余条目、目标是别人那份文件时拒绝、单飞只下载一次、超上限截断、超时、不支持的平台、PATH 命中不下载、显式路径不下载，以及 `spawn` 收到的是解析器给的绝对路径；钉表本身在两项里被检查——每一行的哈希是 64 位小写十六进制、URL 拼出来是 `<tag>/<asset>` 且不带 `latest`，两个二进制各自四行的形状
- test: 新增 `bun run test:obtain`（`test/obtain-probe.ts`，31 项，进 CI 的 `host-probes`）：两个二进制都真下载、真跑 `--version`、真复用 → 用拉来的 dufs 起真共享 → GET 字节一致、Range 206、PUT 落盘、错密码 401、目录列表 200、关闭后端口释放 → 钉表八行 URL 全 `HEAD`。**`--auth user:pass@/:rw` 在 0.46.0 上重测过**，这条门过了版本号才进 README；真隧道那半程用第一节拉下来的那份 cloudflared 起，仍然只 `info:` 报告
- test: 新增 `test/tunnel.test.ts`（4 项）钉住隧道输出读取的转录上限；`test/xfer.test.ts` 那条「dufs 缺失」改用路径形状（裸名现在是下载分支），另加一项断言裸名走解析器，以及上面那条关闭挂死的回归——它的隧道 stub 必须真花掉几十毫秒的事件循环时间，杀信号与订阅挨在一起就量不出这个洞
- fix: `src/tunnel.ts` 的子进程转录有上限（64 KB），主机名到手就不再追加，没到手时收的是尾部——共享开一个小时，那条读循环就陪它一个小时，内存不该跟着长
- docs: AGENTS.md 的例外清单从两条变三条（多了这个获取，连带它的代价：审计、文档，以及只有显式路径这一个出口）；README / README_ZN 里「桥不下载任何东西」重写，两个二进制的钉值各写一处；`docs/protocol.md` 的审计动作加 `install`、钉表段落改两个二进制；`docs/testing.md` 加 `test:obtain` 一节与隧道那条读循环一节
- ci: `ci.yml` 里指向已删除的 `test:blob` 的那一步换成 `test:obtain`，步骤名与它上面那段注释跟着改成两个二进制（原来只写 dufs）
- fix: 站点守卫里「lastmod 不能是未来」那一条拿进程的 wall clock 跟 git 的 `%cs` 比，两个时钟不同源——node 跑在 UTC，提交是 +0800——于是 16:00Z 之后落的那次提交被判成未来日期，报错里两个日期字符串一模一样（`lastmod 2026-10-18 vs CHANGELOG.md 2026-10-18`），看着像比较本身坏了。上界改成仓库里最新那次提交的 `%cs`，与被判的量同一 convention；反证跑过：把 dist 那份 sitemap 里 changelog 与 testing 两行改成 2027-01-01，两项如实红
- 回归：`lint` / `tsc` 干净，`bun test` 186/186（14 文件）。`bun run test:obtain` 31 项全过，含两个二进制真下载与真共享；公网那半程还是量不了——本机网络对代理域名重签 TLS，`*.trycloudflare.com` 从发布它的机器 curl 不回来，主机名 announce 与桥侧的关闭是真测到的。端到端一遍：真宿主 + 隔离 HOME + PATH 上没有 dufs，远程 `xfer_share` 自己拉出 0.46.0、回包点名版本、loopback GET 字节一致、错密码 401、`xfer_stop` 返回且端口释放，审计里 `install` 一条（dufs；cloudflared 在继承来的 PATH 上命中，按规矩不下载）、`share` 与 `stop` 各一条，真的 `~/.local/bin` 一个字节没动。宿主核验全量重跑：`smoke`、`hardening` 34 项、`install` 35 项 `PACKAGE OK`、`scenario` 41 步 0 失败、`registry` 5490 行、`tree` 形状 OK、`takeover` 67.2 秒（推理 POST 1、元数据 1）、审批 `VERDICT: B`；站点 sync 后 render-check 56 项全过

## 2026-10-16 — 传文件由桥自己的三个工具驱动：`dufs` + cloudflared quick tunnel，字节不进 JSON-RPC

`/blob` 撤掉之后，那件活（把宿主机上的文件交给调用方，或反过来）改由三个桥自己实现的工具承担：工具只交出一条路径，字节走普通 HTTP。

- feat: `xfer_share` / `xfer_status` / `xfer_stop`（`src/xfer.ts`；在 `extensions/a2a-bridge.ts` 里追加进 `tools/list`，并在分派时先于宿主执行器）。`xfer_share {path, ttlSeconds?}` 让 `dufs` 在本机 `127.0.0.1` 上以随机端口与随机 basic auth 起一个 HTTP 服务，再由 cloudflared quick tunnel 给它一个公网主机名，返回带凭据的 URL、本地端口与到期时间；默认 TTL 3600 秒，第二次 `xfer_share` 替换第一个，桥停止时带走共享
- feat: `src/tunnel.ts`：quick tunnel 由进程自己起（`cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>`），主机名从子进程输出里解析出来，`stop()` 先 SIGTERM、两秒后 SIGKILL
- fix: 配置新增 `xfer.dufs` 与 `xfer.cloudflared`（缺省就是这两个名字，按 PATH 找）；给了值却不可用的（空串、非字符串）启动即报错，不静默回退到默认名
- fix: 每次 `xfer_*` 调用在审计里留一条 `tool: "xfer"`，args 只有 action/path/port/ttl，文件内容不进日志
- test: 新增 `test/xfer.test.ts`（11 项）：工具面、路径解析（`~` / 相对 / 绝对）、四种拒绝（无 `path`、路径不存在、`dufs` 缺失、到期后端口释放）、共享生命周期（服务端校验的凭据就是桥生成的那一份、`stop()` 释放端口、第二个共享替换第一个）。核验用一个运行时写出的可执行 stub 顶替 dufs，隧道用注入的开洞器
- 回归：`lint` / `tsc` 干净，`bun test` 160/160（新增 11 项）。真机核验：dufs 0.43.0 的二进制直接驱动本模块，GET 字节一致、Range 206、PUT 落盘、错密码 401、目录列表 200、共享关闭后端口释放，8 项全过；cloudflared 侧起得到 `https://<random>.trycloudflare.com` 主机名，但那台机器所在网络对代理域名重签 TLS，`curl` 走公网 URL 报 `unexpected eof`，所以「经隧道端到端」这一条没有从那台机器上测成

## 2026-10-16 — 原始字节端点撤掉：传文件改成桥外的普通 HTTP，桥的原始面只剩 `POST /host-llm`

`POST /blob` 与后来补上的 `GET /blob` 那一半整条从桥里撤掉——`src/blob.ts`、两条路由、审计记录与核验一起走。它原先顶的那件事（宿主审批门配成 `prompt` 而调用方无交互 UI 时写挂起 ≥90s）现在归桥外的 HTTP。

- fix: 传文件走三个桥自己的工具（`xfer_share` / `xfer_status` / `xfer_stop`）：工具只交出一条宿主路径，`dufs` 在那条路径上起 HTTP 服务、cloudflared quick tunnel 给它一个公网主机名，调用方用 `curl` 之类直接搬字节——字节不进 JSON-RPC，也不落在桥的任何一条路由上
- fix: `src/server.ts` 不再分派 `/blob`，桥不属于工具的路径只剩 `POST /host-llm`；MCP 路径 128 MB 的请求体上限（`maxRequestBodySize`）不变
- fix: 审计里的 `blob:write` / `blob:read` 两类记录消失，传文件改记 `tool: "xfer"`，args 只有路径、本地端口与 TTL，内容不进日志
- test: `test/blob-probe.ts` 与 `test/blob-route.test.ts` 删除，`package.json` 的 `test:blob` 脚本一并去掉；`test/scenario.ts` 里两段借 `/blob` 的叙事跟着撤（10 个叙事 → 8 个）；`test/rss-<宿主版本>.json` 四份采样删掉
- docs: 协议页删掉「原始字节传输」一节（含其下的「下载」「内存」「它放弃了什么」），传输表、`stop()` 那两处与鉴权、审计处的 `/blob` 一并去掉；两份 README 删「传文件」/「Moving files」一节与 `test:blob` 那条命令；`AGENTS.md` 的「The exceptions on record」从两条变一条；测试页删 `test:blob` 一节与跟着它的计数

## 2026-10-16 — 宿主自己升到 18.11.0：插件目录改跟随 `HOME`，install 探针那半程改成自包含

宿主自己升到了 18.11.0，版本守卫如实红了（它存在就是为了这个）。同步 pin 与 `bun.lock`、重跑宿主核验之后，`test:install` 红了一项——**原因不在桥**。

- fix: **18.11.0 起 `~/.omp/plugins` 按 `HOME` 解析，18.10.4 上不是。** 实测三组：临时 HOME 起宿主 + 插件装在真实 HOME → 不加载；临时 HOME 里 `omp install` → 加载；临时 HOME 里只放一个软链、`omp install` 不参与 → 不加载。加载读的是 `<plugins>/omp-plugins.lock.json` 里的**登记**，不是目录里有什么。此前那半程按「插件目录不跟随 `HOME`」写，把插件装进真实 HOME 再拿临时 HOME 起宿主，于是在 18.11.0 上必然红
- test: `test:install` 改成把 `omp install .` 装进**它自己起的那个 HOME**，端到端从此自包含，也去掉了旧形状的一个副作用：在真实 HOME 里留下 `pi-a2a-ext` 的登记。那一项检查同时要求软链与 lock 登记都在（两半只有合起来才加载），项数不变
- 一条自证的教训：第一次判定 `~/.omp/plugins` 不跟随 `HOME`，用的是 `</dev/null` 起的宿主——**宿主 stdin EOF 就退出**，什么都没加载，而沉默看起来和「插件发现忽略了 HOME」一模一样。这正是 `test/harness.ts` 一直写着的那条，重犯了一次
- docs: 「插件目录不跟随 `HOME`」这条实测结论写在四处（两份 README、`docs/testing.md` 的表、探针与 harness 的注释），四处一起改成带版本的写法：18.10.4 不跟随、18.11.0 跟随。旧结论本身是对更早一次坏探针的更正，所以这次把版本写进结论里，下次它再翻也能看出来
- docs: 协议页的内存表按 `test/rss-18.11.0.json` 刷新（第三十一轮）：空闲 461 MB，单个 +18、并发 +43，两项峰值都等于安顿。文件名带宿主版本，旧版本那份 `rss-18.10.4.json` 留在 `test/` 里当历史，表指向最新那份
- docs: 两份 README 加了一段**给远程 agent 的提示词**（站点「使用指南」页跟着生成）——远程 agent 会拿宿主的工具当自己熟悉的同名工具调，而 `tools/list` 回的是宿主注册表逐字，这台机器的 `edit` 是补丁语法（`[PATH#TAG]` 加 `PUT N.=M:`），实测猜错换来 `File not found`
- release: 撤下 v0.1.0 与 v0.2.0 的 GitHub Release（`gh release delete`，不加 `--cleanup-tag`），**三个 tag 全留**。v0.2.0 在部分机器上装不上，标成 prerelease 或加一句说明，发布入口里都还留着这个装不上的东西，索性把它和更早那个一起撤掉，可用入口只留 v0.2.1；CHANGELOG 那两节按历史保留，开头补一句现状
- 回归（18.11.0 上重跑）：`lint` / `tsc` / `bun test` 161/161；`tree` 3 项、`registry` 5490 行（18.10.4 上是 5487）、`smoke`、`hardening` 34 项、`blob` 35 项、`install` 33 项 `PACKAGE OK`、`scenario` 54 步 0 失败、`takeover` 34 项 62.0 秒、审批 `VERDICT: B`

## v0.5.3 — 接入面收成两条路，附一个零依赖参考客户端

**这一版对远程调用方经协议拿到的东西一个字没变——同一个 MCP Streamable HTTP、同一个 Bearer token、`tools/list` 照旧；变的在桥外：给「能跑代码但不是 MCP 客户端」的调用方发一个官方参考实现 `scripts/mcp-call.py`（零依赖 Python 3 单文件），并在两份 README、`docs/protocol.md`、站点上把「两条接入路」写清——会说 MCP 的直接 `mcp.json` 接、别造轮子，不会说的取这脚本、别每次重推握手。** 版本位照 2026-10-18 判据进 patch：协议面没动，新增的是操作员侧一个脚本加一条被文档化的接入路。脚本不进 `package.json` 的 `files`（仍 `extensions/`+`src/`），与 bootstrap.sh 同路走 raw URL 交付，tarball 大小不变（65536 B，实测装出来的那份里没有 `scripts/`）。token 不换代，装着 0.5.x 的机器什么都不用动。

- 内容: 见上 2026-10-20 的「接入面收成两条路」一节（新脚本、新探针 `test:mcp-call`、两份 README 的新小节与提示词补句、`docs/protocol.md` 时序末尾的参考指针、`docs/testing.md` 一行与起宿主前置六改七、站点卡、开发命令列表两份各加一行）。
- 边界: 脚本测到的是「桥答得对、握手序列对」，不是「所有 agent 会照抄」——提示词那段是引导不是强制。Windows 无 `python3` 时脚本跑不起来，那是「既无 MCP 客户端能力、又无 python3」的机器的边界，文档指向 `mcp.json` 原生路，这里不内嵌解释器。探针是起宿主的独立探针（与 `test:install`/`test:bootstrap` 同级），不进 `bun test`，单测计数不动。Go 跨平台二进制方案讨论后否掉（会翻成第二套二进制分发系统 + CI 加编译链）。
- 回归（发版前重跑的一遍，2026-10-20）: `bun test` 233 项 660 断言全绿；`lint` / `tsc` 干净；`MCP-CALL OK` 6 项（真宿主 + 假 404 服务器两条都过）；`BOOTSTRAP OK` 47 项；`PACKAGE OK`、npm 组如实 info 跳过、tarball 里没有 `scripts/`；站点 `build` + `check` 全过（首页卡新链 `/intro#两条接入路` 锚点在 dist 里核到）。
- 发版之后核远程路：push 后从公开 git URL `omp install https://github.com/adam-ikari/a2mcp.git` 装进临时 HOME，落盘 `a2mcp@0.5.3`；起宿主后 `initialize` 回 `serverInfo.version` 0.5.3；再用本次交付的 `scripts/mcp-call.py` 对这座远程装起的宿主跑 `call bash`，退 0、stdout `remote-053-ok`——装法、协议、参考客户端三样在同一次真机跑里一起验通。

## v0.5.2 — 文档面回到 git URL：包名收回为预留形态

**这一版对远程调用方经协议拿到的东西一个字没变，代码面也只动了两处不跑在协议上的东西：两份引导脚本的默认 spec 与探针的对应判据。变的是 v0.5.1 那份 Release 与 README 写着的装法——`omp install a2mcp` 指向一个没有发布的包名，命令停在依赖解析；主路翻回 `omp install https://github.com/adam-ikari/a2mcp.git`（整棵检出 2.3 MB，照实写明），v0.5.1 的隧道下载修复原样在其中生效。** token 不换代，装着 0.5.1 的机器什么都不用动——代码同源，这一版是文档与默认值的纠偏。

- 内容: 见上 2026-10-20 的「安装主路回退」一节（两份脚本默认 spec、两份 README、站点卡、CI 注释、testing.md 六处、两个探针的头注释与前置组）。
- 边界: v0.5.1 的 GitHub Release 不撤、正文已改口（它交付的下载修复是真的）；npm 机制（spec 形状二选一、registry 读钉、tarball 打包、探针预留形态组）原样留在树里，哪天发包哪天启用；Windows 慢网新预算首跑仍待维护者回测。
- 回归（发版前重跑的一遍，2026-10-20）: `bun test` 233 项 660 断言全绿；`lint` / `tsc` 干净；`BOOTSTRAP OK` 47 项（默认 git 形态缺 git 要红、`--spec a2mcp` 缺 git 要过两条对调后）；`PACKAGE OK`，npm 组如实 info 跳过；站点 `build` + `check` 全过。
- 发版之后核远程路：push 后从公开 git URL 装进临时 HOME（`test:install` 端到端组），`initialize` 回 `serverInfo.version` 0.5.2，一次 `tools/call` 通；npm 预留形态的组如实 info 跳过。

## v0.5.1 — 隧道取回改进度感知（装法一句以 v0.5.2 为准）

**这一版实际交付的是取回预算：`src/obtain.ts` 的下载从一道 120 秒总墙上时钟换成 30 秒无字节空闲窗加 10 分钟总期限。装法以 v0.5.2 为准——这一节发布时文档里写着主路切到 `omp install a2mcp`，而那个包名从未发到 registry，同一天判据收回（见 2026-10-20 的「回退」一节），v0.5.2 把文档面翻回 git URL。** 发布时按判据算版本位：2026-10-18 立的是「远程调用方拿到的东西变了进 minor」，切装法那轮变的不是调用方经协议拿到的，而是操作者装到盘上的内容集，进 patch 位；隧道修复也不出现在协议面上，出在装不上的机器上：`src/obtain.ts` 的下载预算从一道 120 秒总墙上时钟换成 30 秒无字节空闲窗加 10 分钟总期限，起因是维护者 Windows 真机在 `cloudflared-windows-amd64.exe`（52.7 MB 裸 exe）上把旧时钟量穿了——慢但活的连接与死连接此前报的是同一句话。

- 内容: 见上 2026-10-20 的「取回改进度感知」一节（download 两道门、两类失败各带已收字节、失败文案点名逃生门、三条流控形状测试、protocol.md 三门描述）。装法切 npm 的那一节也在同一版里发出去过，同日翻面，它交付的面由 v0.5.2 收回。
- 边界: `omp install a2mcp` 会停在依赖解析（不发包，包名是预留形态），装机器用 git URL 那条；README 里躺这句话的窗口由 v0.5.2 关闭。Windows 上的 npm 装法本轮没有真机读数（ps1 过的是十三项字面核对，宿主同一条 bun 解析路径）；Windows 慢网在新预算下的首跑读数待维护者回测（持续低于约 90 KB/s 的连接在 10 分钟总期限下仍取不完，那是手动放文件加 `xfer.cloudflared` 绝对路径的地盘）；registry 的 `latest` 缓存陈旧是宿主自己的已知问题（manager 注释 #11634），`--no-cache` 在宿主侧；git tag 与既有 GitHub Release 不撤，旧装法机器照常工作。
- 回归（发版前重跑的一遍，2026-10-20）: `bun test` 233 项 660 断言全绿；`lint` / `tsc` 干净；`BOOTSTRAP OK`（47 项，真 HOME 装、lock 登记、二次运行幂等、卸载回收）；`test:obtain` 真网络 PASS（钉表十行 200、Windows zip 哈希对钉值、真隧道 announce）；`PACKAGE OK`，npm 真装组 info 跳过（registry 上 404，publish 前属预期）；站点 `build` + `check` 全过。
- 发版之后核了两条远程路：git 兼容路已核（push 后从公开 URL 装进临时 HOME，`initialize` 回 `serverInfo.version` 0.5.1，一次 `tools/call` 通）；npm 路不核了——同一天决定不发包，那条命令留在预留形态里，publish 哪天发生哪天再核。

## v0.5.0 — 没有模型配置的机器也连得上，Windows 拿齐两个二进制，公网端点多了操作员的一条命令

**这一版对远程调用方变的是可达面：零模型配置的机器上桥自己填占位模型（此前那类机器根本起不到能应答的端口），`xfer_share` 在 Windows 上把 `dufs` 与 `cloudflared` 真取得到（此前钉表没有 win32 行，那句工具在那台机器上只能报错），操作员多了一条 `/a2mcp tunnel`（端点可以在没有 SSH 的那台机器上直接经公网连上）。** 传输、鉴权、工具面的形状一个字没动：MCP Streamable HTTP `2025-11-25`、单 Bearer token、`tools/list` 还是宿主注册表逐字加那三个 `xfer_*`。token 不换代——装着 v0.4.0 的机器 `omp install` 同 URL 重装即可，远程 `mcp.json` 不用动。

- feat: `src/auto-model.ts`——每个 `session_start` 检查 `Main` 会话的模型槽，空槽填不可达占位 `a2mcp/offline`（RFC 6761 保留域 baseUrl），槽里有模型一步都不做；纯运行态，不碰 `agent.db` 与 `models.yml`。两份引导脚本在「自装宿主且 `models.yml` 不存在」那条窄分支上播种同一张占位行（create-only）。`omp --mode rpc` 那条无头路靠磁盘文件救，运行态占位行救不了它——两半各守一道门。
- feat: win32 的 obtain 补全——钉表加 `win32-x64` 两行（本机整包下载复算哈希）、`.zip` 由桥自己的读取器展开、平台从依赖注入让 Linux 测 win32 分支。`win32-arm64` 那行照旧是空的，上游不发那个构建，桥直接拒绝并说出缺什么。
- feat: `/a2mcp tunnel`——操作员的宿主会话命令，把 `openQuickTunnel` + `resolveBinary` 那套既有机器架在桥自己的端口上，公告 `https://<随机>.trycloudflare.com` 公网 URL；运行态、幂等复用、随端口拆，开与关各一条 `tool: "tunnel"` 审计（`sid: null`，token 不进记录）。这是 AGENTS.md 例外清单的第四条路径：隧道一开，Bearer token 就是公网端点的唯一闸门。
- feat: `scripts/bootstrap.ps1`——PowerShell 那份引导（与 `.sh` 的字面 parity 由 `test/bootstrap-ps1.test.ts` 守着）；真 Windows 机器首跑过 DryRun 与真跑（`-File` 与不落盘 scriptblock 两种形态），官方安装器与播种两支仍未在那台机器上真执行，边界按支级写。
- fix: 两份脚本结尾的 `models.yml` 提示按分支说话（写了才报路径，没写就明说这台没写）。
- test: `bun test` 194 → 231（17 文件；占位模型 8 项、bootstrap ps1 九项扩到十三项、tunnel 五项）。探针侧 `test:bootstrap` 28 → 46 项（自装分支用假 `curl` 驱动到落文件为止），`test:obtain` 31 → 37 项（win32 那两行真下、只验到字节）。
- docs: 安装一节重排成「omp 安装一条命令 + 一键安装分三个系统」；指南原位瘦身（README 各机制段收到「是什么、怎么用」，细节交还 `docs/`，被删事实逐一核对落点）；`docs/protocol.md` 新增「占位模型」与「操作员的隧道」两节；AGENTS.md 例外清单 three paths 改 four paths。
- 边界: **Windows 那一支验到字节，没验到执行**——`dufs.exe` 与 `cloudflared.exe` 的真 spawn 发生在没有 Windows 的机器之外才算，`/a2mcp tunnel` 在 win32 上的那条路同样如此。tunnel 的公网半程 2026-10-19 真宿主手工回过一次 `initialize` 200（stop 后 530），同日 `test:obtain` 的真隧道又撞上本机网络对代理域名重签 TLS——两个读数都按实测记，哪个都不是每日证据。
- 回归（发版前在 18.12.1 上重跑的一遍，2026-10-20）：`lint` / `tsc` 干净，`bun test` 231/231（657 个 expect）；`SMOKE OK`（`tools/list` 22 个）、`tree` 形状 OK、`registry` 对着真注册表 5497 行装配 23.0ms、`HARDEN OK`、`SCENARIOS: 41 steps, 0 failed`、`takeover` 全断言 66.5s（推理 POST 1、元数据非 POST 1）、审批 `VERDICT: B`（挂起 ≥90001ms，审计 `start=1 done=0`）、`obtain` PASS（钉表十个 asset 全 HEAD）、`BOOTSTRAP OK` 46 项、`PACKAGE OK`（发布 tarball 自包含，操作者 `~/.local/bin` 前后一样）；站点 `build` + `check` 全过。
- 发版之后核了一遍远程那条路：临时 `HOME` 里 `omp install https://github.com/adam-ikari/a2mcp.git` 装到 `a2mcp@0.5.0`，起的那份是装好的而不是工作树。`initialize` 回 `{"name":"a2mcp","version":"0.5.0"}`——版本号自证那条落在这行回包上；一次 `tools/call read /etc/hostname` 回 200 拿到内容，审计落下 `start` 与 `done` 两条，`sid` 是 `initialize` 给的那个会话号。

## v0.4.0 — 名字改到机制上：a2mcp

**这一版动的只有名字：包名、入口文件、三个磁盘文件名、环境变量前缀、命令、日志前缀、`serverInfo.name` 整套换成 `a2mcp`，旧名字一处都不读。** 机制没变：传输还是 MCP Streamable HTTP `2025-11-25`，`tools/list` 还是宿主注册表逐字加上那三个 `xfer_*`，调用还是跑在活的 `Main` 会话里，还是单 Bearer token、默认回环。

旧名字里的 A2A 是隔壁那个协议。A2A 的调用单位是 intent 加 task：对端发一张 agent card，任务有自己的状态机，`contextId` 与 `taskId` 跟着走，结果可以流式回推、可以挂 webhook。这些本仓库一个都没实现，初始设计稿的非目标第一条就写着「不是 A2A/Agent2Agent 协议实现」（`docs/superpowers/specs/2026-09-10-a2a-mcp-bridge-design.md:201`）。名字说的是协议 A2A，跑的是 MCP，两边对不上。新名字讲的是实际做的事：**a2mcp**，Agent2MCP，一个 agent 的工具面通过 HTTP 交给另一个 agent 用。

- rename: **加载链那一跳先走。** 入口 `extensions/a2a-bridge.ts` → `extensions/a2mcp.ts`，`package.json` 的 `pi.extensions` 同一提交里跟上（那是宿主的加载开关）；包名 `pi-a2a-ext` → `a2mcp`，仓库 `adam-ikari/pi-a2a-ext` → `adam-ikari/a2mcp`；三个磁盘文件名跟着换：配置 `~/.omp/agent/a2mcp.json`、审计 `a2mcp.log`、安装账本 `a2mcp.installs.json`。`bun.lock` 由 `bun install` 重写，不手改。
- rename: **运行时那一跳。** 环境变量九个换前缀：用户可见的 `A2MCP_CONFIG` / `A2MCP_AUDIT` / `A2MCP_INSTALLS`，加上 `A2MCP_PROBE_REAL_MODELS` / `A2MCP_INSTALL_SPEC` / `A2MCP_BOOTSTRAP_SPEC` / `A2MCP_BOOTSTRAP_OMP_BIN` / `A2MCP_OBTAIN_TARGET` / `A2MCP_SKIP_HOST_VERSION_CHECK`。日志前缀 `[a2mcp]`；TUI 文案从「A2A bridge: http://…」换成「a2mcp listening on …」；命令 `/a2a` → `/a2mcp`（子命令 `rotate`、`token` 不变）；`initialize` 回包的 `serverInfo.name` 从 `omp-a2a-bridge` 变成 `a2mcp`；takeover 的三个内部标识一起换（source `a2mcp`、deny provider `a2mcp-deny`、拒绝文案里那句 `a2mcp takeover: …`）；临时目录前缀 `a2a-*` → `a2mcp-*`。
- 代价: **无兼容，token 直接换代。** 装着 v0.3.0 的机器上，`~/.omp/agent/a2a-bridge.json` 里那个 token 不再被读，桥在新文件名里生成一份新的，远程侧要重新抄一次 announce 或者跑 `/a2mcp`。`a2a-bridge.log` 与 `a2a-bridge.installs.json` 留在原地不动，新账本另起一代。残留的 `A2A_BRIDGE_*` 变成没人读取的普通环境变量，桥按默认路径重新生成配置。选无兼容是因为那份配置本来就要人手工抄一次，改名同时换 token 多出来的成本接近零。
- 已知边界: **插件 lock 按 `package.json:name` 记账**，装了新 URL 又没卸载旧的，机器上会同时挂着 `pi-a2a-ext` 和 `a2mcp` 两份登记：两个端口、两个 token、两条命令，两次 takeover 装载而 `TAKEOVER_SOURCE` 不同，第二次的快照盖掉第一个的影子，`restoreTakeover` 再也拿不回它认领的那个 provider 名。这轮的处理在文档层：README 与 Release 正文把 `omp plugin uninstall pi-a2a-ext` 写成前置命令，不加检测代码。「发现兄弟插件就往 stderr 打一行警告」要读宿主的 lock，是新行为，按 AGENTS.md「Don't grow a second system」得 maintainer 点头。
- test: 新增 `test/naming.test.ts`（6 项，不起宿主）。扫活表面按**形态**匹配，不 blanket ban 字符串 `a2a`：拦 `a2a-bridge`、`pi-a2a-ext`、`A2A_` 前缀、`/a2a` 命令、`a2a_` 开头的工具名；`docs/protocol.md` 把 A2A 当外部协议名比较的那句是合法用法，全文禁掉就成了撒谎。历史与生成物按路径豁免（`CHANGELOG.md`、`brain/**`、`docs/superpowers/**`、站点的 `dist` 与 `content`）；豁免表本身每一条都得被真命中一次，给了没用等于文档在骗人，那条测试红。另两条结构断言把身份钉在一处：`pi.extensions` 声明的每个路径都得存在且 `extensions/` 里不许有它没声明的文件，包名、命令名、`serverInfo.name`、协议页样例里的名字必须是同一个词。
- test: 名字在仓库里只留一处真相。`test/harness.ts` 的 `linkExtension()` 从 `package.json` 的 `pi.extensions` 读入口路径，`test/bootstrap-probe.ts` 的插件名读 `manifest.name`、安装 URL 从 README 那行 `omp install <url>` 解析。读不到就抛，不安静退化成默认值。文件名换了以后，探针一直在 seed 一个没人读的文件而所有断言照样绿，这是这轮改名要防的事，所以补了一条与文件名无关的核对：从桥自己那行 announce 里解析端口与配置路径，把 token 从那个文件读回来，跟 `/a2mcp` 的输出比对。
- docs: README 中英、`docs/protocol.md`、`docs/testing.md`、站点配置与 `scripts/bootstrap.sh`（`PLUGIN`、默认 spec、打印出来的配置路径）全部跟上。`docs/protocol.md` 开头那句自我命名重写。站点 `base` 由 `GITHUB_REPOSITORY` 推得，仓库改名即换路径，新的在 `https://adam-ikari.github.io/a2mcp/`。
- 回归（发版前在 18.12.1 上重跑的一遍）：`lint` / `tsc` 干净，`bun test` 194/194（15 文件、550 个 expect）；`tree` 形状 OK、`registry` 28 项（本机注册表 5497 行、装配 14.6ms）、`SMOKE OK`（`tools/list` 22 个）、`HARDEN OK` 34 项、`PACKAGE OK` 48 项（23 秒，含两个二进制自装 6.4 MB 与 38.4 MB）、`SCENARIOS: 41 steps, 0 failed`（40.4 秒）、`takeover` 34 项 64.6 秒（推理 POST 1、元数据非 POST 1）、审批 `VERDICT: B`（挂起 ≥90027ms，不是 `isError`，bash 审计 `start=1 done=0`）、`obtain` 31 项 PASS、`bootstrap` 28 项 `BOOTSTRAP OK`（9.1 秒）；站点 `build` + `check` 56 项全过。两处变异照做：把 `src/config.ts` 的默认文件名改错一个字母，配置那一跳红；把入口 `getTools` 里追加的三个自有工具摘掉，`install` 探针那句 `the installed copy appends the tools the bridge owns (0 of 3)` 红、脚本退出码 1。改名专属的三条实测：临时 `HOME` 里 `ls` 出来只有 `a2mcp.json` / `a2mcp.log` / `a2mcp.installs.json`，一个 `a2a` 拼写的文件都没有；`initialize` 回 `serverInfo.name == "a2mcp"`；宿主 rpc 命令表里 advertise 的是 `/a2mcp`。quick tunnel 公网那半程还是量不了，本机网络对代理域名重签 TLS，照旧只 `info:` 报告。
- 发版之后核了一遍远程那条路：临时 `HOME` 里 `omp install https://github.com/adam-ikari/a2mcp.git` 装到 `a2mcp@0.4.0`，起的那份是装好的而不是工作树软链。announce 自报 a2mcp、`initialize` 回 `{"name":"a2mcp","version":"0.4.0"}`、agent 目录里配置文件叫 `a2mcp.json` 且没有 `a2a` 拼写的文件、一次 `tools/call read` 回 200 并落下审计那两条。
- docs: 站点自有的那部分文案跟上最近两轮。首页加一张「传文件走普通 HTTP」卡：`xfer_share` 收一条宿主路径、交给 `dufs`、外面套一条 quick tunnel、回来的 URL 内嵌 basic auth 凭据，前置的两个二进制在 PATH 上不应答时按钉死的版本和归档 sha256 装进 `~/.local/bin`。「测试与核验」那张卡补上两条实测——宿主推理那一个是让宿主真连进计数 sink、零是数出来的，发布包那一个在两个二进制都缺时当场拉 6.4 MB 与 38.4 MB。协议页、测试页、变更日志页的 description 各写各的：之前那三句描述的还是改名前的桥，`xfer_*` 与 `obtain` 那套一个字没提。数字按实测填（194 单测含 6 项命名守卫、28 项真实模型注册表、34 项加固、48 项发布包、31 项外部二进制获取、34 项 deny/restore、28 项一键脚本、8 个场景），改完重跑：`bun test` 194/194、`lint` 47 文件干净、`tsc` 干净、站点 `build` + `check` 56 项全过。

## v0.3.0 — 传文件交给桥自己的三个工具，缺的外部二进制按钉值自装，机器上没有 omp 时有一条引导

**这一版对远程调用方改变的是三件事：字节不再走 JSON-RPC、桥上那个缺的 `dufs` 会自己装好、新机器多了一条把宿主也一并编上的路。** 安装方式一个字没变，仍然是 `omp install https://github.com/adam-ikari/pi-a2a-ext.git`；旧版在用的先 `omp plugin uninstall pi-a2a-ext` 再装一次即可。`initialize` 实测回 `{"name":"omp-a2a-bridge","version":"0.3.0"}`（版本号读自 `package.json`，装上去的那份就是这一行）。

- feat: **`xfer_share` / `xfer_status` / `xfer_stop` 三个桥自己的工具，`/blob` 撤掉。** 工具只交出一条路径，字节走普通 HTTP：dufs 在服务那侧，外面套一条 cloudflared quick tunnel。这三个工具由桥自己实现，因此绕开宿主的审批门——代价照 v0.2.0 那条例外一样的形状付掉：审计一条一次调用（`tool: "xfer"`），文档写清，不长出自己的沙箱。桥的原始面现在只剩 `POST /host-llm`
- feat: **PATH 上不应答的那个外部二进制，桥按钉值自己拉**（`src/obtain.ts`）。出口顺序是死的：配置里的值含 `/` 就原样用、**绝不下载**（这是「这台机器永远不许下载」的唯一出口，裸写 `"dufs"` 不是出口）→ `PATH` 上逐段找可执行文件（不起 shell、不 `which`，机器有就别抢）→ `~/.local/bin/<name>` 等于登记里桥为这一条写下的那一行才复用 → 才下载。钉的是版本加**归档** sha256（dufs 0.46.0、cloudflared 2026.10.1，各四个平台行），不请求 `latest`，不向发字节的同一台服务器要校验和，不覆盖不是桥装的文件，下载有界（64 MB / 120 秒），安装排在审计之后。发布前这一遍实测重跑到：`PATH` 上两个都不应答的宿主里，一次 `xfer_share` 把 6.4 MB 与 38.4 MB 都装进桥自己的 `HOME`（`0755`），登记两行、审计两条 `install` 且不是 `isError`，操作者真正的 `~/.local/bin` 前后一样
- feat: `scripts/bootstrap.sh`——**引导，不是第二条安装路径**。PATH 上没有 `omp` 就跑上游官方安装器（`--binary --ref v<pin>`，它自己核 sha256），已有宿主它不动（`--upgrade` 才重装）；然后执行且只执行 README 那条 git URL；最后用宿主自己的 `omp plugin doctor` 自检，脚本不重新发明判据。`--dry-run` 一个字都不写，`--uninstall` 只收登记、留着 token 与审计日志。2026-10-02 删掉 `scripts/install.sh` 那条决定没有翻面：那次错在自己维护一份模块图校验
- chore: `@oh-my-pi/pi-coding-agent` 与 `@oh-my-pi/pi-ai` 的 pin 走到 **18.12.1**（宿主自己升的，版本守卫如期红两条之后同步）。跨的四个版本里两处 breaking 实测到不了桥：18.11.3 改的是 `ui.approve()` 宿主收到可选 `session` 标签并回 `once`/`session`/`deny` 而不是布尔，而桥从不自己调 approve；18.12.1 去掉的是 `eval` 的 `display()`。宿主默认开机自更新，所以「装上时与钉值一致」不等于「一直停在钉值」
- docs: README 中英各加「机器上还没有 omp？」一段与给远程 agent 的提示词修订；`docs/testing.md` 加 `test:bootstrap`（28 项）与 `test:obtain`（31 项）两节，`test:install` 那一节补第五组；插件目录跟随 `HOME` 那张表按 18.10.4 / 18.11.0 / 18.12.1 三个宿主版本各记一次实测
- 回归（发版前在 18.12.1 上重跑的一遍）：`lint` / `tsc` 干净，`bun test` 186/186（14 文件）；`tree` 形状 OK、`registry` 28 项（本机注册表 5497 行、装配 15.3ms）、`SMOKE OK`（`tools/list` 22 个）、`HARDEN OK` 34 项、`PACKAGE OK` 48 项（含上面那次两个二进制自装）、`SCENARIOS: 41 steps, 0 failed`、`takeover` 34 项 64.4 秒（推理 POST 1、元数据 1）、审批 `VERDICT: B`（挂起 ≥90030ms，不是 `isError`）、`obtain` 31 项 PASS、`bootstrap` 28 项 `BOOTSTRAP OK`；站点 `build` + `check` 全过。quick tunnel 的公网那半程仍然量不了——本机网络对代理域名重签 TLS，这条按既有定性只 `info:` 报告


## v0.2.1 — 修：换机器装不上

**v0.2.0 在部分机器上装不上，这是唯一的必修项。** Windows 上 `omp install <git-url>` 直接失败：

```
Failed to load extension: Cannot find package '@oh-my-pi/pi-ai'
  imported from …/pi-a2a-ext/src/takeover.ts
```

- fix: **`src/takeover.ts` 与 `src/bridge.ts` 不再 import `@oh-my-pi/pi-ai`。** 一个发布出来的包是一个**复制品**——躺在 `~/.omp/plugins/node_modules/` 下，**没有自己的 `node_modules`**，所以每一个 `@oh-my-pi/*` 都得由宿主 shim 解析。而桥要的那三个 pi-ai 符号里，有两个（`api-registry`、`utils/event-stream`）**根本不在那个包的 `exports` 映射里**，只靠 `./*` 与 `./utils/*` 通配符解析——也就是说靠文件布局的运气，不靠承诺。现在这三个符号改从 `@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim` 取：那是 pi-coding-agent **显式导出**的子路径，`export * from "@oh-my-pi/pi-ai"`，而 pi-coding-agent 正是扩展为了 `pi.on(...)` 早就依赖、shim 在任何机器上必然可解析的那个包。所以现在整个包**只依赖一个宿主包**。顺带一个类型变化：`AssistantMessageEventStream` 在 shim 侧是类型而非值，改用它的工厂 `createAssistantMessageEventStream`
- test: `test:install` 加一项**跨平台**检查——走同一张 import 图，收所有非相对 specifier，要求**除了 `@oh-my-pi/pi-coding-agent` 没有第二个宿主包**。它抓的是根因而不是症状：一个只起宿主的探针在这里仍然是绿的，因为 Linux 上 shim 能解析、Windows 上不能。变异核验：把 import 退回 `@oh-my-pi/pi-ai/api-registry` → 红并点名 `@oh-my-pi/pi-ai (from src/takeover.ts)`
- test: 同一份复制品形状（`extensions/` + `src/` + `package.json`，**没有 node_modules**）实测起宿主、桥广播。本机 Linux 上这条本来就是绿的（shim 能解析），所以它是形状的证据，不是那个 bug 的守卫——守卫是上面那条静态检查
- fix: 顺带修掉 v0.2.0 自己引入的一个新失败模式。版本号改从 `package.json` 读是对的，但那次读取在**模块顶层**且不兜底，于是在 `extensions/` 直接躺在 agent 目录下、旁边没有 package.json 的布局里，一个版本号就能让整个扩展加载失败。改成读不到就报 `unknown`：**一个因为版本号而加载不起来的桥，比一个报 unknown 的桥更糟**
- 这条探针的结构性盲区值得单独记：`test:install` 一直 `omp install <工作树>`，工作树自带 `node_modules`，所以它测的一直是「软链 + 依赖齐备」这个形状，而 README 给用户的命令是 git URL，也就是「复制品 + 没有依赖」。**两者不是同一件事，而只有后者是用户执行的**。同一个坑此前已经吃过一次（`test:blob` 忘了挂扩展，本机假绿）
- 回归：`lint` / `tsc` / `bun test` 161/161；`test:registry` 28（5487 行）、`test:takeover` 34（66.4 秒）、`SMOKE OK`、`SCENARIOS 54 steps, 0 failed`、`test:install` 30 项（含新增两项）、复制品形状实测桥广播，全绿


## 2026-10-14 — 审完剩下五个探针：两条已经不会失败的检查，一条烂掉的清单

那五个探针（blob-probe 510 行、hardening 357 行、install-probe 348 行、approval-probe 209 行、smoke 175 行）此前只跑过没读过。按同一套办法看：找**发布过、但已经不可能失败**的东西。

- fix: **`test/hardening.ts` 暴露门那组的一项不可能再红**。它断言目录里没有 `a2a_file_*` 开头的工具——那是文件传输面还在时的真检查，而 `POST /blob` 取代它之后，源码里再没有代码注册这种工具。它读起来完全像在保护「桥不自带工具」，实际是一条装饰。删掉并写明这个性质现在钉在哪：`test/bridge.test.ts` 拿**相等**断言（目录列表与宿主注册表逐项相等，多一个少一个都红），而宿主探针这一层看不到宿主自己的注册表可比。hardening 35 → 34 项，六处文档跟着改
- fix: **`test/install-probe.ts` 那份手写的 `src/*.ts` 清单已经烂了**——漏了 `blob.ts` 与 `takeover.ts`，后者是整个宿主推理机制所在的模块。它们没成为覆盖漏洞（第 3 节的 import 图遍历会传递到两者），所以没有任何东西失败——这正是「看起来像覆盖、其实是一份快照」的形状。改成从工作树目录派生，那条检查从此是「src/ 下每个模块都得在包里」，不可能落后于代码
- 变异核验：把 `package.json` 的 `files[]` 收窄成只列五个文件 → 三项红（两条 spot check + 图遍历报 `src/takeover.ts, src/blob.ts` 缺失）
- docs: `test/blob-probe.ts` 的文件头还拿「省 base64 的 33% 体积」当 `/blob` 存在的主要理由，而这条 2026-10-13 已被推翻（理由换成「不会挂」，`src/blob.ts` 与两份 README 都改过，探针的头漏了）。补上：远程调用方本来就有 `bash`，`base64 -d >` 写同一个文件，所以省体积不构成必要性；一个只量字节的探针验的是较弱的那条理由
- 没动的：`approval-probe.ts` 的 A/B/C 判别、副作用文件、宿主存活与审计形状都对；`smoke.ts` 干净。审批探针那条「start 无 done」的断言这轮**变强了**——`auditStart` 现在在工具执行前落盘（上一条提交），所以 `starts === 0` 只可能在审计路径坏掉时发生，而不是碰巧还没落盘
- 回归：`lint` / `tsc` / `bun test` 160/160；`test:hardening` 34 项、`test:install` 28 项（含新派生清单 8 个模块）、`test:blob`、站点 56 项全绿

## 2026-10-14 — 别的扩展占着被声明的名字这一档，定成有意不修

上一条讨论到「别的扩展的运行时状态要不回来」时，本打算补一档探针把这条残余钉成事实。操作者判掉：不补。

理由是它只在一种安装下发生——别的扩展接管了宿主自带的 `anthropic` 或 `openai-codex`——而那不是桥能解决的局面；桥能做的已经做了（restore 时按 `(id, api)` 核回来、没回来就在宿主日志里点名、要重启才恢复）。探针里 `myprov rows 2 -> 2` 那一项覆盖的是常见情形：扩展占着**没被声明**的名字，桥根本不碰它，73 个名字里 71 个属于这一档。

所以代码里那段措辞从「待修的残余」改成「范围决定」，并写明为什么不为它加探针——否则下一个读到注释的人会以为还欠着一项。

## 2026-10-14 — 最后那条覆盖缺口：ACP 那条路也堵死了，而且是量出来的

「重建后的 Main 会话」这项覆盖一直挂着，理由是 rpc 的 `new_session` 不重建会话（`AgentSession.newSession()` 保留同一个对象与监听器，等于 `/clear`），而 `session_start` 的三个发射点里 rpc 对 Main 一个都不暴露。但 `acp-agent.ts:2662` 是真实发射点，看起来能在同一个进程里既重建会话又带着桥——这个角度之前没试过。试了：

- 起 `omp --mode acp`，临时 HOME、`host_llm: deny`、配置与其它探针同形。ACP 的 `initialize` 有正常应答（`protocolVersion: 1`，`agentInfo.version 18.8.7`），协议这侧没问题
- **扩展没有被加载**：stderr 里一次都没提到 extension，进程一个端口都没在听（`ss -ltnp` 按 pid 查为空），`/a2a` 连不上。也就是说 ACP 模式不读 `~/.omp/agent/extensions/`，那个发射点对桥不可达

两条路都试过之后结论才成立：这项覆盖的阻塞不在桥这一侧，而在宿主没有为 Main 暴露重建口，要它得宿主加一个 rpc 或 ACP 钩子。测试页那节记下了这次实测，免得下次再当成一条没试过的路。进程内的 stood-in（第二个真实 `ModelRegistry`）继续算数——重建的实质就是「同一份配置上一个全新的注册表」。

## 2026-10-14 — 审计记录曾经跑在响应后面，那条 flake 的真身

上一条记的那个「十次里红两次、复现不了、没修」的现象，这轮找到了真身，而且它不在测试里：**响应会跑在审计记录前面**。`appendLine` 把行交给进程内一条队列就返回，调用方不等它，于是 `tools/call` 的 200、`POST /blob` 的 200、`/host-llm` 的 200 都有可能先于自己那行到达磁盘。注释里写着「fire-and-forget 是设计」，但这条设计没买到任何东西——队列本来就从不 reject，所以它并没有为调用方挡掉任何失败，只挡掉了「慢盘上响应等一会儿」。

代价是三处，各有各的坏：

- **调用方拿到 200 再读日志，读不到自己这次调用。** `test:scenario` 第 2 项那五步正是紧跟着响应读审计文件的，它红过两次、每次两项（`audit has a done record` 与 `the two phases pair by id`），因为只有磁盘慢到队列排得上时才看得见。
- **那个证据设计本身是假的。** `audit.ts` 写明「`start` 在派发时落盘，所以永不结算的调用会留下 `start` 而无 `done`」。不等队列，工具的副作用就可能先落地——在调用中途崩掉，那个窗口里**什么痕迹都不留**，而不是留下不完整的一份。
- **`/blob` 的唯一痕迹比响应晚。** 那个端点不过审批门，审计就是它全部的追溯手段，一个跑赢自己痕迹的 200 比文档声称的补偿控制弱。

- fix: 四个入口（`auditStart` / `auditDone` / `auditBlob` / `auditHostLlm`）返回队列尾部，调用处在应答前 await。队列仍从不 reject，所以「审计不能让调用失败」不变。实测每条约 **99 µs**（`stat` + `appendFile` + `chmod`，串行，2000 行实测），对着一次 bash 调用可忽略；慢盘推迟的是响应，不是记录。启动那条（`a2a-bridge.ts` 的装配拒绝）没有请求可等，显式 `void`
- test: 单测 `the audit functions hand back the queue tail`。**分两半，因为行为那半只能在慢盘上看出来**：快盘上两种形状长得一模一样，这正是它当那么久 flake 的原因。所以「await 回来记录就在盘上」直接断言（读的时候不带任何等待），确定性那半钉住四个入口都返回 `Promise`——谁把签名改回 `void` 立刻红，不涉及时序
- test: `audit.test.ts` 三处「轮询等落盘」换成确定 await（轮转块、并发轮转竞态、两处记录查找）。那个轮转块从 200 ms+ 的 sleep 轮询变成一次 await，**217 ms → 单测整块 11 ms**。顺带把被改动掏空的两处断言补实：`expect(() => auditStart(dead)).not.toThrow()` 在返回 promise 的函数上什么都证明不了，现在断言的是 resolve
- 变异核验（同一块代码，两个方向）：队列里加 30 ms 模拟慢盘 + 去掉 `bridge.ts` 里的 await（旧形状）→ `SCENARIOS: 54 steps, 2 failed`，红的两项与实况观察到的完全一致；只把 await 放回去、磁盘照样慢 30 ms → 全绿。另外把四个入口退回 `void` → 单测立刻红，且顺带把行为那半也咬到（`none-1` 真的不在盘上）
- 回归：`lint` / `tsc` / `bun test` 160/160（新增 1 项）；`test:blob`（`/blob` 现在等五个出口的审计）、`test:hardening`（含第 9b 组审计检查）、`test:scenario` 连跑三遍全绿
- docs: 协议页与两份 README 补上「记录先于响应落盘」这条约定与其 99 µs 实测；内存表按本轮 `test:blob` 重写的 json 刷新（第二十九轮：空闲 476、单个 +19、并发安顿 +91 峰值 +128）

## 2026-10-13 — 场景核验里有一项检查读的是它自己写的那个文件

「配置改了要重启才生效」这个场景里有一项检查写成 `tk2 === nextToken`，而 `tk2` 是从配置文件读回来的——那个文件正是这个场景自己几行之前写进去的。于是这一步在拿自己的写入和自己的读出比对，标签却写着「重启后的宿主从磁盘读到了改过的 token」。它碰巧能抓到一个真 bug（启动时重新生成 token 的宿主会把那个文件改掉，比对就失败），所以一直没被发现，但那是运气，不是这条检查的职责。

- fix: 换成从服务端拿证据。新步骤是在**同一个会话**上，用改前的 token 去 ping，必须拿到 401。这才是「重启之后编辑生效了」的直接证据。`handshake()` 多一个可选 token 参数，场景里不再从磁盘读自己写的东西
- 顺带记一笔我自己写出来的第二个洞：第一版把状态码写成 `401 || 400`（照抄了场景里另一处「需要重新握手」的宽松条件）。而这里的 400 意思是「还没有会话」，是错的通过理由。变异 B——让重启拿到改之前的配置——就是靠这个 400 混过去的：旧 token 本来就是有效的，ping 返回 200/400 都不是 401。收紧成只认 401 之后，同一个变异让两项都变红
- 变异核验：配置里的 token 一律忽略、每次重新生成 → 「改过的 token 被接受」红（401）；重启时拿到改之前的配置 → 两项都红。另外两项旧步骤的断言（运行中的服务端仍认旧 token、改过的 token 未被采纳 → 401）在这两个变异下都保持绿，说明它们各自守的是另一半
- 一处没查出来的：`test:scenario` 在十次左右跑里有两次各红两项，之后连续七次全绿，也确认没有探针遗留的宿主进程。失败时那次的步骤名没截到，所以不知道是哪两项；嫌疑是审计日志的读取和宿主的 JSONL 落盘在赛跑（审计那两项断言读的是刚返回的调用之后的文件）。失败时探针本来就会留证据（`evidence kept at /tmp/a2a-scen-*`），下次复现从那里查。这条**没有修**，只是记下来
- 回归：`lint` / `tsc` / `bun test` 159/159；`test:scenario` 54 步 0 失败

## 2026-10-13 — 仓库里提交了一个指向仓库根的符号链接，而且守卫不能放进 `bun test`

`hidden-plugin` 是一个被 git 跟踪的符号链接（mode 120000），目标是 `/home/gem/project/pi_a2a_ext`——装着它自己的那个目录。它是 `59a5e60`（也就是加 `harness.linkExtension()` 那次）里一次 `git add -A` 扫进去的调试残留，所以 `git status` 一直干净，全部核验一直绿。三条后果都没有任何东西看得见：`find -L .` 直接回答 "File system loop detected; './hidden-plugin' is part of the same file system loop as '.'"，凡是跟随符号链接的工具（索引器、`rg --follow`、`du -L`、爬虫）都在走环；仓库里存着某台机器的绝对路径，别人 clone 下来拿到的是**他**机器上那个路径上的东西；而 `files: ["extensions/", "src/"]` 把它挡在 npm 包外面，这是它从没有到用户手里的唯一原因——打包的巧合，不是决定。

- fix: 删掉那个链接
- test: `test:tree`，3 项，**不放在 `bun test` 里**。变异的时候才发现这条要命：把守卫写成 `test/*.test.ts` 之后，自环一存在，runner 爬目录撞上自己，`bun test test/tree.test.ts` 跑 10.3 秒、98% CPU、exit 1、只打出 48 字节——没有测试名，没有断言。**坏的树形状不是让某个检查变红，是把证据删掉**，所以守卫放在最需要它的那一次自己就死了。它独立进程跑，CI 里排在 `bun install` 和 `bun test` 前面，无依赖、不需要宿主
- 规则不是「不许有符号链接」。`.claude/skills/design-doc-mermaid -> ../../.agents/skills/design-doc-mermaid` 是被跟踪的、相对的、在仓库内，那是 skill 管理器的产物，禁掉它就是禁掉仓库自己的约定。所以拆成三条子句，各有各的失败：绝对目标（不可移植，且正是那次成环的形状）、解析出仓库（别的机器上悬空）、解析到自己的祖先（按定义就是环）
- 第一版守卫把 `.agents` / `.claude` / `.qoder` 放进了跳过表，等于不看题面所在的目录：它连唯一那个合法链接都没看见，旁边再放一个坏链接同样看不见，而探针报告「0 个链接，干净」。跳过表盖住被检查对象，就是这个仓库反复在付的那笔学费
- 六个变异全红：绝对指回仓库根、相对 `..`、相对 `.`（目标就是仓库根——第一版的祖先判断漏了这一条，靠它补上的）、逃出仓库、仓库内悬空、以及**已跟踪但本地已删**（链接文本从 git index 读，walk 只看得见当前这份工作树）
- 顺手改掉几处手写计数：三处文档里 `bun test` 还写着 157（实为 159），两份 README 里 `test:registry` 还写着 22 项（实为 28）。这些数是跑出来的，不该信文档里的；本次全部按实跑重落
- 回归：`lint` / `tsc` / `bun test` 159/159；`test:registry` 28 项、`test:tree` 3 项、站点 `render-check` 56 项全过

## 2026-10-13 — 网站侧：三处发布过的坑没有守卫，补上，其中一处是真 bug

剩下唯一没看过的边界。按「发布过的东西要有人看着」查 `website/scripts/`，找到三条**这个仓库真踩过**的坑，而现在的 `render-check.mjs` 一条都看不见：sitemap 的 `lastmod` 曾取构建产物 mtime（等于宣称每页每次部署都变，搜索引擎直接忽略）、robots.txt 与 sitemap 的 origin 各推一遍（漂了没人知道）、`withMermaid` 曾把 mermaid 静态注入 entry 让每个页面首屏阻塞预载 1.58 MB。三条都不报错、不影响构建，评审里看不出来。

- fix: **首页的 lastmod 来自错的源文件**（新守卫当场抓到的真 bug）。`collect()` 把 `index.html` 的 `index` 后缀去掉，于是首页的 page 名是空串，`SOURCE_OF.index` 从来没被命中过——那段是死代码，首页落到「无源文件」的兜底，lastmod 变成**仓库最新一次提交**的日期而不是 `README_ZN.md` 的日期。两者同一天时看不出来，所以一直没被发现。修在 `sourceOf()` 里把空串归一为 `index`
- test: `render-check.mjs` 加三组守卫（34 → 56 项）。**首屏阻塞预载预算**：把每页 modulepreload 指向的产物实际大小加起来（实测 3.1KB / 1.1KB，预算 64KB——当前值的 20 倍、那次回归的 1/25），这是 1.58 MB 事件唯一的证人，因为图照样画得出来、标签照样齐。**robots 与 sitemap 同源**：robots.txt 是构建时写的（仓库搬家不留硬编码），origin 被推了两遍，漂了要在这里才看得见。**sitemap 的 lastmod**：每页比对源文件最后一次提交日期，外加两条反空转——每个页面必须映射到一个真实存在的源文件、git 可用时至少要真比对上一条，否则一个坏掉的 URL→页面名解析会让整组检查「全过且什么都没验」（第一版就栽在这，页面名解析成了 `http://localhost:5173/changelog`）
- refactor: 页面→源文件的映射抽成 `website/scripts/sources.mjs`，sitemap.mjs 与 render-check.mjs 共用一份。原先它在 sitemap.mjs 里自带一份，而现在检查要按同一份映射核对——抄两遍正是这个仓库吃过亏的形状（`/a2a rotate`、插件字段各有过一次），而且备份里少改一处不会有任何东西失败
- 三项变异核验：lastmod 回到构建当天 → 红三项（两个 superpowers 页 + 「只有一个日期」那条）；robots 改成相对路径 → 红 robots 那一项；把 mermaid 静态引入 entry **并**去掉 `shouldPreload` 的 `/chunks/` 过滤 → 预载 905.9KB，两页都红。前两次变异没生效，记一笔：第一版把 `defineAsyncComponent(() => import(...))` 改成 `(await import(...)).default`，那**仍然是动态导入**，Vite 照样分包，预算当然不动；第二版只静态引入组件，mermaid 库仍被 `shouldPreload` 挡在预载之外。**要复现那次回归得同时拆掉两半防御**——这本身就是结论：现在有两道独立的闸（懒注册 + 预载过滤），预算那条是兜底
- 回归：`lint` / `tsc` / `bun test` 159/159；站点构建 + `render-check` 56 项全过

## 2026-10-13 — 「桥自己从不请求模型」这句在默认配置下补上守卫

按需求的第一个子句回头查：这个断言此前只在 `host_llm: "deny"` 下被量过——而那是宿主本来就不该推理的配置。默认配置下没有任何东西在数：harness 播种的 provider 故意不可达，请求过去静默失败、数不出缺席，正是当初造计数 sink 要补的那个盲区，只不过这次在开关的另一侧。

`test:takeover` 末尾加一段：把开关恢复成 allow，在一个安静窗口里走 `tools/list` + 一次 `read` + 一次 `bash`，断言 sink 的推理 POST 计数不变（实测 `1 -> 1`），并把同窗口的宿主元数据流量（non-POST）一并打印。探针 32 → 34 项。

变异核验按仓库规矩做了两轮，第一轮**绿了而结论是假的**：让桥在第一次调用时问一次模型，没有被数到——因为那个 mutation 自带一个「只问一次」的守卫，触发点落在探针最开始那次 `read`，早在我量的窗口之外。去掉守卫改成每次调用都问，才红：`inference posts 1 -> 3`（三通里 `tools/list` 不走 `runHost`，所以是两个而不是三个）。**探针变绿时先怀疑 mutation 自己。**

口径写进测试页：这一段量的是「桥处理远程调用时不推理」，不是「工具不推理」——`tools/call task` 确实会推理，那是上面 deny 那几段量的东西，不是这个窗口。

## 2026-10-13 — `/blob` 留下的理由换掉了：撑不住的那个换成撑得住的

按「桥是接口转换器，远程 agent 要的是这台机器的手」这句话回头查仓库，只有一处不对齐，而且是**理由**不对齐：README「传文件」与 `src/blob.ts` 的文件头都拿「省 base64 的 33% 体积」当 `POST /blob` 存在的理由。可远程 agent 本来就有 `bash`，`base64 -d >` 与 `dd` 都能写——按那个理由，这个端点是多余的。

撑得住的理由仓库里已经有，只是没写在这两处：宿主自己的写入工具（`write`、`edit`）与 `bash` 都过审批门，而审批配成 `prompt`、调用方无交互 UI 时那道门**永远等不到应答**（审批核验每轮实测挂起 ≥90s，预期 `VERDICT: B`）。无头远程调用方在那种配置下唯一不会挂的写入路径就是 `/blob`——它不过审批门，在那个场景里正是它存在的理由，不是顺带挨上的缺陷。所以 `POST /blob` 保留（决定记在这里），理由改成这一条，省体积降为第二层理由。

同步落四处：README 中英「传文件」/「Moving files」、协议页「原始字节上传」、`src/blob.ts` 文件头（`## Why this exists` 以「Because it does not hang」起头、编码在后）、AGENTS.md 的「已记录的例外」那条（顺便把 host-llm 那条的描述更新到现在的保证与残差）。站点首页那张卡的文案同样以「不会挂」起头。代价一条没减：不过审批门、桥自己解析路径、能写宿主能写的任何路径，仍按原样记在「安全与边界」。

## 2026-10-13 — 评审：接管不再抢 provider 声明、装配改成事务，第八核验把接管架在真实注册表上

评审用探针打，不是读出来的。两个 P1 与两个 P2 都在 138 个单测全绿、代码也全绿的状态下成立，根因都在宿主的数据结构里。缺的那一档探针这次补上：`bun run test:registry`（新增，22 项，秒级，不需要 omp 也不需要凭据）把接管直接架在**真实** `ModelRegistry` 上跑——`AuthStorage.create` 加 `new ModelRegistry(...)` 对着 `/tmp` 的临时 agent 目录，18.8.7 上是 5457 行、七十多个 provider，不起宿主、不开 TUI、不连网。下面几条都是它在同一轮里量出来的。

- fix: **抢走别人的 provider，而且不还。** 宿主的 `registerProvider(name, …, sourceId)` 会把 `sourceId` 记成这个名字的所有者，别人已经拥有时先把在位者的运行期状态清掉再接管；而公开 API 里唯一的撤销 `clearSourceRegistrations` 是「这个扩展卸载了」，不是「撤销那一次调用」。旧机制把目录里 73 个 provider 全影子化，等于删掉别的扩展注册过的每一个 provider，一次装配删一次、永不恢复。实测：另一个 source 注册的两行 provider，一次 arm/restore 之后变成零行。修法不是想办法还回去（公开面做不到），是**不抢**：判据改成「每条推理请求最后从哪个口出去」，只有不是 fetch 的道才声明 provider 名字。读宿主源码定出两条——cowork 道（`anthropic` + `anthropic-messages` 时宿主换 `node:https` 直连，`pi-ai/src/utils/transport-fetch.ts`）和 Codex 的 websocket 道（`api: openai-codex-responses`，且宿主把 `providers.openaiWebsockets` 逐次转发给 provider 调用，所以按 api 判而不是按行上的标志判）。默认装法下声明 2 个而不是 73 个，装配耗时 288ms → 16ms（不再重算整份目录）
- fix: deny 的第一层从「影子化 provider」换成 **deny api + 宿主 agent 手里那一行的 deny 副本**（`registerCustomApi` + `agent.setModel`，deny 副本不带 `resolveHeaders`，否则 pi-ai 在 api 分派之前会先跑 provider 的 `!command` 取密钥程序）。子代理那条旁路不再靠崩溃封死——它自建注册表、自选模型，请求在 fetch 边界被拒，一次本地拒绝，不出网，协议页与测试页那两处「以 `Unhandled API in mapOptionsForApi` 退出」照实改掉
- fix: **装配途中抛错留下「已全量拒绝但报 enabled」的死局。** 旧顺序是「注册影子 → 推模型行 → 压设置 override → 换 fetch → 最后才记 `armed`」，1-4 步任何一步抛错，残局已改完而 `restoreTakeover` 第一行 `if (!armed) return` 空转。实测：抛错后 5457 行全部处于 deny，端点对「恢复」的回答是 `{"enabled": true}` 且救不回来，只有重启宿主能了事（第一次写探针时根本没打算触发它，`Settings.init()` 没调、`setting.override` 自己抛了，同一个洞自己撞上来）。修法是把记录提到第一次改动之前，抛错时整体回滚再把错误抛出去
- fix: **宿主自己的扩展源对账会把影子剪掉，桥还报 deny。** 合成 source id 会进 `#registeredProviderSources`，而 `createAgentSessionScoped` 每次建 session 都跑 `syncExtensionSources(扩展路径表)`，路径表里没有 `a2a-bridge`——它被当成已卸载的扩展剪掉。实测：一次调用之后 deny 行从 5457 变 0，而 `enabled` 仍读 `false`，只剩绊线一层，正好是「绕过 `globalThis.fetch` 的那几条道」需要影子兜底的那些。修法两条：装配改成幂等（重装保留第一次存下的那一行，不会恢复出一个 deny 副本），入口在**开关开着时**每次 `session_start` 都重装，不再只看配置值
- fix: **恢复会抹掉接管期间宿主换模型的选择。** 旧恢复无条件把快照那行推回去；现在只在 agent 手里仍是桥的 deny 行时才推回去——被换成真行也没用，它落在绊线上，但那是操作员的选择，不是桥该抹掉的状态
- fix: 恢复不再假设撤销一定干净：拿快照逐个核对被声明的 provider，没回来的在宿主 stderr 点名（`takeover restore left N provider(s) unregistered … restart the host to recover`），README 中英的故障排查各加一条。这是公开 API 做不到的那一半，能做的是不装懂
- fix: `applyTakeover` 的拒绝规则从「见到 `transport` 就拒」收到「见到**不在被声明名单里**的 provider 带 `transport` 就拒」——被声明的 provider 整份行都被换成不带 transport 的 overlay，没有东西可短路。同时 `transport` 这条从只认 `pi-native` 变成认任何在 api 分派之前短路的 transport
- fix: `/blob` 的两条 409（offset 与当前大小不符、上传途中文件被别人改了）此前一个字节没写、审计里也一个字没有，而分块上传时 offset 漂掉正是最常见的失败，审计里因此留着一段和「什么都没发生」分不开的空洞。现在两条都按失败写（`bytes: 0` + `error`），五条出口口径一致
- fix: 审计日志补 `chmod 0600`——`appendFile` 的 `mode` 只在创建时生效，从备份恢复或手工建出来的日志会一直宽权限读到进程结束。配置那边早就为同一件事写了 chmod（`src/config.ts`），这边补上
- fix: 启动时（配置就是 `deny`）装配被拒此前只有一条会滚走的界面提示，现在 stderr 一行 + 一条 `sid: null` 的 `host_llm` 审计记录——那台机器本来配了 deny、现在没有，这件事此后仍然查得到
- fix: `tools/call` 的执行器不再钉死在第一次 `session_start` 那个 `ExtensionContext` 上（会话重建后 `ui`/`abort`/`isIdle`/`hasPendingMessages` 全部来自已经死掉的会话，死会话的 abort 信号是已 aborted 的，于是新会话里每个远程工具调用一进门就失败）。入口每次 `session_start` 换一个执行器，服务器读到的是活的。宿主自己在 `runner.ts` 写过同一句话的注记：「a saved context must not retain a completed handler's stale signal」
- test: 单测 138 → 157（10 → 12 文件）。新建 `test/takeover-arm.test.ts`（7 项）盯装配这个事务：推进 deny 行、deny api 注册与注销、fetch 换回、中途抛错三样都不残留、`enabled` 读回 true、重装保留第一次存下的行、接管期间的模型选择不被抹掉、换 session 时先恢复旧的、未覆盖的道在改动任何状态之前就被拒。三项变异各红各名（把 `armed` 赋值挪回末尾 → 只有回滚那条红；去掉「已持 deny 行」的判断 → 只有重装那条红；恢复改成无条件推回 → 只有模型选择那条红）
- test: `test/takeover.test.ts` 补 12 项纯函数层：非 fetch 道的判定（cowork 与 websocket 两条，含「websocket 按 api 判而不是按行标志判」这条）、`transport` 拒绝在「声明名单内/外」的两种结果、deny 副本保留身份字段而摘掉凭据解析器、声明 provider 时整份行一起进 overlay
- test: 新增 `test:registry`（22 项，秒级，CI 的 `check` job 收——它不需要 omp，也不该占 `host-probes` 的分钟数）。变异核验：把声明面改回「每个 provider 都声明」，本探针红 5 项，决定性的一项是 `myprov rows 2 -> 0`。写它的时候顺手现形两件不是探针毛病的事：默认目录里有一条 `preferWebsockets: true` 的 Codex 行，所以「碰到 websocket 行就拒绝装配」会让 deny 在开箱状态下根本装不上；deny 副本必须摘掉 `resolveHeaders`，否则被拒的一轮会先去跑取密钥程序
- test: `test/takeover-probe.ts` 两处随机制改：pi-native 那条的拒绝文案（`transport 'pi-native'` 而非 `pi-native transport`，探针的匹配跟着改，否则它会红）；task 旁路那条的注记改成现在真实的死法
- docs: README 中英「宿主推理接管」整节重写（三层分工按「请求从哪个口出去」划、为什么不全量影子化、恢复核对与点名、启动拒绝的三处留痕）；协议页「宿主推理切换」同步，含「装配途中抛错整体回滚」一段与「它放弃了什么」重排（新条目：provider 所有权抢不回来、恢复不抹掉模型选择）；testing 页加 `test:registry` 一节与总览表两行；故障排查中英各加/改两条；开发计数与文件布局说明同步
- 回归：`lint` / `tsc` / `bun test` 157/157；八个核验在 18.8.7 上全绿——`test:registry` 22 项（5457 行、装配 14–24ms）、`test:takeover` 28 项 64.2 秒（装例行实测 2 providers / 69 keys；子代理那条旁路现在是被绊线按下去而不是崩掉，拒绝计数 2 → 3，sink 命中不变）、`SMOKE OK` 21 tools、`HARDEN OK` 35 项、`BLOB OK` 35 项、`SCENARIOS 54 steps, 0 failed`、`PACKAGE OK`、审批 `VERDICT: B` 挂起 90002ms；站点构建 + 渲染核验 34 项全过

## 2026-10-13 — E2E 重跑：探针的 sink 改成声明道，顺带修掉它抓出来的两处

`test:takeover` 的 sink provider 原来叫 `a2a-takeover-sink`，而 cowork 道按 **provider 名**判，所以它是未声明路径——上一节改的那半边（声明 provider、恢复时把它们放回去）在真实宿主上一次都没跑过，只由 `test:registry` 在进程内覆盖。sink 改名 `anthropic`（`api: anthropic-messages`，baseUrl 指着 sink）之后声明道真的跑起来了，并立刻暴露三件事，其中两件是代码缺陷。

- fix: **幂等重装会忘掉自己持有的声明。** 声明集是重装时从快照重算的，而同一会话的重装读到的快照正是它自己的影子——那些行带着 deny api，不匹配任何道，于是「无需声明」，装例行报 0，恢复后的核对也检查一个空集。声明本身还活着（注册还在），但账本丢了：从下一次装配起声明静默降级成只剩绊线，而那正是文档里列为残差的那几条道。改成重装时把已有的声明并进来（按 id 去重，否则 overlay 会把同一个模型列两遍）。实测修前 `shadowed per arm: 2, 0, 2`，修后 `2, 2, 2`
- fix: **恢复后的核对读的是缓存快照，等于没核对。** 它比对 provider/id，而「撤销没生效」这个形状恰好是 id 全在、api 还在 `a2a-deny`——读起来像恢复了。更要紧的是它调 `getAll`，而 `getAll` 答的是注册表上次合成的那份目录快照，能反映「跳过撤销」的合成恰恰是撤销本身触发的那次。改成按 (id, api) 配对、并走 `getProviderModels`（按 provider 现合成，能看见活着的影子）。变异核验：拿掉 `clearSourceRegistrations` → 探针红并点名 `anthropic, openai-codex`
- fix: **sink 数的是到达网络的一切请求，而接管承诺的是零推理请求。** sink 改名 `anthropic` 之后宿主自己的目录刷新也往同一个 baseUrl 发 GET，那条流量走注册表捕获的 fetch，既不在 deny 里也不在绊线里（设计如此，非推理出口不拦），于是 deny 窗口里出现一次 metadata GET，症状与「推理漏出去了」一模一样。计数按方法分开：POST 是断言对象，非 POST 单独计数并在收尾行打印。**探针量到的比它承诺的多，是这类改动最容易埋的假阳性**
- test: `test:takeover` 加两项断言，都是「撤销声明真的发生了」的外部可见证据。原先那条「恢复后轮次打到 sink」证明不了它——agent 自己那行是单独恢复的、绊线也撤了，拿掉撤销声明这一步照样绿（实测）。能证的两条：桥自己的恢复后核对不报 `takeover restore left`；下一次装配仍声明得到那两个 provider。加完 28 → 30 项。sink 改名之后 rpc 取的是第一条配置行而不是 `settings.yml` 的 `model:`（自定义模型与内置目录合并，`claude-opus-5-5` 排前面），断言因此盯 provider 不盯 model id
- 回归：八个核验在 18.8.7 上全绿，`test:takeover` 连跑三遍（30/30，62.7–63.6 秒，每遍 `shadowed per arm: 2, 2, 2`、`inference posts=1 metadata non-POSTs=1`），`lint` / `tsc` / `bun test` 157/157，`test:registry` 22 项，站点构建 + 渲染核验 34 项。内存表按第二十七轮重落（空闲 482、单个安顿 +22、并发 +38）

## 2026-10-13 — 剩下三件：降级状态、文档措辞、装例行点名声明了谁

上一节收尾时列的三件，按「会不会真咬到操作员」的顺序修完。

- fix: **降级状态：开关开着而当前会话没被 deny，状态栏此前说的是 deny。** `armed` 记的是旧会话，重建后的新会话装配被拒时它还指着旧的，于是 `/a2a` 与 `POST /host-llm` 回包都报 deny，而新会话上只有进程级的绊线——两条非 fetch 道（cowork 的 `node:https`、codex 的 websocket）是裸的。加 `degraded` 位：回包带 `degraded: true`，`/a2a` 显示 `deny (tripwire only)`，stderr 与审计那一行也写明「开关仍开着，这个会话只有绊线」。首轮装配被拒不动（那时什么都没装，`enabled: true` 本来就是诚实的读数）
- fix: **拒绝检查与恢复旧会话的次序——stub 写这条测试时现形的更糟一版。** 原顺序是「先恢复旧会话再检查新会话的目录」，于是重装被拒时会在失败的路上把进程级绊线一起拆掉：操作员要 deny 得到的连绊线都没有，而且 `enabled` 读回 true，与配置写着 deny 矛盾。改成先检查再恢复，拒绝时保住还值得有的那层，并如实标成 degraded
- fix: 装例行把声明的 provider 名字打出来（`2 provider(s) shadowed (anthropic, openai-codex), …`）。声明是把名字从原主人手里拿走、注册表还不回去，操作员看得见的只有这一行；探针也靠它才分得清声明表第二条那条 websocket 道在不在——数量不行，两种声明同样都报 2
- docs: 残差措辞按实测改。原文写「绊线只按推理端点取键」，读起来会以为键内的主机一定被拒，而实测不是：注册表在构造时捕获自己的 fetch，宿主的目录与元数据 GET 到 provider 自己的 baseUrl 出得去，**那个主机名就在键里**（探针每轮 sink 收到一次非 POST，收尾行分开打印）。协议页、README 中英、模块头三处同步，并新增「不走 `globalThis.fetch` 的请求桥管不着」这条残差。`{enabled, denied}` 的响应形状加 `degraded` 一并写进协议页与 README
- test: `test/takeover-arm.test.ts` 加两条（8 项）：拒绝发生在开关开着时读出 degraded、恢复后清掉；装例行点名了声明的 provider。两项变异各红各名——去掉 `degraded = true`、把恢复挪回拒绝检查之前，各红「降级」那一条。`test:takeover` 加两项（32 项）：装例行点名里同时有 cowork 与 websocket 两个 provider；本轮没有一次装配留下 degraded
- fix: `TakeoverDeps` 的返回类型此前只声明 `{enabled, denied}`，而端点把 takeover 的状态整个回传当响应体——协议页写了三个字段，类型只承认两个，正是这类签名落后于实现的漂移。改成 `import type { HostLlmState }`，改完 `tsc` 当场把 `test/host-llm-route.test.ts` 的桩揪出来（桩少 `degraded`），桩与那条 `toEqual` 断言一起补齐。端点那条断言继续用精确相等，钉的是操作员实际读到的那份形状
- test: **上一轮给在途 409 加的那行 `auditBlob` 此前零覆盖**——单测只有前置 409，探针也没有（`test:blob` 里那些 "in flight" 都是 RSS 采样，与它无关），而 CHANGELOG 里「五条出口口径一致」正是拿它当依据。补法：直接调 `handleBlob`，`Request` 桩的 `arrayBuffer` 由测试自己开门——那个 await 落在前置 `stat` 之后，所以在里面追加就是确定性地命中「stat 与 open 之间文件被别人改了」这个窗口，不用靠运气。单测 158 → 159。变异核验：拿掉那行 `auditBlob` → 只有新加的这条红
- test: **「重建后的会话」这条路在宿主探针里驱动不了，改由注册表探针 stood in for。** 试过用 rpc 的 `new_session`：`AgentSession.newSession()` 保留同一个会话对象与监听器（`agent-session.ts:9659` 的注释是 "Listeners are preserved"），只清空消息，等于 `/clear`，不发 `session_start`；而 `session_start` 全宿主只有三个发射点（`runtime-init.ts:212` 建会话、`acp-agent.ts:2662` ACP 挂载、交互式 UI），rpc 对 Main 一个都不暴露。于是 `test:registry` 加一段：第二个真实 `ModelRegistry`（同一份配置，revive 与 ACP 挂载带来的就是它）接走 deny——新注册表被声明 35 行、旧的拿回自己的行、agent 那一行跟着会话走、一次被拒的请求只计一次（绊线没有层层包住自己）、恢复之后新注册表也拿回自己的行。22 → 28 项。变异核验：换会话时不把旧的还回去 → 红两项
- test: 顺带记下一条**仍然没有覆盖**的：降级状态在真实宿主上验不了，它需要「开关开着 + 换主会话 + 新目录里有拦不住的道」，而换主会话这一步上面刚证明驱动不了。降级的覆盖留在 `test/takeover-arm.test.ts` 的 stub session 上（三项各有变异），测试页把这条写进「为什么只能在进程内验」那一段
- 回归：`lint` / `tsc` / `bun test` 159/159；`test:takeover` 32 项、`test:registry` 28 项、`test:blob` 35 项在 18.8.7 上全绿（内存表按第二十八轮重落：空闲 484、单个 +17、并发 +44，峰值与安顿两项相等），站点构建 + 渲染核验 34 项

## v0.1.0 — 首次发布

这个扩展在宿主 `session_start` 时起一个 MCP 服务器（`2025-11-25`，Streamable HTTP，默认只绑 `127.0.0.1`），把宿主会话里的工具暴露给远程 MCP 客户端。执行落在宿主真实的文件与 shell 上，桥自己从不请求模型（宿主侧会话级副作用与接管开关见 2026-10-12 两节）。

- **安装**：`omp install https://github.com/adam-ikari/pi-a2a-ext.git`。只这一条路，不发 npm
- **`tools/list`** 返回宿主注册表，原样透传，不过滤
- **`tools/call`** 走宿主 `Main` 会话的 `getToolByName(name).execute()`，注入真实的 `session.settings` 与 `ExtensionContext ui`，所以宿主审批门照常生效
- **`POST /blob`** 收原始字节（上传专用）。100 MB 镜像一次请求传完，实测字节一致。不经宿主审批门、桥自己解释路径——这两条代价写在 README「安全与边界」与协议页里
- **审计**：每次远程调用写两条 JSONL（`start`/`done` 配对），`/blob` 写入记 `blob:write`
- 核验：54 单测 / 19 blob / 29 hardening / 28 install / smoke / approval，另有站点的 34 项渲染与 SEO 核验

下面各节按日期倒序，含 v0.1.0 之后的演进。

## v0.2.0 — 宿主推理接管（`POST /host-llm`）

- **安装**：同 v0.1.0，`omp install https://github.com/adam-ikari/pi-a2a-ext.git`。**不发 npm**（包名在 registry 上也从未被占用过）
- **`tools/list`** 返回宿主注册表，原样透传，不过滤；`tools/call` 仍走宿主 `Main` 会话
- **`POST /host-llm`**（`{"enabled": bool}`）：把宿主会话的模型请求整体关掉。回包 `{enabled, denied}`，同 token，每次切换一条审计。这条路刻意不进 `tools/list`：目录透传的是宿主注册表，而这是桥对宿主做的事。配置 `host_llm: "deny"|"allow"` 只决定启动状态，切换不落盘
- **接管的机制与边界**见协议页「宿主推理切换」。与 v0.1.0 相比，这个版本会**改动宿主运行时状态**：影子化模型注册表、把 `globalThis.fetch` 换成按目的地判定的绊线、给若干子系统挂运行时 override。不开 `host_llm: deny` 时这些都不发生
- **为什么不是「换个开关就行」**：宿主提供了一整套逐子系统的 `--no-*`（`--no-tools` / `--no-lsp` / `--no-prewalk` / `--no-pty` / `--no-extensions` / `--no-skills` / `--no-session` / `--no-ui` / `--no-rules`），**唯独没有关 LLM 的**——它把工具和增强当可关的，LLM 当核心职能。所以这条只能由桥做。**反过来说：宿主哪天原生加了 `--no-llm`，这一层就该删掉**，那时它是在重复实现宿主已有的东西。这是需求驱动的退役判据
- **已记录的残差**：重建会话且新注册表里有拦不住的道时降级为 `deny (tripwire only)` 并回 `degraded: true`；非 POST 的元数据请求仍会出网（每轮一次）；别人的扩展占住被声明的名字时会不可逆，需重启宿主
- fix: `initialize` 回的 `serverInfo.version` 原先在入口与协议页各写一份 `0.1.0`，所以这个版本一度代码答 0.1.0 而文档与代码一致。改成从 `package.json` 读，协议页改写占位符，并加一项单测钉住「入口不含字面量、页面不含字面量」——两份副本而没有任何东西比对，是这个仓库吃过亏的形状
- 核验：161 单测 / 35 blob / 34 hardening / 28 install / 34 takeover / 28 registry / 3 tree / 54 步场景 / smoke / approval，另有站点的 56 项渲染与 SEO 核验。**九项宿主核验全部在宿主 omp 18.10.4 上重跑过**——pin 原先停在 18.8.7，而宿主在今天凌晨自己升到了 18.10.4（`startup.checkUpdate`，默认开），版本守卫当天如实红了两条。这不是这个仓库的变更，是外部事件撞在发布上：pin 与 lockfile 同步至 18.10.4，全套核验在新宿主上重跑一遍，内存表按新版本重落（第三十轮：空闲 487、单个 +23、并发安顿 +36、峰值 +36，两项都与安顿相等）。**跨版本那一轮不能与前几轮直接比**——并发安顿在 18.8.7 上落在 +38 到 +168，这里是 +36，同一份代码、同一个 Bun

下面各节按日期倒序，是 v0.2.0 之前的逐日演进。

## 2026-10-12 — 宿主推理接管：`POST /host-llm`，第七核验把「零」数出来

- feat: 接管落两条裁决——宿主不允许任何自主 LLM 调用，且宿主能不能推理这个开关本身也归远程。保证是两层的并集：会话模型注册表枚举出的每个 provider 影子化到 deny 实现（`api: "a2a-deny"`），被拒时回哨兵文本 `a2a-bridge takeover: host inference is disabled in this mode`——措辞避开全部四类重试触发器（`TRANSIENT_TRANSPORT_PATTERN`、strict-tools-400、oauth、codex），真实宿主实测被拒的一轮恰好一次尝试、`retryable:false`、`sessionSettled:true`；再把宿主进程的 `globalThis.fetch` 按目的地绊线，键取 models.yml 全部 `baseUrl` 的 host+port，盖的是 task 执行器、web 搜索这类自建注册表、不问会话的旁路。降噪层给自动转后台、宿主重试、advisor、ttsr、prewalk、autolearn、cache warming、自动压缩挂运行时 override，不落盘。实测在位时远程 3 秒 `bash` 同步跑完、不变后台任务
- feat: 控制面。配置 `host_llm: "deny"|"allow"`（缺省 `allow`）只决定启动状态；运行中的开关是 `POST /host-llm` 带 `{"enabled": bool}`，回包 `{enabled, denied}`。同 token，每次切换一条审计（`tool: "host_llm"`，拒绝装配同样记）。这条路刻意不进 `tools/list`：目录透传的是宿主注册表，而这是桥对宿主做的事，不是宿主的工具。装配排在端口绑定之前（否则早到的调用方有一个宿主仍能自己推理的窗口），且每次 `session_start` 重装——revive/ACP/子代理 runner 带来的是没被影子的新注册表。切换不落盘，重启回操作员配置；`/a2a` 显示 `host_llm=deny denied=N`
- feat: 拦不住的直说，不半装：配置里有 `transport: "pi-native"` 的 provider（provider 级键；写成 model 级会被 schema 静默丢掉，探针埋雷时踩过）时 `applyTakeover` 在改动任何状态之前抛错。`/login` 把模型所有权交回宿主，deny 随之失效。运行中新出现的 provider、`title.generator` 枚举里没有关、被拒轮次在会话历史留错误消息，这几条残差全部写进协议页「它放弃了什么」
- test: 单测 117 → 138（10 文件）。`test/takeover.test.ts` 覆盖 deny overlay 形状、哨兵文本不被重试谓词命中、绊线键集、pi-native 拒绝、restore 幂等；`test/host-llm-route.test.ts` 覆盖路由的方法→鉴权→body→动作顺序与两种状态的审计落盘。变异核验各红各名
- test: 第七宿主核验 `test:takeover`（28 项，约 60 秒）。上一节那条「值不值得加第七个核验，待裁决」的裁决是加，且加法是数数：探针自建计数 sink（`Bun.serve`，答 503），本仓库第一个真让宿主连进来的 listener，「零模型请求」从缺席声明变成算术。正负一对：deny 在位时 sink 恒零、拒绝恰好一条；恢复的负控里宿主轮次真的打到 sink（这一条不绿，前面所有的零都只是「连不上」的错觉）。task 旁路实测封着——子代理在独立进程，拿到 deny api 的模型行后自己的注册表分发不了，约 250ms 内以 `Unhandled API in mapOptionsForApi: a2a-deny` 退出：fail-closed 成立，封死的方式是崩溃，不是绊线拦截，文案照实写。rpc 的坑记一条：`prompt` 发出去先回的 `{"type":"response","command":"prompt","success":true}` 只是 ack，结果帧是后到的 `prompt_result`、按 `id` 配对——第一版探针把 ack 当结果读，全绿且什么都没测到
- test: `test:install` 的「首次启动只写 host/port/token」改成四个字段——`saveConfig` 现在连缺省的 `host_llm: "allow"` 一起写，这条在 takeover 落地后第一跑就如实红了
- ci: `host-probes` 加 `test:takeover` 一步，job 头注释同步改——六个核验用占位 provider 就能 boot，这一个要可达的 sink，不然零数不出来
- docs: README 中英新增「宿主推理接管」一节与配置表 clarifier；「安全与边界」里 blob 那条从「是例外」改成「是一个例外」，新加 `POST /host-llm` 条，唤醒条补「这一半是开关，不是既成事实」；故障排查两条；开发计数与文件布局加 `src/takeover.ts`。协议页新增「宿主推理切换」（响应表、生命周期重装、「它放弃了什么」六条）。computer-use 的宿主账改口「花不花取决于接管在不在位」。testing 页加第七核验一节，并把 harness 盲那段收尾成「已收口」。站点加「宿主推理可以整体关掉」卡片，页面 description 与计数同步。AGENTS.md「The one exception on record」改成两条例外记录
- 回归：`lint` / `tsc` / `bun test` 138/138；七个宿主核验在 18.8.7 上跑了两遍全绿，文档落的是后一遍——takeover 28 项 65.6 秒（装例行实测 75 providers / 69 keys）、`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 35 项（RSS 表按第二十五轮重落：空闲 477 MB、单个安顿 +18、并发安顿 +20，单个那项峰值与安顿相等、并发那项峰值高 19 MB）、`SCENARIOS 54 steps, 0 failed`、`PACKAGE OK`、审批 `VERDICT: B` 挂起 90001ms；站点构建 + 渲染核验 34 项全过

## 2026-10-12 — 推广期文案重写；「不消耗 token」被远程实测推翻，全线收窄

- docs: 文案按推广期重写——读者第一眼要能看懂这是什么，不是开发者给自己看的备忘。README（中英）导语改成 outsider 说法：装上的 omp 多开一个 MCP 接口（MCP 是 agent 调用外部工具的标准协议），任何说 MCP 的程序都能调这台机器上的 `read`/`bash`/`edit`；首页 hero 与七张 feature 卡片把「宿主」这类内部词换成「本机/这台机器」，测试卡片写实数（117 项单测、六个拉起真实 omp 的核验）；`SITE_DESC` 与逐页 description 同步
- docs: 「宿主不做模型推理，一个 token 不花」这条绝对说法被远程 Windows 宿主的实测日志推翻，收窄为「桥自己从不请求模型」。实测链条：一条远程 `bash` 超过宿主 300 秒命令超时，宿主把它转成后台任务；任务完成时 omp 往会话注入一条 `async-result` 通知（"Background job bg_1 has completed. Resume your work…"），宿主会话自己的 agent loop 被唤醒，从 04:36:31 起发出真实推理（model stack/medium，单轮输入从 8,309 token 起，此后几十轮）。桥的请求路径本身没问题——唤醒之前那约 28 次远程工具调用只以 UUID custom event 渲染，会话消息数为 0。定性：这是工具执行落在宿主真实会话的会话级副作用，与 `/blob` 同属「桥放弃了不碰宿主会话状态」那类代价。收窄落点：README（中英）导语与「工作原理」bullet、站点 tagline、`SITE_DESC`、`docs/computer-use.md` 的两处表格与「一处容易误解的地方」整段重写；README「安全与边界」新增「远程调用可能唤醒宿主自己的 agent」条目，带完整时间戳
- test: 记下探针的结构性盲区——`test/harness.ts` 播种的不可达 provider 证明的是「桥不靠模型回答也能跑」，证不了「宿主不发模型请求」：被拒绝的请求静默失败，计数看不见尝试本身。这条链正是从盲区漏出去的：六个宿主核验没有一条走超时转后台路径（审批探针把 `bash` 挂住就看结论）。补法是种一个可达但只记账的 sink provider 数模型请求次数，值不值得为它加第七个核验，待裁决。盲区写进 `docs/testing.md` 的 harness 段
- 回归：站点构建 + 渲染核验、`lint` / `tsc` / `bun test` 全绿

## 2026-10-11 — 单测补掉分派层与 `auditBlob`，pin 跟到 18.8.7

- chore: `@oh-my-pi/pi-ai` 与 `pi-coding-agent` 的 pin 从 18.8.6 跟到 18.8.7——宿主 omp 在这两天自己升了版，`test/versions.test.ts` 那条「pin 必须等于宿主」的守卫先红。守卫拦下的正是该拦的：18.8.7 上重跑六个宿主核验全绿之后，pin 与 lockfile 一起落
- test: 单测 107 → 117（8 → 9 文件）。`audit.ts` 的 `auditBlob` 记录形状两条：成功上传是一条 `done`（`tool: blob:write`，args 只有 path/offset/bytes 元数据，没有 start/done 双相可言，协议页拿这个不对称跟 `tools/call` 对照过），失败记录 `bytes: 0`、`error` 切在 200 字符。新建 `test/blob-route.test.ts`（8 项）覆盖 `src/server.ts` 的分派层：401 在读完 body 之前、`DELETE /blob` 走 405 且这条不能杀 MCP 会话、被拒的形状（缺 path、空 body、`offset=abc`）不写文件也不写日志、`issuedSession` 四态（签发过的原样进审计、伪造与缺失记 `null`、TTL 内刷新过期后不再归属）、目录路径 → 500 且照样落一条 `isError: true`、offset 不符 409 且原文件一个字节没动
- 变异核验四项，各红各名：`issuedSession` 换回照抄请求头，红归属与 TTL 那三条；删掉 `server.ts` 里 `DELETE /blob` 的 405 分支，红「会话杀不掉」那条——它掉进通用 handler 会销毁 MCP 会话；`auditBlob` 的 `error.slice(0, 200)` 摘掉，红失败形状那条；`offset !== size` 直接放行，红 409 那条（半截追加同时把字节断言打红）。还原后 `git diff src/` 为空，117/117
- coverage: `src/server.ts` 93% → 100%，`src/audit.ts` 76% → 100%，`src/blob.ts` 5% → 78.67%，`src/bridge.ts` 99% 没动。blob 剩下的 `162-165`（在途 409）、`173-182`（短写）、`184`（写失败 catch）留给 `test:blob`——要在单测里碰它们得换实现（注入 fd、或换一块真满的盘），那条路把宿主专有的语义搬进单测，不值得
- 推翻一条旧立场：此前「刻意不补单测」的理由是分派层与 blob「要的是真字节进文件系统，宿主探针已经在跑」。测下来站不住——单测起真桥、写 `/tmp` 里的真小文件，验的是接线和记录形状，这两样 `test:blob` 的 35 项给不了单测那样的定位（它红的时候不知道是字节还是归因）；字节保真那半程仍归探针，两边的分工现在写在 `docs/testing.md`。上一条的坑复用了一次：断言「日志里没有」之前先投哨兵排空队列（`host-call.test.ts` 的 afterAll 教训第二次派用场）
- docs: 协议页内存表按第二十三轮重落（宿主 18.8.7 首轮：空闲 549 MB，单个 8 MB 安顿 −57 MB，两个并发安顿 −56 MB，峰值 −1 / −32——四个读数都低于基线，负值出在取样位置，原因表里照写）；近六轮基线 497、483、485、468、488、549 MB，跨度 81 MB；100 MB 单请求本轮耗时没被探针日志尾巴截到，写死的秒数删掉不补。`docs/testing.md` 的 RSS 结论段同步（二十三轮、三次为负），覆盖率段按新数重标
- 计数同步：单测 117（README 中英、站点摘要、`docs/testing.md` 总览）
- 回归：`lint` / `tsc` / `bun test` 117/117；六个宿主核验在 18.8.7 上全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 35 项、`SCENARIOS 54 steps, 0 failed`、审批探针 `VERDICT: B` 挂起 90001ms、`PACKAGE OK`）

## 2026-10-10 — 网站文案去 AI 味，首页卡片改成从用途讲

- docs: 站点自有文案（`sync.mjs` 里的 hero、六张卡片、页面 description）扫了一遍 AI 腔：computer-use 摘要里两处 `而非` 拆成实事（执行落在宿主原生工具的实现上、目录由 `tools/list` 给出名字和参数），changelog 摘要的「完整演进」「核验的恢复与推翻」「安装方式的收敛」动词化，testing 摘要拆掉三个连环括号（计数 107/35/35/28/10 原样），`即连通` → `就连上`，hero `操作你本地的设备` → `把本机的工具开给远程的 agent`。卡片里 `前者操作像素，后者操作宿主已注册的工具——要推理的那一方也在不同地方` 这种对仗口号换成两句可核验的陈述
- docs: 仓库文档进站点的三处一并清：`docs/protocol.md` 的 `返回 401 而非 400`、`但那意味着桥开始读…`、`前者伤启动，后者伤证据`（总结句删掉，前后本来就是同一件事）；`docs/testing.md` 三处 `而非`；`docs/computer-use.md` 开头的 `前者落在像素上，后者落在…` 换成直接点名。数字、表格、代码块一字未动
- docs: 首页 features 改成先讲「连上能干什么」：原「远程能碰到什么」一张机制卡拆成三张场景卡（远程烧一块板子、驱动挂在宿主上的设备、把固件放上宿主机），「接上远程 agent」补上默认只绑回环；协议、测试两张导航卡不动
- 核验：`bun run lint` 干净；站点构建 + `render-check` 34 项全过

## 2026-10-10 — 审计先于尺寸落盘，`/blob` 的 `sid` 只认自己签发过的

- fix: **`POST /blob` 的审计记录挪到读回尺寸之前**。旧顺序是写完、`stat` 读回大小、再 `auditBlob`——那一次 `stat` 落在 `close()` 之后的窗口里，文件可以被 unlink、父目录可以失去可寻性，于是一个已经落盘的写入可能换来「500 + 日志无痕」，而这个端点的唯一痕迹就是那行日志。现在记录先落盘，读尺寸失败只让响应少一个 `size` 字段，状态照常 200；不能反过来报 500——分块客户端见 5xx 就重试，而 `/blob` 只会追加，重试等于同一段字节写两遍。这条没有先红后绿：窗口在写完与读回之间，摆不出来，`docs/testing.md` 按「第三条没有」明说
- fix: **`/blob` 的 `sid` 过去照抄请求头**。审计里 `sid` 是共享 token 下唯一的归因字段，照抄等于由调用方自报——任何持 token 的人都能把自己的写入登记到别人的会话名下，或者编一个。现在只认本桥签发过、还在空闲窗口内的 id，其余一律记 `null`；不拒请求，拒了就是桥自己在决定谁可以上传，协议没给过这个位置。签发过的 id 经 `/blob` 刷新空闲计时，与 MCP 路径同语义。顺带把 MCP 与 `/blob` 两条路径上「同一个字段不是一个意思」的分歧消掉：那边逐条验这个头，这边以前根本不碰会话表
- fix: **审计写失败从「吞」改成「吞但不哑」**。`appendLine` 的失败照旧不影响调用（这条不变式原有测试钉着，rejection 冒进宿主进程与卡死队列都在这条的红名单里），新增：每个日志路径第一次写失败往宿主 stderr 打一行 `[a2a-bridge] audit record not written to <路径>（<原因>）`，此后每满一百次再打一行，计数经 `auditWriteFailures()` 可读。理由是外观问题——写不成的日志与从没被调用过的桥看起来一模一样，而整个安全论证建立在这份文件是 `/blob` 唯一痕迹上。「按路径记首次」而非按进程：`$A2A_BRIDGE_AUDIT` 让一个进程可以对着多个路径，全局只报第一次会让第二个路径哑掉
- fix: **401 有了信号，且刻意不进审计文件**。未鉴权尝试原先在日志里零痕迹，运维分不清「没人来」与「来的人全敲错门」；现在进程级计数，第一次与其后每五十次打一行宿主 stderr。不落审计是一条攻击面算术：那份日志 512 KB 轮转、只保留一代，而轮转不认鉴权状态——给鉴权前的流量写记录，等于把冲掉真实记录的唯一杠杆交给每一个正在猜 token 的人，他们不需要猜中，只需要灌量
- fix: **配置的 token 有了下限，且自愈的范围收窄**。字段里存在但短于 32 字符、或含空白的 token，与 `port`/`host` 同罪：拒绝启动并报字段名。旧代码把一切「非法 token」当缺失处理、重写并写回——对三字符的占位符那不是宽容，是给一个能写宿主可写一切的端点留了扇没人知道开着的门；而继续自愈等于桥悄悄换掉谁手写的 token，远程 `mcp.json` 对不上号且没有任何地方说明原因。自愈只剩字段缺失或根本不是字符串一种。`MIN_TOKEN_CHARS = 32` 压在 `generateToken` 自己产出（43 字符）之下，拦的是占位符，不是从别处抄来的密钥
- test: 单测 105 → 107（config 两条：太短与含空白的 token 各自拒绝启动、不落写回）；`test:blob` 32 → 35（伪造头照样写得成且不被归属、伪造头审计记 `null` 不记那个自称的 id、桥签发过的头原样进审计）；`test/audit.test.ts` 的「路径写不成」一项从「不出 rejection」扩到断言告警行点名路径且计数器前进
- test: 排查记录一条：新告警断言在全套件里红、单文件跑绿——`test/host-call.test.ts` 的 afterAll 直接删审计目录，把别的文件此刻还在途的记录一并抹掉。改成先向队列投一条哨兵记录、等它落盘（上限 3 秒）再拆。进程级共享资源做完断言前必须排空再销毁
- 变异核验三项：去掉 token 下限校验，只红新增那两条 config；把审计的 `.catch` 换回空函数，只红那条失败路径断言；`/blob` 的 sid 换回照抄，宿主 blob 核验里只红归属那一条，还原后重跑 35 项全绿——那一轮同时成为内存序列的第二十二轮。审计顺序那条无变异可做，原因见第一条
- docs: 协议页——`200` 响应里 `size` 改为可选并写明读失败只缺字段；处理顺序把 `/blob` 路由列为第 3 步（鉴权之后、JSON 解析之前）；鉴权节补 token 下限与「鉴权前的流量碰不到审计文件」；「它放弃了什么」加第三条：桥自己的 `a2a-bridge.json` 与 `a2a-bridge.log` 就落在它解释路径所用的根里，改写不了（一律追加、`offset` 必须等于当前大小），但往配置追加垃圾会让下一次 `loadConfig` 抛错、桥起不来，往日志灌量会驱动轮转冲掉证据——冲的是启动与证据，不是新增可达范围，能这么干的人本来就握着 token
- docs: README 中英两版同步——配置表与 fail-closed 段补 token 下限与自愈边界，`/blob` 条补上面那条代价，审计条补三处新语义，故障排查加两条（短 token 拒启动、审计路径写不成的外观）。顺手按同一惯例清了「移动文件」一节没人复核的死数：「空闲 368 MB、一次 100 MB 上传后 624 MB、两次并发 846 MB」与「0.4 秒」换成指向协议页每轮刷新的表——那些数是 18.6.1 时代量的，空闲基线这半年就从 368 走到 468–497
- 计数同步：单测 107、blob 35（README 中英、站点摘要、`docs/testing.md` 总览与覆盖率段——后者两处「剩余未覆盖」的行号按当前码位重标）。协议页内存表按第二十二轮重落（空闲 488 MB，单个 8 MB 安顿 +22 MB，两个并发安顿 +40 MB，峰值 +22 / +41——单个那一项峰值与安顿相等，并发那一项峰值高 1 MB；近六轮基线 480、497、483、485、468、488 MB，跨度 29 MB）；100 MB 单请求本轮 2.2 秒，同一天里 0.3 秒也出现过，耗时数跟着机器负载走，文档把这句写明
- 回归：`lint` / `tsc` / `bun test` 107/107；六个宿主核验在变异全部还原之后重跑全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 35 项、`SCENARIOS 54 steps, 0 failed`、审批探针 `VERDICT: B` 挂起 90002ms、`PACKAGE OK`）

## 2026-10-09 — 测试页的序列停在第十六轮，首页卡片把 install 当纯打包

- docs: `docs/testing.md` 那段 RSS 结论抄了协议页的逐轮序列，抄完停在第十六轮——协议页已记到第二十轮，它还少了四个并发数与后来的基线。改成只留区间（单个 −157 到 +171 MB，并发 −141 到 +168 MB）与负值的来处，逐轮序列与近六轮基线归协议页那张表维护，不抄第二份
- docs: 首页「测试与核验」卡片把 `test:install` 当成不起宿主的纯打包检查——它有端到端那半程之后，六个核验全都起宿主（`docs/testing.md` 的统一前置段一直写着六个）。卡片改为六个，点名发布包那一个装回去跑通

## 2026-10-09 — 宿主又超前两天，pin 同步至 18.8.6

- chore: pi-* pin 与 lockfile 同步至 **18.8.6**（第七次复发）。宿主 omp 有 `startup.checkUpdate`（默认开），会自己升级，节奏不由本仓库定；10-07 同步到 18.6.3 推完，10-09 宿主与 node_modules 都到了 18.8.6，版本守卫两条红（实装 ≠ pin、宿主 ≠ pin）。谁在改本仓库的 node_modules 仍是未知机制，不假装知道。代码与文档引的宿主源码位置逐条对 18.8.6 复核过，全部原位未动：三个 `getAllTools` 接线点（`runtime-init.ts:126`、`extension-ui-controller.ts:199/427`、`acp-agent.ts:2581`）、`session_start` 的两个发点（`runtime-init.ts:212`、`extension-ui-controller.ts:320-329`）、`AgentRef.session` 的哨兵注释（`agent-registry.ts:69`，`Null exactly when parked/aborted`）——文档与测试注释里的行号不用改
- 18.8.6 全量回归：`lint` / `tsc` / `bun test` 105/105 三绿；六个宿主核验全绿（`SMOKE OK` 21 工具、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、审批探针 `VERDICT: B`、`PACKAGE OK`）。轮转那组仍是数量守恒：8 条前置 + 212 次调用写出的 424 条，430 条进 `.1`、2 条留在当前文件；审批探针 bash 挂起 90001ms、副作用文件未出现、审计 `start=1 done=0`；`xd://` 挂载设备 5 个。跨版本未变的行为：21 个工具、挂起语义、两阶段审计、审批门仍 fail-closed
- docs: 协议页内存表按 `test:blob` 第二十轮重落（空闲 485 MB，单个 8 MB 上传安顿 +21 MB，两个并发安顿 +51 MB，在途峰值 +22 / +51 MB——这一轮峰值与安顿几乎相等，「高于、低于、相等」三种关系这些轮次里都出现过，这两个数不构成排序；近六轮基线 461、490、480、497、483、485 MB，跨度 36 MB）；100 MB 单请求本轮 0.6 秒
- chore: `test/rss-18.8.6.json` 入库，替换 18.6.3 那份——归档按宿主版本一文件一份，文档那张表的出处跟着当前宿主走

## 2026-10-09 — 两条并发写日志，第二次轮转吃掉第一次

- fix: **审计落盘的「查大小 → 轮转 → 写行」三步不是一个整体**。`src/audit.ts` 的 `appendLine` 原先每来一行就自己起一个 async 闭包，两个同时在飞的写可以都读到越过 512 KB 的尺寸、都去 `rename`，而第二次 `rename` 覆盖掉的正是第一次刚放好上一代的那个 `.1`。被吃掉的是轮转那一刻还留在当前文件里的记录，几毫秒前由另一个调用写下的，外加被换出去的一整代。配上 `/blob` 更糟：那个端点在宿主审批门之外，审计行是它唯一的痕迹。现在按进程一条 promise 链串行，`appendLine` 把行交给链就返回（调用照旧不等磁盘），链上每个环节自带 `.catch`，于是一次写失败既冒不到宿主进程，也不会把链卡住让后面所有审计落不了盘。接受的代价说清楚：磁盘慢的时候，后面的行在内存里排队
- test: `test/audit.test.ts` +1（4 → 5，单测 104 → 105）。舞台摆成只需要一次轮转：日志灌到离 512 KB 差 200 字节以内，同时打 60 条（每条约 1.15 KB），断言按两个文件的记录数守恒、逐条 id 都要在。未修版本重跑六轮先红，落点两种：四次缺 59 条（本轮 60 条只剩 1 条），两次缺 570 条（两个文件各剩 1 条）
- 变异核验三项：换回不串行的写法，只红这一条；去掉链尾的 `.catch`，红两条——「路径写不成」那项（rejection 冒出来）与这条新的（前一个环节失败卡住了链，此后所有审计都落不了盘）；把轮转整句删掉，红的是原有那条保留测试。轮转本身、轮转的串行、串行的自愈，三样各自有人看着
- 顺带两处过期：那条保留测试每 20 对让一次路，注释给的理由是「有链子会冲过上限把尺寸读数弄浑」，串行之后这件事不成立了，注释按新行为改写、让路去掉；`docs/testing.md` 里 `auditBlob` 的未覆盖行号从 `116-136` 跟到 `132-152`
- docs: 协议页审计那条补上串行的理由与实测落点，README 中英两版的审计条各补一句
- 计数同步：单测计数落到 105（README 中英、站点摘要、`docs/testing.md` 总览）；协议页内存表按 `test:blob` 第十九轮重落（空闲 483 MB，单个 8 MB 上传安顿 +20 MB，两个并发安顿 +168 MB，在途峰值 +29 / +258 MB——这一轮峰值高于安顿，上一轮反过来，这两个数不能互相排序；近六轮基线 474、461、490、480、497、483 MB，跨度 36 MB）
- 回归：`lint` / `tsc` / `bun test` 105/105（新那条连跑三轮全绿，串行之后一次多余的轮转都没有）；六个宿主核验在最后一次改动之后重跑全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、`VERDICT: B`、`PACKAGE OK`）。轮转那组报的是数量守恒：8 条前置 + 212 次调用写出的 424 条，430 条进 `.1`、2 条留在当前文件

## 2026-10-09 — 目录、暴露门与执行，原先读三份注册表

- fix: **`tools/list` 与暴露门读的是入口 pin 住那份 `pi`，而执行读 `Main` 的活会话**。宿主把 `pi.getAllTools()` 接到那套 runner **自己的**会话（`runtime-init.ts:126`、`acp-agent.ts:2581` 都是 `() => session.getAllToolInfos()`），入口却只认第一个 `session_start`——task 子代理或 ACP 会话先走到，桥就在报出另一个会话的工具清单，同时把 `Main` 自己的名字按「not exposed」拒掉；反方向也成立，`Main` 有而那份 runner 没有的名字列不出来却其实能调。现在这一处只有一个权威（`src/bridge.ts` 的 `servedTools()`）：读 `Main` 会话的 `getAllToolInfos()`，目录与门都改读它，常规宿主里它与原先那份 `pi` 逐字相同；`AgentRef.session` 为 `null`（parked/aborted 到端口释放之间）时退回那份 `pi`，因为报出一份宿主其实并没有的空注册表不是诚实而是添乱
- test: `test/host-call.test.ts` +2（17 → 19，单测 102 → 104）。harness 多一个 `pinnedPiNames` 把「入口那套 runner 不是 Main」摆出来，假 `Main` 会话补上 `getAllToolInfos` 与 `getToolByName` 同源。新增的第一项三个方向都断，先红在目录那半；第二项断 parked 的兜底
- 变异核验三项：两处都换回 `pi.getAllTools()`（红那一项）、只改目录而门仍读 `pi`（红同一项的另半条断言，两处分别被断着）、去掉 parked 的兜底（红五项——新增的兜底项，加 `test/bridge.test.ts` 里三条依赖「没有 Main 就读入口那份」的目录测试与「registered tool with no Main session」那条）
- 顺带修一处过期的计数：`docs/testing.md` 那节标题写着 14 项，实际早就不是了
- docs: 协议页 `tools/list` 那条改口到真正的权威并写清兜底的适用窗口，README 中英两版的目录、安全与边界、模块表三处加 mermaid 标签同步
- 计数同步：单测计数落到 104（README 中英、站点摘要、`docs/testing.md` 总览）；协议页的内存表按 `test:blob` 第十八轮重落（空闲 497 MB，单个 8 MB 上传安顿 +17 MB，两个并发安顿 +45 MB，在途峰值 +0 / +58 MB——这一轮的峰值低于安顿，正说明这两个数不能互相排序；近六轮基线 484、474、461、490、480、497 MB，跨度 36 MB）
- 回归：`lint` / `tsc` / `bun test` 104/104；六个宿主核验在最后一次改动之后重跑全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、`VERDICT: B`、`PACKAGE OK`），其中 `tools/list` 非空与远程调用走的就是这份新读数

## 2026-10-09 — 释放端口那一刻，在途的那一次要落审计

- fix: **释放端口把正在处理的那一次一刀切断**。`src/server.ts` 的 `stop()` 是 `server.stop(true)`，而端口会在三个时刻释放：`session_shutdown` 看见注册表里没有活的 `Main`、绑定中途那次放弃、启动失败的 catch。任一个时刻都可能正有一个请求在处理。代价分两种：`tools/call` 那一边客户端拿到 `ECONNRESET`、审计只剩 `start` 那一行；`POST /blob` 是整个消失，body 还没收完就断，`Buffer.from(await req.arrayBuffer())` 抛在写之前，于是文件没动、`auditBlob` 也没跑到——而那个端点走的正是宿主审批门之外的路，审计是它唯一的痕迹。改成非强制的 `server.stop()`：监听立刻关，后来的人一律被拒，已经进来的那一次处理完、返回、落审计
- 同一批实测里有一条属于 Bun，不掩盖也不装成已修：非强制 `stop()` 在 1.3.14 **不关**释放时已经空闲的 keep-alive 套接字，`closeIdleConnections()` 只有函数名（返回 `undefined`，socket 照旧被服务），`bun-types` 1.4.2 描述的「空闲连接立刻关」是更新版本的行为。于是这条改动换来的是「新建连接一律进不来」，而释放前就连着、之后仍保持着连接那一方，在它自己的旧 socket 上还能被服务（`tools/call` 只会拿到 `main session not available`，`/blob` 仍写得进去）。核验一律用 `node:net` 裸连判释放，走 HTTP 客户端会复用那根老 socket，量到的是这一半而不是监听的状态
- test: `test/server.test.ts` +1（23 → 24，单测 101 → 102），新增一节「releasing the port」。起一个 `tools/call`，等 stub 的 `callTool` 确实在跑（一个 `entered` 标志），然后 `stop()`，断言那一次照样 200、结果文本完整，再断裸连被拒。同一条里先断裸连在释放前是 `true`，免得这个读数只会恒假
- 变异核验两项：把 `stop(true)` 换回去，只红这一条，18 ms 内以 `ECONNRESET` 红；把 `server.stop()` 整个删掉，红五条——这一条的裸连接断言，加入口那四条靠新建连接判释放的
- docs: 协议页「一个进程，一套端口」加两条（释放的动作为何是非强制、Bun 那条偏差对 `tools/call` 与 `/blob` 各意味着什么），`docs/testing.md` 新增同名一节，README 中英两版的生命周期那条各补一句，站点摘要与单测计数同步到 102（下一节又把它推到 104）
- 回归：`lint` / `tsc` / `bun test` 102/102；六个宿主核验全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、`VERDICT: B`、`PACKAGE OK`）

## 2026-10-09 — 每会话的事件，每进程的端口

- fix: **任何一次子代理结束都会拆掉还在服务的端口**。`extensions/a2a-bridge.ts` 把 `server?.stop()` 挂在 `session_shutdown` 上，而这个事件是**每会话**的：宿主为 task 子代理、ACP 会话、持久化 revive 各建一套 extension runner 并重跑扩展工厂（模块图不重新求值，`server`/`cfg` 因此共享），一个 task 子代理跑完，它的 `session_shutdown` 落到同一个 handler，端口释放，而主会话那边再没有第二个 `session_start` 把它重启。现在的判据是宿主注册表里还有没有 `Main` 会话（`src/bridge.ts` 的 `hasMainSession()`）：有就照常服务，没有才收。交互式宿主的 `/new` 不在此列——它复用同一个 runner，根本不重发 `session_start`
- fix: **两个 `session_start` 同时在途会各绑一套端口**。绑定这一步不是原子的，`loadConfig` 与 `startServer` 都要 await，于是后到的那一个能在 `if (server)` 检查上赶在前一个赋值之前通过，真的再绑一个。模块只记住后一个端口，前一个从此谁也停不掉，操作者还会收到两条指向不同端口的广播。现在后到的等前一个绑完再复用那套
- fix: **绑定还在进行时的 `session_shutdown` 手里没有端口可停**。那个事件的 handler 只看 `server`，而 `loadConfig` 与 `startServer` 都还没回来时它是 `null`，于是它谁也没停，绑定却在随后完成——留下的端口服务的是一个已经不存在的 `Main`，此后再没有 `session_start` 来纠正它。现在绑完那一刻按同一条判据（`hasMainSession()`）复查一次：已经没有 `Main` 就把刚绑的端口收掉，一句广播也不发
- fix: **parked 的 `Main` 被 `hasMainSession()` 当成还在**。宿主把 `AgentRef.session` 注释成「Null exactly when parked/aborted」，槽位留着、会话置 `null`，而这条判断原先比的是 `undefined`，于是那种状态下它说「有 Main，照常服务」，同一份注册表在 `src/bridge.ts` 的调用路径里却回 `main session not available`——两处读同一个字段，读出两个结论。现在按宿主的哨兵判（`!= null`），端口跟着调用路径能服务的那个状态走。顺手把那条假想断言换掉：原先注册的是一句 `session: undefined as never`，宿主根本发不出这个值，它绿得没有依据
- fix: **`/a2a rotate` 先改内存再写文件**，写失败就是运行中的桥换了 token、配置文件留着旧 token、操作者收到一句「失败」。改成先落盘再生效
- 顺带记下启动失败那条注释（「不留半初始化状态」）现在有据可查：catch 里的 `stop()` 与清状态两半各有断言，只清 `cfg` 而留着 `server` 那种改法红不了——挡住 `rotate` 的是两个条件里任一个，这条保护本来就写在注释里，现在写在测试里
- test: 新增 `test/entry.test.ts`（19 项，单测 79 → 98）。入口此前没有任何单测能引到它。不 mock 任何模块：`$A2A_BRIDGE_CONFIG` 指临时文件、端口写 `0`、`Main` 是真注册进 `AgentRegistry.global()` 的假货，每条断言都是「从广播里解析出端口，然后去连它」——200 就是在服务，连不上就是没在服务。`mock.module` 试过，也不行：Bun 的模块 mock 是进程级的，同一进程里 `test/config.test.ts` 的 `loadConfig` 会被换掉，`bun test` 整个绿不回来
- test: `test/host-call.test.ts` +3（14 → 17，单测 98 → 101），其中「没有会话的 Main 槽位」那一项原先注册的是宿主发不出来的 `session: undefined as never`，现在换成宿主真用的 `session: null` 加 `status: "parked"`，`hasMainSession()` 对着真注册表测三种情形：空表、`Main` 在册、`Main` 在册但背后没有会话。入口那条判断就靠这个读数，所以它不能被 stub
- 变异核验十项：去掉 `hasMainSession()` 那道闸（红 1 项）、`rotate` 的赋值挪回写盘之前（1）、catch 里不再 `stop()`（1）、catch 里什么都不清（1）、`hasMainSession()` 恒真（红的正是真注册表那 3 项）与恒假（1）、去掉在途那道闸（1，红的正是并发那条）、去掉绑完之后那次复查（1，红的正是绑定中途结束那条）、把 `hasMainSession()` 的比较换回 `!== undefined`（2，红的正是 parked 那两条：真注册表那一项与入口的端口释放）。第十项是广播里改用配置的端口，红 7 项——端口报错了，所有「去连它」的断言一起塌，这条恰恰证明断言是连着真端口写的
- docs: 协议页新增「一个进程，一套端口」，把后来的 `session_start` 静默复用、并发到达时后到的等前一个绑完、审批归属第一份 `ctx`（子代理那份没有可用 UI，让它占住引用会一路挂住）、`Main` 没了才释放、绑定落地后按同一判据复查、以及「没有 `Main`」按宿主那个 `session = null` 的哨兵判（parked/aborted 的槽位不算在册）这七条写清；README 中英两版各加一条
- 计数同步：README 中英两版的 `bun test` 说明加 101 项与两组新覆盖面，站点 testing 摘要同步；内存表按第十六轮实测重落（空闲 490 MB，单个 8 MB 安顿 +23 MB，两个并发 +160 MB，在途峰值 +24 / +264 MB），基线近六轮依次是 490、567、484、474、461、490 MB
- 回归：`lint` / `tsc` / `bun test` 101/101；宿主核验五连与发布包核验在最后一次改动之后全部重跑，全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、`VERDICT: B`、`PACKAGE OK`）。冷启动那一步也复查过：宿主在构造会话时把 `Main` 预注册进注册表，槽位后面的会话随后附上，而三个模式都是在会话建好之后才发 `session_start`（`runtime-init.ts:212`、`extension-ui-controller.ts:320-329`），所以那条复查挡不到正常启动。探针只跑 `--mode rpc`，tui 与 print 的这一步是按宿主源码核对的。场景核验的「宿主结束 → 端口不再接受连接」正是第一条改动的反例位

## 2026-10-09 — 渲染事件不该决定一次调用的结果

- fix: **宿主拒绝渲染事件时，一次已经执行完的写会被报成失败**。`src/bridge.ts` 里那两次 `emitExternalEvent` 坐在判定结果的 `try` 中。三种后果：start 被拒则工具根本不执行；end 被拒则 `edit` 照常落盘而调用方拿到 `isError`，照着它重试就重复执行一次带副作用的写；工具本身抛错时交出去的错误文本被换成渲染自己的那一条。注释写的是「只驱动渲染」，代码没做到。现在事件的构造与发送失败都吞掉，成功与失败两条路合到同一处结果映射，`toInputSchema` 那类降级照旧
- test: 新增 `test/host-call.test.ts`（14 项）。`buildCallTool` 交给 Main 会话的那半条路径此前一行 deterministic 测试都没有，只在 `test:smoke` 里跑过，而探针能调的工具只返回文本块。`AgentRegistry.register` 接受任何对象作 `session`，`resetGlobalForTests` 就是为此而设，于是不必起宿主也能断：text/image 原样转出（`detail` 不透传）、其他块折成 JSON 文本、`isError` 到调用方与审计、参数按引用交出、工具上下文里 `hasPendingMessages` → `hasQueuedMessages` 那次改名、一调一对事件且 `toolCallId` 是新 UUID、目录有而会话无的名字回 `unknown tool`
- test: `test/server.test.ts` +3。500 那句「细节只进服务端日志」两半都断上了（响应体查不到假宿主路径，`console.error` 拿到了错误对象）；端口退避分支原先不可能覆盖到，因为其余测试都以 `port: 0` 起服务，现在用真实占用的端口断 `fellBack`，反向一条用特权端口的 EACCES 断它不该退避（环境允许绑低端口时跳过）
- test: `test/audit.test.ts` +3、`test/bridge.test.ts` +2。参数含 `JSON.stringify` 拒绝的值时记录仍落盘（`args` 退化成 `[object Object]`）；日志写不成时不同步抛错也不以 unhandled rejection 冒到宿主进程，`appendLine` 末尾那个 `.catch(() => {})` 至此才有断言撑着；注册表里缺 `parameters` 的条目降级成 `{type: "object"}` 而不是把整份目录带走；参数在 1024 字符截断（去掉截断，原先所有测试全绿，所以补了一项 40 × 110 字符的用例）
- 变异验证：12 处逐项破坏实现（image 分支、`hasQueuedMessages`、`structuredClone` 参数、end 换 id、`if (!tool)`、未知块原样发出、吃掉 `isError`、不发 start、500 泄露细节、任何绑定失败都退避、`fellBack` 不置位、去掉参数上限与去掉两处 catch），每项只让自己那条断言变红。fix 本身另以 `git stash push src/bridge.ts` 回到改前状态验证：恰好渲染事件那三项变红，其余十一项绿
- docs: 协议页写清结果内容的三种情形与渲染事件不参与判定这件事；`tools/list` 那条补上「宿主转换器对非对象 `parameters` 会抛，桥接住并降级」。内存表按第十一轮实测重落（空闲 490 MB，单个 8 MB 安顿 +9 MB，两个并发 +16 MB，在途峰值 +32 / +33 MB）
- 计数同步：README 中英两版的加固项数 33 → 35（上一批把核验加到 35 项时漏改），单测 57 → 79（7 文件）
- 回归：`lint` / `tsc` / `bun test` 79/79；宿主核验五连全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、`VERDICT: B`）

## 2026-10-08 — 参数脱敏只走两层，而宿主 `edit` 的正文在第三层

- fix: **审计日志会写下文件正文**。`src/audit.ts` 的 `redact()` 走到第二层就停，注释写着「工具参数不会嵌得更深」，而宿主自己的 `edit` 是 `{path, edits: [{oldText, newText}]}`，正文落在第三层。远程调用一次 `edit`，日志里就多出最多 1 KB 的文件内容（只有 `MAX_ARGS_CHARS` 的截断挡着）。现在逐层走到叶子；嵌套超过 32 层的子树整个换成 `<max-depth>`，不再往下走
- test: 原有的那条脱敏单测（`test/bridge.test.ts`）断言 `args` 字段不含完整的 5000 字符 payload，而那个字段本来就截在 1024 字符，整段永远不可能出现，于是漏洞开着它也是绿的。改成在整行日志里查 payload 的 60 字符窗口，另加一条 40 层嵌套的用例（单测 55 → 57）
- test: `test:hardening` 33 项 → 35 项，同样的事从宿主这一侧再验一次：真发一次带三层正文的 `tools/call`，然后在日志里确认 `<len:4000,sha256:` 查得到、那 60 字符的窗口查不到
- 变异验证：把 `redact()` 的层数停止条件还原，两条单测如实变红。宿主核验那两项的红走的是 `until` 超时抛出，所以那一轮后面的项没跑（27 项 ok 之后中止）。这是宿主核验的既有风格：等不到本该出现的证据就中止，后面的结论没有意义
- docs: README 中英两版与协议页把脱敏的范围写清：**逐层到叶子**，且这是桥自己那份日志的承诺；宿主会话照常收到原参数，宿主的 transcript 里有什么不归本桥管
- 顺带记一条观察：宿主 stdout 会把收到的参数原样打出来，核验失败时探针打印的日志尾部因此带着那个 4 KB 的 payload。保留现场这件事，在有 payload 的用例上要多加一分小心
- 回归：`lint` / `tsc` / `bun test` 57/57 三绿；`HARDEN OK`（35 项）

## 2026-10-08 — `/blob` 两处「报了成功却没写成」，与审计日志的保质期

- fix: **两个调用方同时写一个新文件会丢字节，两条请求都回 200**。旧实现在 body 读进来之前取文件大小、据此选打开方式，两边都看到 0、都选 `w`，而 `w` 在 open 时截断，第二次 open 抹掉第一次已经落盘的内容。改成一律 `"a"` 打开；给了显式 `offset` 的调用方在拿到句柄之后复查一次大小，位置变了就 409，字节不放，也不回报你那个 offset
- fix: **`write` 短写（磁盘满、配额到顶）回 200，且不留任何审计**。现在短写与抛错都是 500，审计记 `bytes: 0` 加错误文本。被 413 挡在 handler 之外的那种不写文件也不写审计，这一条也断言了
- test: `test:blob` 21 项 → 32 项，新增「失败与边界」组。`/dev/full` 是 open 成功、写时 ENOSPC，无 root 下唯一干净地触发写失败的路子（填满 `/dev/shm` 也能达到目的，但那是全机范围的破坏，不做）。其余：只有 token 没有会话头、413 不碰已存在的文件、目录目标、`~` 与相对路径的落点、同一文件两路并发追加，外加四条审计断言
- test: `test:hardening` 29 项 → 33 项，补上审计轮转那组（此前一项都没有）。写它的时候撞见自己一条假断言：拿本轮发出的 JSON-RPC id 去日志里找记录，而日志里的 `id` 是本桥为配对生成的 UUID，JSON-RPC id 从不落盘，那条无论实现怎么写都不会有结果。换成数量守恒：一次调用写两条，N 次调用就要在两个文件里多出 2N 条。让记录变胖同样不能靠一个 1000 字符的路径，`redact()` 把超过 120 字符的字符串折成 `<len:N,sha256:...>`，每条只剩 210 字节，越过 512 KB 要 1241 次调用；换成 10 个 110 字符的参数之后每条约 1.1 KB，213 次调用就够
- test: 新增 `test/audit.test.ts`（单测 54 → 55）。轮转只保留一代，下一次轮转覆盖 `.1`，所以「只有 `start` 没有 `done`」那个挂起信号有保质期。这条直接灌审计模块，一秒跑完四轮流量；用宿主驱动要两千次真实调用，还会把并发落盘的顺序噪声卷进来。变异验证：把 `MAX_LOG_BYTES` 放大到不轮转，那项如实变红
- fix: 三处探针（blob / smoke / hardening）失败时保留现场并把路径打到 stderr。文档早写了「失败时保留现场」，代码里是无条件 `rmSync`，那句话一直是空的
- docs: 内存表按第十轮实测重落（空闲 495 MB，单个 8 MB 安顿 +18 MB，两个并发 +32 MB，在途峰值 +26 / +32 MB），并交代负值的来处：`空闲`基线在探针末尾取样，那一刻前一步那次 100 MB 上传仍有内存没归还，基线自己在往下衰减，于是每个增量量到的是衰减的进度。同一个探针连着三轮给出 −157、+91、+18 MB，「本表是最近一次实测，不是稳定值」那句话就是这么来的。探针打印负增量曾显示成 `+-141`，改成带符号
- docs: `/blob` 的拒绝总表补上 `500` 那一类（打不开、写不进、目标是目录）与 `413` 不碰文件不写审计；README 中英两版与协议页写明审计 `id` 是 UUID、日志只留一代
- 计数同步：README ×2、`docs/testing.md`、`website/scripts/sync.mjs` 里 blob 21 → 32、加固 29 → 33、单测 54 → 55
- 回归：`lint` / `tsc` / `bun test` 55/55 三绿；`SMOKE OK`、`HARDEN OK`（33 项）、`BLOB OK`（32 项，最后一轮 0 项失败）、`SCENARIOS: 54 steps, 0 failed`、审批 `VERDICT: B`、`PACKAGE OK`、站点 `render-check: all pages OK`

## 2026-10-08 — 内存实测重新落表：文档里的数会自己烂掉

- test: **`test:blob` 加宿主 RSS 实测段**（19 项 → 21 项）。`docs/protocol.md` 那张内存表只在宿主 18.6.1 上量过一次，宿主已到 18.6.3，文档里一句没人复核的内存断言会烂在原地。探针每轮起隔离宿主、测空闲/单个 8 MB/两个并发 8 MB 的安顿值与在途峰值，覆盖写进 `test/rss-<宿主版本>.json`，文档表从它刷新
- **不断言阈值**，理由写在探针文件头：这条原本要卡在「两个并发 body 的开销小于两者之和」上，实测杀死了这个想法。单个 8 MB 请求的安顿增量七轮分别是 +11、+26、+171、+165、+10、+18、−6 MB，最后那一轮上传完宿主 RSS 比上传前还低；两个并发的那一项安顿 +44、+147、+148 MB，峰值 +44、+245、+248 MB——并发也不可复现，最大最小差三倍多。主导这些数的是 Bun 分配器（arena 增长，加上前一步 100 MB 上传延迟归还的内存），与本桥有没有把 body 留在内存里无关。断言这种数等于测分配器，且会在忙碌的 CI runner 上因与桥无关的原因变红。改成断言确定的一半：测量期间的并发上传与 100 MB 单请求都必须被接受
- 反证做了两版变异体（延迟写、延迟读）：**峰值不可分辨**，都落在真实路径的噪声带里。所以峰值采样留着当仪器，不当判决。先前一版探针只采安顿值，那读不到在途 body（落盘的和驻留的此刻都被 Bun 放掉了），改成 5 ms 间隔同步读 `/proc` 才看得见；最新归档那一轮峰值与安顿值相等，小 body 传得快时本来就没有可分辨的差
- docs: 内存表换成归档那一轮的实测（空闲 370 MB，单个 8 MB 安顿 +18 MB，两个并发 +44 MB，峰值与安顿值相等）；删掉没人复核的「100 MB 实测 2–5 秒」，改为探针每轮打印耗时（本轮 0.4 秒）；并发的告诫改写为从 128 MB 请求体上限制推（上限是每个在途请求各自的），不再挂在 RSS 上
- fix: **四处文档与实际不符**。README 与 README_ZN 各两处仍写「`omp --version` ≠ pin 只告警」——10-07 已改成失败；README 开发块缺 `test:scenario` 与 `test:install` 两行；`docs/testing.md` 说「五个起宿主的核验」，场景核验接进来之后是六个，前置说明里也没列它；探针文件头仍写「单请求上限 1 MB」，那是 128 MB 之前的话
- fix: 探针注释声称「断言的是文档承诺的规模（100 MB 一次请求）」，代码里那个状态码只被打进日志、没有断言。补上断言。说与做不同，这次是做的少
- chore: `test/rss-18.6.3.json` 入库，作为文档那张表的出处；无 `/proc` 时这组打印 SKIP 并保留旧文件，不把上一台机器的数当本轮的
- 回归：lint / tsc / `bun test` 54/54 三绿；六个起宿主的核验全过——`BLOB OK`（21 项，含 100 MB 字节一致）、`SMOKE OK`、`HARDEN OK`（29 项）、`SCENARIOS: 54 steps, 0 failed`、`PACKAGE OK`（28 项）、审批核验 `VERDICT: B`；站点 34 项渲染与 SEO 核验 `render-check: all pages OK`

## 2026-10-08 — 端到端场景核验：从产生它的通道之外去验

- test: **新增 `bun run test:scenario`**（10 个叙事 / 54 步，约 45 秒，已接进 CI 的 `host-probes`）。其余五个探针都是平铺断言，每项一个观察；这个每个场景是一条叙事，且**结尾状态从产生它的那条通道之外去验**——远程 `bash` 看文件系统与审计日志，`/blob` 的写入用宿主自己的 `read` 读回来，会话终止后去连端口。理由在代码里：留在单通道内的推理正是那 675 行文件传输面带着两个 P1 上线、100 个单测全绿的原因
- 覆盖的空白（此前零覆盖）：端口被占回落 + 告警、配置损坏 fail-closed、`--approval-mode=write` 档、宿主结束释放端口、外部改配置的生效时机、两客户端并存与 sid 归因、并发上传互不串扰、`xd://` 挂载设备、blob→宿主工具的数据一致性
- **每个场景都反证过会红**（改坏实现再跑）：`/blob` 一律覆盖写、非法 port 不 fail-closed、审计不记 sid、`DELETE` 清空整表、端口占用不回落——各自变红，且都点名是哪一步。暴露面校验删除时场景套件**不红**，那条归 `test:hardening`（实测它红两项），并写进探针文件头
- fix: **`test:install` 那项「设备名被拒」会因错误理由变绿**。它只断言 `isError`，而暴露门一去掉，调用会打到宿主、被设备自己以 `Unsupported debug action: undefined` 拒掉——仍是 isError。改为断言**是哪一种拒绝**（必须是桥的 `is not exposed by this bridge`）。与 10-07 那条「通过了却打印『没有广播』」是同一类错误的镜像：断言 A，绿的却是 B
- 途中修正探针自身三处：场景对「一律覆盖写」原本是绿的（对不存在的文件，追加与截断是同一个操作，补了显式 offset 的追加才咬得住）；`rpc()` 没有默认超时，桥没起来时会挂在占用端口上（现在恒有 20s 上限）；断言了宿主 `read` 的输出是裸内容，实际带 `[path#hash]` 头与行号（像 `cat -n`，先还原呈现再比数据）
- docs: `docs/testing.md` 新增该探针一节，含场景/通道对照表与六个注入缺陷的反证结果

## 2026-10-07 — 版本守卫从 warn 改成 fail

- fix: **「pin == 宿主版本」这条守卫此前只 warn，而它是这条不变量唯一的信号**。复发六次，`bun test` 每次红一项，但没人必须处理。宿主自己会升级（omp 有 `startup.checkUpdate`，默认开），CI 两个 job 都看不见真实宿主升过——`check` 用 frozen-lockfile 装，pin 与 lock 自洽；`host-probes` 装的就是 pin 本身，比的也是 pin。**没人必须处理的 warn 不是守卫**，所以宿主比较改成 fail，失败信息同时给出两个版本与修法
- 无宿主时仍然跳过（CI 的 `check` job 就是这种形态，无可比对象）；确实要对着别的宿主版本跑时用 `A2A_SKIP_HOST_VERSION_CHECK=1`，会打一行大声的 SKIPPED，不静默
- 三条路径都反证过：伪造一个报 `18.9.9` 的 `omp` → 如实红；`OMP_BIN` 指向不存在的路径 → 跳过；跳过开关打开 → 大声跳过
- 途中自己写错过一次断言（无条件拼了不匹配那句，于是永远不等），由「pin 已同步却仍红」暴露出来
- chore: pi-* pin 与 lockfile 同步至 **18.6.3**。18.6.3 全量回归：tsc 0 错误、单测 54/54、biome 干净、SMOKE OK（21 工具）、HARDEN OK（29 项）、BLOB OK（19 项）、PACKAGE OK（28 项）、审批探针 VERDICT B（挂起 90s，无副作用，审计 start=1 done=0）
- docs: `docs/testing.md` 此前完全没写这个守卫，补一节：四项断言各是什么、CI 无宿主时哪几项生效、跳过开关

## 2026-10-02 — 端到端每次重装：原先验的是冻结的拷贝

- fix: **`test:install` 端到端那组一直在验一份陈旧拷贝**。上一提交写的 `if (!existsSync(installedPlugin))` 表示「已装就跳过」，但 git URL 装出来的是**实体拷贝**（实测 `ls -ld` 确认非链接），冻结在装的那一刻。后果：改坏工作区的 `src/bridge.ts` 之后端到端全绿报 `PACKAGE OK`——它根本没看工作区。实测复现过
- 改为每次先 `omp plugin uninstall` 再 `omp install .`。装法用 `.`（链接，指向工作区）而不是 README 那个 git URL（拷贝）：链接保证宿主加载的就是当前代码。README 仍只写 git URL 一条安装路径——**本地安装在这里是测试夹具，不是受支持的安装方式**
- 新增一条断言：插件目录 `realpath` 必须等于仓库根，否则下面 11 项测的是拷贝不是工作区
- test:install 27 → 28 项

## 2026-10-02 — 加 `POST /blob`：原始字节上传，桥不再路径中立

- feat: **新增 `POST /blob?path=&offset=`，收原始字节**。`tools/call` 传不了二进制——宿主 `write` 吃字符串、`bash` 吃命令，调用方得先 base64。烧固件这类需求（远程把镜像推到宿主上烧写）实测要走 21 次请求（16 MB，单块用满 1 MB 上限）。`/blob` 省掉编码：每块少传 33%，两端不编解码
- **代价明确写进文档，不是疏漏**：
  - **不经宿主审批门。** `ExtensionAPI` 只有 `on("tool_approval_requested", …)`——宿主问、扩展答的方向，扩展无法主动发起审批。唯一能过审批门的写入方式是发一次 `tools/call`，而那正是这个端点要避免的编码
  - **桥自己解释路径。** 宿主有 `resolvePath()`/`expandPath()`，但那是宿主包内部模块，`BridgeDeps` 没有入口，依赖它们会在宿主移动文件时断。所以 `src/blob.ts` 自己实现 `~` 展开与相对/绝对判断——**代价是桥能写宿主能写的任何路径，无根目录、无白名单**
  - 这两条推翻了 AGENTS.md 的「不要替 omp 实现沙盒」与「桥不解释路径」，按决定记录而非默认
- 保住的一样：**审计照旧**。每次写入留一条 `tool: "blob:write"`，args 只有 `path`/`offset`/`bytes`，文件内容不进日志
- **请求体上限 1 MB → 128 MB**（`maxRequestBodySize`）。100 MB 的镜像一次请求传完，实测字节一致、0.4 秒；129 MB 是干净的 413。先单独验过 Bun 接受多大的值（16 / 128 / 256 MB 各发一个略低于上限的 body，都完整落盘），再定这个数
- **内存代价写进协议页**：`maxRequestBodySize` 是 Bun 在 handler 之前缓冲的上限，所以代价是每个在途请求的内存。实测宿主 RSS：空闲 368 MB → 一次 100 MB 上传 624 MB → 两次并发 846 MB。并发不是线性叠加（两次只比一次多 222 MB，body 流式落盘而非全量驻留），但每个在途大请求仍吃 200 MB 以上。文档明写别开十个并发
- `src/blob.ts` 里原先那道 1 MB 的 `MAX_CHUNK` 检查删掉——body 上限已在 HTTP 层挡住，留着两层限制只会让「边界在哪」有两个答案
- test: 新增 `bun run test:blob`（11 项，已接进 CI 的 `host-probes`）。字节比对是重点：HTTP 200 不证明字节到了，`size` 对也不证明内容对——第一版只断言大小，内容错了照样绿，现在每处写入都用 `Buffer.equals` 比对
- 反证：把写入改成少写一个字节，字节比对的两个断言都变红；复原后全绿。核验抓得住
- docs: 协议页新增「原始字节上传」（含「它放弃了什么」一节）；README（中英）「传文件」改为推荐 `/blob`，「安全与边界」新增 `/blob` 例外条目

## 2026-10-02 — 删掉 install.sh：安装只有 git URL 一条路

- **删除 `scripts/install.sh`（约 130 行）**。上一提交刚修好它「每次实装都失败」的 bug（手写的 `src/*.ts` 必检清单在删 `filetools.ts`/`fileguard.ts` 时没跟着删），但修一个不该存在的东西比删掉它更费：它是 `omp install` 之外的第二条安装路径，自己维护了一份模块图校验。按「不重复造轮子」，安装由 omp 保证，桥不该再给第二条路
- **安装方式收敛为一条**：README（中英）删掉「仓库根执行 `omp install .` 链本地这份」与整段 install.sh 说明，改写为「**只有这一条安装路径**」。手工软链的警告保留但独立成段——那个坑还在（`ln -s "$PWD/..."` 换个目录就链到不存在的路径，桥静默不启动而宿主不报错），只是不再依附于被删的脚本
- test:install 32 → 27 项，删掉测 install.sh 的整组（含那条「移走传递依赖必须拒绝」的反证）。随之清掉 `mkdirSync` / `realpathSync` / `renameSync` 三个未使用 import——biome 的 warning 不影响退出码，只看退出码会漏
- docs/testing.md 与 ci.yml 的 step 名同步。顺带改准两处：矩阵表原说四个核验共用 `OMP_BIN`，实际 `test:install` 不认（它要跑的 `omp install` 与被装的东西必须是同一个）；「三个宿主核验」现在是四个
- 项数实测 27（6 manifest + 3 打包 + 8 内容 + 10 端到端），不是沿用上一轮的 32

> CHANGELOG 与 brain 里的 `install.sh` 记录保留原文——那个 bug 是真的，只是修它的选择错了。

## 2026-10-02 — 端到端核验恢复；上一条「插件发现不受 HOME 影响」的结论被推翻

- fix: **`test:install` 恢复端到端**（17 → 32 项）。上一条把端到端判为「无法自动化」并写进了 README 与 docs，那个判断来自一次坏探针。实测两个目录的行为不同：`~/.omp/agent/extensions/` **跟随** `HOME`（往临时 HOME 放一个只打印标记的扩展，标记出现），`~/.omp/plugins/` **不跟随**（桥仍从真实插件目录加载，`OMP_PLUGIN_DIR` / `OMP_PLUGINS_DIR` / `XDG_DATA_HOME` 都改不动）。坏探针只试了前者，且没给临时 HOME 写 `models.yml`
- **宿主没有模型配置就不创建 session，扩展在 `session_start` 加载，于是桥永不广播**。这个症状与「插件发现忽略了我的 HOME」一模一样，单独吃过一次亏：临时 HOME 起宿主、桥没起来，一度又归因到隔离。所有起宿主的核验统一走 `test/harness.ts` 播种 `models.yml`（不可达 provider，够启动即可——桥只跑工具不推理）
- 新增第五组端到端：宿主广播监听地址 → `initialize` → `tools/list`（21 项、无 `a2a_*`、设备名不作为工具名暴露）→ 远程 `tools/call` 在本机执行并回结果 → `tools/call` 设备名被拒 → 无 token 得 401。**已验过会失败**：把插件目录移走后，那一组如实变红。反证跑了两轮才收敛——第一轮的失败详情打印了整个 `available_commands_update` 帧，一行几千字符
- fix: **`scripts/install.sh` 在完整 checkout 上必然失败**。第 94 行硬编码 7 个 `src/*.ts` 的必检清单，删 `filetools.ts`/`fileguard.ts` 时没跟着删，于是实装报 `incomplete checkout?`。手写清单是模块图的第二份真相，删模块时必然过期。改为脚本自己走**传递** import 图（裸标识符跳过——那是包名的事，不是「checkout 不完整」；路径归一交给 `realpath -m`）
- test: 第四组跑 `install.sh` 本身：临时 `OMP_AGENT_DIR` 上实装、`--status`、`--uninstall`，外加**反证**——移走 `src/bridge.ts` 传递引入的 `audit.ts`，脚本必须以 `unresolvable relative import` 拒绝。反证特意用传递依赖而非入口直连项，否则只证明了脚本读了入口那一行。移走的文件在 `finally` 里复原，核验不留脏工作区
- docs: 两版 README 与 `docs/testing.md` 里「端到端无自动化覆盖」的说法改掉，`docs/testing.md` 增一节把两个目录的实测行为与那条错误结论的来源写明
- docs: 修四处删文件传输面时漏掉的失效描述——「首次启动生成配置、token 与文件沙箱」（实测生成的 `a2a-bridge.json` 只有 `host`/`port`/`token`）、`/a2a` 「显示沙箱根与大小上限」（它只输出地址、端口、token 前缀）、`A2A_BRIDGE_AUDIT` 注为「审计路径沙箱」（实为审计日志路径）

> 上一条（2026-10-01）写的「宿主解析插件目录不受 `HOME` 影响，模拟新机器的探针一直在验真实环境里那份旧安装」——**方向对，机制错**。真实插件目录那份确实会被加载，但原因是探针没播种 `models.yml`，宿主压根没起 session，与目录隔离无关。原记录保留以说明这次误判是怎么发生的。

## 2026-10-01 — 首页与指南改写痛点：远程够不到本地设备

- fix: **CI 的 `site` job 红了**（上一提交引入）。headless 浏览器在 runner 上静默返回空 DOM（`dom=0B`），三个页面全被判 FAIL——而真因是浏览器没跑起来，不是图坏了。核验新增**控制项**：先请求一个不存在的页面（此时服务 404.html），控制项也空就以退出码 2 报「harness 坏了，下面的结果不作数」；顺带让 404 走真实的 `404.html`（此前是纯文本 `not found`）。CI 侧改为装 playwright 的 chromium 并用 `CHROME` 指过去，不再赌镜像自带哪个浏览器


- docs: hero 与 feature 卡片此前全在讲「我是什么」（协议版本、端口、token），没有一句讲「你为什么来」。改为先说痛点：Agent 跑在服务器上、设备插在本机，中间的 USB 没人能跨；hero 改为「让远程的 agent 操作你本地的设备」，tagline 落到 adb / idf / 串口工具与宿主挂载的调试设备
- docs: README（中英）新增「设备 / Devices」一节，并成为 feature 卡片「远程能碰到什么」的落点。两种形态都写清：**工具链走 `bash`**（adb、idf.py、烧录器不是 omp 的工具，是本机命令，PATH 上有什么就有什么）；**挂载设备走 `read` / `write` 的 `path`**（`read {"path":"xd://"}` 列清单，`write {"path":"xd://debug"}` 执行）
- 全部结论实测，不是推断：
  - 远程 `tools/call {"name":"bash","arguments":{"command":"adb version"}}` → 拿到本机 SDK 路径与 `Android Debug Bridge version 1.0.41`。通道通（该机当时未插设备，故 `adb devices` 为空）
  - 远程 `read {"path":"xd://"}` → `isError=false`，返回 5 个挂载设备：`xd://debug`（DAP 调试器）、`xd://lsp`、`xd://ast_edit`、`xd://omniroute_status`、`xd://omniroute_sync`
  - **`tools/call {"name":"xd://"}` 被拒**（`not exposed`）——设备不是独立工具名，只有 `read` / `write` 的 path 能到达。这是宿主的形态，桥不改写
  - `tools/list` 里一个 `xd://` 都没有（21 个工具），所以「远程能碰设备」这件事在目录上完全看不出来，只在正文里讲
- docs: feature 卡片顺手改掉三处已过期的描述（上一轮删掉的「6 个文件传输工具」「五个核验脚本」「跨机器安装」）
- docs: OG 卡片同步为痛点表述

## 2026-10-01 — 三个真实宿主核验接入 CI

- test: **核验不再需要模型凭据**。四个探针原先都拷 `~/.omp/agent/models.yml`（真实 provider + 真实 API key），这是它们只能在开发机上跑的原因。桥只跑工具、不推理，宿主启动只需要「有模型配置」——实测一个故意不可达的 provider 就能让宿主起来并把桥带起来。新增 `test/harness.ts` 提供该占位配置（`A2A_PROBE_REAL_MODELS=1` 可切回真实配置）
- ci: `ci.yml` 拆成三个 job。`check`（typecheck + lint + 单测）不变；新增 `host-probes` 装**与 devDependencies 同一版本**的宿主 omp 并跑四个核验；新增 `site` 构建文档站并跑渲染核验（`render-check` 会断言 SVG 内的标签文本与每页 SEO 头）
  - 宿主版本从 `package.json` 的 pin 读出再装，不写死：探针跑在被 pin 的版本上正是版本漂移那三次事故的教训
  - `test:approval` 在 CI 里仍占约 95s——它**故意**把 bash 调用挂到调用方超时，那个挂起就是被测行为
- 本机复跑：SMOKE OK、HARDEN OK 29/29、VERDICT B（exit 0），三者均用占位 provider

## 2026-10-01 — `test:install` 停止验证错的对象，改为核验发布包自包含

- fix: **`test:install` 一直在验真实环境里那份旧安装**。探针只设 `HOME`=临时目录，但宿主解析插件目录不受 `HOME` 影响——实测往假 HOME 装一个只会打印标记的扩展，标记没出现，真实 `~/.omp/plugins` 里那份桥却起来了。于是每一条「新机器」断言都在重测陈旧副本。`XDG_DATA_HOME`、`OMP_PLUGIN_DIR`、改 `cwd` 都试过，没有一个能改变插件发现
- refactor: 该核验改为只测它真能观测的边界——**发布的 tarball 装得上去、装完能加载**（17 项）。三组：manifest（有 `name`/`version`/`pi.extensions`、无 runtime 依赖、`files[]` 含两半）、打包（`npm pack` 出 tarball、体积 < 500KB 不含 `node_modules`、解出 `package/` 根）、内容（入口与 5 个 `src/*.ts` 都在、**从入口走相对 import 图每个模块都能在包内解析**）。第三组是关键：`files[]` 漏一个模块会**装得上、加载时才炸**，逐个断言文件名会被新增模块绕过，走 import 图才抓得到
- test: 核验自身验过会失败：`files[]` 去掉 `src/` → 5 项 FAIL；`files[]` 精确列文件但漏掉入口 import 的模块 → 精确报出 `src/scratch-mod.ts` 缺失
- docs: `docs/testing.md` 与 README（中英）如实写明 **`omp install <git-url>` 的端到端目前没有自动化覆盖**，并给出原因。恢复它要先搞清楚宿主的插件发现机制，那是独立任务——在这个核验里自己搭目录隔离，等于对别人的布局另立一套权威
- fix: 删掉核验里遗留的未使用 `OMP_BIN`（biome warning，2.x 下 warning 不影响退出码，故前一轮 lint「全绿」时没看见）

## 2026-10-01 — 把本质需求与原则写进仓库

- docs: `AGENTS.md` 新增「What this is」与「Principles」两节。本质需求一句话：**复用本机已经跑着的那个 omp**；桥只负责把调用送到，不在途中加意思。四条原则（不重复造轮子 / 不替 omp 实现沙盒 / 不按权限过滤 / 不长出第二个系统）都从这一句推出，不是并列的偏好
- docs: README（中英）「v1 边界」后加「设计取舍」段。原先这些约束只存在于对话里，仓库里没有任何地方写下，读遍代码的人会重新发明 `deny`、重新长出 675 行沙盒——本轮就是这么发生的
- 原则写完后不加解释。写长了就成了新的可解释空间，而原则的价值恰恰在于它不留余地

## 2026-10-01 — 极简：删掉文件传输与第二套权限

按「极简 / 不重复造轮子 / 不替 omp 实现沙盒 / 不替 omp 管权限」四条，桥缩回成接口转换器。**源码 1460 → 655 行，减 55%。**

- **删除桥自带的 6 个 `a2a_file_*` 工具**（`src/filetools.ts` 460 行 + `src/fileguard.ts` 215 行）。这些能力宿主工具已经给了：远程能调 `mcp__omp-host__bash`，`cat` / `base64 -d >` / `ls` / `dd` 分别覆盖 get / put / list / 分块。为此付出的代价是 675 行实现 + 1216 行测试（测试是实现的两倍），以及**一个已经证明会自己生产 P1 的状态机**：分块 seq 的 TOCTOU 写坏文件、串行化修复自身引入的活性竞态、`.tmp` 暂存目录可寻址被枚举/改写他人上传
- **删除 `deny` / `denyMCPTools`**：这是第二套权限名单，与宿主自己的工具配置可以互相矛盾，而代码里没有定义冲突时谁优先。`tools/list` 现在是 `pi.getAllTools()` **原样透传不过滤**——含 `hidden` 工具、含宿主当前对自己模型禁用的工具。**omp 是什么权限，桥就是什么权限**；要收紧就配宿主，桥不参与
- **删除 `fileRoot` 沙盒**：桥不解释路径。执行走宿主 `Main` 会话的 `getToolByName().execute()`，注入真实 `session.settings` 与 `ExtensionContext ui`，所以宿主审批门（`ExtensionToolWrapper`）照常生效，桥自己一套审批逻辑都没有——删掉 `a2a_file_*` 之后，「绕过审批门所以要自带沙盒」这个因果链也一并消失
- 配置只剩 `port` / `host` / `token` 三个字段。`config.test.ts` 与 `hardening.ts` 里随功能消失的用例一并删除；`bridge.test.ts` 改为断言**注册表原样透传**与**目录外名字一律拒绝**
- 代价（如实记）：100MB 文件不再走 MCP 通道，走 SSH/`scp`（README 早已这么建议）；`a2a_file_put` 的原子落盘（`.tmp` + `rename` + 0600）没有了，远程写文件用宿主的 `edit`/`bash`；远程会看到 `hidden` 工具——这是「不过滤」的必然结果
- 核验：`tsc` 0 errors；`bun test` 114 → **54**；`SMOKE OK`（21 工具全透传、`tools/call` 真实执行）；`HARDEN OK` 29/29；approval 核验 **VERDICT B**（bash 挂起 90s、无副作用、审计 start=1 done=0，exit 0）——审批挂起语义跨这次大改未变。`test:install` 装的是远端代码，推送后才可验

## 2026-10-01 — lint 恢复为有效守卫

- fix: **`bun run lint` 从 `5107bad` 起一直是红的**，持续到本次才修。CI 真实失败原因（`gh run view --log-failed` 查得）共 4 errors + 1 warning：`.agents/skills/.../plugin.json` 与 `skills-lock.json` 的 format（上游用空格缩进，本仓库 `indentStyle: "tab"`）、`website/.vitepress/config.ts` 与 `website/scripts/sitemap.mjs` 的 format、config.ts 的 `noUnusedFunctionParameters`
- fix: 前两个是**范围错误**而非缺陷——它们是外部 skill 安装器的产物，与 `node_modules/` 同类，只是恰好被提交进了版本库。gitignore 管「不该进版本库」，biome 管「该由本仓库负责」，这是两个维度；提交进 git 只改变它被追踪的状态，不改变它的来源。按 biome 2.2.0 的 `useBiomeIgnoreFolder` 规则（忽略目录**不写** `/**`）在 `files.includes` 加 `!.agents` 与 `!skills-lock.json`，覆盖将来安装的任何 skill
- **教训：发现守卫失效时先问「它为什么失效」，而不是逐个修它报出的错。** 逐个修是治标，下次重装 skill 即复发。与 brain 里「守卫失效的两种形态」同源——一个必然失败的检查等于没有检查，它只提供噪音，人看久了就学会无视红灯
- 遗留（未修，需另行决策）：biome 2.x 下 **warning 不影响退出码**（实测 `--diagnostic-level=warn` 仍 exit 0），所以 `noUnusedFunctionParameters` 从设计上就拦不住任何人，它被报出来只是噪音

## 2026-10-01 — 用词统一与站点核验加固

- docs: 活文档中的「探针」统一改为「核验」——`docs/testing.md`（含标题）、README（中英）、站点 nav / 侧边栏 / 首页 feature 卡片。同一个表格里原本「加固核验」与「判别探针」混用，现已一致；`test/approval-probe.ts` 是文件名，不动。CHANGELOG 与 brain timeline 内的历史条目按 append-only 保留原词
- fix: `render-check.mjs` 硬编码 `chromium-browser`——本机是这个名字，GitHub 的 ubuntu runner 是 `chromium` 或 `google-chrome`，会在 deploy 阶段因「找不到可执行文件」而非真实缺陷失败。改为按候选列表探测并支持 `CHROME` 覆盖
- fix: `CHROME` 指向不存在的路径时 spawn 抛未捕获 `error` 事件，打的是 Node 堆栈、看不到原因。补 `proc.on("error")` 给出可读信息
- docs: 首页 hero 与 feature 卡片按 adam 文风校订（见下条）

## 2026-10-01 — 新增「与 computer use 的区别」

- docs: 新增 [docs/computer-use.md](docs/computer-use.md)——按名字调工具与看屏幕猜坐标点按的差别。站点接为 `/computer-use`，进 nav 与侧边栏，首页加一张 feature 卡片
- fix: 站点文案主体此前写成「远程 omp 调用宿主 omp」——**主体搞错了**。桥实现的是 MCP `2025-11-25`，任何 MCP 客户端都能接，调用方与宿主是否同机、是否同为 omp 都不影响。hero 改为「让任意 agent 调用本机这个 omp 的工具」，tagline 补 `url` + Bearer token 与三个具体调用方（另一个 omp / Claude Code / 一段 curl）；`config.ts` 的 `description`、OG 卡、`computer-use.md` 里 6 处「远程」一并改掉。原写法把 README 的一个 `mcp.json` 示例当成了主体
- fix: **`CHANGELOG` 从未做过链接重写**——条目里的仓库相对路径（`docs/xxx.md`）在站点上是死链，VitePress 会因此构建失败。此前没暴露是因为 CHANGELOG 里一直只有站点同名的 `docs/protocol.md` / `docs/testing.md`，这次写了新的 `docs/computer-use.md` 才触发
- docs: 首页 feature 卡片由提纲腔改为句子（「单测矩阵、真实宿主 E2E 四件套、审批判别探针」这类并列名词换成「五个探针起真实的宿主 omp 跑完整流程——含跨机器安装」）；404 的 quote 原本在猜原因（「可能是链接过期」）改为陈述事实（本地址下没有 .md 文件）；footer copyright 补年份与作者
- fix: `config.ts` 里 `description` 与 `transformHead` 的兜底值曾是两份独立字符串，会各自漂移——提取为 `SITE_DESC` 单点引用
- docs: 站点文案按 adam 文风校订——首页 feature 卡片由提纲腔（「单测矩阵、真实宿主 E2E 四件套、审批判别探针」这类并列名词）改为句子；404 的 quote 原本在猜原因（「可能是链接过期」）改为陈述事实；footer copyright 补年份与作者
- 论证落在两处：执行的是宿主原生工具实现（不需要窗口摆着、不需要程序支持无头），目录是 `tools/list` 显式给出的（名字写错得 `not exposed`，坐标点错就是点到别的东西）。另附代价对照（上下文开销、宿主 token、稳定性、前提）
- 明确一处易误解：「不经过模型」指的是**宿主**这一侧，远程那台机器上的模型照旧要推理，只是把推理用来决定调哪个工具而非算坐标——两边 token 账要分开算。`a2a_file_get` 的 base64 仍进远程上下文
- docs: README（中英）「安全与边界」后各加一行指向该页；`sync.mjs` 补 `](docs/computer-use.md)` → `](./computer-use.md)` 重写（漏了会在站点构建时报断链）

## 2026-10-01 — 网站修复（4 项，含 1 项此前从未生效）

- fix: **JSON-LD 从未真正生效**——`transformHead` 写成 `["script", { type, innerHTML }]`，而 VitePress 渲染的是 `["script", attrs, innerHTML]` 三元组，`innerHTML` 被当成 HTML **属性**序列化，`<script>` 体内是空的。标签在 review 里看着齐全，爬虫读到的是零结构化数据。改为第三个元素
- fix: **`og:image` 指向 SVG**——Twitter/X、Facebook、Slack 都不渲染 SVG 社交卡片，等于没有卡片。新增 1200×630 PNG（`public/img/og.png`，可编辑源 `og.svg`），补 `og:image:width/height/alt`，`twitter:card` 由 `summary` 改 `summary_large_image`（630px 高的卡片按 summary 会被压成方形）
- perf: **每页预载 1.58 MB JS**——`withMermaid` 的 Vite 插件把 Mermaid 组件**静态**注册进 app entry，mermaid 及其约 40 个 diagram 类型因此进入 entry 的 import graph，而 VitePress 会预载 entry 的 dynamic imports，于是**每个页面**都在首屏前拉取全部 mermaid 代码，包括四页根本没有图的页面。弃用 `withMermaid`，保留其 markdown fence 渲染、组件改由 `.vitepress/theme/index.ts` 里 `defineAsyncComponent` 按需加载：阻塞预载降到 1–2 KB，空闲预取 169 KB，app entry 从 684 KB 降到 1 KB
- fix: **sitemap `lastmod` 每次部署都是当天**——原实现取构建产物的 mtime，即 CI 运行时间，等于宣称「所有页面每次都变了」，搜索引擎会直接忽略。改为取各源文件（`README_ZN.md` / `CHANGELOG.md` / `docs/**`）的最后提交日期；`deploy.yml` 的 `actions/checkout` 相应加 `fetch-depth: 0`（浅克隆无历史，git 会对所有页面返回同一个 commit，正是要避免的信号）
- fix: sitemap 的站点地址原是 `sitemap.mjs` 里硬编码的兜底常量，而 build 并不传 `SITE_URL`——与 `config.ts` 推导出的地址可能不一致。改为同一套推导逻辑（`GITHUB_REPOSITORY` → `owner.github.io` + base），`SITE_URL` 保留为本地预览的覆盖入口
- fix: `robots.txt` 原是静态文件里的**第二处**硬编码 origin（仓库改名即失效）——改由 `sitemap.mjs` 一并生成，与 sitemap 同一个地址
- fix: sitemap 的源文件映射此前漏了 superpowers 两页，会退回全仓最新提交日；补 `docs/<page>.md` 兜底。实测七页日期各不相同（superpowers 09-10、testing 09-30、其余 10-01）
- docs: 站点 UI 中文化——默认主题的界面文案是英文，zh-CN 站点上是「半成品」外观。补 `search` 弹窗与按钮、目录、回到顶部、跳到正文、外观、上一页/下一页、本页目录，以及 404 页（此前是英文的 "PAGE NOT FOUND" + 一句英文引言）
- test: 新增 `bun run check`（`website/scripts/render-check.mjs`，28 项）——**Mermaid 图是客户端渲染的，构建通过不等于图能画出来**。探针用 headless chromium 载入构建产物，断言 SVG 内的中文标签文本（mermaid 把非 ASCII 转成实体，需先解码），并检查 canonical / og:image 为位图 / twitter:card / 每页 JSON-LD 类型。已接入 `deploy.yml`
  - 写探针时踩了三个 harness 假阴性（都不是站点缺陷）：`cleanUrls` 下请求 `/protocol` 拿不到 `protocol.html`；Pages 的 base 前缀（`/pi-a2a-ext/`）没处理时 entry JS 404、页面不 hydrate，症状与「图坏了」完全一样；「parse error」正则命中的是 `protocol.md` 正文里作为 JSON-RPC 错误码讲解的 `parse error`。前两个已修，第三个改为只扫 SVG 段
  - 探针本身也验过会失败：把组件改成提前 `return` → 两页 FAIL；把 `og:image` 改回 SVG、JSON-LD 改回属性写法 → 对应两项 FAIL

## 2026-09-30 — 定位文案改写

- docs: README（中英）首段改写——去掉术语堆砌的 tagline 式表述，改为讲清实际作用：装上后运行中的 omp 多一个 MCP 接口，远程 omp 配好地址即可调用本机会话里的工具、执行本机真实文件与 shell，宿主不做模型推理故不消耗 token
- docs: 首页 hero 主副标题改为作用导向（主：「让另一台机器直接调用本机会话的工具」），副标题说明装上即多一个 MCP 接口、调用本机真实工具、宿主不做模型推理；替换原协议版本术语堆砌

## 2026-09-30 — 网站 SEO

- feat: VitePress `transformHead` 补齐 VitePress 默认不产出的 SEO 信号——每页 **canonical**、**Open Graph**（title/description/url/image/locale/site_name）、**Twitter Card**、`WebSite` **JSON-LD**（schema.org）
- feat: build 末尾生成 `sitemap.xml`（`scripts/sitemap.mjs`，扫 dist 全部 HTML 排除 404，输出绝对 URL + lastmod；CI 镜像源无 `vitepress-plugin-sitemap`，故自写），新增 `public/robots.txt` 指向该 sitemap

## 2026-09-30 — 架构图改为 Mermaid

- docs: README（中英）「工作原理」的 **ASCII 字符图换成 Mermaid 图**（`graph TB` + 高对比 classDef + Unicode 语义符号），GitHub 原生渲染为矢量图，跨平台一致
- docs: `docs/protocol.md` 的 `tools/call` 节新增 **Mermaid 时序图**（`sequenceDiagram`），画一次完整往返：远程 `tools/call` → 鉴权/查会话 → `getToolByName().execute()` → 宿主工具执行 → 受控端 TUI 的 `emitExternalEvent` 卡片显示 → 审计 start/done，三种出口（成功/未暴露/审批挂起）用 `alt` 分支标明
- build: 网站接入 `vitepress-plugin-mermaid`（`withMermaid`），使用指南页的架构图在站点内渲染为 SVG，不再是代码块

## 2026-09-30 — 受控端显示远程操作

- feat: 受控端（宿主 omp）现在会显示远程 `tools/call`——远程调用宿主工具时，宿主 TUI 按和本地操作**完全一样**的方式渲染出工具卡片（同样的卡片、同样的执行生命周期）。此前远程调用直接 `tool.execute()` 执行、受控端界面毫无痕迹，用户无从得知机器正被远程操作
- 实现：`runHost` 用同一个 `toolCallId` 包住 `tool.execute()`，前后调 `session.agent.emitExternalEvent()` 发 `tool_execution_start` / `tool_execution_end`（本就是 TUI 渲染工具卡片所依赖的事件）。这些事件只驱动渲染、**不进消息流**，故远程调用不会进入 LLM 上下文、不会扰动会话——MCP 执行链路保持天然不变，扩展只补「显示」这一环。范围仅宿主工具，`a2a_file_*` 文件传输按约定不显示

## 2026-09-30 — `/a2a token` 子命令

- feat: 新增 `/a2a token` 子命令——打印完整 token（`/a2a` 状态行与启动通知只显示前 6 位前缀，远程接入需复制完整 token 时用此命令）。`/a2a rotate` 轮换行为不变
- docs: README（中英）Commands 节同步补充该子命令

## 2026-09-30 — 安装方式修正

- feat: **`omp install https://github.com/adam-ikari/pi-a2a-ext.git` 为跨机器安装方式**——装到 `~/.omp/plugins/node_modules/pi-a2a-ext`，`omp plugin uninstall pi-a2a-ext` 卸载。已提交并推送，在全新 HOME（无 config/token/沙箱）上实测：安装 → `pi-a2a-ext@0.1.0` → 宿主起桥并自建独立 token 与沙箱
- feat: 补 `version`（此前缺失致 `omp plugins list` 显示 `@undefined`，且 `npm pack` 直接失败 `Invalid package, must have name and version`）、`description`/`keywords`/`repository`/`homepage`/`bugs`；`files: ["extensions/", "src/"]`——入口 import 的是 `../src/*.ts`，两者缺一则装上也起不来。tarball 实测 12 文件 25.8kB，不含 `node_modules`（`@oh-my-pi/*` 由宿主 shim 运行时重定向）
- docs: 记录 `omp install` 的 spec 限制——接受**目录或 git URL，不接受 `.tgz`**（报 `ENOTDIR`），GitHub `owner/repo` 简写被当作非法包名，须用完整 URL
- test: 新增 `bun run test:install`（26 项）——用独立 `HOME` 模拟另一台机器，走 `omp install <git-url>` 装到全新插件目录，再以远程 MCP 客户端身份走完整流程：manifest/打包文件、首次启动自建 config/token/沙箱、initialize 握手、文件往返、沙箱边界、鉴权、审计。这是**唯一**验证「任意机器可装」的探针——`test:files` 自己软链扩展到沙箱 agentDir，证明桥可用但完全没碰安装链路
  - 写这个探针时踩了两个 harness 坑（都由探针自身暴露，非产品缺陷）：`--print` 带 prompt 跑完一轮即退出，桥随之消失，远程调用得到 `ConnectionRefused`（须用 `--mode rpc` 且不传 prompt、stdin 保持打开）；以及以 `proc.exitCode === null` 作为轮询条件会在最后一个 stdout 分片到达前提前退出，把「桥正常」误报为「桥没起来」——最终改为**直接 HTTP 探测**（真实客户端做法），不再刮 stdout
- feat: **`omp install .` 为本地开发的首选方式**（软链仓库到 `~/.omp/plugins/node_modules/pi-a2a-ext` 并注册，卸载用 `omp plugin uninstall pi-a2a-ext`）。此前 README 只给了手写软链，从未提到 omp 自带的插件安装

- fix: **安装说明的 `ln -s "$PWD/..."` 是错的**——该写法只在 `$PWD` 恰为仓库根目录时成立；换个目录执行会链到不存在的路径（实测 `cd /tmp` 后链成 `/tmp/extensions/a2a-bridge.ts`），桥静默不启动、无任何报错。改为 `scripts/install.sh`：从 `BASH_SOURCE` 推导仓库根目录，装完**校验**软链可解析且入口 import 的模块齐备，装坏了当场报错
- feat: `scripts/install.sh` 另提供 `--status`（只报告状态，坏了非零退出）与 `--uninstall`（删软链，保留 token 配置与审计日志）；`OMP_AGENT_DIR` 可改安装位置
- fix: `--status` 用 `readlink -f` 判活时，**悬空软链会打印空串且退出 0**（`readlink -f` 对断链非零退出且无输出）——已改为比对 `readlink` 原始目标并用 `[ -e ]` 判存在
- fix: 安装目标若已是**真实文件**（用户自己的扩展），脚本拒绝覆盖并退出 1，不再静默替换
- fix: 删除 `package.json` 里无效的 `"pi": { "extensions": [...] }` 声明——`omp plugins list` 只列出已安装的 npm 插件，**不读取本地 package.json 的该字段**，故此前的「或把本仓库作为插件」从来不可用
- **revert（同一提交内更正）**：上一条是**错的**，该删除已回滚。`omp install .` 正是靠 `pi.extensions` 才能工作——`omp install --json` 显示删除后 `manifest` 为 `{}`，实测宿主不加载任何扩展；恢复后 `manifest.extensions` 有值、扩展正常加载。**判据不是「`omp plugins list` 里有没有它」（那是已安装插件列表，与 manifest 解析无关），而是 `omp install --json` 的 `manifest` 字段加上宿主是否真的加载。**

## 2026-09-30 — 双语 README（英文默认 + 中文 `_ZN`）

- docs: `README.md` 改写为**英文**（GitHub 默认展示），中文内容移入 `README_ZN.md`，两版顶部互相链接
- docs: 两版补齐此前遗漏的 `src/fileguard.ts` / `src/filetools.ts` 文件布局行与 `bun run test:files` 命令
- fix: 文档站 `scripts/sync.mjs` 改读 `README_ZN.md`——原先读 `README.md`，若不改会在中文导航「指南」下渲染英文，且语言切换行指向站外不存在的路径；同时剥掉该行（站点单语言）
- docs: brain 中 2 处硬编码 README 行号（`README:103`/`README:105`）改为章节引用，避免下次改文档再次失效；timeline 内 3 处按 append-only 保留原样（历史证据不改写）

## 2026-09-30 — 代码评审修复（文件面 4 项 + 版本漂移）

- fix: **串行化后排队中的步骤会往「已改名的死路径」写入**（P1，由修复自身引入、对抗探针抓出）——`requireTransfer` 在同步阶段取记录、变更本体稍后才在队列上跑；其间若一次 `put_end` 成功提交并已 `rename` 走暂存文件，排队中的 `put_chunk` 会让 `appendFile` **重新创建**该文件，返回 `{"ok":true,"receivedBytes":12}` 而已提交文件仍只有前 8 字节：**字节静默丢失**，且在 `.tmp` 留下一份永远无人回收的孤儿 `.part`。串行步骤内改为先 `requireLive(tr)` 重验记录仍在册
- fix: **`put_chunk` 的 seq 校验有 TOCTOU，并发重试静默损坏文件**（P1）——校验读 `expectedSeq`、自增却在 `await appendPart` 之后，同一 seq 的两个并发请求都能通过校验并都写入；未声明 `totalBytes` 时 `put_end` 报**成功**而文件已是双倍内容，声明时则整个传输报废。这不是假想场景：README 要求调用方自设超时（无 UI 时 `prompt` 审批挂起 ≥90s），超时重试正好并发打出两个相同 seq。同一 transfer 的变更步骤（`put_chunk`/`put_end`）改为串行执行，且**同 seq 同字节的重传按已收处理**（返回 `duplicate: true`）而非双写——重传是超时后的常规动作，不该损坏上传；同 seq 换内容仍报 `bad_chunk_order`。队列吞掉拒绝，单步失败不会卡死后续分块
- fix: **未翻译的宿主 fs 错误泄露绝对路径并破坏错误码契约**（P2）——`ENOTDIR`（父级是文件）、`put_end` 撞目录等原先以裸 errno + 宿主绝对路径直达调用方，既与「500 body 不得泄露宿主内部」的既定立场矛盾，也让按 `a2a_file_error <code>` 解析的客户端失效。兜底为新枚举 `io_error` + 固定文案，细节只进宿主 stderr；`put_end` 补 `is_a_directory` 预检
- fix: **暂存目录 `.tmp` 可寻址，会话绑定形同虚设**（P2）——`.tmp` 只在 `list(".")` 被过滤，直接以路径访问不受限：可枚举他人 `transferId`、读取其在途暂存字节、`put` 改写其暂存文件导致对方 `put_end` 把攻击者字节落成最终文件。首段为 `.tmp` 一律 `invalid_path`（嵌套 `sub/.tmp/x` 仍合法）
- fix: **`a2a_file_list` 跟随符号链接目录**（P3）——只过滤了子项，目标本身用 `stat` 检查，根外目录的**文件名/大小/mtime** 因此泄露；改用 `lstat` 并拒绝符号链接。文件内容始终由 `resolveInRoot` 的 realpath 包含性检查挡住，故此前仅为元数据泄露
- perf: **`a2a_file_get` 每页重算整文件 sha256**（P3）——100MB（默认 `maxFileBytes`）实测每页 76ms、整趟下载 30.4s 纯哈希，而每页只传出 256KB（400 倍读放大，且随文件平方增长）。改为**本次返回区间**的摘要：0.9s。`sha256` 语义随之明确为区间摘要，`totalBytes` 仍是整文件大小
- test: 单测 100 → **114**（新增并发同 seq 不双写、8 路同 seq 突发、乱序 seq 并发保序、200 块长传输字节精确、排队 vs 提交不写死路径、同 seq 异字节拒绝、重传幂等、失败步不卡死、`.tmp` 不可寻址、跨会话暂存不可改写、list 符号链接拒绝、错误码契约与路径不外泄、`get` 区间摘要）；真实宿主探针 `test:files` 54 → **71** 项，两条并发用例（同 seq 突发、排队 vs 提交）跑在真实 HTTP 上而非进程内
- chore: pi-* pin 与 lockfile 同步至 **18.4.4**（宿主已升级；node_modules 漂移同一机制再次复发，版本守卫如期捕获）
- ci: 新增 `.github/workflows/ci.yml`（`bun install` + typecheck + lint + test）——「pin == 宿主」不变量此前三次靠单测事后捕获，CI 的 frozen-lockfile 安装把「pin 与 lockfile 不一致」提前到提交时就失败

## 2026-09-29 — 双向文件传输（桥自带工具）

- feat: 6 个 `a2a_file_*` 工具（put / put_start / put_chunk / put_end / get / list），远程→宿主 push 与宿主→远程 pull 双向；线格式复用 A2A FilePart 的 `{name, mimeType, bytes(base64)}`，**不新增 JSON-RPC 方法**——挂进既有 `tools/list` / `tools/call`，因此鉴权、会话、`deny` 门禁与两阶段审计原样生效
- feat: 分块写入纳入首版（内联与单块 512KiB、单次读响应 256KiB，均留在 1MB 请求体上限内），单文件默认上限 **100MB**；传输状态绑定 `Mcp-Session-Id`，空闲 30 分钟惰性回收（无定时器），并发上限 16
- feat: 配置新增 `fileRoot`（默认 `~/.omp/a2a-bridge-files`）与 `maxFileBytes`，逐字段 fail-closed 校验照旧
- feat: 落盘沙箱 `src/fileguard.ts`——词法拒绝对外路径/`..`/NUL/控制字符/`.` 段，最深存在祖先 `realpath` 后必须仍在根内，根内符号链接既不顺着读也不顺着写；根创建为 0700 且拒符号链接，不得是配置文件或审计日志的祖先目录；写入经 `<root>/.tmp` 原子 `rename`，文件 0600
- feat: 审计脱敏——参数内超过 120 字符的字符串（文件 base64 正文）只记 `<len:N,sha256:前8位>`；`a2a_file_put_chunk` 整体不逐块记录，由 start/end 两条夹住
- feat: 名字冲突策略为**宿主优先**（桥工具绕过宿主审批门，故不允许反向遮蔽），首次遮蔽时宿主 stderr 一次性告警
- fix: `a2a_file_put_end` 未创建目标父目录，导致分块上传到尚不存在的子目录时 `rename` 直接 ENOENT——由真实宿主探针（`bun run test:files`）捕获，单测此前只用顶层路径而漏掉
- test: 单测 59 → **100**（新增 `fileguard` 16、`filetools` 18、`bridge` 桥工具与脱敏 4、`config` fail-closed 3）；新增真实宿主探针 `bun run test:files`（54 项，`FILES OK`）
- fix: 站点内容同步脚本用 `replace` 只改写**首个**链接，README 第二次引用同一页时留下仓库相对路径 → Docusaurus 断链、构建失败；改为 `replaceAll`
- test: 版本守卫的宿主比对用例改用 30s 显式超时——`omp --version` 冷启动实测 ~8s，恒超 bun 默认 5s 而偶发失败
- docs: `docs/protocol.md` 新增「桥自带工具：文件传输」（工具表、`a2a_file_error <code>` 稳定枚举、分块语义），`README.md` 新增「文件传输」节与威胁模型（**桥自带工具不经宿主审批门**：token 即 `fileRoot` 内读写权；pull 回的字节会进远程模型上下文，大二进制建议 SSH 旁路），`docs/testing.md` 补核验矩阵

## 2026-09-28 — 站点配色改为 GitHub Primer 中性主题

- docs: 配色/可读性改版（零新增依赖）——Infima 变量、代码块、首页、侧栏、页脚全面换为 GitHub Primer 色板，明暗双模式实拍验证
- fix: 亮色模式代码块此前恒为深色——根因是 theme-classic 按 `themeConfig.prism.theme` 运行时注入内联 CSS 变量，静态 CSS 覆盖无效；自定义主题挂载于 `themeConfig.prism`（非 preset `theme.prism`），且主题对象须为 v1 `{plain, styles}` 格式（`id`/`name`/`type` 会被 schema 拒绝）

## 2026-09-28 — 宿主 18.4.0 回归与基线修复

- docs: 站点视觉改版——品牌色板（青/紫，明暗双模式）、首页重做（渐变网格 hero + MCP 调用终端示意 + 数据条 + 特性卡图标 + 三步接入）、SVG logo/favicon、导航栏 GitHub 入口；零新增依赖（`navbar.logo` 为 3.10 中导航 logo 的正确挂载点）

- chore: `.gitignore` 收录 `.qoder/` 本地设置目录，恢复 `bun run lint` 干净基线（929b9aa）
- chore: 宿主 omp 升级至 **18.4.0**；node_modules 漂移（同一未知机制第三次复发）被版本守卫捕获，pi-* pin 与 lockfile 同步至 18.4.0（531f7a1）
- test: 18.4.0 全量回归——tsc 0 错误、单测 59/59、SMOKE OK（21 工具）、HARDEN OK 29/29、审批探针 VERDICT B（挂起语义与两阶段审计行为跨版本未变）

## 2026-09-24 — 文档补充与 P3 收尾

- docs: 站点发布至 GitHub Pages（<https://adam-ikari.github.io/pi-a2a-ext/>），push master 经 GitHub Actions 自动构建部署；`url`/`baseUrl` 按 `GITHUB_REPOSITORY` 环境感知（本地预览仍是 `/`）
- docs: Docusaurus 文档站（`website/`：构建时同步 README/CHANGELOG/docs 进生成目录 `website/content`，中文界面，首页 + 指南 + 协议 + 测试 + 变更日志 + 历史设计存档）
- docs: 新增 `docs/protocol.md`（wire 契约：传输、处理顺序、会话生命周期、方法示例、错误码总表）、`docs/testing.md`（单测矩阵、三 E2E 判读含审批探针 VERDICT A/B/C）、`CHANGELOG.md` 与 README 故障排查节
- chore: 新增 MIT `LICENSE`、`package.json` `license` 字段与 README 许可节（d4930b9）
- chore: 引入 Biome lint/format（tab 缩进、120 列、recommended 规则，2 空格 JSON 不受管），新增 `bun run lint`，存量风格归一（5b2342f）
- feat: 审计记录携带 `Mcp-Session-Id`——共享 token 下调用可归因到客户端会话（单测 + 加固探针双重断言）（c20dc4e）
- refactor: 移除全部 3 处 `as never`：`TSchema` 从 `ToolInfo` 原生流入 `toolWireSchema`，`execute()` 上下文对真实 `AgentToolContext` 逐字段校验（变异测试验证校验非空洞）（806ad85）
- fix: 500 响应体固定为 `internal error`，宿主内部细节只进服务端 stderr（e7393eb）

## 2026-09-24 — 元评审修正（第一轮收尾）

- docs: README 实话修正——无 UI 下 prompt 审批挂起 ≥90s（非 `isError`，调用方须自设超时）、默认 yolo 下 token 即工具执行全权、两阶段审计格式、宿主 omp 版本事实更正为 **18.2.10**（18.2.11 是 registry latest 的误读）（f332b4a）
- test: 真实宿主加固核验（29 项）与审批判别探针落仓为手动脚本 `test/hardening.ts`、`test/approval-probe.ts`，接入 `test:hardening` / `test:approval`（6e0414a）
- test: 版本守卫 `test/versions.test.ts`——pi-* pin 必须精确、实装 == pin 硬断言、`omp --version` ≠ pin 告警（4ffdbf7）
- feat: 审计改为**两阶段**——派发即写 `start`，未落定的调用（无 UI 审批挂起）在日志中可见（6162136）
- test: 单测审计路径 `A2A_BRIDGE_AUDIT` 沙箱化、断言与执行顺序解耦（9560729）

## 2026-09-23/24 — 评审加固第一轮

- docs: README 补充配置校验（fail-closed）、暴露语义、会话规则、审计日志与开发脚本（cf58cef）
- feat: fail-closed 配置校验（非法字段拒绝启动，仅 token 自愈并持久）、调用 ∩ 目录暴露交集门、JSONL 审计日志、端口占用回退告警（339a46b）
- fix: 协议加固——鉴权前置于一切状态变更、强制 `Mcp-Session-Id`（缺头 400 / 未知 404，通知同样受限）、版本协商固定 `2025-11-25` 不回显、会话表上限 64 淘汰最久未见（998f572）
- chore: `@oh-my-pi/pi-*` 以**精确版本**声明为 devDependencies，建立 pin == 宿主版本不变量（48d52ca）

## 2026-09-11 — 首版实现

- fix: 会话 TTL 改为命中刷新、过期条目惰性清理（d80237a）
- docs: README（安装、配置、远程 `mcp.json`、SSH 转发、审批语义）（a4ad053）
- test: 真实宿主 E2E 冒烟 `test/smoke.ts`（隔离 HOME 启动 omp、走完整 MCP 流程、`tools/call read` 落真实 Main 会话）（19a2259）
- feat: A2A bridge 核心——`Bun.serve` JSON-RPC 服务器（server/bridge/config/auth）、扩展入口 `session_start` 起服与 `/a2a` 命令（5a4bd02）

## 2026-09-10 — 设计与计划

- spec+plan: 按评审修正设计（pi-ai schema 导入路径、`buildCallTool` 签名、审批经 wrapper runner 而非 `ctx.ui`）（41ae4a2）
- plan: 实施计划 T1-T9（72bc255）
- spec: omp 即 MCP 服务器的 A2A bridge 设计（66517b1）
