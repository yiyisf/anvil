# Anvil 端到端测试验证报告

## 一、执行摘要

- **测试时间：** 2026-08-23 14:00 CST
- **测试分支：** `refactor/build-maintainability`
- **基线提交：** `46b77bf`
- **QA 结论：** **不建议发布（NO-GO）**
- **主要原因：** 核心 BUILD 生命周期在创建后无法自动进入需求澄清阶段；保留的 Legacy 前端还调用了五个后端未注册的接口。

当前重构版本可以成功构建，现有 24 项回归测试全部通过。浏览器层面的项目配置、BUILD 创建和页面访问正常，Git worktree 隔离正常，持久化数据也能在 API 进程重启后恢复。但是，本轮发现两项阻断发布的产品契约缺陷和一项运维入口回归。

## 二、测试范围与方法

测试全部使用隔离的临时目录、包含真实提交的临时 Git 仓库、真实 Git worktree、真实 Node API 进程、真实 Vite 进程以及无头模式的系统 Google Chrome。测试未读取或污染生产数据，也未在真实项目目录下创建测试 worktree。

本轮覆盖：

- 前端生产构建与现有回归测试；
- HTTP 路由、非法输入及错误响应格式；
- Project 创建、查询和列表；
- BUILD 创建、领域记录、筛选及 Ticket Frontier；
- 真实 Git worktree 和分支创建；
- NDJSON 流式错误响应；
- Legacy Requirement 创建、读取及失败原因分类；
- API 进程重启后的数据持久化；
- Legacy 前端与后端路由契约；
- 浏览器中的项目配置、BUILD 创建和 Legacy 页面；
- 运维诊断入口 `doctor.mjs`；
- 依赖安全审计尝试。

未能执行：

- 真实大模型驱动的需求澄清、规格生成和实现流程，因为项目没有 `.env`、模型网关地址及认证信息；
- 依赖漏洞审计结果，因为当前 npm 镜像和公共 npm 安全公告接口均无法从测试环境访问。

## 三、测试环境

| 项目          | 配置                             |
| ------------- | -------------------------------- |
| 操作系统      | macOS                            |
| Node.js       | v24.10.0                         |
| npm           | 11.6.1                           |
| 浏览器        | 系统 Google Chrome 151，无头模式 |
| 浏览器驱动    | Playwright 1.52.0                |
| API 数据目录  | 临时隔离的 `DATA_DIR`            |
| 目标仓库      | 临时 Git 仓库，基线分支为 `main` |
| Worktree 目录 | 临时隔离目录                     |

## 四、测试结果

### 4.1 总体统计

| 测试套件                   |   通过 |  失败 |  阻塞 | 结果           |
| -------------------------- | -----: | ----: | ----: | -------------- |
| 现有回归测试               |     24 |     0 |     0 | 通过           |
| Vite 生产构建              |      1 |     0 |     0 | 通过           |
| API、Worktree 与持久化 E2E |      9 |     6 |     0 | 失败           |
| 浏览器 UI E2E              |      3 |     0 |     0 | 通过           |
| 运维诊断入口               |      0 |     1 |     0 | 失败           |
| 真实模型生命周期           |      0 |     0 |     1 | 阻塞           |
| 依赖安全审计               |      0 |     0 |     1 | 阻塞           |
| **已执行自动化检查合计**   | **37** | **7** | **2** | **不建议发布** |

37 项通过检查包括：24 项回归测试、1 次生产构建、9 项 API E2E 和 3 项浏览器 E2E。

### 4.2 已通过的关键场景

- 未知路由返回 JSON 格式的 `404`，API 进程不会崩溃。
- 非法 JSON 请求被拒绝，随后 API 仍然可用。
- Project 参数校验、创建、读取和列表查询正常。
- 创建 BUILD 时会生成 Work 以及 Alignment、Specification、Planning 三个 Activity。
- 创建 BUILD 时会生成真实的短路径 Git worktree 和 `agent/*` 分支。
- Work 列表可以按 `projectId` 正确筛选。
- BUILD 在规划前返回合法的空 Ticket Frontier。
- 流式执行错误使用 NDJSON 格式返回。
- 当前已注册接口支持 Legacy Requirement 的创建和读取。
- 失败原因分类接受文档规定的值，并拒绝未知值。
- Project、Work 和 Activity 数据可以在 API 进程重启后恢复。
- 用户可以在 Chrome 中配置项目、创建并打开 BUILD。
- 用户可以在兼容界面中打开 Legacy Requirement。
- 浏览器测试完成后再次运行回归验证，24 项测试和 Vite 构建仍全部通过。

## 五、缺陷清单

### QA-BUG-001：新建 BUILD 无法自动启动需求澄清

- **严重级别：** 阻断 / P0
- **状态：** 待修复
- **受影响契约：** 创建 BUILD 后应自动检查项目并进入需求澄清。
- **测试证据：** `QA-API-010` 失败。创建 BUILD 并持续查询后，Alignment 仍为 `idle`。
- **原因位置：**
  - `server/build/service.mjs:20` 将新 Work 的状态直接设置为 `active`；
  - `src/build/WorkView.jsx:309` 仅在 Work 状态为 `draft` 时调用 `advance()`。
- **用户影响：** 新建 BUILD 后虽然能看到需求界面，但 Agent 不会启动，页面也没有可用的回复输入框，核心 BUILD 生命周期无法继续。
- **复现步骤：**
  1. 创建 Project；
  2. 调用 `POST /api/v5/works` 创建 BUILD；
  3. 打开返回的 Work；
  4. 持续查询其 Activity；
  5. Alignment 始终保持 `idle`。
- **修复建议：** 明确初次推进的唯一责任方。可以让新 Work 保持 `draft` 并由前端推进，也可以在 worktree 创建完成后由服务端主动推进。修复后增加 API 和浏览器回归用例，确认 Alignment 能离开 `idle`。

### QA-BUG-002：Legacy 前后端路由契约不完整

- **严重级别：** 高 / P1
- **状态：** 待修复
- **受影响原则：** v4 能力在完成替代或明确删除前应保持可用。
- **测试证据：** 以下五个契约测试均返回 `404`：
  - `POST /api/message`
  - `POST /api/handoff`
  - `POST /api/run`
  - `POST /api/settled`
  - `GET /api/events`
- **前端调用位置：** `src/legacy/api.js:14-19`、`src/app/App.jsx:27`。
- **后端证据：** `server/legacy/routes.mjs` 没有注册上述路由。
- **用户影响：** 用户可以打开和查看 Legacy Requirement，但需求澄清、移交、工单执行、确认以及运行事件更新均不可用。
- **修复建议：** 逐项明确这些能力的去向：通过隔离的 Legacy 模块恢复接口、迁移到 BUILD 等价能力，或者删除已经不可用的前端操作。建议根据 Legacy 客户端接口自动生成路由契约测试。

### QA-BUG-003：源码迁移后 `doctor.mjs` 无法启动

- **严重级别：** 中 / P2
- **状态：** 待修复
- **测试证据：** 执行 `node doctor.mjs` 时，在环境检查开始前即抛出 `ERR_MODULE_NOT_FOUND`。
- **原因位置：**
  - `doctor.mjs:13` 仍导入已删除的 `server/tools.mjs`；
  - `doctor.mjs:14` 仍导入已删除的 `server/sandbox-path.mjs`。
- **正确路径：** `server/platform/tools.mjs` 和 `server/platform/sandbox-path.mjs`。
- **用户影响：** 文档中用于诊断 Sandbox、Worktree 和工具桥接问题的命令无法使用。
- **修复建议：** 更新两个导入路径，并为文档中的可执行入口增加启动冒烟测试。仅运行 `node --check` 不足以发现此问题，因为必须真正执行模块解析。

### QA-BUG-004：客户端错误使用了不一致的 HTTP 状态码

- **严重级别：** 中 / P2
- **状态：** 待修复
- **测试证据：** 非法 JSON 返回 HTTP `500`；Project 缺少必填参数时返回 HTTP `200` 和错误对象。
- **用户影响：** 客户端和监控系统无法可靠地区分调用方错误与服务端故障。
- **修复建议：** 非法 JSON 和参数校验失败使用 `400`，资源不存在使用 `404`，仅服务端异常使用 `500`。如果 NDJSON 流在建立连接后通过 HTTP `200` 返回执行错误，应在接口契约中明确记录。

## 六、阻塞项与残余风险

### 6.1 真实模型生命周期

由于项目未配置 `.env`、LiteLLM 地址、API Key 和模型，未能执行完整的：

```text
Alignment → Gate → direct/spec/tickets → Implementation
```

现有编排测试覆盖了状态决策，但无法证明模块迁移后真实 Coding Agent、Skill、Sandbox 和 Session 链路仍然可用。

**残余风险：高。** 发布前至少需要针对受控测试仓库执行一次 direct 路径和一次 tickets 路径，覆盖工具执行、文件修改、验证以及 Session 延续。

### 6.2 依赖安全审计

- 当前配置的 npm 镜像对安全公告接口返回 `404 NOT_IMPLEMENTED`；
- 切换到 `https://registry.npmjs.org` 后，测试环境在 TLS 连接建立前断开。

**残余风险：中。** 应在能够访问 npm 安全公告服务的 CI 环境中运行 `npm audit --omit=dev`。本次结果不能视为“未发现漏洞”。

## 七、发布建议

**当前版本不建议发布，也不建议以“BUILD 迁移完成”的状态合并。**

重新测试前必须完成：

1. 修复 QA-BUG-001，确保新 BUILD 自动进入 Alignment；
2. 解决 QA-BUG-002，对每项 Legacy UI/API 能力执行恢复、迁移或明确删除；
3. 修复 QA-BUG-003，并对文档中的运维入口执行冒烟验证；
4. 重新运行 API 和浏览器 E2E；
5. 在具备有效模型配置的环境中执行真实 BUILD 全链路 E2E；
6. 在 CI 中完成依赖安全审计。

## 八、可重复执行的测试资产

- `qa/e2e/api.e2e.test.mjs`：隔离的 API、Git worktree 和持久化测试套件；
- `qa/e2e/ui.e2e.spec.mjs`：真实 Chrome 浏览器测试套件；
- `qa/e2e/playwright.config.mjs`：浏览器测试配置；
- `.qa-results/`：本地原始日志及 Playwright 产物，不纳入源码管理。

执行命令：

```bash
npm run check:v5
npm run test:e2e:api
npm run test:e2e:ui
node doctor.mjs
npm audit --omit=dev
```
