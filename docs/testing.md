# 测试与核验

## 总览

| 命令 | 类型 | 需要本机 omp | 预期输出 |
| --- | --- | --- | --- |
| `bun run test:tree` | 仓库形状核验，3 项，无依赖 | 否 | `tree-probe: repo shape OK` |
| `bun test` | 单测（自动发现 `test/*.test.ts`） | 否 | 160 pass / 0 fail（12 文件） |
| `bun run test:registry` | 真实模型注册表核验，28 项，秒级 | 否 | `registry probe: all assertions met` |
| `bun run test:smoke` | 真实宿主 E2E | 是 | `SMOKE OK` |
| `bun run test:hardening` | 真实宿主加固核验，35 项 | 是 | `HARDEN OK` |
| `cd website && bun run check` | 站点渲染与 SEO 核验，56 项 | 否 | `render-check: all pages OK` |
| `bun run test:approval` | 审批边界判别核验，约 95 秒 | 是 | `VERDICT: B`（预期），exit 0 |
| `bun run test:takeover` | 宿主推理 deny/restore 核验，34 项，约 65 秒 | 是 | `takeover probe: all assertions met` |
| `bun run test:blob` | 原始字节上传（`POST /blob`），35 项 | 是 | `BLOB OK` |
| `bun run test:install` | 发布包自包含 + 端到端，28 项 | 是 | `PACKAGE OK` |
| `bun run test:scenario` | 端到端场景，10 个叙事 / 54 步，约 45 秒 | 是 | `SCENARIOS: 54 steps, 0 failed` |

统一前置（七个起宿主的核验）：PATH 上有 `omp`。`test:smoke` / `test:hardening` / `test:approval` / `test:blob` / `test:scenario` / `test:takeover` 另外认 `OMP_BIN`；`test:install` 不认——它要跑的 `omp install` 与被它装的东西必须是同一个，所以固定用 PATH 上那份。**不需要模型凭据**——`test/harness.ts` 写入一个故意不可达的 provider，宿主只要「有模型配置」就能启动，而桥只跑工具不推理（设 `A2A_PROBE_REAL_MODELS=1` 可改用真实配置）。`test:takeover` 在这条上是例外，而且是故意的：它的 provider 是一个真在听的计数 sink（`Bun.serve`，答 503）。deny 有没有把宿主推理清零，只能靠数出请求来验，不可达的凭据数不出缺席。`test:install` 的端到端那半程是另一个例外：它走 `omp install .` 装进**真实**插件目录，因为宿主解析 `~/.omp/plugins` 不受 `HOME` 影响、也没有环境变量能改道（详见下一节）。`test:smoke` / `test:hardening` / `test:approval` / `test:blob` / `test:scenario` / `test:takeover` 的宿主都跑在**隔离临时 HOME** 里：软链本仓库扩展、独立配置与审计路径、跑完即删（失败时保留现场并在 stderr 打印路径）。保留的现场不自动清理，看完手动删：一个场景核验的目录 33–53 MB，blob 核验失败时还要多留 100 MB 级别的上传，`/tmp` 是真实磁盘不是 tmpfs，攒多了会挤掉别的东西。`test:registry` 两条都不要：它不起宿主、不连网，只在 `/tmp` 下开一个临时 agent 目录。提交前基线：`bun run lint` + `bun run typecheck` + `bun test` 三绿。

七个宿主核验与文档站构建都在 CI 里跑（`ci.yml` 的 `host-probes` 与 `site` 两个 job），宿主版本从 `package.json` 的 pin 读出再装。

## `test:install` — 发布包自包含核验 + 端到端（28 项）

**核验发布的 tarball 装得上去、装完就能加载、起宿主能通。** 四组：

| 组 | 项数 | 断言 |
| --- | --- | --- |
| manifest | 6 | 有 `name`；有 `version`（否则 omp 显示 `@undefined`）；声明 `pi.extensions`（加载开关）；**无 runtime 依赖**（`@oh-my-pi/*` 由宿主 shim 提供）；`files[]` 同时含 `extensions/` 与 `src/` |
| 打包 | 3 | `npm pack` 出 tarball；体积 < 500KB（不含 `node_modules`）；解开是 `package/` 根 |
| 内容 | 8 | 入口 `extensions/a2a-bridge.ts` 与 5 个 `src/*.ts` 都在 tarball 里；从入口出发走**相对 import 图**，每个模块都能在包内解析到；确实走起来了（≥6 模块） |
| 端到端 | 11 | 每次先卸载再 `omp install .`——装的是链接，所以宿主加载的就是工作区；断言该路径不是实体拷贝；桥被发现并广播监听地址；首次启动只写 `host`/`host_llm`/`port`/`token`；`initialize` 返回协议版本；`tools/list` 非空且无 `a2a_*`（不断言具体数量——宿主装几个扩展就变几个，写死会静默过期）；设备名不作为工具名暴露；远程 `tools/call` 在本机执行并回结果；`tools/call` 设备名被拒；无 token 得 401 |

第三组是关键：入口 import 的是 `../src/*.ts`，`files[]` 漏掉任何一个都会**装得上、加载时才炸**。逐个断言文件名会被新增的模块绕过，走 import 图才抓得到。

端到端这组**每次都先卸载再装**。原先是「已装就跳过」，那是个洞：git URL 装出来的是**实体拷贝**，冻结在装的那一刻，于是改坏工作区的 `src/bridge.ts` 之后端到端那 11 项全绿——它验的是那份旧拷贝。实测过：破坏工作区、旧版核验报 `PACKAGE OK`。现在每次重装，且断言插件目录**解析到工作区，不是拷贝**，破坏工作区会如实变红并点名那个文件。

装法用 `omp install .`（链接）而不是 README 那个 git URL（拷贝）：链接指向工作区，宿主加载的就是当前代码。**本地安装在这里是测试夹具，不是受支持的安装方式**——受支持的只有 git URL 一条，见 README。

## 插件发现与 HOME：实测结论

早先这个核验断言「宿主解析插件目录不受 `HOME` 影响」，并据此放弃了端到端。**那条结论是错的，来源是一次坏探针。** 实测：

| 目录 | 是否跟随 `HOME` | 证据 |
| --- | --- | --- |
| `~/.omp/agent/extensions/` | **跟随** | 往临时 HOME 放一个只打印标记的扩展，标记出现了 |
| `~/.omp/plugins/` | **不跟随** | 桥仍从真实插件目录加载；`OMP_PLUGIN_DIR`、`OMP_PLUGINS_DIR`、`XDG_DATA_HOME` 都不能改道 |

坏探针错在哪：它只往临时 HOME 的 agent 目录放标记，没往 plugins 目录放；而且**没给临时 HOME 写 `models.yml`**。

第二点是关键，也单独吃过一次亏：**宿主没有模型配置就不创建 session，扩展在 `session_start` 加载，于是桥永远不广播**。这个症状与「插件发现忽略了我的 HOME」完全一样。写「桥没起来」的失败信息时，先看有没有这句 `No models available`。所有起宿主的核验都走 `test/harness.ts` 播种 `models.yml`（不可达 provider，够启动即可，桥不推理）。这个播种的边界要写清：它证明的是「桥不靠模型回答也能跑」，证不了「宿主不发模型请求」——不可达的请求静默失败，计数看不见。现实里确实有一条链从这个盲区漏出去：远程 `bash` 超过宿主 300 秒超时会被宿主转成后台任务，任务完成的 `async-result` 通知进会话，唤醒宿主自己的 agent 开始推理（远程 Windows 宿主实测，见 [computer-use](./computer-use.md)）。当时现有核验没有一条走后台任务路径——审批探针把 `bash` 挂住就看结论，超时转后台这条路没碰过。这条盲区由 2026-10-12 的第七核验收口：`test:takeover` 在带接管与撤掉接管两种状态下各测一次长 `bash`，唤醒链在负控那侧被真实地跑起来并数到（见「test:takeover」一节）。

所以端到端这组**不假装自己验证了干净机器**——插件发现确实无法用环境变量改道。

它每次先卸载再 `omp install .`，所以插件目录里那份永远是链接、永远指向工作区。原先
写的是「已装就跳过」，那是个洞：git URL 装出来的是实体拷贝，冻结在装的那一刻，于是
改坏工作区的 `src/bridge.ts` 之后端到端全绿报 `PACKAGE OK`——它根本没看工作区。实测
复现过。现在破坏工作区会如实变红并点名那个文件。

需要说清的是这组**测什么、不测什么**：测的是桥在宿主里能不能起来、MCP 面通不通；装到
插件目录这一步是**前置条件**，用的是本地链接，因为被测对象是当前工作区。发布路径能否
安装由 omp 保证，不在这个核验的范围内。

全过 → `PACKAGE OK`；任何一项不过 → `FAIL: <label>` + exit 1。

## `test:blob` — 原始字节上传核验（35 项）

**核验 `POST /blob` 能把字节原样放到宿主机上，且每种拒绝都成立。**

字节比对是重点，不是状态码。`200` 不证明字节到了，`size` 对也不证明内容对——第一版探针只断言 `size === 1_500_000`，内容错了照样绿。现在每处写入都用 `Buffer.equals` 比对。写入内容是 0x00–0xff 全覆盖，任何一次意外的字符串往返（UTF-8 编解码）都会立刻现形。

| 组 | 项数 | 断言 |
| --- | --- | --- |
| 字节一致 | 4 | 768 KB 无编码字节一致；**100 MB 一次请求字节一致**；3 块 500 KB 追加字节一致；129 MB → 413 |
| 拒绝 | 5 | 无 token → 401；缺 `path` → 400；空 body → 400；`offset` 与现大小不符 → 409；`offset` 非整数 → 400 |
| 仅 POST | 7 | `GET`/`PUT`/`PATCH`/`DELETE`/`HEAD`/`OPTIONS /blob` 各 → 405；文件既没被读回也没被删掉 |
| 其他 | 3 | 父目录不存在时自动创建；审计写入 `blob:write`；审计不含文件内容 |
| 失败与边界 | 14 | 操作系统层写失败不报成功（写 `/dev/full`）；失败也进审计并记为 error；只有 token 没有会话头仍能写，审计里 `sid` 为 `null`；桥没签发过的会话头同样写得成，审计里也是 `null`，不记成那个自称的 id；桥签发过的会话头原样进审计；413 不碰已存在的文件；目标是目录时整条拒绝；`~` 展到宿主 HOME、不是调用方的；相对路径落在 agent 目录；同一文件两路并发追加各自完整不互相插字节；413 不进审计 |
| 内存实测 | 2 | 测量期间的两次并发上传都被接受；这一轮的 100 MB 单请求仍返回 200 |

「仅 POST」那组是补的。接 `/blob` 进 handler 时只测了 POST，其他动词落到哪个分支没人验——于是 `DELETE /blob` 落进了 blob 的处理流程，因为 body 为空返回 400，那个状态码在说谎（读起来像「上传格式不对」，实际是「这个端点没这个方法」）。**接一个新路由时，「哪些方法会落到这里」和「这个路由做什么」是同一个问题的两面。**

100 MB 那条是会抓到旧的 1 MB `maxRequestBodySize` 的那条——它红了才算数。

「失败与边界」那组补出三个真缺陷。前两条各有先红后绿的断言，第三条没有：它落在写完与读回尺寸之间那个窗口里，摆不出来（原因见下）：

- 两个调用方同时开一个**新**文件时字节会丢。旧实现在 body 读进来之前取文件大小，两边都看到 0，都选 `w` 打开，而 `w` 在 open 时截断，第二次 open 抹掉了第一次已写入的内容。两条请求都回 200，文件只有一半。现在一律 `"a"` 打开，拿到句柄再读一次 EOF。
- 写失败既不报错也不留审计。`handle.write` 会短写（磁盘满、配额到顶），旧实现不看 `bytesWritten`，回 200 且不写审计记录，等于「一次没人知道的失败」。现在短写与抛错都记 `bytes: 0` 加错误文本，状态 500。
- 成功那条路径上的审计排在一次可抛错的读之后。写完关闭句柄，实现再从文件上读一次尺寸用于响应，读失败（文件在这两步之间被删、父目录不再可查、网络盘给 EIO）就一路冒到 handler 的兜底 catch：客户端拿 500，而这一次真实落盘的写入在日志里没有记录。三条失败路径都是先落审计再返回，唯独成功那条把它排在后面。现在审计先走，读不回尺寸就少一个字段，响应仍是 200——写成 500 会让分块上传的客户端重发同一块，而 `/blob` 只追加。

同一组里还有两条关于「谁调用」的。审计的 `sid` 是共享 token 下唯一的归因字段，而 `/blob` 过去直接照抄请求头：任何持 token 的人都能把自己的写入登记到别人的会话名下，或者编一个。MCP 那条路径在 `server.ts` 里逐条验这个头（缺失 400、未知 404），`/blob` 却不碰会话表，同一个字段在两条路径上不是一个意思。现在两条都只认桥自己签发过、还在空闲窗口内的 id；`/blob` 拿到别的值不拒，只记 `null`——拒绝会是这个端点自己在决定谁能上传。

变异验证按实现还原做（把修复前那份 `src/blob.ts` 整体放回原位，不是随手改一行）：红的正好是这两项。中途一次不忠实的变异（把 `"w"` 分支插在 `at` 赋值之前）触发 TDZ，所有请求 500，红了两条与目标无关的项。那种红不说明任何事，它只证明变异把整条路径打断了。

写失败用 `/dev/full` 来触发：open 成功，写时 ENOSPC，这是无 root 权限下唯一干净的路子。把 `/dev/shm` 填满也能达到目的，但那是全机范围的破坏，不做。

内存那组只断言「上传确实成了」，不断言 RSS 阈值，原因写在探针文件头，这里记结论：同一个 8 MB 请求的宿主 RSS 安顿增量二十五轮里从 −157 MB 跨到 +171 MB，其中三轮是负的（上传完宿主 RSS 比上传前还低）；两个并发那一项落在 −141 到 +168 MB，峰值最高 +264 MB。逐轮的数与近六轮基线不抄在这里——抄过的那份停在第十六轮就再没人更新，序列只在协议页那张内存表里维护。负值来自测量本身的位置：`空闲`基线在探针末尾取样，此刻前一步那次 100 MB 上传仍有内存没还给操作系统，基线自己一路往下衰减，每个增量量到的都是衰减的进度，量不到那一次上传。分布的宽度由 Bun 分配器决定（arena 增长加延迟归还），跟本桥有没有把 body 留在内存里无关。拿它们设阈值，测的是分配器，且会在忙碌的 CI runner 上因与桥无关的原因变红。探针每轮把实测覆盖写进 `test/rss-<宿主版本>.json`，`docs/protocol.md` 的内存表从它刷新——那页的数此前只在 18.6.1 上量过一次，没人复核就会烂在文档里。没有 `/proc` 时这组打印 SKIP 并保留旧文件，不会把上一台机器的数当本轮的。

## `test:hardening` — 加固核验（35 项）

配置种子**故意不带 token**（验证自愈）。35 项分组：

| 组 | 项数 | 断言 |
| --- | --- | --- |
| token 自愈 | 2 | 生成 43 字符 base64url（32B）并持久化；配置 0600 |
| 版本协商 | 3 | initialize → `2025-11-25`；签发会话头；请求 `1999-01-01` 仍答服务器版本 |
| 会话强制 | 4 | 带会话通知 202；通知缺头 400；请求缺头 400；伪造会话 404 |
| 鉴权放置 | 4 | 无 token 401；错 token 401；**未鉴权 DELETE 401**；会话在未鉴权 DELETE 后仍存活 |
| JSON-RPC 校验 | 4 | GET 405；坏 JSON 400；`jsonrpc: "1.0"` 400；batch 400 |
| 暴露门 | 4 | 目录含 `read`；无桥自带工具（`a2a_file_*` 一个都没有）；未注册名调用 → `isError` + `not exposed`；别名 `xd://read` 同样拒绝 |
| 真实执行 | 1 | `tools/call read` 在 Main 会话读回文件内容 |
| 审计 | 7 | `read` 的 start/done 双相；被拒的调用也有 start；所有 done 能按 id 配对到 start；**记录携带 `sid`（归因）**；审计文件 0600；**嵌到第三层的长字符串折成 `<len:N,sha256>`，正文 60 字符的窗口在日志里查不到** |
| 审计轮转 | 4 | 过 512 KB 确实轮转；轮转前后记录总数不缩水（按数量算，6 条前置 + 426 条本轮 = 429 进 `.1` + 3 留在当前文件）；跨两个文件每条 `done` 都能配到 `start`（本轮有 1 条只能在 `.1` 里配到）；`.1` 是完好的 JSONL |
| 会话终止 | 2 | 已鉴权 DELETE → 204；随后请求该会话 → 404 |

全过 → `HARDEN OK`；任何一项不过 → `FAIL: <label>` + exit 1（并打印宿主日志尾部）。

审计轮转那组此前一项都没有，写它的时候踩到自己一条：原先按「本轮发出的 JSON-RPC id 应能在日志里找到」断言，永远红不了也永远绿不了，因为日志里的 `id` 是本桥为配对生成的 UUID（`src/bridge.ts`），调用方的 JSON-RPC id 从不落盘。改成数量守恒：一次 `tools/call` 写 `start` 与 `done` 两条，N 次调用就要在两个文件里多出 2N 条。让记录变胖也不能靠一个 1000 字符的路径，`redact()` 会把超过 120 字符的字符串折成 `<len:N,sha256:...>`（约 30 字节），那样一条记录才 210 字节，越过 512 KB 需要 1241 次调用；换成 10 个 110 字符的参数之后每条约 1.1 KB，213 次调用就够，这一组从几分钟降到几十秒。

「证据会过期」不在这里测，在 `test/audit.test.ts`：那里直接灌审计模块，一秒内跑完四轮流量，先断言窗口内的记录读得到，再断言最老的两条在两个文件里都查不到。轮转只保留一代，下一次轮转覆盖 `.1`，所以 README「审计日志」里那个「只有 `start` 没有 `done` 就算挂起」的信号是有保质期的。把这条放单测而不是宿主核验，是因为它只关乎文件大小；用宿主驱动要两百多次刻意喂胖的调用，还把并发写进来的顺序噪声一起卷进来。

### 参数脱敏只走两层，而 `edit` 在第三层

`src/audit.ts` 的注释写着「走两层，工具参数不会嵌得更深」，宿主自己的 `edit` 就是反例：`{path, edits: [{oldText, newText}]}`，文件正文落在 `args.edits[0].oldText`。脱敏停在那一层之外，正文原样进日志，只有 1 KB 的参数截断挡着。现在逐层走到叶子，嵌套超过 32 层的子树整个换成 `<max-depth>`，不再往下走。

原有的那条单测为什么没抓到：它断言 `args` 字段里不含完整的 5000 字符 payload，而那个字段本来就截在 1024 字符，整段永远不可能出现，于是漏洞开着它也是绿的。新的两条在**整行日志**里查 payload 的 60 字符窗口，并另有一项把 40 层的嵌套喂进去。宿主核验再加两项：真发一次 `tools/call`，从日志这一侧确认窗口查不到、`<len:4000,sha256:` 查得到。

一处边界写进了 README：这是桥自己那份日志的承诺。宿主会话照常收到原参数，宿主的 transcript 里有什么，不归本桥管。

## 单测补齐的空白

覆盖率给出的线索有个共同形状：注释里写了承诺，测试里没有对应的断言。三处都补了，其中一处补的时候改出一处实现缺陷。

### 宿主交接那半条路径（`test/host-call.test.ts`，19 项）

`buildCallTool` 分两半。暴露门那半早有单测，把调用交给 Main 会话的那半一行 deterministic 测试都没有：它只在 `test:smoke` 里跑过，而探针在那儿能调的工具只返回文本块。`AgentRegistry.register` 接受任何对象作 `session`，`resetGlobalForTests` 就是为这种用法留的，于是这半条路径不必起宿主。

断言覆盖：text 与 image 两块原样转出（image 的 `detail` 不透传，MCP 的内容类型没有这个字段）；既非 text 也非 image 的块折成 JSON 文本；`isError` 一路到调用方与审计记录；参数按引用交给工具（桥不复制、不过滤、不校验）；工具上下文是会话状态加扩展控件，含 `hasPendingMessages` 到 `hasQueuedMessages` 那次改名；一次调用一对 `tool_execution_start` / `tool_execution_end`，`toolCallId` 是新生成的 UUID；目录里有而会话里没有的名字回 `unknown tool`。成功调用的审计记录也在这里，此前单测产出的 `done` 全是 `isError: true`，生产里最常见那条没被看过。

改出来的一处：两次 `emitExternalEvent` 坐在判定结果的那个 `try` 里。宿主不接受该事件时（会话形状来自另一个版本、事件入口不是函数）三种后果都成立：start 被拒则工具根本不执行；end 被拒则一次已经落盘的 `edit` 报成失败；工具本身抛错时，交出去的错误文本被换成渲染自己的那一条。调用方照着 `isError` 重试，就重复执行了一次带副作用的写。注释写的是「只驱动渲染」，代码没做到。现在事件的构造与发送失败都吞掉，成功与失败两条路共用同一处结果映射。

变异核验八项：去掉 image 分支、删掉 `hasQueuedMessages` 那行、把参数 `structuredClone` 一份、end 事件换一个 id、去掉 `if (!tool)`、未知块原样发出、吃掉 `isError`、不发 start。每项只让自己那条断言变红。修复本身用 `git stash push src/bridge.ts` 回到改前状态跑了一轮，恰好关于渲染事件的三项变红，其余十一项绿。

顺带一条关于 `tools/list` 的：宿主把 schema 转成 JSON Schema 的那个子程序按 WeakMap 键缓存，`parameters` 不是对象就抛。注册表里少一个 `parameters` 是可能的（自定义工具），桥那边接住并降级成 `{type: "object"}`；不接的话一个坏工具把整份目录带走。

### 500 与端口退避

`src/server.ts` 的 500 分支写着「细节只进服务端日志」，两半此前都没断言。现在让 stub 的 `getTools()` 抛一条带假宿主路径的 Error，响应体里 `/home/dev` 与 `ENOENT` 都查不到，同时 `console.error` 那一侧确实拿到了错误对象。

端口退避整条分支原先不可能被覆盖：其他测试都以 `port: 0` 起服务，而它只在配置了固定端口时生效。现在用一个真实被占用的端口断言 `fellBack` 为真、端口换了、换到的那个能用；反向一条用特权端口 1（EACCES）断它不该退避而是把错误交出，环境允许绑低端口时该项跳过。

### 审计的两条不变式与参数上限

`test/audit.test.ts` 补两条。参数里出现 `JSON.stringify` 拒绝的值（BigInt）时记录照样落盘，代价是 `args` 退化成 `[object Object]`，这是「宁可含糊也不能没有」的取舍；日志路径写不成时既不同步抛错，也不以 unhandled rejection 冒到宿主进程，`appendLine` 末尾那个 `.catch(() => {})` 至此才有断言撑着。

参数在 1024 字符截断这条是变异测出来的：把截断去掉，原先所有测试全绿。补了一项 40 个 110 字符的值（每个都低于 120 字符的叶子闸，全靠上限压住），断言记录里的 `args` 收在 1025 字符以内且以省略号结尾。记录大小近似固定，512 KB 的轮转窗口才谈得上「多少条」。

### 分派层与 `auditBlob` 的最后三处（10 项）

上一轮剩下的 `issuedSession`、`/blob` 分派与 `auditBlob`，2026-10-11 各给了断言。新的 `test/blob-route.test.ts` 起 stub 服务器、注入时钟，8 项覆盖：鉴权先于 payload 读取的 401、`DELETE /blob` 答 405 且不杀会话、三种拒绝形状既不落盘也不进日志、签发过的会话原样入录、伪造与缺头的记 `null`、`/blob` 命中刷新空闲窗口（去掉刷新行，同一条里的后一个 ping 就是 404）、open 失败带 error 入录、409 不产生第二条记录。`test/audit.test.ts` 补 2 项钉住 `auditBlob` 的记录形状：一条 `done` 不配对，失败一条带截到 200 字符的 message 与 `bytes: 0`。

变异四项：`issuedSession` 换回照抄，红的正是归因与过期那两条；抽掉刷新行，只红 TTL 那条；拆掉 DELETE 守卫，只红 405 那条；去掉 200 字符截断，只红失败形状那条。还原后 117/117。

「不存在」那几条先排空再断言：appends 排在同一条进程链上，用 `auditStart` 投一条哨兵等它落盘，它前面的行都已定局，直接 sleep 只是在猜。这是 host-call 那条 afterAll 教训的第二次 usage。

按行算，这一轮把 `src/server.ts` 从 93% 带到 100%、`src/audit.ts` 从 76% 到 100%、`src/blob.ts` 从 5% 到 79%，`src/bridge.ts` 停在 99% 没动。此前这三处写着「刻意不补单测」，理由是它们要真字节进文件系统、宿主探针已经在跑；补的时候发现那个理由站不住——临时目录里写几字节的真实文件不是假磁盘，探针验的是字节保真与竞态，这里验的是本桥的接线：拒绝形状、`sid` 归因、TTL 刷新，后两条靠注入时钟，真宿主上根本移不动。剩下未覆盖的 `162-165`（在途改 409）、`173-182`（短写）与 `184` 的写失败兜底需要满盘与真机条件，那本来就是 `test:blob` 35 项的领地。

## 释放端口的那一刻，在途那一次算什么

`src/server.ts` 的 `stop()` 原先是 `server.stop(true)`。这条在单测里从来没有对照面：入口那几条按「去连它」判释放，新建连接被拒就通过，至于断开的那一刻有没有一个请求正在处理，没人问。它现在有了自己的一条（`test/server.test.ts` 末尾，「releasing the port」）：起一个 `tools/call`，等 stub 的 `callTool` 确实在跑（一个 `entered` 标志），然后 `stop()`，断言这一次照样拿到 200 和结果文本。

强制切断的代价分两种。`tools/call` 少一行 `done`，客户端拿到 `ECONNRESET`；`POST /blob` 是整个消失——body 还没收完就断，`Buffer.from(await req.arrayBuffer())` 抛在写之前，于是文件没动、`auditBlob` 也没跑到，而那个端点是宿主审批门的例外，审计是它唯一的痕迹。非强制那一半把这两样都保住了：监听立刻关，后来的人一律被拒；已经进来的那一次处理完、返回、落审计。

同一批实测里还有一条 Bun 的缺口，记在这里是为了别把它当成已解决：非强制 `stop()` 不关释放时已经空闲的 keep-alive 套接字，`closeIdleConnections()` 在 1.3.14 只有函数名（返回 `undefined`，socket 照旧服务），`bun-types` 1.4.2 描述的「空闲连接立刻关」是更新版本的行为。所以断言「释放后不接受连接」不能走 HTTP 客户端——它会复用那根老 socket，量到的是这一半而不是监听的状态；这里用 `node:net` 裸连，并在同一条测试里先断它在释放前为 true，免得这个读数只会恒假。

变异两项：把 `stop(true)` 换回去，只红这一条，18 ms 内以 `ECONNRESET` 红；把 `server.stop()` 整个删掉，红五条——这条的裸连接断言，加入口那四条靠新建连接判释放的。

## 目录、暴露门与执行，原先读三份注册表

`buildToolCatalog` 与 `buildCallTool` 里那道暴露门都读入口 pin 住的那份 `pi.getAllTools()`，而执行每次现取注册表里 `Main` 会话的 `getToolByName`。宿主把 `pi.getAllTools()` 接到的是**那套 runner 自己的会话**（`runtime-init.ts:126`、`acp-agent.ts:2581` 都是 `() => session.getAllToolInfos()`），所以只要第一个 `session_start` 不是 `Main` 的——task 子代理与 ACP 会话都可能先走到——桥就在报出另一个会话的工具清单，同时把 `Main` 自己的名字按「not exposed」拒掉。反过来说也一样：`Main` 有而那份 runner 没有的名字，列不出来却其实能调。

改法是让这一处只有一个权威：`src/bridge.ts` 里新增 `servedTools()`，读 `Main` 会话的 `getAllToolInfos()`（宿主接 `pi.getAllTools()` 用的就是这个函数，所以常规情况下两个读数逐字相同），目录与暴露门都改读它；`AgentRef.session` 是 `null`（parked/aborted，端口还没释放的那一段）时退回那份 `pi`，因为此时报出一份宿主其实并没有的空注册表不是诚实而是添乱。于是「列出来却调不动」只剩两次读之间工具被注销这一种情形，那条断言还在。

核验落在 `test/host-call.test.ts`：harness 多一个 `pinnedPiNames`，用来把「入口那套 runner 不是 Main」这件事摆出来；假 `Main` 会话现在带 `getAllToolInfos`，与 `getToolByName` 同源。新增两项，第一项三个方向都断（目录只列 `Main` 的、`Main` 的名字照常执行、另一个会话的名字在门就被拒），第二项断 parked 时退回入口视图。第一项先红：目录交出的是那份 `pi` 的清单。

变异三项：两处都换回 `pi.getAllTools()`，红那一项；只改目录、门仍读 `pi`，红同一项（红在门那半条断言，说明两处分别被断着）；去掉 parked 的兜底，红五项——新增那两项里的兜底一项，加 `test/bridge.test.ts` 里三条依赖「没有 Main 就读入口那份」的目录测试与「registered tool with no Main session」那条。六个宿主核验重跑全绿，其中 `test:install` 的「`tools/list` 非空」与 smoke、scenario 的远程调用，走的就是这份新读数。

## 两条并发写日志，谁吃掉谁

`src/audit.ts` 的 `appendLine` 是 `stat` 查大小、`rename` 轮转、`appendFile` 落行三步，而这三步不是一个整体。两个调用同时在飞时可以都读到越过 512 KB 的数字、都去轮转，第二次 `rename` 覆盖的正是第一次刚放好上一代的那个 `.1`。被吃掉的是轮转那一刻恰好留在当前文件里的记录——也就是几毫秒前刚写下的那些——外加被换出去的一整代。这件事单独看已经够糟，配上 `/blob` 就更糟：那个端点不走宿主的审批门，审计行是它唯一的痕迹。

原有的那条轮转保留测试（`test/audit.test.ts` 第一组）看着的只是「记录会不会冲出窗口」，它每 20 对让一次路，注释里给的理由是有链子会冲过上限、把尺寸的读数弄浑——那说的是多写几行，丢数据这一半从来没有断言。

补的这条先把舞台摆成只需要一次轮转：日志灌到离 512 KB 差 200 字节以内，再同时打 60 条（每条约 1.15 KB），然后按两个文件的记录数守恒断，逐条 id 都要在。未修版本重跑六轮，落点两种：四次是 572 条里缺 59 条（本轮 60 条只剩 1 条，前置那一代还在），两次是缺 570 条（两个文件各剩 1 条，前置那一代也被吃掉）。方向只有一个——每多一次轮转，就多一批刚写下的记录连着自己所在的文件一起被覆盖掉。

改法是一个进程一条 promise 链，前一个环节写完才轮到下一个，`stat` 读到的就是上一个 `appendFile` 落完的大小。`appendLine` 把行交给链就返回，调用照旧不等磁盘；链上每个环节自带 `.catch`，于是一次写失败既不会冒到宿主进程，也不会把链子卡住让后面所有审计落不了盘。接受的代价说清楚：磁盘慢的时候，后面的行会在内存里排队。

变异三项：换回不串行的写法，只红新增这一条；去掉链尾的 `.catch`，红两条——「路径写不成」那一项（rejection 冒出来）与这条新的（前一个环节的失败卡住了链，之后的记录一条都落不了盘）；把轮转整句删掉，红的是原有那条保留测试。也就是说轮转本身、轮转的串行、串行的自愈，三样各自有人看着。

顺带一处过期维护：那条保留测试里每 20 对让路的理由在串行之后不成立了，注释按新的行为改写，让路本身去掉。

## 入口那一层（`test/entry.test.ts`，19 项）

`extensions/a2a-bridge.ts` 此前没有任何单测能引到它——不起了宿主就摸不到，而它管的是这台服务器的生死。它现在被直接 import：`$A2A_BRIDGE_CONFIG` 指到临时文件，端口写 `0`，`Main` 会话是真注册进 `AgentRegistry.global()` 的假货。不 mock 任何模块：入口的每个决定最后都要落到一个能被连接的端口上，所以断言一律是「从广播里解析出那个端口，然后去连它」。连不上就是没在服务，200 就是在服务——这比数调用次数结实，而 `mock.module` 在本机还有个硬伤：Bun 的模块 mock 是进程级的，`test/config.test.ts` 的 `loadConfig` 会被同一进程里的 mock 换掉，一次 `bun test` 就绿不回来了。

事件序列照宿主的实际行为摆：交互式宿主里 `/new` 复用同一个 runner、不再发 `session_start`，但 task 子代理、ACP 会话、持久化 revive 各建一套 runner 并重跑扩展工厂（模块图不重新求值，所以 `server`/`cfg` 共享，而 handler 是各自的）。于是 `session_start` / `session_shutdown` 是每会话的，端口是每进程的。

写不出来的那一条正好是这里的缺陷：`session_shutdown` 无条件 `server.stop()`，所以**任何一次子代理结束都会把还在服务的端口拆掉**，而主会话那边再没有第二个 `session_start` 来把它重启。修法是让释放与否取决于宿主注册表里还有没有 `Main` 会话（`hasMainSession()`，`src/bridge.ts`），这条读数本身也对着真注册表测了三种情形。顺带两处：启动失败时代码清掉了 `cfg` 却没清 `server` 的话，`/a2a rotate` 会替一个已经停服的端口报成功；`rotate` 原先先改内存再写文件，写失败就是「运行中的桥换了 token、配置文件还是旧的、而操作者收到一句失败」。

同一层还有一个缺陷：绑定不是原子的，`loadConfig` 与 `startServer` 都要 await，所以两个 `session_start` 可以在同一个 `if (server)` 检查上同时通过，各绑一套。模块只记住后一个，前一个端口没有名字，谁也停不掉，操作者还会收到两条指向不同端口的广播。这一条先是红的：并发用例里第二个 runner 从广播里解析出了一个端口号，说明它确实又绑了一套。现在的写法是后到的等前一个绑完再复用（`bringingUp`）。

同一个窗口还漏着另一头：`session_shutdown` 到达时 `server` 还是 `null`，它谁也没停，而绑定随后完成，留下的端口服务的是一个已经不存在的 `Main`，此后没有第二个 `session_start` 来纠正它。这一条也红过一轮：修复前那个端口从广播里解析得出来，说明绑定确实完成了，而它的 `session_shutdown` 早已跑完，再没有人停它。修法是把复查放在绑定之后：那一刻注册表里已经没有 `Main`，就把刚绑的端口收掉，一句广播也不发。

| 断言 | 项 |
| --- | --- |
| 广播的端口真能 `initialize`（含端口被占回落后那个新端口）、token 只出前 6 字符 | 5 |
| 配置坏了不绑任何东西并点名文件与字段；宿主没有配置文件时补写一份 | 2 |
| 绑定后失败不留半初始化状态（端口拒绝、`rotate` 报未运行、配置文件不动） | 1 |
| 两个 `session_start` 同时在途只绑一个端点，且那个端点照常被释放 | 1 |
| `session_shutdown` 落在绑定完成之前：刚绑的端口自己收掉，也不广播，后来的 `session_start` 重新绑一个能用的 | 1 |
| `Main` 槽位还在但 `session` 是 `null`（宿主的 parked/aborted）：端口照样释放 | 1 |
| 子代理结束端口仍在；`Main` 没了端口才释放；释放后新的 `session_start` 重绑 | 3 |
| `/a2a`：注册名、rotate 先落盘再生效、落盘失败则运行中的仍是旧 token、`token` 出全串而 status 只出前缀、未运行时三个子命令都拒绝 | 5 |

变异核验十项：去掉 `hasMainSession()` 那道闸、把 `rotate` 的赋值挪回写盘之前、启动失败的 catch 里不再 `stop()`、catch 里什么都不清、`hasMainSession()` 恒真与恒假、去掉在途那道闸（红的正是并发那条）、去掉绑完之后的那次复查（红的正是绑定中途结束那条）、把 `hasMainSession()` 的比较换回 `!== undefined`（红的正是 parked 那两条），各红自己那一两条。只有把广播里的端口换成配置值而不是实际绑上的那个，红了七条：端口报错了，所有「去连它」的断言一起塌。这正是把断言写成真连接的代价与好处，它不给你留「实现错了但计数对得上」的余地。

## `test:approval` — 审批边界判别核验

**要回答的问题**：宿主无交互 UI（rpc 模式）时，`prompt` 档的 `tools/call`（bash）到底是什么行为？

做法：以 `--approval-mode=always-ask` 启动隔离宿主 → 自愈拿 token → initialize → 先用 `read`（always-ask 自动放行只读工具）确认服务器活着 → 再发决定性的 `bash` 调用（副作用为临时目录里的 `touch <file>`，客户端 90s 超时）→ 检查副作用文件 → ping 存活 → 审计日志配对检查。

### 判读（VERDICT）

| 判定 | 观察 | 含义 | 退出码 |
| --- | --- | --- | --- |
| **A** | 快速返回 `isError`，无副作用 | 行为已回归为 fail-closed —— **需要更新 README 审批节**（文档落后于实现） | 0 |
| **B（预期）** | 挂起 ≥90s 被客户端中止，无副作用，ping 仍 200，`read` 仍可用，审计 `start` 有 `done` 无 | 命令**没有执行**（安全意义上 fail-closed），但调用方收不到答复——调用方必须自设超时；即 README 审批节所记行为 | 0 |
| **C** | 副作用文件存在 | **FAIL-OPEN（最坏情况）**：prompt 策略在无 UI 模式下被绕过 | 1 |
| UNEXPECTED | 返回了但不是 `isError` | 非预期返回形态 | 1 |
| 审计不可见 | 无 start 记录；或判 B 却有 done | 派发期审计被破坏 | 1 |

setup 失败（token 自愈超时、服务器起不来等）→ exit 1，stderr 打印宿主日志尾部。**失败时临时目录保留**（`evidence kept at <path>`）供事后检查；成功才清理。

## `test:takeover` — 宿主推理 deny/restore 核验（34 项）

**要回答的问题**：deny 在位时宿主自己的会话是不是真的发不出模型请求，远程把它撤掉之后恢复是不是真的生效。此前的核验答不了这个问题，原因在测量而不在覆盖：被测宿主用的是故意不可达的 provider，请求失败不出声，「零模型请求」就只是一个缺席、不是一个数。这个探针把不可达换成一个真在听的计数 sink（`Bun.serve`，答 503）——仓库里第一个真让宿主连进来的 listener。于是断言变成算术：命中数该还是命中数。

宿主按 rpc 模式起在隔离 HOME：配置 `host_llm: "deny"`，`models.yml` 的 provider 指向 sink，`bash.autoBackground.thresholdMs` 压到 1500（让唤醒链最容易触发），命令超时 120 秒。

| 组 | 项 | 断言 |
| --- | --- | --- |
| 启动装配 | 5 | deny-from-config 在 `session_start` 装上；装例行报告声明数与绊线键数；**并点名声明了谁**（本轮 `anthropic, openai-codex`——声明表第二条那条 websocket 道只有这一行能证它在不在，数量不行）；sink 的目的地在绊线键里；当前模型行被推进 deny 位（`model pushed: anthropic/…`，模型 id 不钉死，见下） |
| 桥照常工作 | 1 | 装了在位时 `initialize` 照样签发会话——接管限制的是宿主推理，不是 MCP |
| 被拒的轮次 | 4 | `prompt_result` 以 `status:"error"` 终止（不是幻影成功）；sink 零推理命中；恰好一行拒绝（哨兵文本不命中任何重试触发条件，所以只有一次尝试、`retryable:false`）；哨兵文本确实回到调用方 |
| 降噪 | 3 | 远程 3 秒 `bash` 同步跑完、没变成后台任务；期间 sink 仍零 |
| 状态读回 | 2 | 再发一次 `{"enabled": false}` 不报错，回包读回 `enabled:false` 与非零计数 |
| 恢复与负控 | 4 | `enabled:true` 回到 allow 并在 stderr 留下 `takeover restored`；**负控**：恢复后发出的宿主轮次打到 sink（这一条不绿，上面所有的零都只是「连不上」的错觉）；ON 窗口只开到数出第一个命中就切回；**恢复核对**：stderr 没有 `takeover restore left`——桥自己的恢复后核对没发现声明的 provider 没回到装配前的行 |
| 重装 | 5 | 轮次在途时切回 `{"enabled": false}`，回包报 deny；被打断的 ON 轮次照样 settle（在途重试多打了几个命中）；第二次装配在 deny 层拒掉新轮次（拒绝计数 +1）；sink 计数不再增长；**重装仍声明得到那两个 provider**（`shadowed per arm: 2, 2, 2`）——声明集是重装时从快照重算的，所以这一条是「恢复真的撤销了声明」的唯一外部可见证据 |
| 旁路 lane | 2 | 远程发 `task`（执行器自建注册表、自选模型、不问会话的那类调用者）：子代理的请求没到 sink，且子代理是被明确终止、不是安静成功。子代理拿到的不是 agent 那条 deny 行——它自己的注册表是现建的——拦住它的是目的地绊线：它发的请求最后都落到 `globalThis.fetch`，而那里每次调用现读全局，一次本地拒绝，不出网 |
| 审计 | 2 | 每次切换一条 `host_llm` 记录（实测 ≥3 次切换都有）；每条记录携带发起切换的那个 MCP 会话 id |
| pi-native | 3 | 另起一个宿主：配置里带 `transport: "pi-native"` 的 provider——装配在启动时被拒，拒绝点名拦不住的 transport，且没有「报了装上却没影子」的半状态 |
| 无降级 | 1 | 本轮没有一次装配把开关留在一个它没能 deny 的会话上（stderr 里没有「the switch is still on; this session is covered by the tripwire only」） |
| 开关关着时 | 2 | **桥自己一次模型请求都不发**——本探针上面所有的零都是在 `host_llm: "deny"` 下量的，而那是宿主本来就不该推理的配置。默认配置下把开关恢复成 allow，再走一遍 `tools/list` + 一次 `read` + 一次 `bash`：sink 的推理 POST 计数不变。harness 播种的 provider 故意不可达，所以这类请求静默失败、数不出来——正是当初造 sink 要补的那个盲区，只是这次在开关的另一侧。变异核验：让桥每次调用都按会话当前模型发一次请求 → `inference posts 1 -> 3` |

**sink 必须命名为 `anthropic`，否则这探针测不到声明那条道。** cowork 道按 provider 名判（`provider === "anthropic" && api === "anthropic-messages"`），中性名字的 sink 只走绊线，声明与撤销声明一次都不会被触发——而那正是 2026-10-13 改机制时动的半边。改成 `anthropic` 之后自定义模型与宿主内置目录合并，rpc 模式取的是第一条配置行而不是 `settings.yml` 的 `model:`（内置的 `claude-opus-5-5` 排在前面），所以断言盯 provider 不盯 model id。

两处坑是写了探针才现形的。第一处在 rpc 协议：`prompt` 发出去先回来的 `{"type":"response","command":"prompt","success":true}` 只是 ack，结果帧是后到的 `prompt_result`、按 `id` 配对。把 ack 当结果读，被拒的轮次也会读成「成功」——第一版探针就是这样，全绿，什么都没测到。第二处在 `transport: "pi-native"` 的摆放：它是 provider 级的键，写进 model 行会被 schema 静默丢掉；往配置里埋这一条的时候别猜，去看宿主 `models-config-schema-bundle` 的行号。

第三处是 sink 的计数口径：它数的是**到达网络的一切请求**，而接管承诺的是零**推理**请求。sink 改叫 `anthropic` 之后，宿主的目录刷新也会往同一个 baseUrl 发 GET——那条流量走注册表自己捕获的 fetch，既不在 deny 里也不在绊线里（设计如此，非推理出口不拦），于是 deny 窗口里出现一次 metadata GET，症状与「推理漏出去了」一模一样。计数因此按方法分开：POST 是断言对象，非 POST 单独计数并在收尾行打印。**探针量到的比它承诺的多，是这类改动最容易埋的假阳性。**

第四处是断言本身不成立：把「恢复后宿主轮次打到 sink」当成「声明被撤销了」是错的——agent 自己那行是单独恢复的，绊线也已经撤了，所以拿掉撤销声明这一步它照样绿（实测）。撤销声明的外部可见证据只有两条，都已加进探针：桥自己的恢复后核对不报 `takeover restore left`，以及下一次装配仍声明得到那两个 provider。变异核验两条：拿掉 `clearSourceRegistrations` → 第一条红并点名 `anthropic, openai-codex`；保留记忆的声明集而快照已影子化 → 第二条红（`shadowed per arm: 2, 2, 0`）。这两条也是修复的来源，见 CHANGELOG 同日那节。

失败语义与其他探针一致：任何一项 FAIL → exit 1，临时目录保留并打印路径；全过 → `takeover probe: all assertions met`。

## `test:registry` — 真实模型注册表核验（28 项，秒级）

**要回答的问题**：接管在**宿主的数据结构**上做了什么。上面七个探针问的都是一段时间里的行为——一轮对话、一个审批弹窗、一个后台任务把 agent 叫醒。这个探针问的是宿主的 `ModelRegistry` 本身，而它问得动，因为那个注册表可以在进程内直接造：`AuthStorage.create` 加一个 `new ModelRegistry(...)`，对着 `/tmp` 下的临时 agent 目录，就能拿到真实的内置目录（18.8.7 上 5457 行、七十多个 provider），不起宿主、不开 TUI、不连网。

这一档是 2026-10-13 那轮评审缺的。读 `src/takeover.ts` 只会得到「它把每个 provider 重新注册一遍，恢复时清掉这些注册」；拿真实注册表一跑才知道那两次调用对**别的扩展注册过的** provider 做了什么——名字被抢走，而且不还：`clearSourceRegistrations` 是宿主的「这个扩展卸载了」，不是「撤销那一次调用」。当时 138 个单测全绿，代码也全绿。

| 组 | 项 | 断言 |
| --- | --- | --- |
| 装配声明面 | 3 | 只声明两条非 fetch 道所属的 provider（本轮 `anthropic,openai-codex`）；其余 provider 保持自己的 api（它们归绊线管）；装配不再重算整份目录（15–17ms，旧机制 288ms） |
| 被声明者的目的地 | 1 | 对被声明 provider 的目的地发一次 fetch，被拒 |
| 未声明者的目的地 | 2 | 对**别的扩展**注册的那个 provider 的目的地发 fetch，同样被拒（它在绊线键里）；一个无关目的地不被拦——「不是桥该裁的」也是断言 |
| 恢复 | 4 | 恢复后逐行比对：0 少、0 多、0 变（9 个字段 × 5457 行）；agent 拿回原来那行；deny api 注销；`enabled:true` 之后 fetch 不再被拦 |
| 别人的注册 | 1 | **本探针存在的理由**：另一个 source 注册的 provider 在一次 arm/restore 之后行数不变（旧机制下是 2 → 0） |
| 装配途中抛错 | 5 | `setModel` 抛错：错误传出去；agent 那行没动；deny api 没注册；fetch 已换回；`enabled` 读回 true——也就是端点对「恢复」的回答不会是在骗人 |
| 宿主剪枝 | 1 | 宿主自己的 `syncExtensionSources` 剪掉这个合成 source 之后，重装一次仍然在位（`session_start` 的重装是幂等的） |
| 换会话 | 6 | **重建后的会话**：第二个 `ModelRegistry`（同一份配置，revive 与 ACP 挂载带来的就是它）接走 deny——新注册表被声明 35 行、旧的拿回自己的行、agent 那一行跟着会话走（旧的恢复、新的被拒）；一次被拒的请求只计一次（绊线没有层层包住自己，操作员的拒绝计数不能漂）；恢复之后新注册表也拿回自己的行 |

**为什么「重建后的会话」只能在进程内验。** 试过在宿主探针里用 rpc 的 `new_session` 驱动，结果是它根本不重建会话：`AgentSession.newSession()` 保留同一个会话对象与监听器（`agent-session.ts:9659` 的注释原话是 "Listeners are preserved"），只是清空消息，等于 `/clear`，不发 `session_start`。而 `session_start` 全宿主只有三个发射点——`runtime-init.ts:212`（建会话时）、`acp-agent.ts:2662`（ACP 挂载）、交互式 UI——rpc 对 **Main** 一个都不暴露。所以换主会话这件事在宿主探针里根本驱动不了，本探针用第二个真实注册表把它 stood in for：重建的实质就是「同一份配置上一个全新的注册表」。

**ACP 那条路也堵死了，这条是量出来的。** `acp-agent.ts:2662` 确实是第二个真实发射点，看起来能在同一个进程里既重建会话又带着桥，所以实测了一次：起 `omp --mode acp`（临时 HOME、`host_llm: deny`、配置与其它探针同形），ACP 的 `initialize` 有正常应答（`protocolVersion: 1`、`agentInfo.version 18.8.7`），但**扩展根本没被加载**——stderr 里一次都没提到 extension，进程一个端口都没在听，`/a2a` 连不上。也就是说 ACP 模式不加载 `~/.omp/agent/extensions/`，那个发射点对桥不可达。两条路都试过之后，这项覆盖的阻塞不在桥这一侧，而在宿主没有为 Main 暴露重建口；要它得宿主加一个 rpc/ACP 钩子。

这条也解释了为什么降级状态在真实宿主上验不了：降级需要「开关开着 + 换主会话 + 新目录里有拦不住的道」，而换主会话这一步就驱动不了。降级的覆盖留在 `test/takeover-arm.test.ts` 的 stub session 上（读出 `degraded`、恢复后清掉、拒绝排在恢复之前——三项各有变异）。

写这一档的时候顺手现形了两件事，都不是探针的毛病：默认目录里有一条 `preferWebsockets: true` 的 Codex 行，所以「碰到 websocket 行就拒绝装配」会让 deny 在开箱状态下根本装不上——而那条道是按 **api** 判的，因为宿主把 `providers.openaiWebsockets` 这个设置逐次转发给 provider 调用，一行一个标志并不成立，于是那张表按 api 写；另外 deny 副本必须摘掉 `resolveHeaders`，否则 pi-ai 在 api 分派之前会先跑 provider 的 `!command` 取密钥程序。

变异核验：把声明面改回「每个 provider 都声明」，本探针红 5 项，其中决定性的一项是 `myprov rows 2 -> 0`；换会话时若不把旧会话的 deny 还回去，红「拿回自己的行」与「agent 那一行跟着会话走」两项。

失败语义与其他探针一致：任何一项 FAIL → exit 1，临时目录保留并打印路径；全过 → `registry probe: all assertions met`。CI 的 `check` job 跑它（不需要 omp，秒级），`host-probes` 不收。

## `test:scenario` — 端到端场景核验（10 个叙事 / 54 步）

其余五个探针是**平铺的断言**：每项一个观察，彼此独立。这个探针反过来——每个场景是一条有头有尾的叙事，而**结尾状态要从产生它的那条通道之外去验**：

| 场景 | 结尾从哪条通道验 |
| --- | --- |
| `/blob` 写进去的东西，宿主 `read` 读得回来 | 宿主自己的 `read` 工具（桥的路径解析是它自己的事，只比字节会漏） |
| 远程 `bash` 的副作用 | 文件系统 + 审计日志（记录里的参数必须点名那个文件） |
| 两个客户端共用一个 token | A 的 `DELETE` 之后 B 仍可用；审计里两个 sid 都在 |
| 外部改配置 | 运行中的服务器只认启动时的 token；重启后新 token 生效 |
| 配置端口被占 | 广播的端口不是被占那个，且带告警，桥在新端口可连 |
| 配置损坏 | **不广播**、宿主仍活着、报错点名文件与字段 |
| `--approval-mode=write` | 读立刻答（25ms），`bash` 无答案（挂住），审计留下 start 无 done，桥仍可用 |
| 宿主结束 | 端口不再接受连接 |
| 8 路并发上传 | 每个文件只有自己的字节，且没有两个文件同尺寸 |
| 挂载设备 | `read {"path":"xd://"}` 不报错（实测本机 5 个设备） |

**每个场景都反证过会红**，方法是把对应的实现改坏再跑：

| 注入的缺陷 | 变红的那一步 |
| --- | --- |
| `/blob` 一律覆盖写，不追加 | 「文件现在包含两段且有序」「第一段没被第二段截断」 |
| 非法 `port` 不再 fail-closed | 「不广播」「报错点名文件与字段」 |
| 审计不记 `sid` | 「记录带调用方会话 id」「审计归属到两个客户端」 |
| `DELETE` 清空整张会话表 | 「B 不受 A 终止影响」 |
| 端口占用时直接抛错不回落 | 「在另一个端口广播」「宿主告警」「桥在新端口可连」 |
| 暴露面校验删除 | 场景套件**不红**——归 `test:hardening` 管（实测它红两项） |

第一轮反证时场景套件对「一律覆盖写」是绿的：对一个还不存在的文件，追加与截断是同一个操作。补了一段显式 offset 的追加才咬得住。同一轮反证还揪出探针自身的两个毛病——`rpc()` 没有默认超时，桥没起来时会挂在占用端口上（现在恒有 20s 上限）；以及 `test:install` 那项「设备名被拒」只断言 `isError`，暴露门一去掉就会因为**设备自己**拒了而绿——理由错了也绿。

这套场景**不覆盖**什么，各由谁管，写在 `test/scenario.ts` 的文件头：暴露面与协议层拒绝归 `test:hardening`，单次 `/blob` 的字节一致性与 offset 冲突归 `test:blob`，prompt 档挂起归 `test:approval`，发布包自包含归 `test:install`。

## 版本守卫（`test/versions.test.ts`，`bun test` 的一部分）

「pin == 宿主版本」是手工维护的不变量，复发过七次。四项断言：

| 项 | 断言 | CI `check` job（无宿主） |
| --- | --- | --- |
| 精确 pin | `@oh-my-pi/*` 用精确版本，无 `^` `~` | 生效 |
| installed == pin | `node_modules` 与 `package.json` 一致 | 生效（frozen-lockfile 装的就是 pin） |
| 两个 pin 一致 | `pi-ai` 与 `pi-coding-agent` 同版本（lockstep 发布） | 生效 |
| 宿主 == pin | `omp --version` 与 pin 相同 | **跳过**（无宿主可比） |

第四项以前只 warn，那是这条不变量唯一的信号恰好落在没人必须处理的地方：宿主自己会升级（`startup.checkUpdate`，默认开），而 CI 两个 job 都看不见——`check` 用 frozen-lockfile 装，pin 与 lock 自洽；`host-probes` 装的就是 pin 本身，比的也是 pin。**没人必须处理的 warn 不是守卫**，所以它现在 fail。

失败信息同时给出两个版本与修法。确实要对着别的宿主版本跑时用 `A2A_SKIP_HOST_VERSION_CHECK=1`，会打一行大声的 SKIPPED 日志，不会静默。宿主二进制认 `OMP_BIN`。

## 约定

- `test/*.test.ts` 被 `bun test` 自动发现；核验脚本（`smoke.ts` / `hardening.ts` / `approval-probe.ts`）故意不带 `.test` 后缀，只能手动跑，避免 CI/本地把真实宿主进程拉起来。
- 环境变量：`OMP_BIN`（宿主二进制）、`REPO`（仓库根，脚本默认自推导）、`A2A_BRIDGE_AUDIT`（审计日志路径，默认 `<agentDir>/a2a-bridge.log`）、`A2A_SKIP_HOST_VERSION_CHECK`（设 `1` 跳过版本守卫的宿主比较，见上一节）。
- 判定性结论（如审批挂起语义）必须由核验复核，不以源码阅读或推理代替——这是本仓库评审沉淀的规矩。
