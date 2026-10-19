# 测试与核验

## 总览

| 命令 | 类型 | 需要本机 omp | 预期输出 |
| --- | --- | --- | --- |
| `bun run test:tree` | 仓库形状核验，3 项，无依赖 | 否 | `tree-probe: repo shape OK` |
| `bun test` | 单测（自动发现 `test/*.test.ts`） | 否 | 226 pass / 0 fail（17 文件） |
| `bun run test:registry` | 真实模型注册表核验，28 项，秒级 | 否 | `registry probe: all assertions met` |
| `bun run test:obtain` | 外部二进制获取核验，37 项，dufs 与 cloudflared 真下载 | 否 | `PASS — target <平台>, dufs <钉值>, cloudflared <钉值>` |
| `bun run test:smoke` | 真实宿主 E2E | 是 | `SMOKE OK` |
| `bun run test:hardening` | 真实宿主加固核验，34 项 | 是 | `HARDEN OK` |
| `cd website && bun run check` | 站点渲染与 SEO 核验，56 项 | 否 | `render-check: all pages OK` |
| `bun run test:approval` | 审批边界判别核验，约 95 秒 | 是 | `VERDICT: B`（预期），exit 0 |
| `bun run test:takeover` | 宿主推理 deny/restore 核验，34 项，约 65 秒 | 是 | `takeover probe: all assertions met` |
| `bun run test:install` | 发布包自包含 + 端到端，48 项 | 是 | `PACKAGE OK` |
| `bun run test:bootstrap` | 一键脚本的判断核验，46 项，约 9 秒 | 第五组要 | `BOOTSTRAP OK` |
| `bun run test:scenario` | 端到端场景，8 个叙事 / 41 步，约 45 秒 | 是 | `SCENARIOS: 41 steps, 0 failed` |

统一前置（六个起宿主的核验）：PATH 上有 `omp`。`test:smoke` / `test:hardening` / `test:approval` / `test:scenario` / `test:takeover` 另外认 `OMP_BIN`；`test:install` 不认——它要跑的 `omp install` 与被它装的东西必须是同一个，所以固定用 PATH 上那份。`test:bootstrap` 前五组连真宿主都不起：它用脚本自己造在临时目录里的记账 `omp` stub 和一只记录 argv 的假 `curl`，PATH 上没有真宿主也照样跑，只有最后一组（真宿主）用 PATH 上那份。**不需要模型凭据**——`test/harness.ts` 写入一个故意不可达的 provider，宿主只要「有模型配置」就能启动，而桥只跑工具不推理（设 `A2MCP_PROBE_REAL_MODELS=1` 可改用真实配置）。`test:takeover` 在这条上是例外，而且是故意的：它的 provider 是一个真在听的计数 sink（`Bun.serve`，答 503）。deny 有没有把宿主推理清零，只能靠数出请求来验，不可达的凭据数不出缺席。`test:install` 的端到端那半程也自包含：它把 `omp install .` 装进自己那个临时 `HOME`，宿主自 18.11.0（18.12.1 上重测仍如此）按 `HOME` 解析 `~/.omp/plugins`，加载的是 `omp-plugins.lock.json` 里的登记（详见下一节）。它的第五组是这趟里唯一真出网的一支：`PATH` 上什么都不留，让桥自己把两个二进制拉下来，约 46 MB，落点仍是它自己那个临时 `HOME`。`test:smoke` / `test:hardening` / `test:approval` / `test:scenario` / `test:takeover` 的宿主都跑在**隔离临时 HOME** 里：软链本仓库扩展、独立配置与审计路径、跑完即删（失败时保留现场并在 stderr 打印路径）。保留的现场不自动清理，看完手动删：一个场景核验的目录 33–53 MB，`/tmp` 是真实磁盘不是 tmpfs，攒多了会挤掉别的东西。`test:registry` 两条都不要：它不起宿主、不连网，只在 `/tmp` 下开一个临时 agent 目录。`test:obtain` 也不起宿主，但它要出网到 GitHub 取 release 资产，并且只往自己那一个 `/tmp/a2mcp-obtain-probe-*` 目录里写——机器上真的 `~/.local/bin` 它不碰，`HOME` 换成临时目录之外没有第二条落点。提交前基线：`bun run lint` + `bun run typecheck` + `bun test` 三绿。

六个宿主核验、`test:obtain`、`test:bootstrap` 与文档站构建都在 CI 里跑（`ci.yml` 的 `host-probes` 与 `site` 两个 job），宿主版本从 `package.json` 的 pin 读出再装。

## `test:install` — 发布包自包含核验 + 端到端（48 项）

**核验发布的 tarball 装得上去、装完就能加载、起宿主能通。** 五组：

| 组 | 项数 | 断言 |
| --- | --- | --- |
| manifest | 6 | 有 `name`；有 `version`（否则 omp 显示 `@undefined`）；声明 `pi.extensions`（加载开关）；**无 runtime 依赖**（`@oh-my-pi/*` 由宿主 shim 提供）；`files[]` 同时含 `extensions/` 与 `src/` |
| 打包 | 3 | `npm pack` 出 tarball；体积 < 500KB（不含 `node_modules`）；解开是 `package/` 根 |
| 内容 | 15 | 入口 `extensions/a2mcp.ts` 与 `src/` 下每一个 `*.ts` 都在 tarball 里（清单由 `readdirSync(src)` 现读，新增模块不需要改探针，`src/obtain.ts`、`src/tunnel.ts`、`src/xfer.ts` 就是这样自己进的名）；从入口出发走**相对 import 图**，每个模块都能在包内解析到；确实走起来了（≥6 模块，当前 10）；整包除 `@oh-my-pi/pi-coding-agent` 之外不引任何宿主包，而这一项确实读到了 import（不是空过） |
| 端到端 | 11 | 每次先卸载再 `omp install .`——装的是链接，所以宿主加载的就是工作区；断言该路径不是实体拷贝；桥被发现并广播监听地址；首次启动只写 `host`/`host_llm`/`port`/`token` 加一个 `xfer`（里面是两个二进制名，没有路径也没有沙箱字段）；`initialize` 返回协议版本；`tools/list` 非空，且桥自己那三个传输工具确实出现在目录里（名字从 `src/xfer.ts` 的 `XFER_TOOL_NAMES` 现读，不在探针里抄第二份；不断言具体数量——宿主装几个扩展就变几个，写死会静默过期。这一条原先断言的是「目录里没有桥自带的工具」，桥自带工具之后标签已经不成立而断言也永远不会红，改成正面断言的来龙去脉写在 `test/install-probe.ts` 的注释里）；设备名不作为工具名暴露；远程 `tools/call` 在本机执行并回结果；`tools/call` 设备名被拒；无 token 得 401 |
| 两个二进制都由一次 `xfer_share` 拉下来 | 13 | 给这个宿主削过的 `PATH`（`omp` 所在目录 + bun + `/usr/bin` + `/bin`）上 `dufs` 与 `cloudflared` 都不应答——这两条不成立就整组跳过并说明原因，这台机器证不了不等于桥错了；宿主照样起；`xfer_share` 的答复里没有一句是关于获取的；两个文件都在桥自己的 `HOME` 里且是 `0755`（6.4 MB 与 38.4 MB）；登记两个版本各一行、`target` 是本机平台；审计两条 `install` 且不是 `isError`；回包 `installed` 同时点名两个版本；loopback GET 字节一致、错密码 401、`xfer_stop` 后端口释放；操作者真正的 `~/.local/bin` 前后一样 |

第三组是关键：入口 import 的是 `../src/*.ts`，`files[]` 漏掉任何一个都会**装得上、加载时才炸**。逐个断言文件名会被新增的模块绕过，走 import 图才抓得到。

端到端这组**每次都先卸载再装**。原先是「已装就跳过」，那是个洞：git URL 装出来的是**实体拷贝**，冻结在装的那一刻，于是改坏工作区的 `src/bridge.ts` 之后端到端那 11 项全绿——它验的是那份旧拷贝。实测过：破坏工作区、旧版核验报 `PACKAGE OK`。现在每次重装，且断言插件目录**解析到工作区，不是拷贝**，破坏工作区会如实变红并点名那个文件。

装法用 `omp install .`（链接）而不是 README 那个 git URL（拷贝）：链接指向工作区，宿主加载的就是当前代码。**本地安装在这里是测试夹具，不是受支持的安装方式**——受支持的只有 git URL 一条，见 README。

第五组是那天那遍端到端的提交版。它盯的形状此前谁都没覆盖：`test:obtain` 里 cloudflared 是写明路径那一侧，`bun test` 把获取整个 stub 掉，于是「一次 `xfer_share`、`PATH` 上什么都没有、两个二进制都自己拉」只被一个用完即删的脚本证明过。代价是每轮 CI 多出约 46 MB 出网（6.4 与 38.4），跑顺时整个探针 23 秒。

这一组硬的是安装那三样——文件、登记、审计。`xfer_share` 先解析 dufs 再起服务，起好了才解析 cloudflared，再开洞，所以隧道成不成它们都该成立。共享本身和它后面那个 GET 只报告不硬：quick tunnel 要 Cloudflare 的边缘，而本仓库早就定过（`test/obtain-probe.ts`）那一边断了不算这个代码的证据。「答复里没有一句是关于获取的」这一条例外——它问的是工具回了什么，不是有没有回成功，所以获取一旦回归，隧道那边正断着它也照样红。

反证跑过两遍。把 `src/obtain.ts` 的下载上限从 64 MB 改成 1024 字节：这一组红五项（获取那条点名截断、两个文件缺失、登记无行、审计那条带 `isError`），其余四组全绿；往削过的 `PATH` 里塞一个 stub `dufs`：整组如实跳过，并在两项的括号里说清这台机器证不了。第一遍还顺手暴露了探针自己的一个毛病——登记文件不存在时 `readFileSync` 抛异常，后面的审计项与「操作者 `HOME` 没被动过」就此不跑，红是红了，报的是一处而不是全部；现在两处外部文件都先查在不在，共享回包也要先看形状（失败时工具回的是一个 JSON 字符串，`JSON.parse` 它 parse 得动）。

## 插件发现与 HOME：实测结论

这个核验在插件目录上翻过一次，宿主换版本时又翻了第二次，所以这里带上版本。18.10.4 上实测 `~/.omp/plugins` 不跟随 `HOME`——**那次结论本身是对一次坏探针的更正**；18.11.0 上它跟随，18.12.1 上是同一种行为（那遍全量回归里 `test:install` 48 项与 `test:bootstrap` 第五组都是在临时 `HOME` 里真装真登记跑绿的）。实测：

| 目录 | 是否跟随 `HOME` | 证据 |
| --- | --- | --- |
| `~/.omp/agent/extensions/` | **跟随** | 往临时 HOME 放一个只打印标记的扩展，标记出现了 |
| `~/.omp/plugins/` | **18.10.4 不跟随；18.11.0 跟随，18.12.1 仍跟随** | 18.11.0 上，临时 HOME 里 `omp install` 的插件会加载、真实 HOME 那份不会；加载读的是 `omp-plugins.lock.json` 里的登记，只放软链不加载（实测） |

第一次的坏探针错在哪：它只往临时 HOME 的 agent 目录放标记，没往 plugins 目录放；而且**没给临时 HOME 写 `models.yml`**。

第二点是关键，也单独吃过一次亏，2026-10-19 在本钉住的宿主上把两半各量了一遍才写准：**零模型配置的机器上，交互式宿主照样创建 session**（撞车发生在提示时刻——操作者发 prompt 才会看到 `No model selected`），**而无头启动（`omp --mode rpc`）死在 `createAgentSession` 里，扩展代码一行都没跑**——那时桥的占位模型（`src/auto-model.ts`，在每个 `session_start` 填上空着的模型槽）还没机会存在，救无头的只有启动前就在磁盘上的 `models.yml`。播种因此有两个家：运行态那张占位行归桥，磁盘那份归引导脚本的自装宿主分支。写「桥没起来」的失败信息时，先分清死的是哪一道门。所有起宿主的核验都走 `test/harness.ts` 播种 `models.yml`（不可达 provider，够启动即可，桥不推理）。这个播种的边界要写清：它证明的是「桥不靠模型回答也能跑」，证不了「宿主不发模型请求」——不可达的请求静默失败，计数看不见。现实里确实有一条链从这个盲区漏出去：远程 `bash` 超过宿主 300 秒超时会被宿主转成后台任务，任务完成的 `async-result` 通知进会话，唤醒宿主自己的 agent 开始推理（远程 Windows 宿主实测，见 [computer-use](./computer-use.md)）。当时现有核验没有一条走后台任务路径——审批探针把 `bash` 挂住就看结论，超时转后台这条路没碰过。这条盲区由 2026-10-12 的第七核验收口：`test:takeover` 在带接管与撤掉接管两种状态下各测一次长 `bash`，唤醒链在负控那侧被真实地跑起来并数到（见「test:takeover」一节）。

所以端到端这组现在是自包含的：它把插件装进自己那个临时 `HOME`，宿主从同一个 `HOME` 加载，真实机器上不留登记。

它每次先卸载再 `omp install .`，所以那个临时 HOME 的插件目录里那份永远是链接、永远指向工作区。原先
写的是「已装就跳过」，那是个洞：git URL 装出来的是实体拷贝，冻结在装的那一刻，于是
改坏工作区的 `src/bridge.ts` 之后端到端全绿报 `PACKAGE OK`——它根本没看工作区。实测
复现过。现在破坏工作区会如实变红并点名那个文件。

需要说清的是这组**测什么、不测什么**：测的是桥在宿主里能不能起来、MCP 面通不通；装到
插件目录这一步是**前置条件**，用的是本地链接，因为被测对象是当前工作区。发布路径能否
安装由 omp 保证，不在这个核验的范围内。

全过 → `PACKAGE OK`；任何一项不过 → `FAIL: <label>` + exit 1。

## `test:bootstrap` — 一键装宿主与扩展的脚本核验（46 项，约 9 秒）

**核验 `scripts/bootstrap.sh` 的判断，不核验 omp 会不会装东西。** 七组：

| 组 | 项数 | 断言 |
| --- | --- | --- |
| 钉值从哪来 | 6 | PATH 上没有宿主时，计划里的安装器调用带着从 `package.json` 读出的钉值，并说明读自哪个文件；把 `package.json` 换成另一份、钉值写 9.9.9，`--ref` 跟着变；钉值写成 range（`^18.0.0`）不当钉值用，如实告警后装 latest；`--host-version 7.7.7` 压过文件；`--host-version latest` 计划里没有 `--ref` |
| 脚本单独一份时（无克隆那一支） | 9 | 见下节 |
| `--dry-run` 的计划 | 5 | 退出 0；PATH 上已有宿主就不装（计划里一行 `curl` 都没有）；扩展那一步是 README 那条 git URL 原文；自检交给宿主自己的 `omp plugin doctor`；跑完那个临时 `HOME` 里一个条目也没有 |
| 前置 | 7 | 没有 `curl` 且必须装宿主 → 红，且 `wanted` 那行写的就是 curl；没有 `git` → 红并点名 git；没有 `tar` → 只告警（那是桥自己解包用的），照样绿；`HOME` 不可用 → 红并说 HOME；不认识的参数 → 红而不是被忽略；脚本单独一份且 PATH 上没有 curl → 读钉值那条先如实告警，停仍停在安装器对 curl 的要求上；`sh -s -- --help` 从管道进去 → 打出选项表并退 0（`$0` 这时是 shell，不是脚本文件） |
| 登记的取舍 | 7 | 已登记就不再装（stub 的 argv 里没有一个 `install`）；真装时跑的是 spec 不是本地路径；`--reinstall` 的卸载排在安装之前；`--uninstall` 只调卸载、一个安装都没有；doctor 那行是 ✔ 就过并回声出来；改成 ✗ 就红（这道门不是摆设）；宿主版本与钉值不一致只告警、不中止 |
| 占位 `models.yml` | 7 | 见下节「自装宿主那一条分支的播种」 |
| 真宿主 | 5 | 用 PATH 上那份真 omp 在临时 `HOME` 里跑真一遍：脚本退出 0、登记落进 `omp-plugins.lock.json`、`node_modules/<插件>` 目录在、第二次跑如实说 already registered、`--uninstall` 把登记从 lock 里拿掉 |

### 自装宿主那一条分支的播种（7 项）

脚本在「自己装了宿主且文件不存在」时写 `~/.omp/agent/models.yml`（不可达占位 provider，形状见 `docs/protocol.md` 的占位模型一节），这是安装器之外它唯一的落盘。前几组都进不去这条分支——要么 PATH 上有宿主，要么 `--dry-run` 停在计划——所以这一组把下载替换掉而不是跳过：一只假 `curl` 认 `omp.sh/install` 那次调用、回空（真安装器会写的二进制已经预先躺在 `PI_INSTALL_DIR` 里，是记账 stub 的副本），其余 URL 一律按 `curl -f` 退 22；脚本自己的解析逻辑接着找到 `$PI_INSTALL_DIR/omp`，自装宿主分支从头走到尾。

| 断言 | 判据 |
| --- | --- |
| 这一支跑到底并写出文件 | 退出 0 且 `<HOME>/.omp/agent/models.yml` 存在 |
| 文件带的是桥自己那张占位形状 | `providers:`、`a2mcp:`、`baseUrl: http://a2mcp.invalid/v1`、`api: anthropic-messages`、`apiKey: not-a-real-key`、`- id: offline` 逐条在场 |
| 脚本说了它写了什么 | stdout 有 `Wrote <路径>` 一行 |
| `--host-version` 在场时只出网一次 | 假 curl 的日志里只有安装器那一条，没有 raw 的钉值请求 |
| 已存在的文件 create-only | 先放一份哨兵内容，跑完字节不变、输出里没有 `Wrote` |
| `--dry-run` 只打计划 | 有 `plan: write …（…create-only）` 一行，且那个 `HOME` 跑完还是空的 |
| 已有宿主的机器不写 | stub 宿主在 PATH、非 dry-run 走完全程，`HOME` 下没有 `.omp` |

一道变异跑过：删掉脚本里 create-only 那个 `[ -e ]` 守卫 → 第五项红（`exit 0: claimed a write`），其余 45 项不动。这一组也让「宿主那一支从没被执行过」这句话第一次变了形状：执行是执行了，被替换的只有下载那一下。

运行态那一半在 `bun test` 里是 `test/auto-model.test.ts` 八项（有模型 → 一个调用都不发；空槽 → 恰好一次注册一次选中；行的字面值、sourceId 不等于 takeover 那个、选中的是注册表自己的行、剪枝后逐次重放、注册表不吐行就抛错）。宿主不在场的部分靠 pty 真量了一遍（2026-10-19，18.12.1，临时 `HOME` 零配置）：TUI 起来、桥广播、`initialize` 与 `tools/list` 回 200；占位行在位的会话发一条 prompt，宿主报的是 `Couldn't connect to a2mcp.invalid (connection refused)`，会话记录里 `provider=a2mcp model=offline stopReason=error`——第二道 `getApiKey` 闸门被内联假 key 放过，这是量出来的，不是推的。变异两道：删掉「有模型就不动」的守卫 → 两项红；把 sourceId 写成接管的 `a2mcp` → 命名那条红。`host_llm: "deny"` 与占位行同场由 `bun run test:takeover` 守（带这段接线的 34 项全绿那一遍）。

### 无克隆那一支（9 项）

`curl -fsSL …/scripts/bootstrap.sh | sh` 这种跑法没有仓库在旁边：`$SCRIPT_DIR/../package.json` 指向的是管道那侧不存在的路径，钉值那一跳就掉了，脚本于是知道要装宿主却不知道钉哪个版本。这一组把脚本拷进一个上面没有 `package.json` 的目录（`bareScript()`），再塞一个假的 `curl` 进 PATH（`fakeCurl()`：把每次调用的 argv 追加进一个日志文件，然后要么吐出我们指定的 `package.json`，要么按 `curl -f` 的方式退 22）。断言因此能同时说清两件事：取到了什么，以及它到底有没有出网。

| 断言 | 判据 |
| --- | --- |
| 钉值取自 spec 指向的那个仓库 | 假 curl 回 9.9.9，计划里是 `--binary --ref v9.9.9` |
| 出处那行写的是 URL 本身 | `pinned to v9.9.9 (read from https://raw.githubusercontent.com/adam-ikari/a2mcp/HEAD/package.json)` |
| 这个钉值真走了网络 | 假 curl 的 argv 日志里有那条 URL 的 `-fsSL --max-time 20` 调用 |
| 取不到就装 latest，不停下来 | 假 curl 退 22：退出码 0、计划里是不带 `--ref` 的安装器命令、stderr 点名试过的那个 URL |
| 失败时说的是试过哪儿 | 回声那行 `no pin available from <URL> — installing latest` |
| 不是 `github.com` 的 spec 不猜也不发请求 | `--spec git@gitlab.example:foo/bar.git`：假 curl 的日志空，输出说明这个 spec 推不出 URL，装 latest |
| `--host-version` 优先且不读钉值 | 传 `7.7.7`：假 curl 一次没被调用，`--ref v7.7.7` 照样在计划里 |
| 已有宿主就不出网 | PATH 上放着 stub 宿主：假 curl 一次没被调用——既然不装宿主，就没有要钉的版本 |
| 推出来的 URL 服务的是本仓库这个钉值 | 真发一次 `curl` 到那条 URL，取回的钉值 == `package.json` 里的 `PIN`；够不着 GitHub 时这一项打印 `info:` 不计入项数 |

三条变异跑过：把派生出来的 `/HEAD/` 改成 `/main/` → 出处那行与「真走了网络」那两条一起红（假 curl 对 URL 不敏感，所以拦住它的是断言盯着字面 URL，不是它挑不挑 URL）；去掉「已有宿主就不出网」那个条件 → 第八条红，argv 日志里多出一条请求。第 9 条挂在真网络上，跑的时候 GitHub 可达，它读回来的是 `18.12.1`。

为什么第八条值得占一项：无克隆那条路是给人装第一台机器用的，而「机器上已经有宿主」是最常见的形态；这个脚本在这种形态下应当一次请求都不发。读钉值的分支挂在「确实要装宿主」这个条件上，条件写丢的失败模式是一次无害的 GET，看不见、也不报错，只有 argv 日志能证明它没发生。

它为什么存在：README 教的安装方式是 `omp install <git-url>` 那一条，而那句话假设机器上已经有 `omp`。脚本补的是宿主那一层，扩展那一半执行的还是原句——**它不是第二条安装路径**。2026-10-02 删掉 `scripts/install.sh` 那条决定也没被翻面：那次错在自己维护一份模块图校验，这次连插件登记好不好都问宿主的 `omp plugin doctor`，脚本不重新发明判据。

`PATH` 是探针自己造的目录，只软链点名的那几个真二进制，所以「没有 curl」是真没有，不是脚本自己说的。`omp` 换成一个只往文件里追加 argv 的 stub，于是安装、卸载、`plugin list`、`plugin doctor` 全都看得见，而机器上什么都没被改动。

插件名与安装 URL 都不抄在探针里：前者读 `package.json:name`，后者读 README 里那行 `omp install <url>`，读出来是空就抛错而不是继续跑。同一个名字原先抄在三处（脚本、README、探针），改一半也能全绿，所以这两样都改成从源头读。无克隆那一组的 raw URL 也从 `README_URL` 推，不另抄一份 owner/repo。

一个洞是写的过程中自己踩到的：前置那组第一个场景拿掉了 `curl`，可 PATH 上还留着 stub 宿主，脚本走的是「已有宿主」那一支，`curl` 那条检查根本没跑到；它顺手把扩展「装」进了 stub 的登记文件，于是下一个场景（拿掉 `git`）读到已登记、跳过安装，两条都绿。修法是该场景把 `omp` 也从 PATH 上拿掉，并且每个场景重铺 stub 的状态。这类「上一个场景改了夹具」的污染，只有把每条的期望退出码打出来才看得见。

边界写在探针文件头，不藏着：**官方安装器那一次下载在探针里永远不真跑**——要么 PATH 上有宿主（脚本就不装），要么在 `--dry-run` 里（只打印计划），要么像播种那一组那样被假 `curl` 替换掉（分支走全，下载那一下是假的）。2026-10-19 手动补了一次真跑：临时 `HOME`、`PI_INSTALL_DIR` 指进同一个目录、PATH 上没有宿主，脚本从 raw 读到 `18.12.1`，安装器按 `--ref v18.12.1` 把二进制写进那个临时目录，`omp install <git-url>` 真克隆并登记出 `✔ plugin:a2mcp: v0.4.0`，`--uninstall` 收掉登记，整个目录 353 MB 删掉，机器上原有的宿主与插件没动。这一次不在探针里，它证明的是那半程走得通，不是它每天被跑着。

第五组用 `omp install .`（本地安装在这里同样是测试夹具，不是受支持的安装方式），它验的是脚本能不能驱动真宿主走完登记、自检、卸载这一串；`A2MCP_BOOTSTRAP_SPEC` 指成 git URL 就改成验 omp 自己的 git 抓取，那条路 `test:install` 前三组已经覆盖。

### PowerShell 那一支：十三项字面核对（`test/bootstrap-ps1.test.ts`，在 `bun test` 里）

`scripts/bootstrap.ps1` 与上面这 46 项无关——**这 46 项一项都没执行过那份脚本**。2026-10-19 真 Windows 机器头一遍跑了它（`omp 18.12.2` 已在 `PATH`、扩展已登记），DryRun 打出计划，真跑停在宿主自己的 `plugin doctor` 那枚 `✔` 上；同日 README 现在教的不落盘 scriptblock 形态也在这台机器上跑了 DryRun——计划原文从 raw 取回、纯 ASCII。过的始终只有「已有宿主」这一支；官方安装器那一次调用与占位 `models.yml` 那一次播种至今仍然没有任何地方执行过。字面核对因此还是字面核对，十三项把那支脚本当文本读，跟 `bootstrap.sh` 对一遍：插件名（并与 `package.json:name` 对）、扩展仓库（从 README 那行 `omp install <url>` 现读，与探针同一个源头）、安装器地址（shell 那条是 `https://omp.sh/install`，PowerShell 那条必须是它加 `.ps1`）、读钉值时点名的宿主包名、拒绝 range 而要确切版本那道门的字面正则、每一次 `([scriptblock]::Create(...))` 调用都带 `-Binary`（共两次——钉值那次与 latest 那次；这一条盯着上游那个坑：`-Ref` 不给模式开关会被翻成 bun 源码构建）、`-Ref "v$Version"` 与 `-HostVersion` 走同一个 `$Pin`、整个文件纯 ASCII（PowerShell 5.1 按 ANSI 码页读无 BOM 的 UTF-8，一个非 ASCII 字符就是一条乱码注释，落在字符串字面量里就是一个错值）、所有副作用都过 `Run` 而 `Run` 先打印计划再执行，以及占位 `models.yml` 播种的四条：写进文件的正文逐行相等（heredoc 对 here-string）、`InstalledHost` 赋值各只一次且紧跟「No omp on PATH」那行、两边都是 create-only 且落在各自平台的 profile 路径上、dry-run 两边都只打同一句计划。

**这不是覆盖。** 断言的标题里就写着：往 `bootstrap.ps1` 里放一个语法错误，这十三项照样全绿——真解释器过它只有 2026-10-19 那一次手工，一次性，不在任何 CI 里。它们值一句「两个文件没写岔」，再多的一句都不值。这一节的存在是因为 README 把那条 PowerShell 命令摆给人敲，而这里唯一能自动跑的核对只有这一种形状。

四道变异跑过（都按 `cp` 出来的备份恢复，没有用 `git checkout`）：把钉值那次调用上的 `-Binary` 删掉 → 一项红；把 `$Plugin` 改一个字符 → 一项红；删掉 ps1 播种的 `Test-Path -PathType Leaf` 守卫 → create-only 那条红，其余十二项不动；把播种的 `$InstalledHost = $true` 改成两处 → 「只一次」那条红。红的都正好是盯着这一处的那条。

## `test:obtain` — 外部二进制获取核验（37 项）

**要回答的问题**：桥自己拉下来的那两个二进制，是不是真能用。`--auth user:pass@/:rw` 这组参数最后一次实测是在 0.43.0 上，而 `src/obtain.ts` 钉的是 0.46.0——没跑过就把版本号写进 README，那是猜。cloudflared 那一侧同样的规矩：钉表的哈希是从 release 元数据读的，读回来还得对着真下的字节复算一次。这条探针因此是钉值的门：它不绿，文档里那些版本就留空。

| 组 | 项 | 断言 |
| --- | --- | --- |
| 真下载（两个二进制各五项） | 10 | 本机平台在钉表里；`resolveBinary` 把文件装进它说的那个临时目录；`--version` 自己报出钉的那个版本；账本记下这次安装的哈希；第二次调用不重下 |
| 由 `xfer_share` 驱动 | 2 | 空 PATH + 空安装目录，让工具自己完成获取，回包的 `installed.dufs` 点名它拉的那个版本；`installed.cloudflared` 是 `null`（cloudflared 在这里是写明路径的那一侧，按规则不下载） |
| 拉来的二进制起真共享 | 8 | GET 字节一致（200）、Range（206）、PUT（201）且落盘、错密码 401、目录列表 200、`xfer_stop` 后端口释放、下一次共享复用安装而 `installed` 回到 `null` |
| 钉表每一行的 URL | 10 | 两个二进制 × 五个平台，每个 asset 的 URL `HEAD` 一次要回 200。本机跑不了的那四个平台的行，单测只核对 URL 拼法，是否存在只有这里能说 |
| Windows 那两行按字节读 | 4 | `win32-x64` 那两行指向错 asset 也一样回 200，而本仓库没有一处运行 Windows 二进制，所以这两行按 Windows 主机会读的方式读一遍：dufs 的 zip 在这台机器上算出的 sha256 与表里一致、表里那个条目名由 `readZipEntry`（win32 安装走的同一段代码）读得出来（实测 4 721 664 字节）、cloudflared 的 `.exe` 前两个字节是 `4d5a`（HTTP 206 拿到的，不是归档）、报回的总长 55 325 120 在桥自己的 64 MB 上限之内。这四项说的是「字节与形状都对」，说不了「跑得起来」 |
| 审计 | 3 | 日志里两个版本各一条 `install`，`share` 记录在 |

这组核验里 cloudflared 走的是**写明路径**那一侧，所以「两个二进制都由一次 `xfer_share` 拉下来」这条它没有覆盖，单测也没有（单测把获取整个 stub 掉）。那一条要靠真宿主的端到端：隔离 `HOME`、`PATH` 削到只剩宿主自己，远程调 `xfer_share`。2026-10-17 头一遍跑绿是拿用完即删的脚本量的：14.0 秒返回，`installed` 是 `{"dufs":"0.46.0","cloudflared":"2026.10.1"}`，两个文件都落在桥自己的 `HOME` 里（6.4 MB 与 38.4 MB，`0755`），登记各一行，审计是 `install` 两条加 `share`、`stop` 各一条，loopback GET 字节一致、PUT 201 落盘、错密码 401、`xfer_stop` 后端口释放，操作者真正的 `~/.local/bin` 里依然没有 `dufs`。同一趟在出网差的时候也真跑过另一遍：dufs 装成功，cloudflared 那 40 MB 在流里停住，120 秒到点回 `isError` 带失败原文，共享没开成、dufs 服务被收走、没有孤儿进程，整趟 229 秒——冷装两个二进制最坏就是两个 120 秒加握手，这两遍合起来把上限与正常值都量到了。第二天这一遍升格成 `test:install` 的第五组（见上一节），从此它是提交里的核验，脚本不再是唯一证人。

真隧道单列，只 `info:` 报告不断言：拿第一节下载并验过哈希的那份 cloudflared 起一次真 quick tunnel，主机名确实 announce 出来了，但从发布它的那台机器 curl 回去报证书错误——本机网络对代理域名重签 TLS。于是断言那一路用注入的开洞器，硬检查一律打在 `127.0.0.1:<port>` 上。还有一处现象记在 `test/obtain-probe.ts` 的文件头而没有解释：探针自己同时握住真 cloudflared 与那次公网取回时，两次都是本地各项全过、然后不再返回。它留在文件头，是因为没查清原因的事既不能写成结论，也不能写成断言。

### Windows 那些分支在 Linux 上测的部分（`test/obtain.test.ts`「the shape Windows insists on」，10 项）

`src/obtain.ts` 里的 win32 判断不读 `process.platform`，平台由 `ObtainDeps.platform` 注入（与既有的 `target`、`pins`、`env`、`binDir` 同一个性质），所以这台 Linux 机器能走进那些分支。测试里自己造 zip：手工写本地头、`deflateRawSync` 压出的数据、中央目录与 EOCD，CRC 是真算的（那夹具对过一次 `unzip -t`）。十项各自盯着一个只有 Windows 才有的形状：zip 里那一个条目装出来叫 `dufs.exe`；`readZipEntry` 两种存法都读得出（deflate 与 stored）；条目按名字精确匹配，差一点不算；压缩方法不是 0/8 就拒绝而不是猜；条目声明的长度超过上限时一个字节都不解；解出来的长度与声明不符即失败；不是 zip 的字节找不到 EOCD；裸名字在 `PATHEXT` 上命中而不问 release 服务器（假 fetch 断言一次请求都没发）；`C:\tools\dufs.exe` 认作「按给定路径用」且零请求；win32 的安装目录在 `LOCALAPPDATA` 下而不是 unix 的 home。另有一项断言两张钉表都不给 `win32-arm64` 留半行。

变异跑过两处：把 `cdOffset` 读错一位（`eocd + 16` 多加一个字节），十项里红六项——装不出 `dufs.exe`、deflate 与 stored 读不出、精确条目名/方法拒绝/上限拒绝三条各自的前置都不成立，只有「不是 zip 的字节找不到 EOCD」照样绿，因为它本来就该失败；去掉「值里带 `\` 就是路径」那半边，只有 `C:\…` 那一条红，其余全绿——这台机器上除了那条断言，没人替 Windows 用户守着这道门。

## 隧道那条读循环（`test/tunnel.test.ts`，4 项）
`src/tunnel.ts` 读子进程的输出，从里面找主机名。那条循环开着多久等于共享开着多久，所以它手里那个缓冲区两个方向都会坏：收得太早就把主机名丢了，症状是隧道从来不 announce；完全不收，一个小时的共享就变成宿主进程里一个小时的内存增长。代码的写法是先搜，搜不到才把缓冲区收成尾部的一半。

钉住它的是「主机名埋在比转录更多的输出后面」那一条，而这一条的难点在夹具，不在实现。子进程不加节奏地写（每行一次 `writeSync`，或者一整块写下去），到父进程这边是十来个体积不等的读事件，实测有一次把 200 KB 全塞进第一个事件——那样的流里压根没有几次能撞到上限，把实现写成「满了就不再追加」也不会红。每行之间加一个 `await Bun.sleep(5)`，流才真是一行一个事件。另一个坑更安静：`process.stdout.write` 的循环后面接一句 `console.log`，Bun 让那句同步写越过排队的异步写，主机名直接跑到第一个 chunk 里。夹具的注释写着这两条，因为下一个改这个文件的人会重新发明它们。

## `test:hardening` — 加固核验（34 项）

配置种子**故意不带 token**（验证自愈）。34 项分组：

| 组 | 项数 | 断言 |
| --- | --- | --- |
| token 自愈 | 2 | 生成 43 字符 base64url（32B）并持久化；配置 0600 |
| 版本协商 | 3 | initialize → `2025-11-25`；签发会话头；请求 `1999-01-01` 仍答服务器版本 |
| 会话强制 | 4 | 带会话通知 202；通知缺头 400；请求缺头 400；伪造会话 404 |
| 鉴权放置 | 4 | 无 token 401；错 token 401；**未鉴权 DELETE 401**；会话在未鉴权 DELETE 后仍存活 |
| JSON-RPC 校验 | 4 | GET 405；坏 JSON 400；`jsonrpc: "1.0"` 400；batch 400 |
| 暴露门 | 3 | 目录含 `read`；未注册名调用 → `isError` + `not exposed`；别名 `xd://read` 同样拒绝 |
| 真实执行 | 1 | `tools/call read` 在 Main 会话读回文件内容 |
| 审计 | 7 | `read` 的 start/done 双相；被拒的调用也有 start；所有 done 能按 id 配对到 start；**记录携带 `sid`（对得上是哪个客户端会话）**；审计文件 0600；**嵌到第三层的长字符串折成 `<len:N,sha256>`，正文 60 字符的窗口在日志里查不到** |
| 审计轮转 | 4 | 过 512 KB 确实轮转；轮转前后记录总数不缩水（按数量算，6 条前置 + 426 条本轮 = 429 进 `.1` + 3 留在当前文件）；跨两个文件每条 `done` 都能配到 `start`（本轮有 1 条只能在 `.1` 里配到）；`.1` 是完好的 JSONL |
| 会话终止 | 2 | 已鉴权 DELETE → 204；随后请求该会话 → 404 |

全过 → `HARDEN OK`；任何一项不过 → `FAIL: <label>` + exit 1（并打印宿主日志尾部）。

暴露门那组原本有第四项，断言目录里没有任何 `a2a_file_*` 开头的工具——没有任何代码注册这种名字的工具，那一条永远不会红，却读起来完全像在保护「桥不自带工具」。删掉它不是丢覆盖：这个性质现在钉在 `test/bridge.test.ts`，那里拿**相等**断言（目录列表与宿主注册表逐项相等，多一个少一个都红），而宿主探针这一层看不到宿主自己的注册表可比。

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

## 释放端口的那一刻，在途那一次算什么

`src/server.ts` 的 `stop()` 原先是 `server.stop(true)`。这条在单测里从来没有对照面：入口那几条按「去连它」判释放，新建连接被拒就通过，至于断开的那一刻有没有一个请求正在处理，没人问。它现在有了自己的一条（`test/server.test.ts` 末尾，「releasing the port」）：起一个 `tools/call`，等 stub 的 `callTool` 确实在跑（一个 `entered` 标志），然后 `stop()`，断言这一次照样拿到 200 和结果文本。

强制切断的代价：`tools/call` 少一行 `done`，客户端拿到 `ECONNRESET`。非强制那一半把它保住了：监听立刻关，后来的人一律被拒；已经进来的那一次处理完、返回、落审计。

同一批实测里还有一条 Bun 的缺口，记在这里是为了别把它当成已解决：非强制 `stop()` 不关释放时已经空闲的 keep-alive 套接字，`closeIdleConnections()` 在 1.3.14 只有函数名（返回 `undefined`，socket 照旧服务），`bun-types` 1.4.2 描述的「空闲连接立刻关」是更新版本的行为。所以断言「释放后不接受连接」不能走 HTTP 客户端——它会复用那根老 socket，量到的是这一半而不是监听的状态；这里用 `node:net` 裸连，并在同一条测试里先断它在释放前为 true，免得这个读数只会恒假。

变异两项：把 `stop(true)` 换回去，只红这一条，18 ms 内以 `ECONNRESET` 红；把 `server.stop()` 整个删掉，红五条——这条的裸连接断言，加入口那四条靠新建连接判释放的。

## 目录、暴露门与执行，原先读三份注册表

`buildToolCatalog` 与 `buildCallTool` 里那道暴露门都读入口 pin 住的那份 `pi.getAllTools()`，而执行每次现取注册表里 `Main` 会话的 `getToolByName`。宿主把 `pi.getAllTools()` 接到的是**那套 runner 自己的会话**（`runtime-init.ts:126`、`acp-agent.ts:2581` 都是 `() => session.getAllToolInfos()`），所以只要第一个 `session_start` 不是 `Main` 的——task 子代理与 ACP 会话都可能先走到——桥就在报出另一个会话的工具清单，同时把 `Main` 自己的名字按「not exposed」拒掉。反过来说也一样：`Main` 有而那份 runner 没有的名字，列不出来却其实能调。

改法是让这一处只有一个权威：`src/bridge.ts` 里新增 `servedTools()`，读 `Main` 会话的 `getAllToolInfos()`（宿主接 `pi.getAllTools()` 用的就是这个函数，所以常规情况下两个读数逐字相同），目录与暴露门都改读它；`AgentRef.session` 是 `null`（parked/aborted，端口还没释放的那一段）时退回那份 `pi`，因为此时报出一份宿主其实并没有的空注册表不是诚实而是添乱。于是「列出来却调不动」只剩两次读之间工具被注销这一种情形，那条断言还在。

核验落在 `test/host-call.test.ts`：harness 多一个 `pinnedPiNames`，用来把「入口那套 runner 不是 Main」这件事摆出来；假 `Main` 会话现在带 `getAllToolInfos`，与 `getToolByName` 同源。新增两项，第一项三个方向都断（目录只列 `Main` 的、`Main` 的名字照常执行、另一个会话的名字在门就被拒），第二项断 parked 时退回入口视图。第一项先红：目录交出的是那份 `pi` 的清单。

变异三项：两处都换回 `pi.getAllTools()`，红那一项；只改目录、门仍读 `pi`，红同一项（红在门那半条断言，说明两处分别被断着）；去掉 parked 的兜底，红五项——新增那两项里的兜底一项，加 `test/bridge.test.ts` 里三条依赖「没有 Main 就读入口那份」的目录测试与「registered tool with no Main session」那条。六个宿主核验重跑全绿，其中 `test:install` 的「`tools/list` 非空」与 smoke、scenario 的远程调用，走的就是这份新读数。

## 两条并发写日志，谁吃掉谁

`src/audit.ts` 的 `appendLine` 是 `stat` 查大小、`rename` 轮转、`appendFile` 落行三步，而这三步不是一个整体。两个调用同时在飞时可以都读到越过 512 KB 的数字、都去轮转，第二次 `rename` 覆盖的正是第一次刚放好上一代的那个 `.1`。被吃掉的是轮转那一刻恰好留在当前文件里的记录——也就是几毫秒前刚写下的那些——外加被换出去的一整代。

原有的那条轮转保留测试（`test/audit.test.ts` 第一组）看着的只是「记录会不会冲出窗口」，它每 20 对让一次路，注释里给的理由是有链子会冲过上限、把尺寸的读数弄浑——那说的是多写几行，丢数据这一半从来没有断言。

补的这条先把舞台摆成只需要一次轮转：日志灌到离 512 KB 差 200 字节以内，再同时打 60 条（每条约 1.15 KB），然后按两个文件的记录数守恒断，逐条 id 都要在。未修版本重跑六轮，落点两种：四次是 572 条里缺 59 条（本轮 60 条只剩 1 条，前置那一代还在），两次是缺 570 条（两个文件各剩 1 条，前置那一代也被吃掉）。方向只有一个——每多一次轮转，就多一批刚写下的记录连着自己所在的文件一起被覆盖掉。

改法是一个进程一条 promise 链，前一个环节写完才轮到下一个，`stat` 读到的就是上一个 `appendFile` 落完的大小。`appendLine` 把行交给链就返回，调用照旧不等磁盘；链上每个环节自带 `.catch`，于是一次写失败既不会冒到宿主进程，也不会把链子卡住让后面所有审计落不了盘。接受的代价说清楚：磁盘慢的时候，后面的行会在内存里排队。

变异三项：换回不串行的写法，只红新增这一条；去掉链尾的 `.catch`，红两条——「路径写不成」那一项（rejection 冒出来）与这条新的（前一个环节的失败卡住了链，之后的记录一条都落不了盘）；把轮转整句删掉，红的是原有那条保留测试。也就是说轮转本身、轮转的串行、串行的自愈，三样各自有人看着。

顺带一处过期维护：那条保留测试里每 20 对让路的理由在串行之后不成立了，注释按新的行为改写，让路本身去掉。

## 入口那一层（`test/entry.test.ts`，19 项）

`extensions/a2mcp.ts` 此前没有任何单测能引到它——不起了宿主就摸不到，而它管的是这台服务器的生死。它现在被直接 import：`$A2MCP_CONFIG` 指到临时文件，端口写 `0`，`Main` 会话是真注册进 `AgentRegistry.global()` 的假货。不 mock 任何模块：入口的每个决定最后都要落到一个能被连接的端口上，所以断言一律是「从广播里解析出那个端口，然后去连它」。连不上就是没在服务，200 就是在服务——这比数调用次数结实，而 `mock.module` 在本机还有个硬伤：Bun 的模块 mock 是进程级的，`test/config.test.ts` 的 `loadConfig` 会被同一进程里的 mock 换掉，一次 `bun test` 就绿不回来了。

事件序列照宿主的实际行为摆：交互式宿主里 `/new` 复用同一个 runner、不再发 `session_start`，但 task 子代理、ACP 会话、持久化 revive 各建一套 runner 并重跑扩展工厂（模块图不重新求值，所以 `server`/`cfg` 共享，而 handler 是各自的）。于是 `session_start` / `session_shutdown` 是每会话的，端口是每进程的。

写不出来的那一条正好是这里的缺陷：`session_shutdown` 无条件 `server.stop()`，所以**任何一次子代理结束都会把还在服务的端口拆掉**，而主会话那边再没有第二个 `session_start` 来把它重启。修法是让释放与否取决于宿主注册表里还有没有 `Main` 会话（`hasMainSession()`，`src/bridge.ts`），这条读数本身也对着真注册表测了三种情形。顺带两处：启动失败时代码清掉了 `cfg` 却没清 `server` 的话，`/a2mcp rotate` 会替一个已经停服的端口报成功；`rotate` 原先先改内存再写文件，写失败就是「运行中的桥换了 token、配置文件还是旧的、而操作者收到一句失败」。

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
| `/a2mcp`：注册名、rotate 先落盘再生效、落盘失败则运行中的仍是旧 token、`token` 出全串而 status 只出前缀、未运行时三个子命令都拒绝 | 5 |

变异核验十项：去掉 `hasMainSession()` 那道闸、把 `rotate` 的赋值挪回写盘之前、启动失败的 catch 里不再 `stop()`、catch 里什么都不清、`hasMainSession()` 恒真与恒假、去掉在途那道闸（红的正是并发那条）、去掉绑完之后的那次复查（红的正是绑定中途结束那条）、把 `hasMainSession()` 的比较换回 `!== undefined`（红的正是 parked 那两条），各红自己那一两条。只有把广播里的端口换成配置值而不是实际绑上的那个，红了七条：端口报错了，所有「去连它」的断言一起塌。这正是把断言写成真连接的代价与好处，它不给你留「实现错了但计数对得上」的余地。

## 名字守卫（`test/naming.test.ts`，6 项）

**要回答的问题**：这一轮把项目改到了 `a2mcp`。名字抄在几处就可能漏改几处，旧拼写会从三条路回来：抄错的一行文档、新写的一个探针、手填的 `serverInfo`。

按形态匹配，不是全文禁那个协议名：`docs/protocol.md` 拿它当隔壁那个协议来比较，那是合法用法。拦的是自指的四种形态——旧包名、旧桥名、旧环境变量前缀、旧斜杠命令，外加旧前缀打头的标识符和散文里那句旧称呼。这比一刀切禁字符串弱，弱在哪里也写明了：要拦临时目录前缀就得把那个前缀列成形态，而两个历史设计稿的文件名长得和它一样。

扫描面是 `src`、`extensions`、`test`、`scripts`、`.github`、`docs` 顶层、`website`（生成物除外）加四个根文件。豁免两种：整文件是历史（变更日志、brain、设计稿、锁文件与站点构建输出——锁文件记的是它生成时那个目录名，本仓库的工作目录留着旧拼写是有意的），以及逐条列出的旧名引用：README 的迁移段必须写出该卸载哪个、哪个文件从此没人读，探针与被替换那句断言的注释也都得拼旧名字。按文件生效而不是按行，这是个真实的洞；收下它是因为每个文件只有一个理由拼旧名字，而没人用的豁免会让这条测试变红——表自己烂不掉。守卫这份文件自己也在豁免里：旧拼写在它那儿是数据，它不能同时是扫描对象。

另三条是结构断言：`pi.extensions` 里每个路径都存在，而 `extensions/` 里除了它不许有第二个 `.ts`；`harness.linkExtension()` 软链出去的文件名就是它；包名、命令名、`serverInfo.name` 是同一个词。v0.3.0 上这三个是三个词，远程调用方在 `initialize` 里读到的名字和宿主 `plugin list` 里的不是一回事。

变异核验四条都实跑过：把入口那行 notify 的自称改回旧称呼 → 红并点名 `extensions/a2mcp.ts:172`；从豁免表里删掉一条 → 红并指回 README 那一行；把表里某条的字面量改错一个字母 → 同一条测试既报这条豁免没人用了，又报 README 的那行；把协议页样例回包里的名字改回旧桥名 → 红的是那条对照代码与文档的断言。

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

**要回答的问题**：接管在**宿主的数据结构**上做了什么。上面六个探针问的都是一段时间里的行为——一轮对话、一个审批弹窗、一个后台任务把 agent 叫醒。这个探针问的是宿主的 `ModelRegistry` 本身，而它问得动，因为那个注册表可以在进程内直接造：`AuthStorage.create` 加一个 `new ModelRegistry(...)`，对着 `/tmp` 下的临时 agent 目录，就能拿到真实的内置目录（18.8.7 上 5457 行、七十多个 provider），不起宿主、不开 TUI、不连网。

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

**ACP 那条路也堵死了，这条是量出来的。** `acp-agent.ts:2662` 确实是第二个真实发射点，看起来能在同一个进程里既重建会话又带着桥，所以实测了一次：起 `omp --mode acp`（临时 HOME、`host_llm: deny`、配置与其它探针同形），ACP 的 `initialize` 有正常应答（`protocolVersion: 1`、`agentInfo.version 18.8.7`），但**扩展根本没被加载**——stderr 里一次都没提到 extension，进程一个端口都没在听，`/a2mcp` 连不上。也就是说 ACP 模式不加载 `~/.omp/agent/extensions/`，那个发射点对桥不可达。两条路都试过之后，这项覆盖的阻塞不在桥这一侧，而在宿主没有为 Main 暴露重建口；要它得宿主加一个 rpc/ACP 钩子。

这条也解释了为什么降级状态在真实宿主上验不了：降级需要「开关开着 + 换主会话 + 新目录里有拦不住的道」，而换主会话这一步就驱动不了。降级的覆盖留在 `test/takeover-arm.test.ts` 的 stub session 上（读出 `degraded`、恢复后清掉、拒绝排在恢复之前——三项各有变异）。

写这一档的时候顺手现形了两件事，都不是探针的毛病：默认目录里有一条 `preferWebsockets: true` 的 Codex 行，所以「碰到 websocket 行就拒绝装配」会让 deny 在开箱状态下根本装不上——而那条道是按 **api** 判的，因为宿主把 `providers.openaiWebsockets` 这个设置逐次转发给 provider 调用，一行一个标志并不成立，于是那张表按 api 写；另外 deny 副本必须摘掉 `resolveHeaders`，否则 pi-ai 在 api 分派之前会先跑 provider 的 `!command` 取密钥程序。

变异核验：把声明面改回「每个 provider 都声明」，本探针红 5 项，其中决定性的一项是 `myprov rows 2 -> 0`；换会话时若不把旧会话的 deny 还回去，红「拿回自己的行」与「agent 那一行跟着会话走」两项。

失败语义与其他探针一致：任何一项 FAIL → exit 1，临时目录保留并打印路径；全过 → `registry probe: all assertions met`。CI 的 `check` job 跑它（不需要 omp，秒级），`host-probes` 不收。

## `test:scenario` — 端到端场景核验（8 个叙事 / 41 步）

其余五个探针是**平铺的断言**：每项一个观察，彼此独立。这个探针反过来——每个场景是一条有头有尾的叙事，而**结尾状态要从产生它的那条通道之外去验**：

| 场景 | 结尾从哪条通道验 |
| --- | --- |
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
| 非法 `port` 不再 fail-closed | 「不广播」「报错点名文件与字段」 |
| 审计不记 `sid` | 「记录带调用方会话 id」「审计归属到两个客户端」 |
| `DELETE` 清空整张会话表 | 「B 不受 A 终止影响」 |
| 端口占用时直接抛错不回落 | 「在另一个端口广播」「宿主告警」「桥在新端口可连」 |
| 暴露面校验删除 | 场景套件**不红**——归 `test:hardening` 管（实测它红两项） |

第一轮反证时场景套件对「一律覆盖写」是绿的：对一个还不存在的文件，追加与截断是同一个操作。补了一段显式 offset 的追加才咬得住。同一轮反证还揪出探针自身的两个毛病——`rpc()` 没有默认超时，桥没起来时会挂在占用端口上（现在恒有 20s 上限）；以及 `test:install` 那项「设备名被拒」只断言 `isError`，暴露门一去掉就会因为**设备自己**拒了而绿——理由错了也绿。

这套场景**不覆盖**什么，各由谁管，写在 `test/scenario.ts` 的文件头：暴露面与协议层拒绝归 `test:hardening`，prompt 档挂起归 `test:approval`，发布包自包含归 `test:install`。

## 版本守卫（`test/versions.test.ts`，`bun test` 的一部分）

「pin == 宿主版本」是手工维护的不变量，复发过七次。四项断言：

| 项 | 断言 | CI `check` job（无宿主） |
| --- | --- | --- |
| 精确 pin | `@oh-my-pi/*` 用精确版本，无 `^` `~` | 生效 |
| installed == pin | `node_modules` 与 `package.json` 一致 | 生效（frozen-lockfile 装的就是 pin） |
| 两个 pin 一致 | `pi-ai` 与 `pi-coding-agent` 同版本（lockstep 发布） | 生效 |
| 宿主 == pin | `omp --version` 与 pin 相同 | **跳过**（无宿主可比） |

第四项以前只 warn，那是这条不变量唯一的信号恰好落在没人必须处理的地方：宿主自己会升级（`startup.checkUpdate`，默认开），而 CI 两个 job 都看不见——`check` 用 frozen-lockfile 装，pin 与 lock 自洽；`host-probes` 装的就是 pin 本身，比的也是 pin。**没人必须处理的 warn 不是守卫**，所以它现在 fail。

失败信息同时给出两个版本与修法。确实要对着别的宿主版本跑时用 `A2MCP_SKIP_HOST_VERSION_CHECK=1`，会打一行大声的 SKIPPED 日志，不会静默。宿主二进制认 `OMP_BIN`。

## 约定

- `test/*.test.ts` 被 `bun test` 自动发现；核验脚本（`smoke.ts` / `hardening.ts` / `approval-probe.ts` / `obtain-probe.ts`）故意不带 `.test` 后缀，只能手动跑，避免 CI/本地把真实宿主进程拉起来。
- 环境变量：`OMP_BIN`（宿主二进制）、`REPO`（仓库根，脚本默认自推导）、`A2MCP_AUDIT`（审计日志路径，默认 `<agentDir>/a2mcp.log`）、`A2MCP_INSTALLS`（安装账本路径，默认 `<agentDir>/a2mcp.installs.json`，见 `src/obtain.ts`）、`A2MCP_OBTAIN_TARGET`（`test:obtain` 的安装目录覆盖，默认临时目录，所以它不会写真的 `~/.local/bin`）、`A2MCP_SKIP_HOST_VERSION_CHECK`（设 `1` 跳过版本守卫的宿主比较，见上一节）。
- 判定性结论（如审批挂起语义）必须由核验复核，不以源码阅读或推理代替——这是本仓库评审沉淀的规矩。
