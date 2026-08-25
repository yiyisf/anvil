# Conversation-native BUILD V6 设计

> 状态：Accepted for implementation  
> 日期：2026-08-25  
> 决策 ADR：docs/adr/0003-conversation-native-build.md

## 1. 目标

Anvil V6 将 BUILD 从“分阶段页面中嵌入对话”调整为“以对话为主界面、以阶段和 Artifact 为结构化执行骨架”。

用户从提出需求到确认、实现、验证和反馈始终停留在同一条对话时间线。Anvil 内部仍保留明确的需求理解、方案、开发、验证阶段，但用户无需操作流程本身。

本设计借鉴 Google Antigravity 的任务级抽象和 Artifact 体验：

- 用户观察任务级进度，而不是原始工具调用；
- Agent 自主完成规划、执行和验证；
- 计划、任务列表、截图、测试结果和 Walkthrough 作为可验证 Artifact；
- 用户可以在工作过程中持续反馈，而不是只能接受或放弃最终结果。

参考：

- https://antigravity.google/blog/introducing-google-antigravity
- https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/

## 2. 非目标

V6 第一阶段不处理：

- 多个 BUILD Agent 并行调度界面；
- 云端远程工作区；
- 团队协作评论和权限模型；
- 通用 Skill 市场；
- 兼容现有 Alpha BUILD 数据。

当前项目尚未投入使用，因此采用直接替换，不维护旧协议双写和迁移适配层。

## 3. 核心设计原则

### 3.1 对话是唯一产品主线

用户消息、AI 回复、阶段转换、Artifact、验证结果和异常恢复都进入同一条 Work Timeline。

阶段进度条只用于定位当前状态，不承担页面导航。

### 3.2 事件是事实，文本不是事实

Assistant 文本只负责与用户沟通。任何 Activity 状态变化必须来自后端领域事件，禁止解析自然语言或可见文本来推进流程。

废弃可见响应中的 ANVIL_DECISION Marker。

### 3.3 Skill 是执行方法，不是编排协议

Pocock Skill 负责如何澄清、设计、实现或验证。Anvil Controller 负责判断 Activity 是否完成、选择路线和推进状态。

不得要求第三方 Skill 原生输出 Anvil 私有 Marker。

### 3.4 必要且充分的 Artifact

不是每个 BUILD 都强制生成 Spec 和 Tickets。每条路线只生成足以理解和验证工作的 Artifact。

### 3.5 用户通过自然对话确认

普通确认不需要独立按钮。用户在对话中回复“确认”“按这个做”“开干吧”等，由 Alignment Observer 结合上下文识别。

高风险、不可逆、外部操作仍使用显式 Gate；Gate 作为对话事件和可选快捷操作呈现。

### 3.6 阶段必须可观察

阶段状态统一为：

- pending：尚未开始；
- running：正在执行；
- waiting_user：等待用户输入；
- completed：已经完成；
- skipped：当前路线明确不需要；
- blocked：无法自动继续；
- failed：执行失败。

skipped 必须与 pending 在视觉上区分。

## 4. 产品流程

~~~mermaid
stateDiagram-v2
    [*] --> Alignment
    Alignment --> Alignment: 仍有阻塞决策
    Alignment --> AwaitingConfirmation: 决策 frontier 为空
    AwaitingConfirmation --> Alignment: 用户补充或修订
    AwaitingConfirmation --> RouteSelection: 用户确认共同理解
    RouteSelection --> Specification: spec 或 tickets
    RouteSelection --> Implementation: direct
    Specification --> Planning: tickets
    Specification --> Implementation: spec
    Planning --> Implementation
    Implementation --> Verification
    Verification --> Completed: 验证通过
    Verification --> Implementation: 验证失败且可修复
    Completed --> Implementation: 用户反馈实现缺陷
    Completed --> Alignment: 用户反馈改变需求范围
~~~

### 4.1 Direct 路线

理解需求 → 制定方案 skipped → 开发实现 → 完成验证。

必须产生：

- requirement_summary；
- execution_tasks；
- verification_report；
- walkthrough。

### 4.2 Spec 路线

理解需求 → 制定方案 → 开发实现 → 完成验证。

必须产生：

- requirement_summary；
- implementation_plan；
- execution_tasks；
- verification_report；
- walkthrough。

### 4.3 Tickets 路线

理解需求 → 制定方案 → 拆分开发任务 → 逐任务实现 → 完成验证。

必须产生：

- requirement_summary；
- implementation_plan；
- task_list；
- 每个 Ticket 的 progress；
- verification_report；
- walkthrough。

## 5. Work Timeline 协议

WorkEvent 是前端展示、断线恢复和审计的唯一顺序事实。

~~~ts
type WorkEvent =
  | MessageEvent
  | PhaseEvent
  | AlignmentEvent
  | RouteEvent
  | ArtifactEvent
  | TaskEvent
  | GateEvent
  | VerificationEvent
  | RecoveryEvent
  | CompletionEvent;

interface EventEnvelope<T> {
  id: string;
  workId: string;
  sequence: number;
  type: string;
  actor: "user" | "agent" | "controller" | "system";
  activityId?: string;
  payload: T;
  createdAt: string;
}
~~~

### 5.1 事件类型

| 类型 | 用途 |
| --- | --- |
| user_message | 用户对话 |
| assistant_message | AI 对话 |
| phase_started | 阶段进入 running |
| phase_waiting_user | 阶段等待用户 |
| phase_completed | 阶段完成 |
| phase_skipped | 路线明确跳过阶段 |
| alignment_assessed | Observer 判断结果 |
| alignment_confirmed | 后端接受用户确认 |
| route_selected | 路线选择结果 |
| artifact_created | 创建 Artifact |
| artifact_updated | 更新 Artifact |
| task_started/progress/completed | 任务进度 |
| gate_requested/resolved | 风险确认 |
| verification_started/result | 验证状态 |
| recovery_started/completed/failed | 恢复状态 |
| work_completed | BUILD 完成 |
| work_reopened | 完成后因反馈重新进入执行 |

### 5.2 不变量

- sequence 在单个 Work 内严格递增；
- 事件只追加，不原地修改；
- 同一 commandId 重试不能产生重复领域结果；
- Activity 状态必须可由事件重放恢复；
- 前端不得通过 Assistant 文本推断阶段；
- work_completed 之前必须存在成功的 verification_result；
- phase_completed(alignment) 之前必须存在 alignment_confirmed。

## 6. Alignment Assessment 协议

### 6.1 职责

Alignment Agent 使用 grilling 与用户对话，维护设计决策树和 frontier。

Alignment Observer 是独立的内部结构化判断器。它不向用户直接输出内容，也不修改项目文件。

Observer 在以下时机运行：

- Alignment Agent 完成一轮回答后；
- 用户在 waiting_user 状态发送新消息后；
- 恢复 Alignment Session 后。

### 6.2 输入

~~~ts
interface AlignmentObserverInput {
  work: {
    id: string;
    title: string;
  };
  latestUserTurn?: TimelineMessage;
  latestAssistantTurn?: TimelineMessage;
  confirmedDecisions: DecisionRecord[];
  currentOpenDecisions: OpenDecision[];
  repositoryFindings: FindingSummary[];
}
~~~

不向 Observer 提供隐藏思考文本，只提供用户可见消息、结构化工具发现和既有决策。

### 6.3 输出

~~~ts
interface AlignmentAssessment {
  schemaVersion: 1;
  state: "clarifying" | "awaiting_confirmation" | "aligned";
  openDecisions: Array<{
    id: string;
    question: string;
    reason: string;
    blocking: boolean;
  }>;
  confirmedDecisions: Array<{
    id: string;
    question: string;
    outcome: string;
    sourceTurnIds: string[];
  }>;
  requirementSummary: {
    goal: string;
    scope: string[];
    outOfScope: string[];
    constraints: string[];
    acceptanceCriteria: string[];
  };
  confirmation: {
    detected: boolean;
    sourceTurnId: string | null;
    summary: string;
  };
}
~~~

### 6.4 后端判定规则

Observer 输出不能直接修改 Activity。Controller 必须再次校验：

~~~text
state = aligned
AND openDecisions 中不存在 blocking=true
AND confirmation.detected = true
AND confirmation.sourceTurnId 指向 user_message
AND sourceTurnId 晚于最近一次 requirementSummary 实质变更
~~~

否则不得触发 alignment_confirmed。

### 6.5 自然语言确认

允许：

- “确认，开干吧”
- “理解没问题，按这个范围实现”
- “可以开始”
- “同意你的总结”
- “方案 OK”

不允许误判：

- “先别开干”
- “我还没有确认”
- “如果确认后是不是就会开干？”
- Assistant 自己说“已经对齐”
- 用户确认的是局部选项，但仍存在其他阻塞问题

关键词只能用于召回候选，最终必须结合上下文和否定语义进行结构化判断。

### 6.6 Alignment Agent 的结束体验

当 frontier 非空，继续提出当前可回答的问题。

当 frontier 为空但用户未确认，Agent 必须：

1. 发布或更新 requirement_summary Artifact；
2. 用自然语言说明理解结果；
3. 询问用户是否还有补充，确认后即可开始。

用户确认后，Observer 生成 aligned，Controller 才推进。

## 7. Route Selection 协议

Route Selector 只在 alignment_confirmed 后运行，与 Alignment Skill 分离。

~~~ts
interface RouteDecision {
  schemaVersion: 1;
  route: "direct" | "spec" | "tickets";
  reason: string;
  risk: "low" | "medium" | "high" | "critical";
  requiresApproval: boolean;
  expectedArtifacts: ArtifactKind[];
}
~~~

### 7.1 路线规则

direct：

- 边界清晰；
- 改动局部；
- 不需要持久化设计；
- 不存在多个独立验收单元。

spec：

- 需要先固定设计、接口或迁移策略；
- 实现仍可由一个 Activity 完成；
- 拆 Ticket 不产生额外价值。

tickets：

- 存在多个可独立验证单元；
- 存在明确依赖关系；
- 需要分步推进、恢复或并行。

### 7.2 路线对用户的呈现

route_selected 作为对话中的系统卡片：

> 执行方式：直接开发  
> 原因：范围局部且验收标准明确，不需要额外方案或任务拆分。

普通低风险路线自动继续。高风险路线进入 Gate。

## 8. Artifact 协议

~~~ts
type ArtifactKind =
  | "requirement_summary"
  | "implementation_plan"
  | "task_list"
  | "verification_report"
  | "screenshot"
  | "browser_recording"
  | "walkthrough";

interface Artifact {
  id: string;
  workId: string;
  activityId: string;
  kind: ArtifactKind;
  title: string;
  version: number;
  status: "draft" | "reviewable" | "accepted" | "superseded";
  summary: string;
  content: unknown;
  sourceEventIds: string[];
  createdAt: string;
  updatedAt: string;
}
~~~

### 8.1 Artifact 版本

Artifact 更新创建新版本，但保持相同 artifactId。Timeline 展示更新事件，右侧面板默认显示最新版本，并允许查看历史。

### 8.2 Artifact 反馈

用户针对 Artifact 回复时生成 feedback command，包含 artifactId 和 version。

Controller 分类反馈：

- clarification：回到 Alignment；
- plan_revision：回到 Specification；
- implementation_fix：进入新的 Implementation Activity；
- verification_retry：重新 Verification；
- informational：仅记录，不改变阶段。

反馈不删除既有事件和 Artifact。

## 9. Activity、Session 与 Skill

### 9.1 边界

Work：用户委托的一项端到端工作。

Activity：一个明确阶段的一次执行实例。

Agent Session：模型上下文载体，可跨 Activity 续接，但不决定产品状态。

Skill Run：某 Activity 内执行某个 Skill 的记录。

WorkEvent：面向产品和审计的事实日志。

Artifact：用户可验证的工作产物。

### 9.2 Session 连续性

direct 可以沿用 Alignment Session 的上下文，但必须创建独立 Implementation Activity。

spec 可以沿用 Specification Session，或通过结构化 Handoff 创建实现 Session。

tickets 每个 Ticket 使用独立 Implementation Activity；是否复用 Session 由执行策略决定。

Session 连续不等于 Activity 合并。

### 9.3 Skill 组合

| 阶段 | Skill |
| --- | --- |
| Alignment | grilling |
| Domain capture | domain-modeling，可选旁路 |
| Specification | to-spec |
| Planning | to-tickets |
| Implementation | implement + tdd + code-review |
| Verification | 独立 verify 能力，后续引入测试 Skills |

废弃当前 grill-with-docs 作为 Alignment 主入口。其组合语义由 Anvil 显式编排，避免依赖 Skill 再调用 Skill。

## 10. 单对话用户体验

### 10.1 页面结构

顶部：

- BUILD 标题和总体状态；
- 紧凑阶段条；
- 当前执行方式；
- 工程详情入口。

中间：

- 唯一 Work Timeline；
- 输入框始终位于底部；
- 消息、阶段事件、Artifact 和任务进度按 sequence 展示；
- 新输出自动滚动；用户主动向上阅读时暂停自动滚动并显示“回到最新”。

右侧：

- 默认可收起；
- 需求摘要；
- 已确认决策；
- 当前未决问题；
- 当前阶段与任务；
- 风险/阻塞；
- Artifact 索引。

右侧只读取结构化数据，不复制 Assistant 原始全文。

### 10.2 典型交互

~~~text
用户：增加移动端登录按钮全宽支持。

AI：我检查了登录页。需要确认两个问题……
    [问题卡片]

用户：两个断点都处理；旧主题也要兼容。

AI：已更新需求理解。
    [需求摘要 Artifact v2]
    目前没有其他阻塞问题。如果理解无误，回复我即可开始。

用户：没问题，开干吧。

系统：[理解需求 已完成]
系统：[执行方式 直接开发]
系统：[制定方案 已跳过]
系统：[开发实现 进行中]

Agent：[任务 1/3 修改布局]
Agent：[任务 2/3 补充响应式测试]
Agent：[任务 3/3 浏览器验证]

系统：[完成验证 已通过]
AI：已完成。
    [Verification Report]
    [Screenshot]
    [Walkthrough]
~~~

### 10.3 快捷按钮

问题选项、确认和风险 Gate 可以提供按钮作为快捷输入，但按钮点击必须转换成普通 user_message 或 gate command，并出现在 Timeline 中。

按钮不是独立于对话的另一套状态协议。

## 11. 中途反馈和打断

用户在 running 阶段仍可发送消息。

Controller 分类：

- question：Agent 继续执行，异步回答；
- minor_adjustment：加入当前任务队列；
- scope_change：暂停当前 Activity，回到 Alignment；
- stop：请求安全停止；
- high_risk_instruction：创建 Gate。

范围变化必须形成 work_reopened 或 phase_reopened 事件，不能偷偷修改已经 accepted 的需求摘要。

## 12. 错误恢复

恢复事件也进入 Timeline：

- “测试失败，正在自动修复”；
- “实现 Session 上下文耗尽，已创建续接 Session”；
- “需要你决定是否扩大改动范围”。

自动恢复不得伪造 phase_completed。

Activity 只有在对应产物和验证条件满足时才能 completed。

## 13. 存储和 API

建议新增：

~~~text
.data/works/<workId>.json
.data/events/<workId>.jsonl
.data/artifacts/<workId>/<artifactId>.json
.data/activities/<activityId>.json
~~~

核心 API：

~~~text
GET  /api/v6/works/:id
GET  /api/v6/works/:id/events?after=<sequence>
POST /api/v6/works/:id/messages
GET  /api/v6/works/:id/artifacts
GET  /api/v6/artifacts/:id
POST /api/v6/artifacts/:id/feedback
POST /api/v6/gates/:id/decision
POST /api/v6/works/:id/stop
~~~

流式连接只传 EventEnvelope。断线后使用 sequence 续传，不依赖页面内存恢复。

## 14. 组件边界

~~~mermaid
flowchart TD
    UI["Conversation Workspace"] --> API["BUILD API / Event Stream"]
    API --> Commands["Command Handler"]
    Commands --> Controller["BUILD Controller"]
    Controller --> Observer["Alignment Observer"]
    Controller --> Router["Route Selector"]
    Controller --> Runner["Activity Runner"]
    Runner --> Skills["Pocock Skills"]
    Runner --> Runtime["Harness / Sandbox"]
    Controller --> Events["Work Event Store"]
    Controller --> Artifacts["Artifact Store"]
    Events --> UI
    Artifacts --> UI
~~~

BUILD Controller 是唯一允许提交阶段转换的组件。

Agent、Skill、Observer 和前端只能提出结果或 command，不能直接写 Work 当前阶段。

## 15. 淘汰项

V6 直接删除：

- ANVIL_DECISION 文本 Marker；
- parseAlignmentDecision；
- 从 Assistant 全文提取问题和决策；
- Alignment Activity 内执行实现；
- 通用“确认完成”按钮 Gate；
- 前端根据 Activity 缺失猜测阶段；
- direct 路线把 planning 灰色视为未开始；
- grill-with-docs 的隐式二次 Skill 调用。

## 16. 实施顺序

### Phase A：领域协议

1. 新增 WorkEvent、Artifact、AlignmentAssessment 类型与校验；
2. 新增 Event Store 和顺序号；
3. 新增 BUILD Controller；
4. 新增 Alignment Observer；
5. 新增 Route Selector；
6. 删除 Marker 依赖。

### Phase B：执行编排

1. Activity 状态只由 Controller 转换；
2. 对接 grilling；
3. 明确 direct/spec/tickets 的 skipped 和 required 阶段；
4. 引入 Verification Activity；
5. 把恢复流程转换为事件。

### Phase C：产品界面

1. 重建 Conversation Workspace；
2. 渲染 typed timeline events；
3. 实现 Artifact 卡片和右侧索引；
4. 实现滚动暂停/回到最新；
5. 实现对话确认和 Artifact 反馈；
6. 工程详情展示 Activity/Session/Skill Run。

### Phase D：删除 Alpha

1. 删除 /api/v5；
2. 删除旧 WorkView 状态投影；
3. 删除旧 decision protocol；
4. 更新 CONTEXT、ARCHITECTURE、README 和 QA；
5. 清理旧测试与未使用字段。

## 17. 验收标准

### Alignment

- Assistant 说“可以开始”不能独自推进；
- 用户明确确认且没有阻塞决策时自动推进；
- “先别开始”等否定表达不能误判；
- 决策记录只包含摘要和来源 Turn，不包含 Assistant 全文或隐藏思考；
- Marker 缺失不再影响流程，因为 V6 不使用 Marker。

### Routing

- direct 明确产生 phase_skipped(specification/planning)；
- spec 明确跳过 planning；
- tickets 形成 task_list；
- 路线选择与 Alignment Agent 输出解耦。

### Execution

- 每次实现均存在 Implementation Activity；
- Timeline 在实现开始时立即收到 phase_started；
- 完成前必须存在 Verification Activity；
- 验证失败可以自动回到实现；
- 完成后反馈可以重新打开 BUILD。

### UI

- 用户在一个对话中完成端到端需求；
- 不需要切换阶段页面；
- 所有阶段转换在 Timeline 可见；
- pending 和 skipped 视觉不同；
- Artifact 可展开、反馈和查看版本；
- 断线重连后按 sequence 恢复且不重复事件。

### 安全

- Alignment 默认无代码写权限；
- 项目配置只能收窄阶段权限，不能扩大；
- 高风险操作必须经过 Gate；
- Controller 拒绝非法状态跳转；
- 原始模型思考不进入 Event 或 Artifact。

## 18. 测试策略

- Alignment Observer 表驱动测试：确认、否定、反问、补充、局部确认；
- Controller 状态机属性测试：非法跳转和重复 command；
- direct/spec/tickets 核心 E2E；
- Verification 失败修复循环；
- Artifact feedback 路由测试；
- Event sequence 断线重放测试；
- Windows worktree 回归；
- 浏览器 E2E：单对话完成 direct BUILD；
- 安全测试：Alignment 无法获得 write/edit/bash。

## 19. 关键决策总结

1. 产品采用单一对话时间线；
2. 内部阶段和 Activity 保留并强化；
3. Event Store 是产品状态事实源；
4. Pocock Skills 不承担 Anvil 协议；
5. Alignment Observer 独立判断需求是否对齐；
6. 用户确认必须来自对话中的 user_message；
7. Route Selection 与 Alignment 分离；
8. Artifact 是用户理解和验证工作的主要媒介；
9. Verification 成为一等 Activity；
10. V6 直接替换 Alpha，不做兼容迁移。
