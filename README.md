# 研发流程控制台 · v4 初稿

两阶段工作流：**需求分析**（人机对话把边界问清）→ **实现**（skill 自动执行）。
每个需求一个独立 git worktree，分析产物与代码改动都在里面，支持作废重跑。

## 跑起来

```bash
npm install
cp .env.example .env      # 按下方说明填写
npm run dev               # 同时起 API(:8787) 与 UI(:5173)
```

打开 http://localhost:5173

只起后端：`npm run api`；只起前端：`npm run ui`

### .env 必填项

```
LITELLM_BASE_URL=http://你的地址:端口     # 不要带 /v1，Pi 会自己拼
LITELLM_API_KEY=你的key
PI_MODEL=anthropic/你的内部模型名          # 必须带 provider 前缀
PI_PROVIDER=anthropic                     # LiteLLM 暴露 anthropic 协议就填这个
REPO_PATH=/path/to/your/repo              # 已有 git 仓库
WORKTREES_DIR=/path/to/worktrees          # 各需求工作副本的父目录
BASE_BRANCH=main
```

模型相关的四项与 spike 里跑通的配置保持一致即可。

### 自检（不需要模型）

```bash
node --env-file=.env doctor.mjs [需求ID]
```
逐层检查环境路径、worktree、工具配置与沙箱内实际执行结果，详见下方「配置不生效时」。

## 走一遍完整流程

1. 左上角 **+** 新建需求，填标题 → 自动创建 worktree 与 `agent/<REQ-ID>` 分支
2. **分析阶段**：描述需求，代理逐条追问。右栏"需求条目"实时收敛
   - 已定项可点击直接改；未定项填完即转为已定
   - 未定项清零后，"生成规格并移交实现"按钮才可用
3. **移交**：生成 `.agent/spec.feature` 与 `.agent/tickets.md` 写入 worktree，提交到分支
4. **实现阶段**：每个工单点"跑 implement / code-review / e2e"逐步推进
   - 底部细对话条可查看与介入，平时不占版面
   - 出异常时右栏变成处置面板
5. **作废重跑**：销毁 worktree 与分支后重建，产物全部清空

## worktree 布局

```
<WORKTREES_DIR>/
  REQ-XXXXX/          ← 分支 agent/REQ-XXXXX
    .agent/
      spec.feature    ← 分析产物：Gherkin 规格
      tickets.md      ← 分析产物：工单拆分
    src/...           ← 实现阶段的代码改动
```

分析产物与代码改动同在一个 worktree、同一分支，作废重跑一次清干净。
主仓库不受影响（已验证）。

右栏的「改动文件」按**相对基线分支**统计：每跑完一个 skill 都会 `commitAll` 一次，
只看 `git status` 的话工作区早已干净，清单会永远是空的。所以它取
`base...HEAD` 的已提交改动，再叠上尚未提交的工作区状态。

## 两层工具：sandbox 环境依赖 vs agent 可用工具

这是两件不同的事，配置也分开：

| 层 | 是什么 | 配置项 |
|---|---|---|
| **agent 工具** | LLM 能调用哪些工具（read/write/edit/bash/grep/glob/webSearch） | `agentTools` |
| **sandbox 环境** | `bash` 里能调用哪些真实二进制（node/mvn/python） | `sandboxTools` |

**嵌套关系**：agent 有没有 `bash` 工具，决定它能不能执行命令；sandbox 里有没有 `node`，
决定 `bash` 里能跑什么。关掉 `bash` 工具，`sandboxTools` 配再多也没用。

### agent 工具按阶段限定（默认档位）

| 阶段 | 可用工具 | 理由 |
|---|---|---|
| `analysis` 需求分析 | read, grep, glob | 只需读代码理解上下文，**不该改任何东西** |
| `spec` 生成规格/工单 | read, write, edit, grep, glob | 要写 `.agent/` 下的文件，但不需要执行命令 |
| `impl` 实现 | 全部内建工具 | 需要改代码、跑测试 |

这把"分析阶段不该动代码"从**提示词里的期望**变成了**结构上的保证**。

项目可覆盖：

```json
{
  "sandboxTools": ["node", "npm", "git", "mvn"],
  "agentTools": {
    "analysis": { "allow": ["read", "grep", "glob"] },
    "impl": { "allow": ["read", "write", "edit", "bash"] }
  }
}
```

用 `builtinToolFiltering`（直接摘掉工具）而非 `permissionMode` 做主控制，
因为过滤是确定性的；`permissionMode` 走审批流，当前没有内建工具的审批 UI，
设成需审批会让运行卡住，故统一 `allow-all`，由"有哪些工具"划边界。

### 配置不生效时：先跑诊断

```bash
node --env-file=.env doctor.mjs [需求ID]
```

它会逐层报告：环境路径解析、git 记录的 worktree、配置文件在哪、实际生效的是什么、
宿主 PATH 里有没有这些命令，以及在真实 sandbox 会话里逐个执行的结果。

第 0 步会把三方信息摊开交叉比对（环境变量解析后的绝对路径 / `git worktree list` /
目录实际内容），「服务建好了但 doctor 找不到」这类不一致一眼可见。

> **建议 `WORKTREES_DIR` 和 `REPO_PATH` 都用绝对路径。** 用相对路径时，
> API 服务与 doctor 若从不同目录启动，解析出的绝对路径不同，就会各看各的。

**两类报错含义完全不同，别混：**

| 现象 | 原因 | 处理 |
|---|---|---|
| `bash: java: command not found` | 命令**没注册**——配置没读到 | 见下方「配置必须提交」；或服务未重启 |
| `[bridge] 工作目录不存在` | **worktree 没建出来**，与命令无关 | 重建需求，或做一次「作废重跑」 |
| `[bridge] 宿主上找不到命令 java` | 已注册，但**服务进程的 PATH** 里没有 | 装上或用绝对路径；注意从 IDE 启动时 PATH 可能与登录 shell 不同，改完**重启 API** |
| 「路径不可用」/ `Unable to resolve path` | 沙箱里缺 `realpath`，pi 的文件工具无法规范化路径 | 见「沙箱内建 realpath」；`doctor.mjs` 第 6 步会直接判定 |

> 第二条容易误诊：`execFile` 在「命令不存在」和「工作目录不存在」两种情况下
> 抛的都是 `spawn <cmd> ENOENT`，完全无法区分。桥接现在会先检查工作目录，
> 避免把「worktree 缺失」报成「宿主没装这个命令」，让排查方向跑偏。

> **Windows 上的批处理**：`mvn` / `npm` / `npx` / `gradle` 在 Windows 上实际是
> `.cmd` / `.bat` 批处理文件，`execFile` 不经 shell 起不来，报的还是 `ENOENT`，
> 与「没装这个命令」无法区分。桥接现在会先用 `where` / `which` 解析出**绝对路径**，
> 再按扩展名决定：`.exe` 直接执行，`.cmd` / `.bat` 经 `cmd.exe /d /s /c` 启动。
> 用绝对路径也顺带避开了「从 git-bash 启动时 PATH 里是 POSIX 路径、Windows 的 Node 解析不了」的问题。
> 另一个坑：Maven / npm / gradle 的 bin 目录里**同时**有无扩展名的 Unix 脚本（`mvn`）
> 和 Windows 批处理（`mvn.cmd`），`where mvn` 两个都返回。取第一行往往拿到前者，
> Windows 执行不了，报错还是 ENOENT。现在会按 `PATHEXT` 优先挑 `.exe/.cmd/.bat`。
> `doctor.mjs` 第 4 步会显示解析到的真实路径，批处理会标注出来。

> **PATH 处理**：just-bash 的 `ctx.env` 里带着它自己的虚拟 PATH（`/usr/bin:/bin`）。
> 桥接执行宿主命令时**始终保留宿主真实 PATH**，不让虚拟 PATH 覆盖 —— 否则装在
> sdkman、`/opt`、`Program Files` 等位置的 java / mvn 会全部 ENOENT，
> 而报错与「命令不存在」一模一样。命令里显式设置的变量（如 `JAVA_HOME=x mvn test`）仍会透传。

### ⚠️ agent.config.json 必须提交到仓库

worktree 是从分支检出的，**未提交的文件不会出现在 worktree 里**。
只在主仓库工作区创建配置而没提交，每个需求的 worktree 都读不到它，
会静默回退到环境变量或内置默认值。

```bash
cd <你的仓库> && git add agent.config.json && git commit -m "add agent config"
```

已存在的需求需要做一次「作废重跑」重新检出，或新建需求。

> **worktree 保留的是它创建那一刻的配置。** 之后往主仓库提交的新配置不会自动同步过来，
> 所以后加的工具（如 mvn）在老需求里不生效。`doctor.mjs` 会比对两份配置并提示。

> **HOME 也不能被虚拟值覆盖**：just-bash 的 `ctx.env.HOME` 是 `"/"`，
> 若透传给宿主进程，git 会去找 `//.config/git/config`，Windows 上直接
> `Invalid argument`（exit=128）。桥接现在把 HOME、USERPROFILE、TEMP 等
> 一并挡在外面，只放行用户在命令里显式设置的变量。

## sandbox 里的真实二进制

**just-bash 是 JS 实现的 bash，内建命令都是 JS 版，没有任何真实二进制。**
不配置的话，`node --version` 在 sandbox 里会 127 command not found，
implement / e2e 这类 skill 根本跑不了测试。

因此 `server/tools.mjs` 把宿主的真实二进制桥接进 sandbox：

```
SANDBOX_TOOLS=node,npm,npx,git      # 按需增减，如 python3,mvn,go
TOOL_TIMEOUT_MS=180000
```

工作方式：sandbox 里执行 `npm test` → 桥接到宿主 `npm`，
执行目录按沙箱 cwd 映射回真实 worktree（`/REQ-XXX` → `<WORKTREES_DIR>/REQ-XXX`）。
未在白名单的命令仍然 127，内建命令不受影响。

### 沙箱内建 realpath（与白名单无关，永远注册）

`server/sandbox-path.mjs` 往每个 sandbox 注册一个纯 JS 实现的 `realpath`，
直接操作沙箱 VFS，不走桥接、不受 `sandboxTools` 控制。

**为什么必须有它**：harness-pi 的 read / write / edit / grep / glob 在动手前，
都会先在沙箱里跑一段 shell 把路径规范化：

```sh
if [ ! -e "$target" ]; then echo __PI_REALPATH_NOT_FOUND__; exit 2; fi
resolved=$(realpath "$target" 2>/dev/null) || { echo __PI_REALPATH_FAILED__; exit 3; }
```

just-bash 的命令表里有 `readlink`、**没有 `realpath`**，于是子 shell 127
command not found，走进第二个分支，pi 抛 `Unable to resolve path`——
界面上就是**「路径不可用」**。

> 这个报错极具误导性：文件明明在，第一行的 `[ -e ]` 也过了，挂的是下一行。
> 从"文件到底在不在"去查会全程查不出东西。

也不能靠 `sandboxTools` 桥接宿主的 `realpath` 绕过：Windows 上没有这个二进制，
且桥接过去的参数是沙箱路径（`/REQ-1/src/a.js`），宿主上并不存在。

> **Windows 上还有第二层**：`ReadWriteFs` 返回的"虚拟路径"是把宿主真实路径的
> root 前缀切掉得到的，于是带的是反斜杠——`D:\trees\REQ-1\src\a.js` 切成
> `\REQ-1\src\a.js`。pi 用 `path.posix` 判断结果是否还在工作区内，
> 反斜杠串一律判为越界（`Pi path escapes the readable roots`）。
> 所以补了 `realpath` 命令还不够，`posixVirtualFs` 在 fs 层统一把
> `realpath` / `readlink` 的返回值掰回 posix，`pwd -P` 也一并受益。

`doctor.mjs` 第 6 步会跑与 pi 内部一模一样的那段 shell，直接告诉你这一步过没过。

### 按项目配置白名单

在**项目仓库根目录**放一个 `agent.config.json`（建议提交，团队共享同一套）：

```json
{
  "tools": ["node", "pnpm", "git", "mvn"],
  "toolTimeoutMs": 300000
}
```

优先级：`项目 agent.config.json` > 环境变量 `SANDBOX_TOOLS` > 内置默认。
配置文件缺失或格式错误会自动回退，不会中断运行。

因为 worktree 是仓库的检出，配置会随之带进每个需求的工作副本，天然按项目生效；
将来支持多项目时这里无需改动。

调试：`DEBUG_TOOLS=1` 启动会打印每个需求实际注册了哪些工具及配置来源。

### 安全边界

本工具的定位是**开发者本地安装**，信任模型与 Claude Code / Cursor / Codex CLI 同类：
在自己机器上、操作自己的代码。需要清楚的是：

- 文件读写被 `ReadWriteFs` 的 root 限制在 `WORKTREES_DIR` 内；
- **但被桥接的工具本身不受此限制** —— `node -e "..."` 能读写任意路径、发起网络请求。
  白名单挡得住"没桥接的命令"，挡不住"桥接了的命令能做什么"。

已有的一层保护值得保持：**代理在 worktree 里干活，碰不到开发者正在用的工作区**。
这比直接在当前检出上改动的编码代理，影响范围小一圈。

实践建议：
- `tools` 按项目最小化，别图省事全加上；
- 别把这个服务跑在有生产凭证的机器上；
- 若将来要多人共用一个实例（而非各自本地安装），必须放进容器并重新评估隔离。

## 流式

分析对话、生成规格、skill 运行都是流式的（NDJSON，每行一个 JSON 事件）：

```
{"type":"reasoning","text":"..."}      推理过程
{"type":"text","text":"..."}           回复增量
{"type":"tool","n":"read","a":"src/x"} 工具调用
{"type":"file","path":"src/x"}         文件改动
{"type":"stage","text":"解析工单拆分"}  模型之外的处理步骤
{"type":"done","req":{...}}            结束，带完整需求状态
```

界面表现：分析阶段文字逐字出现；实现阶段运行中的 skill 自动展开，
工具调用逐条浮现并显示调用次数。协议行（SETTLED / VERDICT）在流式过程中隐藏，
避免出现半截 JSON。

**生成规格**要等模型写完 `spec.feature` 与 `tickets.md`，十几秒到几分钟不等。
过程中按钮变成「正在生成规格」，下面按顺序显示：服务端报的处理步骤（`stage`）、
代理正在写的文件、模型的说明文字 —— 有东西在动，才不会被当成卡死去刷新页面。

### 选中的需求在地址栏里

`?id=REQ-XXXXX`。刷新、贴链接给同事都能回到同一个需求；地址栏里的 id 已失效时
自动回落到「选择或新建一个需求」，不会白屏。用 `replaceState` 而非 `pushState`：
切需求不算页面跳转，不该让「后退」变成在需求之间倒着翻。

### 每步耗时

实现阶段每个 skill 记录实际执行毫秒数（`step.ms`，服务端测量），工单标题右侧是这个
工单的累计耗时。运行中显示前端本地秒表（服务端 `startedAt` 与浏览器时钟未必一致，
不能直接相减）。**重试会累加而不是清零** —— 否则「这步到底花了多久」会被少算。

## 自动推进与工单依赖

移交后自动开跑，无需逐个点按钮。执行模型：

- **工单之间**按依赖拓扑串行（先串行：共享同一 worktree，并发会互相踩文件）
- **工单内部** implement → code-review → e2e 依次跑
- **失败自动重试一次**，重试时把上次失败原因作为上下文带进去（重试当前 skill，
  不是整个工单从头来，避免推翻已通过的工作）
- 重试仍失败 / 需人确认 → 停下等人，**下游依赖它的工单标成「等待 T-x」而不是继续跑**

### 声明依赖

`.agent/tickets.md` 里：

```
- T-1 导出服务与分页
- T-2 接入权限校验 [依赖 T-1]
- T-3 脱敏与审计 [依赖 T-1, T-2]
- T-4 前端按钮
```

不标依赖就是可独立执行。依赖成环会被检测到并自动忽略全部依赖（界面给出提示），
不会让调度卡死。

### 会话按工单隔离

实现阶段**每个工单一个独立会话**（`impl-T-1`、`impl-T-2`…），而不是全部工单共用一个。

原因：共用会话时上下文随工单数线性累积，迟早触发压缩；压缩后实施质量不可控，
且当前 LLM 侧压缩异常没有自动处理。按工单隔离后，一个会话只承载自己那三步
（implement / code-review / e2e），上下文规模可预期。

连带处理：
- 作废重跑会清空该需求下**全部** `impl-*` 会话（不只是一个）
- 实现阶段的人工对话会落到**当前正在处理/最近处理**的那个工单会话里，
  否则代理没有刚才那段工作的上下文，回答会不着边际

### 运行是异步的

`POST /api/start` 立即返回，推进在服务端后台进行：关掉页面不会中断，
重新打开会通过 `GET /api/events?id=` 接回事件流（长连接，带心跳，可中途接入并补发近期事件）。
界面顶部有「暂停 / 继续推进」。

## 跨平台

宿主命令的执行交给 **cross-spawn**（npm 自己在用的实现），它处理了这些差异：

- **PATHEXT 解析**：Windows 上 `mvn` / `npm` / `gradle` 的 bin 目录里同时有无扩展名的
  Unix 脚本和 `.cmd` 批处理，`where` 两个都返回；取错就是 ENOENT，看起来像"没装"。
- **`.cmd` / `.bat` 经 cmd.exe 启动**，并按 cmd 的规则转义参数（带空格、引号、`&|<>^%!` 的参数）。
- **shebang 脚本**、ENOENT 错误归一化。

另外自行处理的：

| 问题 | 处理 |
|---|---|
| 虚拟 PATH / HOME 覆盖宿主值 | 沙箱默认环境变量一律不透传，只放行命令里显式设置的 |
| 超时后子孙进程残留 | Windows `taskkill /T /F`；POSIX 起独立进程组后整组 kill |
| 输出过大撑爆内存 | 超过 16MB 截断并终止 |
| 代理写出跑不通的命令 | 实现阶段把「当前系统 + 可用命令清单」注入 instructions，并明确禁止执行 `./mvnw`、`*.sh` 等未桥接的脚本 |
| Windows 上填了 `/d/xxx` 这类 git-bash 路径 | doctor 会检出并提示改成 `D:/xxx` |
| CRLF 检出让 `edit` 工具必然失配 | 建 worktree 时加 `-c core.autocrlf=false -c core.eol=lf`，见下 |

### 换行：worktree 一律按 LF 检出

Git for Windows 安装器默认 `core.autocrlf=true`，检出会把库里的 LF 展开成 CRLF。
代理的 `edit` 工具是**逐字节 `indexOf`**（`current.indexOf(oldText) === -1` 就报
`Text to replace was not found`），而模型产出的 `old_string` 几乎总是 LF ——
文件里是 `\r\n`、模型给的是 `\n`，永远匹配不上。

症状很有迷惑性：`read` 一切正常，只有 `edit` 失败，代理于是退而用 `write` 整篇重写。
改动面被放大，diff 里全是无关行，code-review 也就失去意义了。

处理：`ensureWorktree` 只在 `worktree add` 这一条命令上加
`-c core.autocrlf=false -c core.eol=lf`。

- 只影响 anvil 自己建的 worktree，**不动用户仓库的配置**，主工作区不受牵连；
- 库里存的始终是 LF，提交内容与之前逐字节相同；
- 项目若确实需要 CRLF，`.gitattributes` 的 `eol=crlf` 优先级更高，仍然照旧生效。

> 已存在的 worktree 是按老规则检出的，做一次「作废重跑」重建才会变成 LF。

> 说明：Windows 相关逻辑（PATHEXT 挑选、路径分隔符还原）未做真机验证；
> 执行与转义已交给 cross-spawn，边界情况由它兜底。`doctor.mjs` 可在真机上逐层核对。

## 已知边界（初稿）

- **工单不并发**：共享同一 worktree，并发改文件会互相踩。要并发需每工单一个 worktree。
- **失败即停**：任一工单失败/需确认，整体停下等人，独立工单也不再推进。
- **skill 是内联的**（`server/skills.mjs`）。接 Matt skills 时改为读取 SKILL.md 目录。
- **状态存文件**（`.data/`）。生产换 Postgres/MinIO 只需替换 `server/store.mjs` 里四个函数。
- **skill 结果判定靠关键词匹配**模型自陈（"超出范围""未通过"）。要更可靠需让 skill
  输出结构化 verdict。
- 单进程、无并发控制。同一需求同时跑多个 skill 会互相干扰。
- 桥接工具在宿主执行，无资源隔离（CPU/内存/网络不受限），只有超时保护。

## 代码里的 ⚠️ 注释

`server/harness.mjs` 里每处 `⚠️` 都是实测踩出来的坑，改动前先看设计说明第十一、十二节：

- 必须 delete 进程内的 `ANTHROPIC_*`（否则请求打到官方 API）
- 必须显式传 `model` 给 `createPi`
- `customEnv` 协议要与 LiteLLM 一致
- just-bash 的 `run()` 不注入 env，mkdir 必须用字面量路径
- **jsonl 必须在 `session.stop()` 之前读取**（session 结束后 host 临时目录被清理）
- 挂载 worktree 的**父目录**，`workDir` 填目录名；`useDefaultLayout:false` 防止污染仓库
