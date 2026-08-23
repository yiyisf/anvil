# E2E 缺陷修复与验证计划

> 实施状态：功能修复和确定性验证已完成。真实模型 E2E 因本地无凭据未执行；上游 Pi shrinkwrap 仍包含 2 个高危和 3 个中危生产依赖漏洞，因此发布门禁尚未完全满足。详见 `docs/qa/2026-08-23-e2e-retest-report.md`。

## 1. 目标

根据 `docs/qa/2026-08-23-e2e-validation-report.md`，本计划负责：

1. 修复新建 BUILD 无法自动进入 Alignment 的 P0 缺陷；
2. 删除全部 Legacy Requirement 产品能力，不保留兼容或迁移路径；
3. 恢复 `doctor.mjs` 运维诊断入口；
4. 统一 HTTP 错误状态及前端错误处理；
5. 建立可确定执行的 Fake Agent 全链路测试；
6. 建立真实模型 E2E 和依赖安全审计发布门禁。

完成后，BUILD 是唯一产品生命周期，应用代码中不再存在 Legacy Requirement 入口或执行逻辑。

## 2. 已确认决策

- BUILD 首次推进采用两阶段方案：本轮由后端创建 `draft` Work，前端自动调用流式 `advance`；未来再演进为服务端托管的异步执行。
- Legacy 不提供读取、执行或数据迁移能力，相关前后端代码全部删除。
- Project、Agent Session、Agent Runtime、Sandbox、Skill 和 Worktree 是共享能力，继续保留。
- 外部 `/api/v5/*` BUILD 路径本轮保持稳定。
- HTTP 客户端错误使用规范状态码，但本轮保持 `{ "error": "message" }` 响应体形状，避免同时扩大协议改动。
- 普通 PR 使用 Fake Agent 执行确定性全链路验证；真实模型 E2E 每日定时及发布前执行。
- 不自动删除磁盘上的 `.data/reqs` 文件。应用停止读取这些文件；物理删除属于部署数据清理，不应作为代码发布的隐式副作用。

## 3. 非目标

- 本轮不引入任务队列，也不实现服务端后台 Job Runner。
- 不重命名现有 `/api/v5/*` 路径。
- 不恢复任何 v4 接口。
- 不修改 Sandbox 命令白名单或安全模型。
- 不把真实模型 E2E 放到外部贡献者 PR 中，避免密钥暴露和不可控费用。

## 4. 实施阶段

### 阶段 0：冻结失败用例并建立可注入测试缝

#### 修改

1. 保留当前失败用例作为修复验收基线：
   - `QA-API-010`：创建 BUILD 后 Alignment 必须离开 `idle`；
   - Legacy 路由用例后续改为断言接口和 UI 已被删除；
   - 新增 `doctor.mjs` 启动测试；
   - 新增 HTTP 状态码测试。
2. 将 Agent 执行从直接导入改为可注入 Adapter：
   - `createActivityRunner({ agentRuntime, skillCatalog })`；
   - `agentRuntime.runTurn()` 是生产和 Fake 共用的最小接口；
   - `skillCatalog.loadBundle()` 隐藏 Skill 文件布局。
3. 由应用组装入口注入生产 Adapter，测试注入 Fake Adapter。
4. Skill Catalog 默认读取当前项目已安装的 `.agents/skills/<name>/SKILL.md`，同时允许通过环境变量覆盖根目录。

#### 设计约束

- Fake Agent 只能替换 Agent 外部行为，不得复制 Orchestrator 逻辑。
- 测试必须通过与生产相同的 HTTP、Repository、Orchestrator 和 Activity Runner。
- Fake 输出使用真实协议，例如：

```text
ANVIL_ROUTE: {"route":"direct","reason":"deterministic test"}
```

#### 验收

- 生产代码不读取测试环境变量来判断业务路径。
- Fake 与生产 Adapter 满足同一个小型接口。
- 现有 24 项回归测试保持通过。

### 阶段 1：修复 BUILD 初次推进

#### 修改

1. `server/build/service.mjs` 不再把新 Work 立即设为 `active`，保持领域模型创建的 `draft` 状态。
2. Worktree 创建成功后才把 Work 返回给前端。
3. `src/build/WorkView.jsx` 在满足以下条件时调用一次 `advance`：
   - Work 为 `draft`；
   - 所有 Activity 均为 `idle`；
   - 当前 Work ID 尚未在本页面实例中触发过自动推进。
4. 使用 `useRef` 或等价的 Work ID 启动集合，防止 React Strict Mode、刷新和重复渲染产生并发 `advance`。
5. 服务端在 Activity 已经进入 `running`、`waiting_user` 或 `completed` 时保证重复推进不会再次执行同一 Activity。
6. 自动推进失败时，UI 显示可理解的错误和重试入口，不能停留在“无需操作”的假状态。

#### 自动化验证

- 创建 BUILD 后，Fake Alignment 被调用一次且仅一次。
- Alignment 进入 `waiting_user`，Work 进入 `waiting_user`。
- 刷新页面不会再次执行已开始的 Alignment。
- 两次并发 `advance` 不会创建两个 Agent Session。
- Agent 失败时生成可观察错误，用户可以重试。

#### 完成标准

`QA-API-010` 转为通过；浏览器中创建 BUILD 后能够看到 AI 输出或明确错误，而不是永久停留在空白澄清页。

### 阶段 2：删除 Legacy Requirement

#### 前端删除

- 删除 `src/legacy/api.js`；
- 删除 `src/legacy/LegacyWorkspace.jsx`；
- 从 `src/app/App.jsx` 删除：
  - Legacy Requirement 列表和选择状态；
  - `id` URL 参数；
  - Legacy 创建入口；
  - `/api/events` 订阅；
  - Legacy 成功率统计和阶段组件；
  - 所有 Legacy API 调用。
- Sidebar 只展示 BUILD Work。

#### 后端删除

- 删除 `server/legacy/routes.mjs`；
- 删除 `server/legacy/repository.mjs`；
- 删除 `server/legacy/runner.mjs`；
- 删除 `server/legacy/skills.mjs`；
- 删除 `server/legacy/migrate-project.mjs`；
- 删除 `server/build/legacy-compat.mjs` 及对应投影测试；
- 从 `server/index.mjs` 移除 Legacy 路由和启动迁移；
- 确认 Project 和 Session Repository 没有 Legacy 依赖后删除空目录；
- 将 `package.json` 名称从 `v4-console` 调整为不带版本语义的 Anvil 名称，并同步 lockfile。

#### 数据处理

- 应用不再扫描或读取 `.data/reqs`；
- 不在启动或升级过程中主动删除 `.data/reqs`；
- 部署说明中给出可选的人工清理命令，但不提供数据迁移。

#### 自动化验证

- 源码中不再出现 `/api/req`、`REQ-`、`LegacyWorkspace`、`createLegacyApi`；
- 原 Legacy API 明确返回 `404`；
- UI 中不存在 Legacy、旧需求或旧版创建入口；
- BUILD、Project、Session、Worktree 测试仍通过；
- 使用依赖扫描断言 `build/`、`platform/`、`persistence/` 不依赖已删除目录。

### 阶段 3：恢复并更新 `doctor.mjs`

#### 修改

1. 更新导入路径：
   - `server/platform/tools.mjs`；
   - `server/platform/sandbox-path.mjs`。
2. 将“需求 ID”术语改为“Work ID”。
3. 使用 `workspaceKey()` 和 `treePath()` 解析短 Worktree 目录，不能再假设目录名等于完整 Work ID。
4. 无参数时继续扫描第一个有效 worktree；传入 Work ID 时映射到正确短目录。
5. 更新 README 和使用说明中的命令、输出及故障排查文字。

#### 自动化验证

- 无配置时，`doctor.mjs` 返回清晰的缺少配置提示，而不是模块解析错误；
- 给定临时 Project 和 Work ID 时，能够找到短路径 worktree；
- 至少验证工具配置解析、宿主命令发现和 Sandbox 路径解析；
- `doctor.mjs` 作为独立进程执行，测试其退出码和关键输出。

### 阶段 4：规范 HTTP 错误语义

#### 修改

1. 在 `server/http/` 定义带状态码的 `HttpError` 或等价错误类型。
2. `createHttpHandler` 根据错误类型返回状态：
   - JSON 解析或参数错误：`400`；
   - 资源不存在：`404`；
   - 状态冲突或重复操作：`409`；
   - 未分类服务异常：`500`。
3. 路由不再以 HTTP `200` 返回 `{ error }` 表示普通请求失败。
4. `postJson`、`createBuildApi` 统一检查 `response.ok`，并保留服务端错误信息。
5. NDJSON 在响应头发出前可以返回标准 HTTP 错误；响应开始后继续使用 `{ type: "error" }` 流内事件。

#### 自动化验证

- 非法 JSON 返回 `400`；
- Project 缺少必填字段返回 `400`；
- Work、Project 或 Activity 不存在返回 `404`；
- 非法 Gate 状态返回 `409`；
- 未处理异常返回 `500` 且不泄露堆栈；
- 前端显示服务端错误，不把错误对象写入正常状态。

### 阶段 5：确定性全链路验证

使用 Fake Agent 覆盖三条 BUILD 路径：

#### Direct

```text
创建 BUILD
→ 自动 Alignment
→ 返回 direct 推荐
→ 用户批准 Gate
→ 延续同一 Session 实现
→ Work completed
```

验证 Session 连续性、SkillRun、Activity 状态、流式事件及最终文件记录。

#### Spec

```text
创建 BUILD
→ Alignment 推荐 spec
→ 批准
→ Specification
→ 从 Specification Session 实现
→ Work completed
```

验证不会创建 Planning Ticket。

#### Tickets

```text
创建 BUILD
→ Alignment 推荐 tickets
→ Specification
→ Planning 生成依赖工单
→ 批准 Gate
→ 按 Frontier 执行
→ Work completed
```

验证阻塞依赖、执行顺序、失败恢复及完成计数。

#### 额外场景

- Agent 失败后的恢复和人工升级；
- Session 上下文耗尽后的 fresh-session 恢复；
- 页面刷新和重复请求幂等性；
- API 进程重启后的继续执行；
- Worktree 路径隔离和越界防护。

### 阶段 6：真实模型与 CI 门禁

#### PR 必跑

- `npm ci`；
- 单元和模块测试；
- Fake Agent direct/spec/tickets E2E；
- Playwright Chromium UI E2E；
- Vite 生产构建；
- `doctor.mjs` 冒烟测试；
- Legacy 引用扫描。

CI 安装浏览器：

```bash
npx playwright install --with-deps chromium
```

#### 每日及发布前必跑

- 使用受控仓库执行一次真实 direct BUILD；
- 使用受控仓库执行一次真实 tickets BUILD；
- 验证 Matt Skills 加载、工具调用、文件修改、测试执行、Session 续接和 Work 完成；
- 凭据仅允许在受信任的定时任务和手动发布工作流使用；
- 记录模型、Provider、耗时、Token/费用和失败产物。

#### 安全审计

在可访问 npm 安全公告服务的独立 CI Job 中执行：

```bash
npm audit --omit=dev --registry=https://registry.npmjs.org
```

安全审计不可用时标记 Job 为阻塞或基础设施失败，不能记录为“未发现漏洞”。

## 5. 建议提交顺序

1. `test: add injectable fake agent build harness`
2. `fix(build): start draft work alignment exactly once`
3. `refactor: remove legacy requirement lifecycle`
4. `fix(doctor): resolve platform modules and work ids`
5. `fix(http): return structured client error statuses`
6. `test(e2e): cover direct spec and ticket build routes`
7. `ci: add deterministic and model-backed quality gates`
8. `docs: update build-only architecture and QA evidence`

每个提交都必须保持 `npm run check:v5` 通过，避免把 P0 修复、Legacy 删除和 HTTP 协议调整混成无法独立回滚的大提交。

## 6. 最终验收标准

同时满足以下条件才允许将 QA 结论从 NO-GO 改为 GO：

- 新建 BUILD 能自动且仅执行一次 Alignment；
- direct、spec、tickets 三条 Fake Agent 全链路全部通过；
- Legacy 前端、后端、路由、Repository、Runner 和兼容投影全部删除；
- `doctor.mjs` 在临时 BUILD worktree 上执行成功；
- HTTP `400/404/409/500` 语义测试全部通过；
- Chrome UI E2E 无控制台错误和非预期网络错误；
- API 重启后 Work 和 Session 可继续读取；
- 真实 direct 与 tickets 模型冒烟测试通过；
- npm 安全审计完成且不存在未接受的高危或严重漏洞；
- README、ARCHITECTURE、CONTEXT 和 ADR 与实现一致；
- 生成新的中文 QA 复测报告，并关闭 QA-BUG-001 至 QA-BUG-004。

## 7. 回滚策略

- 阶段 0 仅增加测试缝，可独立回滚；
- 阶段 1 失败时恢复 Work 初始状态和 UI 触发逻辑，不影响数据格式；
- 阶段 2 删除 Legacy 前先保留 Git 可回滚提交，但不建立运行时兼容开关；
- 阶段 4 保持错误响应体形状，必要时可以单独回滚状态码变更；
- CI 门禁分 Job 配置，真实模型基础设施故障与产品测试失败分别报告。
