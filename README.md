# Anvil

Anvil 将经过验证的 AI 工程 Skills 产品化，让工程师和非专业工程用户都能通过一个简单的 BUILD 界面完成需求澄清、工程决策、编码与验证。

Anvil 不维护 Skill 市场，也不重新发明一套工程方法论。Coding Agent 直接使用 Matt Pocock Skills；Anvil 负责产品交互、状态编排、工作区隔离、恢复与工程可观测性。

> 当前分支为 Adaptive BUILD Alpha。详细架构见 `ARCHITECTURE.md`，完整使用说明见 `USAGE.md`。

## 核心理念

传统固定流水线会把所有需求都强制变成「需求 → Spec → Tickets → 实现」。Anvil 当前实现改为自适应 BUILD：先通过 `/grill-with-docs` 把真正影响实现的边界说清楚，再由 Coding Agent 根据任务本身推荐合适的工程形态。

```text
需求澄清 / grill-with-docs
          │
          ▼
    Agent 工程判断
          │
   ┌──────┼──────────┐
   ▼      ▼          ▼
直接开发  形成方案    拆分任务
 direct    spec       tickets
   │        │           │
   │     /to-spec    /to-spec
   │        │           │
   │        │        /to-tickets
   │        │           │
   └────────┴─────┬─────┘
                  ▼
               实现与验证
```

- **直接开发**：小而明确的改动继续当前 Coding Agent Session，不强制生成 Spec 或 Tickets。
- **形成方案后开发**：需要持久化设计上下文时调用 `/to-spec`，但不为了流程完整而强制拆 Tickets。
- **拆分任务后开发**：复杂工作才使用 `/to-spec → /to-tickets`，并按 Ticket 依赖 Frontier 推进实现。

这些内部 Skill 名称默认不要求普通用户理解。UI 使用「理解需求 / 制定方案 / 开发实现 / 完成验证」等产品语言，工程详情中才暴露 Activity、Skill、Session、Recovery 等信息。

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

默认打开 `http://localhost:5173`。只启动后端可运行 `npm run api`，只启动 UI 可运行 `npm run ui`。

### 基础环境

`.env` 至少需要配置模型、目标仓库和 worktree 目录。以 `.env.example` 为准，常用项包括：

```text
LITELLM_BASE_URL=http://你的模型网关
LITELLM_API_KEY=你的key
PI_MODEL=anthropic/你的模型名
PI_PROVIDER=anthropic
REPO_PATH=/path/to/your/repo
WORKTREES_DIR=/path/to/worktrees
BASE_BRANCH=main
MATT_SKILLS_ROOT=/path/to/optional-skills-root
```

Anvil 默认从当前项目的 `.agents/skills/<skill>/SKILL.md` 加载 Skills。只有需要覆盖默认安装位置时才配置 `MATT_SKILLS_ROOT`；同时支持 Matt Skills 仓库的分组目录布局。

## 使用 BUILD

1. 创建一个 BUILD，只需要用业务语言描述希望完成的事情。
2. AI 自动检查项目并进入需求澄清；存在关键边界时通过对话继续确认。
3. 右侧「需求理解」逐步投影已明确内容、仍待确认内容和可能影响区域。
4. 当需求足够明确时，Agent 推荐直接开发、先形成方案或拆分开发任务。
5. 用户确认需求后，Anvil 采用推荐路径继续推进；复杂工程细节默认隐藏。
6. 实现完成后 BUILD 进入完成状态；发生可恢复异常时优先自动恢复，需要人工判断时才升级到用户。

工程师可以展开「工程详情」查看 Skill、Activity、Session、Ticket Frontier 和恢复信息；非工程用户无需理解这些内部概念。

## Worktree 隔离

每个 Work 使用独立 git worktree 和 `agent/<workspace-key>` 分支，代码修改、Skill 产物和验证都发生在隔离工作区中。

领域层仍使用完整 `WORK-<uuid>` 标识；文件系统边界使用稳定短 `workspaceKey`。这是为了避免 Windows 上完整 UUID 叠加深层项目目录后触发 `Filename too long`。

```text
<WORKTREES_DIR>/
  <short-workspace-key>/
    .agent/       # Anvil 自有产物（如需要）
    .scratch/     # Skills 生成的规格/任务等工作产物
    src/...       # 实际代码修改
```

不要依赖 worktree 文件夹名称作为领域 ID；Work 与 worktree 的映射由 `server/platform/workspace-manager.mjs` 管理。

## Agent 与 Sandbox

Anvil 将 Agent 可调用工具和 Sandbox 可执行的真实二进制分成两层：

| 层            | 作用                                                               |
| ------------- | ------------------------------------------------------------------ |
| Agent tools   | 决定 Coding Agent 能使用 read/write/edit/bash/grep/glob 等哪些能力 |
| Sandbox tools | 决定 `bash` 内能执行 node/npm/git/mvn/python 等哪些宿主二进制      |

需求分析阶段默认限制为读取型工具；实现阶段才开放修改与执行能力。Sandbox 仍通过白名单桥接宿主工具，并保留路径隔离。

Windows 下 npm/mvn/gradle 等 `.cmd/.bat`、宿主 PATH、HOME/USERPROFILE 以及 sandbox POSIX 路径转换均由桥接层处理。出现环境问题时优先运行：

```bash
node --env-file=.env doctor.mjs
```

## 项目结构

```text
src/
  app/                       应用外壳与项目选择
  build/                     BUILD 界面及状态投影
  shared/                    HTTP/NDJSON 客户端
server/
  build/                     Work / Activity、编排、恢复与 Ticket Frontier
  http/                      HTTP 传输与 BUILD/Project 路由
  persistence/               BUILD、Project、Session 文件存储适配器
  platform/                  Agent、Skill、Sandbox 与 Worktree 运行边界
  index.mjs                  依赖组装与服务启动
CONTEXT.md                   领域词汇
ARCHITECTURE.md              架构说明
USAGE.md                     使用说明
```

## 验证

CI 的 `alpha-check` 覆盖服务端测试、BUILD 核心链以及前端构建。Adaptive BUILD 的核心回归测试同时覆盖：

- direct：需求确认后直接进入实现；
- spec：生成规格后直接实现，不进入 Ticket 拆分；
- tickets：完整规格、任务拆分和 Ticket Frontier。

本地验证以 `package.json` 中脚本为准。

## 当前边界

Adaptive BUILD 仍处于 Alpha。当前目标是优先验证核心研发闭环，而不是建设 Skill 市场或复杂 Skill 管理系统。Skill 的工程语义尽量保持来自原始 Skills，Anvil 上层主要解决：

- 对非工程用户友好的交互；
- 自适应工程路径；
- Coding Agent Session 连续性；
- worktree 隔离；
- 异常恢复；
- 工程状态投影与可观测性。

后续实现应继续遵循同一原则：**优先利用 Coding Agent 和 Skills 的原生能力，上层只增加产品化所必需的结构。**
