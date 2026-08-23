# Anvil BUILD 使用说明

## 面向谁

Anvil 的目标是让工程师和非专业工程师都可以使用经过验证的 Coding Agent 工程方法，而不需要先学习每个 Skill 的名称、参数和组合方式。

日常使用时，你只需要描述想完成的工作、回答必要的问题，并在关键节点确认。Anvil 与 Coding Agent 决定是否需要额外方案或任务拆分。

## 基本使用流程

### 1. 创建 BUILD

创建一个工作并描述目标。Anvil 会为该 Work 准备独立的 git worktree，避免直接污染主工作区。

### 2. 与 AI 澄清需求

进入“理解需求”后，AI 会读取项目上下文并针对真正影响实现的边界进行追问。

直接用自然语言回答即可，不需要使用工程术语。右侧“需求理解”用于辅助查看当前已经明确、仍待确认以及可能受影响的内容。

### 3. 确认需求

当你认为需求已经说清楚后，点击“需求已清楚，确认”。Coding Agent 会结合任务实际情况选择合适的后续工程方式。

产品层的三种含义是：

- **直接开发**：需求较小且边界清晰，继续当前对话直接完成，不额外生成方案或开发任务。
- **先制定方案**：需要先形成可靠的实现方案，但任务本身没有必要继续拆成多个开发任务。
- **拆分开发任务**：工作较大或存在多个执行单元，需要先形成方案，再拆分后逐项实现。

普通使用者不需要手动选择或调用 `/to-spec`、`/to-tickets` 等 Skill；这些属于 Anvil 内部的工程执行细节。

### 4. 等待实现与验证

确认后 BUILD 自动继续。直接开发会沿用需求澄清时的 Coding Agent 上下文；需要方案时会先形成实现规格；只有真正需要拆分时才会生成开发任务。

遇到可恢复的执行异常时，Anvil 会优先自动恢复。只有需要外部动作、重新规划或人工决策时才再次要求用户操作。

### 5. 查看工程详情

默认 UI 面向任务结果和决策。需要排查或理解执行过程时，可以展开“工程详情”查看 Activity、Skill、Session、Ticket 等工程信息。

## 工程师模式理解

当前内部 BUILD 路由如下：

```text
alignment (/grill-with-docs)
  ├─ direct  -> same-session implementation
  ├─ spec    -> /to-spec -> specification-context implementation
  └─ tickets -> /to-spec -> /to-tickets -> ticket implementation
```

路由由 Alignment Agent 推荐，在需求确认时采用。若 Agent 没有给出有效推荐，当前版本保守回退到完整 tickets 路径。

## 环境与启动

安装依赖并准备环境配置：

```bash
npm install
cp .env.example .env
npm run dev
```

核心环境变量仍以 `.env.example` 为准，包括模型/LiteLLM、代码仓库路径、worktree 根目录和基础分支等配置。

如遇到 worktree、命令桥接或 sandbox 工具问题，可运行：

```bash
node --env-file=.env doctor.mjs [WORK-<uuid>]
```

## 设计原则

1. Skill 是 Coding Agent 的工程能力，不是要求用户理解的产品菜单。
2. 不为了流程完整而制造无价值的 spec 或 tickets。
3. 小任务尽量保持单 Session，减少上下文切断和流程开销。
4. 复杂任务才逐步增加持久化规格、任务拆分和依赖管理。
5. 人只在需求澄清、关键确认和无法自动恢复的异常处介入。

更详细的逻辑分层、领域模型和路由说明见 `ARCHITECTURE.md`。
