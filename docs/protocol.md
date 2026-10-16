# 协议参考

omp A2A Bridge 实现 MCP（Model Context Protocol）`2025-11-25` 的 Streamable HTTP 子集，所有响应为纯 JSON（无 SSE 流）。权威实现是 [`src/server.ts`](../src/server.ts)；本文与代码冲突时以代码为准。使用侧背景（安装、配置、威胁模型）见 [README](../README.md)。

## 传输

| 项 | 行为 |
| --- | --- |
| 端点 | MCP 侧不校验 URL path，任意路径的 POST/DELETE 均受理；惯例用 `/`（`http://127.0.0.1:<port>/`）。例外是 `/blob` 与 `/host-llm`，见「原始字节上传」「宿主推理切换」 |
| POST | 单条 JSON-RPC 2.0 消息；**不支持 batch**（顶层数组 → 400）；请求体上限 128MB（`maxRequestBodySize`，`/blob` 与 MCP 路径共用） |
| GET | `405` 空响应体（不实现 SSE 端点与流式推送） |
| DELETE | 结束会话，见「会话生命周期」 |
| 其他方法（PUT 等） | `405` |
| 响应头 | 一律 `Content-Type: application/json`；`initialize` 额外返回 `mcp-session-id` |
| CORS | 不发送（回环工具，非浏览器场景） |

## 一个进程，一套端口

服务器是**每进程**的资源，而宿主给它的两个事件是**每会话**的：task 子代理、ACP 会话、持久化 revive 都会新建一套 extension runner 并重跑本入口（模块图不重新求值，所以 `server`/`cfg` 是共享的）。入口的职责就是把这两者对上：

- 第一个 `session_start` 绑定端口，之后的 `session_start` 静默复用同一个服务器，不再广播。绑定这一步不是原子的（`loadConfig` 与 `startServer` 都要 await），所以两个 `session_start` 可以同时在途：后到的等前一个绑完，不另起一套。各绑各的会留下一个谁也停不掉的端口，操作者还会收到两条指向不同端口的广播
- 交给宿主执行的工具属于注册表里的 `Main` 会话（每次调用现取），而审批与通知属于**第一个** `session_start` 那份 `ctx`，之后不再换。交互式宿主里那正是主会话；`/task` 子代理的 `ctx` 没有可用 UI，若让它先占住这份引用，写入类调用会一路挂住
- `session_shutdown` 只在宿主注册表里已经没有 `Main` 会话时释放端口。这里的「没有」按 `AgentRef.session` 是不是 `null` 判：宿主把这个字段注释成「Null exactly when parked/aborted」，槽位还在但会话是 `null` 的那种，`tools/call` 本来也只会回一句 `main session not available`，留着端口只是占着一个没人能用的接口。子代理结束（或被 idle-TTL 停泊）会发出这个事件，那时端口照常服务主会话
- 绑定这一步要 await，所以那个事件可能落在端口落地之前：它手里还没有端口，谁也没停，而绑定随后完成，留下的端口服务的是一个已经不存在的 `Main`。绑完之后再按同一条判据看一次注册表，已经没有 `Main` 就把刚绑的端口收掉，一句广播也不发。这条复查不会挡住正常启动：宿主三个模式（tui、rpc、print）都是在会话已经建好之后才发 `session_start`（`runtime-init.ts:212`、`extension-ui-controller.ts:320-329`），那一刻槽位后面的会话是非 null 的
- 主会话结束时这条判断也就没有 `Main` 可看了：交互式宿主的 `session_shutdown` 是进程退出那一步发的（端口随进程释放），会话型宿主在 dispose 里注销注册表条目。核验只看一件事——没有 `Main` 之后端口不再接受连接，有 `Main` 期间端口一直在
- 释放的动作是**非强制**的 `server.stop()`。强制（`stop(true)`）会把正在处理的那一次一刀切断：客户端拿到 `ECONNRESET`，`tools/call` 的审计只剩 `start` 那一行；`POST /blob` 更彻底，body 还没收完就断，于是写不发生、`auditBlob` 也不发生，一次上传无迹可查地没了——而审计是这个端点唯一的痕迹。非强制那一半实测（Bun 1.3.14）：监听立刻关，之后新建连接一律被拒；已经进来的那一次照常处理完、返回、落审计
- 同一批实测里还有一条偏差要记着：非强制 `stop()` **不关**释放时已经空闲的 keep-alive 套接字（`closeIdleConnections()` 在这个版本只有函数名，返回 `undefined`，socket 照旧；`bun-types` 1.4.2 写的「空闲连接立刻关」是更新版本的行为）。所以释放前就连着、之后仍保持着连接的那一方，在它那一根旧 socket 上还能被服务：`tools/call` 只会拿到 `main session not available`，`/blob` 则仍然写得进去。核验一律按「新建连接被拒」判释放，且用裸 TCP 去连——走 HTTP 客户端的连接池复用，量到的就是这一半而不是监听的状态。这一半是 Bun 的缺口，不是这里已经解决的事

## 原始字节上传

`POST /blob` 收原始字节，用来把固件、镜像这类二进制放上宿主机。**它存在的理由是「不会挂」，省体积是次要的。** 宿主自己的写入工具（`write`、`edit`）与 `bash` 都过审批门；审批配成 `prompt` 而调用方无交互 UI 时那道门等不到应答，实测挂起 ≥90s 不返回（见「审批」，审批核验每轮都跑这一条，预期 `VERDICT: B`）。无头调用方在那种配置下唯一不挂的写入路径就是这条——它不过审批门，在那个场景里正是它存在的理由。`tools/call` 传不了二进制是第二层理由：它只能传字符串，调用方得先 base64。

```
POST /blob?path=<p>[&offset=<n>]
Content-Type: application/octet-stream
Content-Length: <n>

<原始字节>
```

| 查询参数 | 语义 |
| --- | --- |
| `path` | 必填。`~` 与 `~/x` 按宿主 HOME 展开，相对路径按宿主 agent 目录解析。**不设根目录，不设白名单** |
| `offset` | 省略则追加到文件末尾；给出则必须等于当前文件大小，否则 409。不允许写进文件中部。这个比较在拿到文件句柄之后又做一次：body 读进来要时间，期间文件可能被别的写入长大，显式 `offset` 的调用方说了字节属于哪里，位置变了就整条拒绝，不会把字节放到别处却回报你那个 offset |

响应 `200` 带 `{written, offset, size, path}`。`size` 是写完之后再从文件上读回来的那一个。这一步会失败：文件在关闭句柄之后被删掉，父目录不再可查，网络盘给一个 EIO。那种时候写字节已经成功，所以响应里少了 `size`，其余三个字段照旧。桥不猜一个总数，也不用 `500` 回报一次已经落盘的写入，因为分块上传的客户端把 `500` 当作「这块没进去」，重发之后 `/blob` 照样追加，同一块进文件两次。拒绝情形：

| 状态 | 条件 |
| --- | --- |
| `401` | 无 Bearer token（与 MCP 路径同一个 token） |
| `400` | 缺 `path`；body 为空；`offset` 非非负整数 |
| `500` | 打不开或写不进目标（父目录建不出来、`path` 是个目录、权限不够、磁盘满）。这些是操作系统的答复，原样带回并把 `path` 写进消息；目录那种是整条拒绝，不存在「写进去一半」 |
| `409` | `offset` 与当前文件大小不符（打开前后各查一次，第二次针对在途变化） |
| `413` | 请求体超过 128 MB（`maxRequestBodySize`，与 MCP 路径同一个上限）。Bun 在 handler 之前就拒了，所以既不碰文件也不写审计 |
| `405` | `/blob` 只接受 `POST`。`GET` 不会读回文件，`DELETE` 不会删文件——它不会误落进 MCP 的「结束会话」分支 |

每次写入在审计日志里留一条 `tool: "blob:write"` 的记录，args 只有 `path`/`offset`/`bytes`——**文件内容不进日志**。走到 handler 的失败同样记录，`bytes: 0` 加一段错误文本，所以「写了 16 MB」与「试过且没写成」在日志里分得开；被 413 挡在 handler 之外的不记录。磁盘满或配额到顶会让 `write` 短写，那种回 `500` 而不是 `200`，响应带上已经落盘的 `offset`/`size`。

这条记录排在回读尺寸之前落盘。反过来的话，一次跟写入无关的失败会把该端点唯一的痕迹一起带走：字节在盘上，日志里没有。

`sid` 只填桥自己签发过、还在 24 小时空闲窗口内的会话 id。`/blob` 不用会话头做准入判定（token 是唯一的门，不带会话头也照样写得成），但这个字段是记录里唯一说明「谁调用」的东西：照抄请求头，任何持 token 的人都能把自己的写入登记到别人的会话名下，而共享 token 正是它存在的理由。所以签发过的 id 在这里同样刷新空闲计时，没签发过的一律记 `null`，与不带会话头同样处理。

### 没有下载，这是有意的

`/blob` 只做上传。读取仍走宿主工具，而宿主侧有三处限制叠在一起：`read` 单行超 150 KB
直接拒绝、`bash` 输出超 768 字节就截断并指向 `artifact://N`、`read artifact://N`
自己又截断在约 150 KB。加一个 `GET /blob` 能绕过它们，可桥就从此要**读**宿主任意路径，
比写更敏感（SSH 私钥、`.env`）。所以这里不做，实测的三个限制原样列出来，让客户端知道
`GET` 的 405 是设计决定，不是还没做。

### 内存

`maxRequestBodySize` 是 Bun 在 handler 之前缓冲的上限，所以代价是**每个在途请求**的内存，不是预分配。`test:blob` 每轮实测宿主 RSS 并写进 `test/rss-<宿主版本>.json`（同名覆盖；宿主换版本时文件名跟着变，旧版本那份留在 `test/` 里当历史。下表是最新那份，宿主 **18.11.0**，2026-10-16）：

| | 宿主 RSS |
| --- | --- |
| 空闲 | 461 MB |
| 一次 8 MB 上传后（安顿值） | 479 MB（+18 MB） |
| 8 MB × 2 并发后（安顿值） | 505 MB（+43 MB） |

这一轮的在途峰值是 +18 / +43 MB，安顿 +18 / +43：两项都与峰值相等。**这轮的宿主又换了版本**（18.10.4 → 18.11.0，宿主自己升的），所以并发那一项同样只当量级看：上一轮是 +36，这一轮 +43。同一份代码、同一个 Bun，只是宿主换了版本——这也是为什么这张表的数字只能当量级看。峰值与安顿之间的三种关系这些轮次里都出现过：峰值高于安顿（第十九轮 +29 / +258 对 +20 / +168，第二十五轮的并发那一项）、低于安顿（第十八轮 +0 / +58 对 +17 / +45）、与安顿相等（第二十一轮的两项，第二十轮的并发那一项，第二十二轮的单个那一项，第二十四轮的两项，第二十五、二十六、二十七、二十八轮的各项，第三十一轮的两项）。**这些数字只能当量级看，峰值与安顿之间不构成排序。** 三十一个轮次的单个 8 MB 安顿增量依次是 +11、+26、+171、+165、+10、+18、−6、−157、+91、+18、+9、+34、+131、+151、+27、+23、+17、+17、+20、+21、+24、+22、−57、+24、+18、+14、+22、+17、+19、+23、+18 MB，其中三次为负；两个并发那项安顿为 +147、+148、+44、−141、+99、+32、+16、+52、+138、+144、+157、+160、+38、+45、+168、+51、+40、+40、−56、+40、+20、+38、+38、+44、+91、+36、+43 MB，峰值为 +245、+248、+44、−141、+100、+32、+33、+52、+140、+148、+243、+264、+38、+58、+258、+51、+40、+41、−32、+40、+39、+38、+38、+44、+128、+36、+43 MB。连`空闲`基线自己都在动：近十二轮依次是 485、468、488、549、467、477、491、482、484、476、487、461 MB，跨度 88 MB——其中的 549 是宿主换到 18.8.7 后的首轮，比前五轮高出的六十来兆没去查原因，先按同一口径量级看待。负值出在取样位置上：`空闲`在探针末尾读，那一刻前一步那次 100 MB 上传仍有内存没还给操作系统，基线自己一路往下衰减，于是每个增量量到的是衰减的进度，量不到那一次上传。分布的宽度来自 Bun 分配器（arena 增长，加上延迟归还），跟本桥有没有把 body 留在内存里无关。探针每轮重跑并覆盖同名 json（宿主换版本时文件名跟着变，旧版本那份留在 `test/` 里当历史），所以本表是**最近一次实测**，不是稳定值。同一天里同一版本跑几轮，归档的也只有最后那一份。阈值要对着整个分布设，建在这上面的任何阈值测的都是分配器当天的状态，会在忙碌的 CI runner 上因与桥无关的原因变红。

能确定的是规模：100 MB 一次请求传完（探针每轮打印耗时；同一天里 0.3 秒与 2.3 秒都出现过，这个数跟着机器当时的负载走，所以表里不固定写它），请求体上限 128 MB，超出是干净的 413。

**并发要保守，理由在上限本身。** 上限是**每个在途请求**各自的，所以十个并发的 100 MB 上传就是十份各自 100 MB 的缓冲——这个算术不用实测。真实峰值取决于 Bun 怎么分配，上面那些数说明不了。要更大的文件就分块：`/blob` 追加到 EOF，分块是一个循环。

### 它放弃了什么

这是这个端点存在的原因，也是它的代价，写在这里以免被当成疏漏：

- **不经宿主审批门。** `tools/call` 的写入走宿主自己的 `write`，因此过审批（`ExtensionToolWrapper`）。这里直接落盘。`ExtensionAPI` 只有 `on("tool_approval_requested", …)`——那是宿主问、扩展答的方向，扩展无法自己发起审批；唯一的近似做法是发一次 `tools/call`，而那正是这个端点要避免的编码。
- **桥自己解释路径。** 宿主有 `resolvePath()` / `expandPath()`，但那是宿主包的内部模块，`BridgeDeps` 里没有任何入口，依赖它们会在宿主移动文件时断掉。所以 `src/blob.ts` 自己实现 `~` 展开与相对/绝对判断——**代价是桥现在能写宿主能写的任何路径**。
- **桥自己的两份文件就落在这个解析根下。** `a2a-bridge.json` 和 `a2a-bridge.log` 都在 agent 目录里，相对 `path` 也解析到这里。两处都改写不了：写入只追加，`offset` 又必须等于当前尺寸。能做的事有两种。往配置尾部追加垃圾，下一次 `loadConfig` 解析失败，桥拒绝启动；往日志里灌量，越过 512 KB 就轮转，再一代把 `.1` 覆盖掉，更早的记录在两个文件里都不存在。两种都不是新的可达范围，能做这些的已经握着 token，而「能写任何路径」这条代价本来就是按这个前提记下的。

README「安全与边界」一节按这个前提写。

### 请求处理顺序

错误按以下顺序**先到先判**（例如「未鉴权 + 缺会话头」这一条，鉴权在前，给出 401）：

1. HTTP 方法（非 POST/DELETE → 405）
2. 鉴权（→ 401）
3. `/blob` 与 `/host-llm` 路由（各自受理 `POST`；这两条路径上的其他方法 405，不进 JSON-RPC 分支）
4. body 解析（→ 400 parse error）
5. JSON-RPC 形状校验（→ 400 invalid request）
6. 会话强制，仅对非 `initialize` 消息（→ 400 / 404）
7. `notifications/*` 前缀 → `202` 空响应体
8. 方法分发（未知方法 → `-32601`）
9. 兜底异常 → 500（细节只进宿主 stderr）

## 宿主推理切换

`POST /host-llm` 是桥第二条不属于工具的路。它开关宿主自己会话的模型请求能力：body `{"enabled": <boolean>}`，`false` 在当前 `Main` 会话上装 deny，`true` 按 takeover 的快照恢复（deny api 注销、被声明的 provider 恢复、原始模型行放回、fetch 引用还原、settings overrides 撤销）。响应 `200` 带 `{enabled, denied, degraded}`——`enabled` 是这次调用之后的状态，`denied` 是进程启动以来被拒的模型请求计数，`degraded` 是下面那条降级状态。重复的 `{"enabled": true}` 不报错：没装的时候恢复就是空操作。这个端点不进 `tools/list`，理由与 AGENTS.md 同源：目录透传的是宿主注册表，而这是桥对宿主做的事，不是宿主的工具，不该藏进工具列表里。

deny 是三层的并集，分工按「每条推理请求最后从哪个口出去」划的，判据读自宿主自己的代码（`pi-ai/src/utils/transport-fetch.ts` 是所有推理请求必经的那一个 fetch）：

- **deny api + 宿主当前持有的模型行。** `a2a-deny` 注册成自定义 api，它的 `streamSimple` 只计数、只失败；`agent.setModel` 把宿主 agent 手里那一行换成同一行的 deny 副本（agent 持有的是它捕获的 `Model` 对象，不是查表）。宿主自己那一轮因此在建请求之前就被拒：一次尝试，不进重试循环，也不去解析凭据（deny 副本不带 `resolveHeaders`，否则 pi-ai 会在 api 分派之前先跑 provider 的 `!command` 取密钥程序）。返回错误 `a2a-bridge takeover: host inference is disabled in this mode`，这句话不命中宿主的任何重试触发条件，真实宿主上实测被拒的一轮只发起一次、以 `retryable: false` 终止。
- **目的地绊线。** 包一层宿主进程的 `globalThis.fetch`，URL 主机匹配快照里任一 `baseUrl` 的请求一律拒绝。pi-ai 的取 fetch 顺序是 `options.fetch ?? globalThis.fetch`，取的是全局绑定、每次调用现读，所以这层盖住所有走 fetch 的推理请求——包括自建注册表、不问会话的那类调用者：task 执行器、web 搜索、commit 消息。
- **注册表影子化，只声明不得不声明的那两个 provider。** 有两条道不是 fetch：cowork 道（`provider: anthropic` + `api: anthropic-messages` 时宿主换一个 `node:https` 直连客户端）和 Codex 的 websocket 道（`api: openai-codex-responses`，且宿主把 `providers.openaiWebsockets` 这个设置逐次转发给 provider 调用，所以是按 api 判、不是按行上的标志判）。这两条道的 provider 名字被重新注册到 deny 后面；默认装法下是 73 个 provider 里的 2 个。

另有一个降噪层按住会让宿主自己忙起来的自主源（长命令自动转后台、宿主侧重试、advisor、TTSR、prewalk、autolearn、cache warming、自动压缩），全是运行时 override，不落盘。

**为什么只声明这两个。** `ModelRegistry.registerProvider(name, …, sourceId)` 会把 `sourceId` 记成这个名字的所有者，而别人已经拥有时它先把在位者的运行期状态清掉再接管（overlay、动态模型管理器、discovery 状态、运行期 api key）；公开 API 里唯一的撤销 `clearSourceRegistrations` 是「这个扩展卸载了」，不是「撤销那一次调用」。所以「把目录里每个 provider 都影子化」等于删掉别的扩展注册过的每一个 provider，一次装配删一次、永不恢复——2026-10-13 在真实注册表上实测：一个扩展注册的两行 provider，一次 arm/restore 之后变成零行。同时那个合成的 source id 会进宿主的 `#registeredProviderSources`，而下一次建 session 时的 `syncExtensionSources(扩展路径表)` 会把它当已卸载的扩展剪掉。于是这张表按「哪条道逼的」来写，能不声明就不声明；`restoreTakeover` 也不再假设撤销一定干净，而是拿快照核对被声明的 provider，逐个点名没回来的。

**启动状态与生命周期。** 配置字段 `host_llm`（`"deny" | "allow"`，缺省 `allow`）只决定启动状态。值为 `deny` 时入口在每次 `session_start` 都装一次：绑定端口之前装（端口开着而注册表没影子，等于给早到的调用方留一个宿主还能自己推理的窗口），会话重建之后也装——revive、ACP、task 子代理都会新建 runner，新的 `Main` 会话带着没被影子化的新注册表，端口在不在状态说明不了注册表的状态。**运行期由远端打开的 deny 同样在每次 `session_start` 重装**：宿主自己的扩展源对账可以把影子剪掉，重装是幂等的（`bun run test:registry` 有一项就盯这个）。切换从不落盘，重启回到操作员写下配置时的状态。装例行会把声明的 provider 名字打出来（`takeover armed: 2 provider(s) shadowed (anthropic, openai-codex), 68 tripwire key(s), model pushed: …`）——声明是把名字从原主人手里拿走，而注册表还不回去，所以操作员看得见的只有这一行，探针也靠它才分得清声明表里那两条道各自在不在。`/a2a` 显示的是运行态：`host_llm=deny denied=2`。

**降级状态。** 两种拒绝不能读成同一种。启动时拒绝（什么都没装）→ `enabled: true`，宿主按自己的规则推理，这是诚实的读数。而**开关开着的时候拒绝**（会话重建了，新会话的目录里有拦不住的道）→ 开关仍开着、进程级的绊线仍在，但新会话没拿到 deny 行、也没拿到声明，于是两条非 fetch 道在它上面是裸的。这时回包带 `degraded: true`，`/a2a` 显示 `host_llm=deny (tripwire only)`，stderr 与审计各留一行说明。装配的拒绝检查排在恢复旧会话**之前**就是为了这个：先恢复再拒绝，等于在失败的路上把绊线也拆了，操作员要 deny 得到的却是连绊线都没有。

**拒绝情形。** 判定顺序与 `/blob` 一致（方法 → 鉴权 → body → 动作）：

| 状态 | 条件 |
| --- | --- |
| `401` | 无 Bearer token（与 MCP 路径同一个） |
| `400` | body 不是 JSON，或 `enabled` 不是布尔 |
| `501` | 服务器没接 takeover 开关（只可能出现在单测自建的服务上） |
| `500` | 装配被拒：没有活的 `Main` 会话，或模型配置里有不在被声明名单里的 provider 带 `transport`（`pi-native` 及任何在 api 分派之前短路的 transport）；响应 `error` 就是原因原文 |
| `405` | `/host-llm` 只接受 `POST`；`DELETE` 不会结束会话 |

装配过程中任何一步抛错都整体回滚再把错误抛出去：agent 那一行、deny api 的注册、fetch 兜底、设置 override 都回到装配前，端点照常返回 `500` 并把原因记进审计。半装状态是最坏的一种——宿主推理被关掉，而端点对「恢复」的回答是「已恢复」——2026-10-13 评审在真实注册表上量到过：抛错后 5457 行全部处于 deny，而 `setEnabled(true)` 回答 `{"enabled": true}` 且救不回来，只有重启宿主能了事。

每次切换在审计里写一条 `tool: "host_llm"`，args 只有 `enabled`，被拒时多一个 `error` 字段。拒绝同样要记——「有人试过装 deny，桥说不行」正是这份日志存在的用途。启动时（配置就是 `deny`）装配被拒不走端点，那里没有调用方也没有 `sid`，所以记的是 `sid: null` 的一条，外加宿主 stderr 一行与界面一条提示：toast 会滚走，审计不会。`sid` 的处理与 `/blob` 相同：只认桥自己签发过的会话，外面来的头记 `null`。

### 它放弃了什么

- **provider 名字的所有权抢不回来。** 被声明的那两个 provider 若本来就是某个扩展运行期注册的（不是 models.yml 里配的），一次 arm/restore 之后那份注册不会回来：撤销原语没有这个能力。恢复时会点名（`takeover restore left N provider(s) not serving their pre-arm rows …`），不点名就是骗人。
- **不走 `globalThis.fetch` 的请求桥管不着。** 注册表在构造时捕获了自己的 fetch，宿主的目录与元数据 GET（模型列表、目录刷新）因此出得去——**即使那个主机名就在绊线键里**。实测每轮探针的 sink 都会收到一次非 POST，收尾行把它与推理 POST 分开打印。非推理出口不拦是设计如此，但「键内的主机一定被拒」这句话是错的，README 与模块头按实测措辞写。
- **`transport` 拦不住。** 那种 transport 在宿主内部先于扩展注册的任何实现分派，桥排不到它前面。快照里出现「不在被声明名单里的 provider 带 transport」时 `applyTakeover` 在改动任何状态之前抛错——拒绝装配好过装一半。需要 deny 的地方，改的是配置，不是桥。
- **绊线盯的是宿主进程。** `bash` 工具里发出的 `curl`、task 起的进程都在别处，绊线到不了。`deny` 不是网络沙箱，也不自称是。子代理那条路实测封着：它自建注册表、自选模型，deny 状态下它的请求在 fetch 边界被拒（一次本地拒绝，不出网），以同一条 sentinel 结束。
- **运行中新加的 provider 不在 deny 里。** 桥跑着的时候编辑 `models.yml` 新增的 provider，要等下一次装配（重启，或 true→false 再切一次）才进快照、才被绊线盯上。
- **`/login` 把模型所有权交回宿主**（sourceHandoff）。对被声明的那两个 provider，这会让影子失效：影子盖的是桥注册的行，宿主重新掌管的注册表不在它手里。
- **接管期间宿主把模型行换回真行也没用**，它落在绊线上；但恢复时不会把它换回 deny 副本——那是操作员的选择，不是桥该抹掉的状态。
- **`title.generator` 没有关这个值**（枚举只有 `fork | tiny`），宿主仍会尝试生成会话标题；尝试在 deny 层失败关闭，错误通知可能出现在会话里。
- **被拒的轮次仍是轮次。** 宿主会话历史里留下一条错误消息。takeover 限制的是宿主能做什么，不是它记得什么。

## 鉴权

每个请求（含 `initialize` 与 `DELETE`）在任何状态变更之前校验：

- 头：`Authorization: Bearer <token>`，scheme 大小写不敏感（`/^Bearer\s+(.+)$/i`）。
- 比较为常数时间（先比字节长度）；失败返回 `401`，响应体 `{ "jsonrpc": "2.0", "id": null, "error": { "code": -32000, "message": "unauthorized" } }`。
- 不返回 `WWW-Authenticate` 头。token 来源与轮换见 README「配置」「命令」。
- token 的强度下限写在配置装载里：`a2a-bridge.json` 里现成的 token 少于 32 个字符，或者含空白，`loadConfig` 按其他字段同样的 fail-closed 处理，抛错，桥不起。这里故意不自愈：换一个更强的 token 会把某人自己写下的那份换掉，远端 `mcp.json` 从此 401，而日志里没有任何一句解释为什么。生成出来的是 43 个字符（32 随机字节，base64url），下限留在 32，拦的是手填的占位值，不是从别处拷来的秘密。
- 鉴权失败不进审计日志，进宿主 stderr：第一次一条，此后每 50 次一条（`[a2a-bridge] N unauthorized attempt(s)`）。这份日志是 `POST /blob` 唯一的痕迹，而它只保得住一代记录；把写入开放给还没鉴权的流量，等于让任何没有 token 的人用洪水面把真实记录推出窗口。会话错误（缺头 400、未知 404）与 `tools/list` 同样只在响应里体现，不留记录。

## 会话生命周期

1. `POST initialize`（**不需要**会话头）→ `200`，响应头 `mcp-session-id: <uuid>`。**每次** initialize 都签发一个新会话。
2. 此后的**所有**请求与通知都必须携带 `mcp-session-id: <uuid>`。
3. 每次命中刷新 24 小时空闲计时（TTL 跟踪的是空闲时间）；上限 64 个会话，满时在新 `initialize` 处淘汰最久未见者。`POST /blob` 带合法会话头时同样算命中，但它带别的值不会被拒：那个头只用于归因，见「原始字节上传」。
4. 主动结束：已鉴权的 `DELETE` → `204`，幂等（未知或缺失会话头同样 `204`，只是不删任何东西）。
5. 会话是宿主**进程内存态**：宿主重启即全部失效；过期与不存在的会话统一返回 `404 unknown session`。

## 方法

### `initialize`

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-11-25" } }
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "omp-a2a-bridge", "version": "<package.json 的 version>" }
  }
}
```

- `protocolVersion` **恒为** `2025-11-25`：服务器只说一个版本，不回显请求值（请求 `1999-01-01` 也得到 `2025-11-25`）。
- `params` 其余内容被忽略。
- 响应头 `mcp-session-id` 即新会话 id。

### `ping`

→ `200 { "jsonrpc": "2.0", "id": <id>, "result": {} }`。用于存活探测（挂起调用之后服务器仍应答 ping）。

### `tools/list`

→ `200 { "result": { "tools": [ { "name", "description", "inputSchema" } ] } }`

- **无 `nextCursor`**：单页返回全量（宿主 omp 客户端的分页循环在缺省游标时正常终止）。
- `inputSchema` 为 JSON Schema 2020-12（由宿主工具的 typebox schema 经 `toolWireSchema` 导出）。
- 内容 = 宿主 `Main` 会话的工具注册表（`AgentSession.getAllToolInfos()`——宿主也正是用它接出 `pi.getAllTools()`），**原样透传不过滤**：含 `hidden` 工具，也含宿主当前对自己模型禁用的工具。桥不贡献任何自己的工具，也不解释权限——语义详见 README「安全与边界」。目录、暴露门与执行读同一份注册表，所以「列出来却调不动」只剩两次读之间工具被注销这一种情形。没有活的 `Main` 时（parked/aborted 到端口释放之间那一段）退回入口那份 `pi` 的视图，而不是报出一份宿主其实并没有的空目录
- 请求可带 `params.cursor`，被忽略。

### `tools/call`

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "read", "arguments": { "path": "/etc/hostname" } } }
```

三种出口：

1. **成功 / 工具内部拒绝**：一律 `200`，`result = { "content": [...], "isError": <bool> }`。工具抛错（审批拒绝、参数校验失败等）进 `isError`，**不**变成 HTTP 错误。`content` 元素为 `{ "type": "text", "text" }` 或 `{ "type": "image", "data", "mimeType" }`；宿主侧工具结果的类型就只有这两种，第三种（自定义工具绕过类型声明）折成 `text` 的 JSON，桥不把客户端解析不了的内容类型发出去。image 这条路径是真的：`AgentToolResult.content` 的声明就是 text 与 image 两种，宿主 `read` 的文档写明支持图像文件，浏览器截图与图像生成工具也产出 image 块，`data` 是 base64。宿主侧的 `detail`（OpenAI 的分辨率提示）在 MCP 的内容类型里没有对应字段，因此不透传。
2. **未暴露**（不在注册表里，含别名如 `xd://bash`）：`200` + `isError: true`，text 含 `not exposed`。未注册与不存在**共用同一文案**，不泄露名字是否存在。
3. **审批挂起**（宿主无交互 UI 且工具为 `prompt` 档）：**没有响应**——请求会一直挂起（实测 ≥90s）。调用方必须自设超时；审计日志留 `start` 无 `done`。详见 README「审批」。

补充：

- `arguments` 原样透传给宿主工具执行（在宿主 `Main` 会话上下文中）。桥自己的日志把超过 120 字符的字符串折成 `<len:N,sha256:前8位>`，**逐层折到叶子**，宿主 `edit` 的正文落在 `args.edits[0].oldText`（第三层）也在覆盖范围内；宿主会话收到的还是原参数，宿主的记录不由本桥管。
- 每次 `tools/call`（包括被拒绝的）都写一对审计记录，见 README「审计日志」。日志有两处读者容易踩空的地方，`test:hardening` 第 9b 组实测过：其一，记录里的 `id` 是本桥为配对生成的 UUID，**不是**调用方发来的 JSON-RPC id，所以按 JSON-RPC id 查日志查不到任何东西；其二，轮转只保留一代（过 512 KB 就把当前文件改名成 `.1`，下一代再把 `.1` 覆盖掉），因此日志是一份滚动窗口：后续调用把它推过两代，一次挂起的 `start` 证据就从两个文件里同时消失。用日志判挂起，要在轮转窗口内读，且要把 `.1` 与当前文件一起看。落盘按进程一条队列串行，因为 `stat` 查大小、`rename` 轮转、`appendFile` 写行这三步不是一个整体：两个并发写都读到越过上限的尺寸就会都轮转，第二次 `rename` 覆盖的正是第一次放好的那个 `.1`，被吃掉的是那一刻还留在当前文件里的记录。这条不是假想——同一份未串行的代码重跑六轮，最坏的一次两个文件各剩 1 条，测试摆到磁盘上的 572 条记录里有 570 条在两个文件里都找不到；最轻的一次是并发那 60 条只剩 1 条。串行之后「一代窗口」才是文档里那个意思：只由尺寸决定，不由并发决定。
- **记录先于响应落盘。** `tools/call` 的 `start` 在工具真正执行之前落盘，`done` 在响应发出之前落盘；`POST /blob` 的五个出口同理。拿到的 200 意味着那一行已经在盘上，调用方紧接着读日志不必轮询。这一条以前是反的：落盘走进程内一条队列、调用方不等它，于是响应会跑在记录前面，而它是**偶发**的——只有磁盘慢到队列排得上时才看得见。实测代价是每条记录约 99 µs（`stat` + `appendFile` + `chmod`，串行），对着一次 bash 调用或一次文件读取可以忽略；慢的磁盘推迟的是响应，不是记录，这正是要的取舍。队列本身仍然从不 reject，所以写失败不会变成一次失败的调用（记一条 stderr，计入 `auditWriteFailures()`）。附带修好的还有那个证据设计本身：`start` 一旦不排在工具执行之前，「进程死在调用中途、只剩 `start` 没有 `done`」这条判据就是假的——工具的副作用会先落地，那个窗口里崩掉就什么痕迹都不留。
- `params.name` 缺失按空串处理（走向出口 2）。

下面的时序图是 `tools/call` 的一次完整往返，含受控端 TUI 的显示与审计：

```mermaid
sequenceDiagram
    autonumber
    participant C as 远程 omp<br/>MCP client
    participant B as 桥<br/>server.ts + bridge.ts
    participant S as Main 会话
    participant T as 宿主工具
    participant U as 受控端 TUI
    participant A as 审计日志

    C->>B: POST /tools/call<br/>Bearer token + mcp-session-id
    B->>B: 鉴权 · 查会话 · 查暴露
    alt 未暴露（名字不在注册表）
        B-->>C: 200 isError=true<br/>"not exposed"
    else 审批挂起（无 UI + prompt 档）
        B-->>C: 无响应（挂起，调用方自设超时）
    else 正常执行
        B->>U: emitExternalEvent(tool_execution_start)
        B->>S: getToolByName(name).execute()
        S->>T: 执行真实工具
        T-->>S: AgentToolResult
        S-->>B: 结果
        B->>U: emitExternalEvent(tool_execution_end)
        B->>A: 审计 start / done
        B-->>C: 200 { content, isError }
    end
```

图上那两条 `emitExternalEvent` 只管渲染：受控端的 TUI 因此把一次远程调用画成与本地调用相同的卡片，同样的开始/结束生命周期。它们不参与返回值判定。宿主若不接受这个事件（会话形状来自另一个版本、事件总线的入口不是函数），桥照常执行工具、照常把工具自己的结果与错误文本交给调用方。这两个调用此前坐在判定结果的那个 `try` 里，于是渲染失败能让一次已经落盘的 `edit` 报成失败，也能把工具真正的错误换成渲染自身的错误；调用方按 `isError` 重试，就重复执行了一次带副作用的写。

`toolCallId` 每次调用新生成（UUID），不复用调用方的 JSON-RPC id：宿主按 id 渲染卡片，复用会把两次远程调用合成一张。

### `notifications/*`

方法名以 `notifications/` 开头（如 `notifications/initialized`）→ `202` 空响应体。仍需通过会话强制（缺头 400 / 未知 404）。

### 未知方法

→ **HTTP 200** + `{ "error": { "code": -32601, "message": "method not found" } }`（注意是 200，不是 404）。

### 无 id 消息

严格 JSON-RPC 中无 `id` 即通知、不应有响应；本服务器只认 `notifications/` 前缀——其他无 id 消息会得到 `id: null` 的响应。客户端应按规范用 `notifications/` 发通知。

## 错误码总表

| HTTP | JSON-RPC `code` | `message` | 触发条件 |
| --- | --- | --- | --- |
| 401 | -32000 | `unauthorized` | 缺失/错误的 Bearer token |
| 400 | -32700 | `parse error` | body 不是合法 JSON |
| 400 | -32600 | `invalid request` | batch 数组、`jsonrpc` ≠ `"2.0"`、`method` 非字符串、非对象 body |
| 400 | -32000 | `missing mcp-session-id` | 非 `initialize` 消息未带会话头（请求与通知同样处理） |
| 404 | -32000 | `unknown session` | 会话不存在或空闲超 24h（过期条目顺带清理） |
| 405 | — | （空体） | GET 或非 POST/DELETE 方法 |
| 500 | -32603 | `internal error` | 服务器内部异常；**响应体固定为该文案**，细节只打到宿主 stderr（`[a2a-bridge] internal error:`） |
| 200 | -32601 | `method not found` | 未实现的方法 |
| 200 | （result） | `isError: true` | 工具侧拒绝 / 未暴露（text 含 `not exposed`） |

所有错误响应体形如 `{ "jsonrpc": "2.0", "id": <id 或 null>, "error": { "code", "message" } }`。

## 客户端接入时序

1. `POST initialize` → 记下响应头 `mcp-session-id`。
2. （可选）`POST notifications/initialized` → 202。
3. `POST tools/list` / `POST tools/call`，都带 `Authorization` 与 `mcp-session-id` 两个头。
4. **每次调用设置超时**（审批挂起时唯一能解开客户端的手段；用审计日志判定挂起）。
5. 退出时 `DELETE`（可选，释放会话槽位）。

与宿主 omp 自带 MCP 客户端实测兼容（协议 `2025-11-25`、纯 JSON 响应、initialize 后自动附带会话头）。远端跨机场景用 SSH 转发，见 README「跨机转发」。

## v1 未实现面

resources、prompts、SSE 推送、调用取消、并发/速率限制、OAuth/TLS——完整边界见 README「v1 边界」。

