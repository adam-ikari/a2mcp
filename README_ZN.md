# omp A2A Bridge

[English](README.md) | 简体中文

这是一个 omp 扩展。装上之后，本机跑着的 omp 会多开出一个 MCP 接口（MCP 是 agent 调用外部工具的标准协议）：另一个 omp、Claude Code、一段 curl 脚本，任何说 MCP 的程序都能通过它调用这台机器上的工具（`read`、`bash`、`edit`……），命令在本机的 shell 里真跑，文件在本机的磁盘上真改。扩展自己从不请求模型：收请求、跑工具、回结果，推理在调用方那一侧。默认只监听 `127.0.0.1`，跨机器要用 SSH 端口转发接进来。

## 什么时候用哪个

宿主自带 `omp acp`：编辑器（比如 Zed）启动它，把提示词交给它，它自己调模型、自己干活，
结果流回编辑器显示。**要一个能替你干活的本地 agent，用它。**

本桥不干活。发过来的是工具名和参数，桥把它们交给宿主执行，再把结果原样送回——**推理发生在
调用方。** 所以你要的如果是「我自己推理，只借你这台机器的手脚」，用本桥。

两者没法互相替代。`ssh host 'omp acp'` 也不行：那启动起来的是另一个会自己推理的
agent，不是你手上那套模型。

| | `omp acp` | 本桥 |
| --- | --- | --- |
| 谁推理 | omp | 调用方 |
| 传输 | stdio | Streamable HTTP + Bearer |
| 谁连上来 | 代码编辑器 | 任何 MCP 客户端 |

## 工作原理

```mermaid
graph TB
    subgraph Remote["🖥️ 远程 omp（MCP client）"]
        Client["🔌 MCP 客户端<br/>mcp__omp-host__read"]
    end

    subgraph Host["🏠 宿主 omp（MCP server）"]
        direction TB
        Serve["⚙️ src/server.ts<br/>Bun.serve · 鉴权 + 协议<br/>tools/list · tools/call"]
        Bridge["🌉 src/bridge.ts<br/>Main 会话的注册表"]
        Tools["🛠️ 宿主真实工具<br/>read · bash · edit"]

        Serve -->|"getToolByName().execute()"| Bridge
        Bridge --> Tools
    end

    Client -->|"HTTP/JSON-RPC<br/>2025-11-25 · Bearer token"| Serve

    classDef client fill:#FFE66D,stroke:#F08C00,color:#000
    classDef server fill:#4ECDC4,stroke:#0B7285,color:#fff
    classDef tool fill:#A8DADC,stroke:#1864AB,color:#000
    class Client client
    class Serve,Bridge server
    class Tools tool
```

- 扩展在 `session_start` 时启动 `Bun.serve`，实现 MCP `2025-11-25` 的 `initialize` / `tools/list` / `tools/call`，响应为纯 JSON（无 SSE）。
- 端点是**每进程**一个，而宿主的 `session_start` / `session_shutdown` 是**每会话**一个（task 子代理、ACP 会话、持久化 revive 各有自己一套 handler）。后来的 `session_start` 复用已起的服务器（同时在途的两个只绑一个端点）；`session_shutdown` 只在宿主注册表里没有活的 `Main` 会话时才释放端口（宿主把 `AgentRef.session` 注释成「parked/aborted 时恰为 null」，而 `tools/call` 本来就拒绝那个状态），否则任何一次子代理结束都会把还在服务的端口拆掉。若那个事件落在绑定完成之前，它手里还没有端口可停，于是绑定的那一方完成后回头看一眼注册表：`Main` 没了就把刚绑上的端口收掉。释放用的是非强制的 `stop()`：监听立刻关、新建连接一律被拒，而已经在处理的那一次照常跑完并落审计——强制切断会让 `tools/call` 少一行 `done`，让 `POST /blob` 整条上传不留记录地消失。
- 目录、暴露门与执行读同一份注册表：宿主的 `Main` 会话（`getAllToolInfos()`，宿主也正是用它接出 `pi.getAllTools()`），执行随后就在同一个会话上按 `getToolByName` 解析名字。没有活的 `Main` 时（parked/aborted，端口尚未释放那一段），目录退回绑定它的那套 runner 自己的视图，而不是报出一份宿主其实并没有的空注册表。
- 目录就是宿主注册表本身，桥不过滤（见「安全与边界」）。
- 桥自己从不请求模型：一次远程调用就是「收请求 → 跑工具 → 回结果」。但执行落在宿主的真实会话里，工具留下的会话级副作用可能唤醒宿主自己的 agent，那次推理花的是宿主的 token（见「安全与边界」）。宿主能不能自己推理，这件事本身也归远程接管：见「宿主推理接管」。

## 安装

任意机器上，从 git URL 装：

```sh
omp install https://github.com/adam-ikari/pi-a2a-ext.git
```

它会装到 `~/.omp/plugins/node_modules/pi-a2a-ext`。卸载：

```sh
omp plugin uninstall pi-a2a-ext
```

**只有这一条安装路径。** `omp install` 本身也接受目录和 npm spec，但本扩展不提供
本地安装方式：装的就是上面那个 git URL 对应的仓库。`package.json` 里的
`pi.extensions` 字段是告诉 omp 该加载哪个入口文件的，**不要删掉它**。

URL 必须是完整的 `https://….git`——GitHub 的 `owner/repo` 简写会被当作非法包名
拒绝；指向 `.tgz` 会报 `ENOTDIR`。

上面这些是实测过的，`bun run test:install` 也覆盖：核验发布包、再起一个宿主、
以远程客户端身份把桥的 MCP 面走完。做不到的是假装机器是干净的——宿主解析
`~/.omp/plugins` 不受 `HOME` 影响，也没有环境变量能改道，所以端到端那半程跑的是
`omp install` 真实写入的那个插件目录。见 [docs/testing.md](docs/testing.md)。

也别手工软链到 `~/.omp/agent/extensions/`：`ln -s "$PWD/extensions/a2a-bridge.ts" ...`
只在 `$PWD` 恰好是仓库根目录时有效，换个目录执行就链到一个不存在的路径，桥静默地
不启动，而宿主不会报错。

首次启动时桥会在 `~/.omp/agent/` 下自行生成配置与 token，所以每台机器无需额外
配置。

启动宿主 omp 后，通知栏显示：

```
A2A bridge listening on http://127.0.0.1:<port> (token <前6字符>…)
```

`<port>` 是实际监听端口（默认随机）。

## 配置

配置文件 `~/.omp/agent/a2a-bridge.json`，首次启动自动生成，权限 `0600`（创建时即 0600，无权限窗口）：

```json
{ "port": 0, "token": "<base64url 32B>", "host": "127.0.0.1", "host_llm": "allow" }
```

| 字段 | 含义 |
| --- | --- |
| `port` | `0` = 随机端口；写具体数字则固定 |
| `token` | Bearer token，首次启动自动生成（43 字符）；手写短于 32 字符的会被拒绝 |
| `host` | 监听地址，默认 `127.0.0.1`（改成 `0.0.0.0` 会额外告警） |
| `host_llm` | `"deny"` \| `"allow"`（默认）：宿主启动时自己的会话能不能发模型请求，见「宿主推理接管」。它只决定**启动状态**；桥跑起来之后，远程一侧随时可以用 HTTP 切换，与这里写的是什么无关 |

只有这四个字段。**没有工具白名单或黑名单，没有文件沙箱**——桥不替宿主做权限决定，配置里加这些字段不会生效（多余字段被忽略）。`host_llm` 也不在此列：它管的不是调用方能执行什么（那由 token 和宿主自己的工具权限决定），是宿主自己能不能推理。

环境变量 `A2A_BRIDGE_CONFIG` 可覆盖配置文件路径；`A2A_BRIDGE_AUDIT` 可覆盖审计日志路径。

校验是 **fail-closed** 的：字段类型非法（`port` 非整数/越界、`host` 非非空字符串、`token` 短于 32 字符或含空白、`host_llm` 不是 `deny`/`allow` 之一）时扩展拒绝启动并报错。唯一的例外是**缺失**的 `token`（或根本不是字符串）：自动生成并**写回配置**，保证跨重启稳定。谁手写进去的 token 不会被桥换成桥自己生成的那一个——那会让远程 `mcp.json` 对不上号，且没有任何地方说明原因。下限压在 `generateToken` 的产出（43 字符）之下，它拦的是占位符，不是从别处抄来的密钥。

配置文件的改动在**下次重启宿主**后生效；运行中只想换 token 用 `/a2a rotate`（立即生效，旧 token 即刻作废）。

### 命令

宿主会话内：

- `/a2a` — 显示当前监听地址、端口与 token 前缀
- `/a2a rotate` — 轮换 token（写完配置后需同步更新远程 `mcp.json`）
- `/a2a token` — 打印完整 token（状态行只显示前缀）

## 远程连接示例

远程 omp 的 `mcp.json`：

```json
{
  "mcpServers": {
    "omp-host": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

连上后远程侧会看到 `mcp__omp-host__read`、`mcp__omp-host__bash` 之类的工具，直接调用即可。

## 跨机转发

默认只绑回环，不对外网开放。远程机做 SSH 端口转发：

```sh
ssh -L <localport>:127.0.0.1:<port> user@host
```

`mcp.json` 的 `url` 写 `http://127.0.0.1:<localport>/`。

## 审批

远程调用完全复用宿主的审批门（`ExtensionToolWrapper`），不额外开权限：

- 宿主默认 `approvalMode` 为 `yolo` → 直通，没有审批环节。
- 若宿主把某个工具在 `tools.approval` 配成 `prompt`，且宿主有交互 UI（TUI），远程调用会弹 Approve/Deny，用户确认后继续，结果原路返回。
- 宿主无交互 UI 时（rpc 模式实测；print 同为无 UI 路径，未实测），`prompt` 类审批**不会执行命令，但也不返回**：请求一直挂起（实测 ≥90s），宿主在等一个永远不会出现的 UI 应答。**调用方必须自设超时**；挂起的调用会在审计日志留下 `start` 记录而无配对的 `done`（见下），可据此发现。

## 宿主推理接管

实测的唤醒链（见「安全与边界」）说明了同一件事的另一半：宿主会话会在没人要求的时候花掉自己的 token。接管开关把这个决定交到持 token 的人手里。

**`deny` 的含义是宿主自己的会话发不出任何模型请求。** 两层，因为调用者有两种：

- 会话模型注册表里能枚举到的每个 provider 都被重新注册到一份 deny 实现后面：每次尝试都计数、往宿主 stderr 打一行，并收到错误 `a2a-bridge takeover: host inference is disabled in this mode`。这段文本不命中宿主的任何重试触发条件——真实宿主上实测，被拒的一轮只发起一次尝试，以 `retryable: false` 结束。
- 宿主进程的 `globalThis.fetch` 上按目的地挂绊线：URL 主机名匹配模型配置里任一 `baseUrl` 的请求一律拒绝。这一层盖住的是自建注册表的调用者（task 子代理、web 搜索、commit 消息），它们不问会话的注册表。

降噪层把会让宿主自己忙起来、说个不停的设置按住（长命令自动转后台、宿主侧重试、advisor、TTSR、prewalk、autolearn、cache warming、自动压缩），全部是运行时 override，不落盘。实测：接管在位时，一条远程 3 秒 `bash` 跑完就结束，不会变成后台任务。

**归谁控制。** 配置里的 `host_llm` 只决定启动状态（缺省 `allow`）。运行中用 `POST /host-llm` 带 `{"enabled": false}` 装 deny，带 `{"enabled": true}` 按 takeover 的快照恢复（原始注册、fetch 引用、settings overrides），回包是 `{enabled, denied}`。鉴权与其他路径同一个 Bearer token，每次切换写一条 `tool: "host_llm"` 审计。这个端点刻意**不是**工具：`tools/list` 保持宿主注册表原样。`/a2a` 显示当前状态（`host_llm=deny denied=2`）。切换从不落盘，重启回到操作员的配置。

**它放弃了什么，什么在承诺之外。**

- `transport: "pi-native"` 在宿主内部先于扩展注册的任何实现分派，桥拦不住。配置里有这样的 provider 时 takeover **拒绝装配**：错误可见，绝不半装。真需要 deny 的地方，改的是配置，不是桥。
- 绊线盯的是宿主进程。`bash` 工具里的 `curl` 和 task 子代理跑在别的进程里，`deny` 不是网络沙箱，也不自称是。（实测：deny 状态下 task 子代理在发出第一个请求之前就退出，因为它拿到的模型行指向 deny API，而它自己的注册表不认识这个 api——封死了，但封死的方式是崩溃，不是拦截。）
- 桥运行期间往 `models.yml` 新增的 provider，要等下一次装配才进 deny；`/login` 把模型所有权交回宿主，deny 随之失效。
- `title.generator` 的枚举里没有关（只有 `fork | tiny`），宿主仍会尝试生成会话标题；这些尝试在影子层失败关闭，错误通知可能出现在会话里。
- 被拒的轮次仍然是轮次：宿主会话历史里会留下一条错误消息。接管限制的是宿主能做什么，不是它记得什么。

## 传文件

远程 agent 要把固件、镜像这类二进制放到宿主机上烧写，走 `POST /blob`——收原始字节，不用先 base64：

```sh
curl -X POST --data-binary @firmware.bin \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:<port>/blob?path=/tmp/firmware.bin"
```

单次上限 128 MB——核验每轮实测一次：100 MB 的镜像一次请求就传完，字节一致。不带 `offset` 就是追加，带上则必须等于当前文件大小，否则 409。更大的文件分块传，每块也是原始字节。完整约定见 [协议参考](docs/protocol.md)。

注意内存：请求体在到达 handler 之前由 Bun 缓冲，所以代价是**每个在途请求**的内存——十个并发的 100 MB 上传就是十份 100 MB 的缓冲，这笔算术不用实测。上传前后的宿主 RSS 核验每轮量一次，当前那张表在 [协议参考](docs/protocol.md)；这些数跟着 Bun 分配器走，只能当量级看，不能当预算排。并发上传要限量。

**下载走不通。** 三处宿主侧的限制叠在一起，任一条单独都足以卡住：

- `read` 单行超 150 KB 直接拒绝，报 `exceeds 150.0KB limit`；1 MB 的多行文件只回来约 16 KB
- `bash` 输出超 768 字节就截断，尾巴指向 `artifact://N`
- `read artifact://N` 自己也截断在约 150 KB

所以远程 agent 拿不回本机的大文件，只能读小片段（实测 20 段 `dd` 累计约 3.2 MB / 4 MB，有缺口）。`/blob` 只解决上传。

纯文本或小文件直接用 `write` 工具（单次约 900 KB）更省事，只是不走 `/blob` 的路径。

## 设备

设备在宿主那边有两种形态，桥都原样透传。

**工具链（`bash`）**。`adb`、`idf.py`、串口工具、烧录器都不是 omp 的工具，是本机上的命令。`bash` 在 `tools/list` 里，于是远程直接跑：

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "bash", "arguments": { "command": "adb devices -l" } } }
```

执行落在本机的 shell，PATH 上有什么就有什么——装了 Android SDK 就调得到 adb，ESP-IDF 装了就能 `idf.py flash`。端口监视、寄存器读写同理。

**挂载设备（`xd://`）**。宿主把工具挂成虚拟设备，**它们不在 `tools/list` 里**，而是通过 `read` / `write` 的 `path` 参数驱动：

```json
{ "name": "read",  "arguments": { "path": "xd://" } }              // 列出挂载的设备
{ "name": "read",  "arguments": { "path": "xd://debug" } }         // 取该设备的文档与 JSON schema
{ "name": "write", "arguments": { "path": "xd://debug", "content": { … } } }  // 执行
```

清单由宿主运行时决定——装了哪些扩展、接了什么设备，就有什么。本机实测挂载的是 `xd://debug`（DAP 调试器）、`xd://lsp`、`xd://ast_edit`。

**`tools/call` 直接叫 `xd://` 会被拒**（`not exposed`）：设备不是独立工具名，只有 `read` / `write` 的 `path` 能到达。这是宿主的形态，桥不改写它。

## 安全与边界

- **token 即工具执行全权（默认配置下）**：宿主默认 `approvalMode: yolo`，拿到 token 就可在宿主会话里直接执行任意暴露的工具（含 `bash`），不经过任何审批；只有宿主把工具配成 `prompt` 才有审批门可拦（无 UI 时见审批节）。配置文件保持 `0600`，不要进版本库。
- **桥不做权限决定**：`tools/list` 就是宿主 `Main` 会话的注册表（`getAllToolInfos()`），原样透传，不过滤。因此它包含 `hidden` 工具、也包含宿主当前对自己模型禁用的工具——**omp 是什么权限，桥就是什么权限**。桥没有 `deny` 这类第二套名单：两份名单可以互相矛盾，而代码里没有定义谁优先。要收紧就配宿主自己的工具权限，桥不参与。
- **执行走宿主原生工具**：`tools/call` 固定路由到宿主 `Main` 会话的 `getToolByName().execute()`，注入真实的 `session.settings` 与 `ExtensionContext ui`，所以宿主的审批门（`ExtensionToolWrapper`）照常生效，桥自己一套审批逻辑都没有。
- **远程调用可能唤醒宿主自己的 agent**。桥自己一次模型请求都不发，但执行归宿主管：一条远程 `bash` 超过宿主的命令超时（实测默认 300 秒），宿主把它转成后台任务，任务完成时往会话里注入一条完成通知（"Background job … has completed. Resume your work…"），宿主会话自己的 agent loop 就从这条通知醒过来，开始推理、跑它自己的本地工具。Windows 宿主上实测的链条：调用超时转后台（04:35:23）→ 完成通知进会话（04:36:27）→ 宿主第一批带 usage 的 assistant 消息（04:36:31，模型 stack/medium，单轮输入从 8,309 token 起），此后几十轮。这不是桥在推理，是工具执行在宿主会话里留下的后果，花的是宿主的 token。宿主这一半是开关，不是既成事实：接管在位时（`host_llm: "deny"` 或 `POST /host-llm`），被唤醒的会话发不出任何模型请求——见「宿主推理接管」。
- **调用与列表同源**：`tools/call` 只接受出现在 `tools/list` 里的名字，别名（如 `xd://bash`）和未注册的名字一律拒绝，且不区分「被过滤」与「不存在」（不泄露名字是否存在）。
- **`POST /blob` 是例外，它不经宿主审批门。** 它收原始字节（省掉 base64），直接落盘，桥自己解释路径——**能写宿主能写的任何路径，无根目录、无白名单**。这是刻意的取舍：扩展无法主动发起审批（`ExtensionAPI` 只有 `on("tool_approval_requested", …)`，那是宿主问、扩展答的方向），而唯一能过审批门的写入方式是发一次 `tools/call`，那正是 `/blob` 要避免的编码。审计照旧记 `tool: "blob:write"`，args 只有 `path`/`offset`/`bytes`，文件内容不进日志。在这里解释路径还有一层后果：桥自己的两个文件就落在它解析相对路径的那个根里——`a2a-bridge.json` 与 `a2a-bridge.log` 都在宿主 agent 目录，每一个相对 `path` 也是。两者都改写不了（写入一律追加，显式 `offset` 必须等于当前大小），但往配置里追加垃圾会让下一次 `loadConfig` 抛错、桥拒绝启动，往日志里灌量则驱动轮转、把保留的那一代冲出去。冲的是启动与证据，不是新增的可达范围：能这么干的人本来就握着 token。详见 [协议参考](docs/protocol.md)。
- **`POST /host-llm` 是桥第二条不属于工具的路。** 它直接伸手进宿主会话——换注册表行、override 设置、替换进程的 `fetch`——和 `/blob` 同一类例外：桥在这里有了自己的意见，绕开了宿主的工具分发，代价是审计（`tool: "host_llm"`，每次切换一条）和文档。它限制的是宿主自己的推理，且只听从握着 token 的人的指令。见「宿主推理接管」。
- 默认仅回环监听；真要对外暴露，防火墙自己负责。
- **会话强制**：除 `initialize` 外所有消息必须携带 `Mcp-Session-Id`（缺失 → 400，未知/空闲超 24h → 404）。会话上限 64 个，超出淘汰最久未用；每次命中刷新空闲计时。
- **审计日志**：每次远程 `tools/call` 写两条 JSONL——发起时 `{ts,id,sid,phase:"start",tool,args}`，完成时 `{ts,id,sid,phase:"done",tool,isError,args}`（同 `id` 配对；`sid` 为该调用的 `Mcp-Session-Id`，共享 token 下可把调用归因到客户端会话；参数摘要截断 1KB）到 `~/.omp/agent/a2a-bridge.log`，权限 0600，超过 512KB 轮转为 `.1`。这里的 `id` 是本桥为配对生成的 UUID，调用方的 JSON-RPC id 不落日志，所以按 JSON-RPC id 查不到。参数里超过 120 字符的字符串只记 `<len:N,sha256:前8位>`，日志不落载荷，且**不分嵌套层数**：宿主 `edit` 的文件正文就落在 `args.edits[0].oldText`（第三层），只走两层的脱敏会把它原样写出去。嵌套超过 32 层整个子树换成 `<max-depth>`，不再往下走。这里说的是桥自己这份日志；宿主会话照常收到那些参数，宿主自己的记录归宿主管。记录按进程内一条队列落盘，因为「查大小 → 轮转 → 写行」是三步而不是一个整体：两个并发写都读到越过上限的尺寸就会都去轮转，第二次 `rename` 覆盖掉的正是第一次刚放好的那个 `.1`。不串行时同一份代码重跑六轮，最坏的一次两个文件各剩 1 条记录——测试摆到磁盘上的 572 条里有 570 条在两个文件都找不到；最轻的一次是并发那 60 条只剩 1 条。日志写失败不影响调用，但也不无声吞掉：每个日志路径的头一次写失败会往宿主 stderr 打一行 `[a2a-bridge] audit record not written to <路径>（<原因>）`，此后每满一百次再打一行——写不成的日志与从没被调用过的桥看起来一模一样。`blob:write` 记录先于响应读回文件大小落盘，所以写完之后再读尺寸失败，代价只是响应里少一个 `size` 字段，不是整条痕迹。`POST /blob` 的 `sid` 只认本桥签发过的会话：外面来的头记成 `null`，因为让调用方自选的值等于任何握 token 的人都能把写入挂到别人的会话名下。未鉴权的尝试在这份日志里一条不写——走宿主 stderr，第一次与其后每五十次各一行——写审计就要驱动轮转，这个杠杆不该交到还在猜 token 的人手里，少记那几行的损失没有它大。
- **只有 `start` 没有 `done` = 调用已发起但未完成**（典型：无 UI 下挂起的审批）。读这个信号有两处坑，都实测过：轮转可能把一次调用的两条分处 `.1` 与当前文件，所以要在两个文件里按 `id` 配对；而且只保留一代——下一次轮转会覆盖 `.1`，挂起调用的证据会被后续流量冲出日志。要在它还在的时候读。
- 端口被占用时回退到随机端口并告警（远程 `mcp.json` 需同步改端口）。

与 computer use（看屏幕猜坐标点按）的差别见 [docs/computer-use.md](docs/computer-use.md)。

请求/响应格式、处理顺序、会话生命周期与错误码总表的完整 wire 契约见 [docs/protocol.md](docs/protocol.md)。

在线文档站（GitHub Pages，push 自动发布）：<https://adam-ikari.github.io/pi-a2a-ext/>

v1 边界：

- 只暴露工具（`tools/list` + `tools/call`），无 resources、无 prompts。
- 无 SSE 推送，无调用取消。
- 固定路由到宿主 `Main` 会话。
- 静态 Bearer token，无 OAuth。
- 无并发/速率限制。

设计取舍（想加功能前先看这段）：

- 桥只负责把调用送到，不在途中加意思。宿主已有 `read`/`bash`/`edit` 就能表达的能力，不另造工具；不替宿主判断路径；不按权限过滤目录——**omp 是什么权限，桥就是什么权限**。给桥加一份自己的判断，它就成了第二个 omp。
- 桥自带的工具会绕过宿主审批门，因此必然要自带沙箱。**这是一个决定的两个后果，要一起删**：只删沙盒会留下谁都不管的洞。


## 故障排查

- **401 `unauthorized`**：token 不匹配。远程 `mcp.json` 的 `Authorization` 头必须与配置 `token` 一致；`/a2a rotate` 之后要同步改远程侧。宿主 stderr 会在第一次失败以及此后每五十次打一行 `[a2a-bridge] N unauthorized attempt(s)`；这些尝试刻意不进审计日志（理由见「安全与边界」的审计日志条目）。
- **桥拒绝启动，报 `field 'token' must be at least 32 characters`**：有人往 `a2a-bridge.json` 里写了个短的 token。放真正的密钥进去，或者删掉该字段让桥自己生成并持久化一个——桥不会替换交到它手里的那份。
- **桥拒绝启动，报 `field 'host_llm' must be 'deny' or 'allow'`**：这个字段被写成了别的值（`"false"`、`"ALLOW"`、布尔量）。它决定接管的启动状态；含糊的值一律拒绝，不猜（见「宿主推理接管」）。
- **takeover 装配失败**（`/a2a` 通知或宿主 stderr 里的 `A2A takeover failed to arm: … pi-native transport …`）：模型配置里有 `transport: "pi-native"` 的 provider，桥拦不住它，于是拒绝装配，推理照常归宿主自己的规则管。确实需要 deny，就删掉或改掉那个 provider。
- **审计一条没有、调用也没有失败**：日志路径写不进去——`$A2A_BRIDGE_AUDIT` 指向不存在的目录、权限不对，或磁盘满。宿主 stderr 里有 `[a2a-bridge] audit record not written to <路径>（<原因>）`。修好路径拿不回已经丢掉的那些记录。
- **400 `missing mcp-session-id` / 404 `unknown session`**：除 `initialize` 外都要带会话头。会话是宿主进程内存态——宿主重启即全部失效、空闲超 24h 也回收；重新 `initialize` 拿新会话即可（正规 MCP 客户端库会自动处理）。
- **连不上 / 端口对不上**：宿主启动时配置端口被占用会回退到随机端口并在通知栏告警——以通知栏或 `/a2a` 显示的实际端口更新 `mcp.json`。
- **调用一直没有返回**：宿主无交互 UI 且该工具审批为 `prompt`（见「审批」）——命令不会执行但也不返回；调用方必须自设超时，审计日志里该调用只有 `start` 没有 `done`（见「安全与边界」的审计日志条目）。
- **500 `internal error`**：服务端内部故障；响应体固定不含细节（防泄露），真实原因在宿主 stderr，形如 `[a2a-bridge] internal error: …`。
- **改了配置不生效**：外部编辑 `a2a-bridge.json`（如 `port`）需重启宿主；运行中只有 `/a2a rotate` 即时生效。
- **`bun test` 版本守卫失败**（开发）：两种可能——`@oh-my-pi/pi-*` 实装与 pin/lock 失同步（`bun install` 恢复），或本机 `omp --version` 与 pin 不一致（升级宿主时同步改 `package.json` 里的两个精确版本号）。宿主那一半此前只告警，pin 于是可以无人察觉地漂移；现在会失败，只在 `PATH` 上没有宿主时跳过。确实要对着别的宿主版本跑，用 `A2A_SKIP_HOST_VERSION_CHECK=1`，会打一行大声的 SKIPPED，不静默放过。

## 开发

```sh
bun install

bun run typecheck     # 类型检查
bun run lint          # lint + 格式检查（Biome；修复用 bunx biome check --write .）
bun test              # 单测：test/*.test.ts（138 项：协议/鉴权/配置/暴露门/宿主交接/入口生命周期/审计/版本守卫/blob 分派/takeover 形状/host-llm 路由）
bun run test:smoke    # 真实 E2E（需本机 omp；不需要模型凭据）
bun run test:hardening # 真实宿主加固核验，35 项（需本机 omp）
bun run test:blob      # POST /blob 原始字节上传，35 项（需本机 omp）
bun run test:approval  # 审批边界判别核验，约 95 秒（需本机 omp）
bun run test:takeover  # 宿主推理 deny/restore 对一个计数 sink 实测，约 60 秒（需本机 omp）
bun run test:scenario  # 端到端场景，10 个叙事 / 54 步，约 45 秒（需本机 omp）
bun run test:install   # 发布包自包含 + 真实宿主走 MCP，28 项（需本机 omp）
bun run website        # 文档站（VitePress）本地预览，端口见输出（5173 起，被占则顺延）；首次先 cd website && bun install
```

各测试的覆盖面、真实宿主核验的前置条件与判读标准（含审批核验 VERDICT A/B/C 语义）见 [docs/testing.md](docs/testing.md)。

依赖说明：`@oh-my-pi/pi-coding-agent` 与 `@oh-my-pi/pi-ai` 以**精确版本**固定在 `devDependencies`，与宿主 omp 版本保持一致，仅用于类型检查与单测。**运行时不要从 `node_modules` 加载它们**——宿主 omp 的 `omp:legacy-pi-shim` 会把这些 import 重定向到宿主内嵌的同一份模块，`AgentRegistry.global()` 这类模块级单例才能共享；升级 omp 时同步改这两个版本号；`bun test` 内置**版本守卫**：实装 devDep ≠ pin 直接失败，本机 `omp --version` ≠ pin 时同样失败（那一半此前只告警，而没人必须处理的告警不是守卫）。

文件布局：

| 路径 | 职责 |
| --- | --- |
| `extensions/a2a-bridge.ts` | 扩展入口，`session_start` 起服务器，注册 `/a2a` |
| `src/server.ts` | `Bun.serve` + JSON-RPC（MCP 2025-11-25，纯 JSON 响应）、会话与版本协商 |
| `src/bridge.ts` | 工具目录与执行（都走 AgentRegistry 的 `Main` 会话，入口那份 `pi.getAllTools` 只在没有活的 Main 时兜底）、暴露交集判定 |
| `src/config.ts` | 配置加载/保存、字段校验、token 生成 |
| `src/auth.ts` | Bearer token 校验（timing-safe 比较） |
| `src/audit.ts` | 远程调用审计日志（JSONL 两阶段 `start`/`done`，轮转） |
| `src/takeover.ts` | 宿主推理接管：注册表影子化、fetch 绊线、降噪 overrides、快照与恢复 |

变更历史见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。
