# Anvil 修复后端到端复测报告

## 一、结论

- **测试分支：** `refactor/build-maintainability`
- **确定性测试结论：** 通过
- **发布结论：** **有条件不通过（NO-GO）**

QA-BUG-001 至 QA-BUG-004 均已修复并通过自动化复测。当前阻塞发布的项目不再是功能回归，而是：

1. 测试环境没有真实模型配置，因此 direct 与 tickets 的真实模型冒烟测试尚未执行；
2. `npm audit --omit=dev` 仍报告 2 个高危和 3 个中危传递依赖漏洞，来源是 `@ai-sdk/harness-pi` 内部带 shrinkwrap 的 `@earendil-works/pi-coding-agent@0.80.10`。

## 二、复测统计

| 验证项                       |   通过 |  失败 |  阻塞 |
| ---------------------------- | -----: | ----: | ----: |
| 模块、领域与 Fake Agent 测试 |     32 |     0 |     0 |
| API / Worktree / 持久化 E2E  |     15 |     0 |     0 |
| Chrome UI E2E                |      3 |     0 |     0 |
| Vite 生产构建                |      1 |     0 |     0 |
| 真实模型 direct / tickets    |      0 |     0 |     2 |
| 生产依赖安全审计             |      0 |     1 |     0 |
| **合计**                     | **51** | **1** | **2** |

## 三、原缺陷复测

### QA-BUG-001：新建 BUILD 无法自动启动需求澄清

**状态：已修复。**

- 新 Work 保持 `draft`，由 BUILD 页面调用流式 `advance`；
- 自动启动按 Work ID 去重；
- 服务端同一 Work 的并发 `advance` 共享同一个 Promise；
- 初次 Alignment 会收到 Work 标题，不再以空需求启动；
- 自动启动失败时页面提供“重试”；
- Fake Agent 验证 Alignment 只执行一次并进入 `waiting_user`；
- Chrome E2E 验证创建 BUILD 后 Alignment 能离开 `idle`。

### QA-BUG-002：Legacy 前后端路由契约不完整

**状态：已通过删除解决。**

- 已删除 Legacy 前端客户端和界面；
- 已删除 Legacy 后端路由、Repository、Runner、Skills 和启动迁移；
- 已删除 BUILD 的 Legacy 投影适配器；
- UI 只展示 BUILD；
- 原 Legacy API 均稳定返回 `404`；
- 应用不读取历史 `.data/reqs`，也不会自动破坏性删除磁盘数据。

### QA-BUG-003：`doctor.mjs` 无法启动

**状态：已修复。**

- 导入已更新到 `server/platform/`；
- 参数术语改为 Work ID；
- 完整 Work ID 通过 `workspaceKey()` 映射到短 worktree 目录；
- 进程测试验证无配置提示；
- 集成测试验证临时 Git Worktree、Sandbox 和工具诊断可以完整执行并正常退出。

### QA-BUG-004：HTTP 状态码不规范

**状态：已修复。**

- 非法 JSON 和参数校验返回 `400`；
- 资源不存在返回 `404`；
- 非法 Gate 状态返回 `409`；
- 未分类服务异常保留 `500`；
- NDJSON 在流开始后继续使用 `type:error`；
- 前端 JSON 客户端统一检查 `response.ok` 并抛出服务端错误信息。

## 四、新增验证能力

### Fake Agent 全链路

确定性测试已覆盖：

- direct：Alignment → Gate → 同 Session 实现 → completed；
- spec：Alignment → Specification → 实现 → completed，且不创建 Ticket；
- tickets：Alignment → Specification → Planning Gate → 依赖顺序执行 Ticket → completed；
- 并发 `advance` 幂等；
- Skill 路由推荐协议；
- Agent Session 连续性。

### 浏览器 E2E

`npm run test:e2e:ui` 会自动：

1. 创建临时 Git 仓库；
2. 启动隔离 API 和 Vite；
3. 使用真实 Chrome 执行测试；
4. 验证 Project 配置、BUILD 创建、自动 Alignment 和 BUILD-only UI；
5. 清理进程及临时文件。

### 真实模型 E2E

新增 `npm run test:e2e:model`，支持：

```bash
MODEL_E2E_ROUTE=direct npm run test:e2e:model
MODEL_E2E_ROUTE=tickets npm run test:e2e:model
```

GitHub Actions 每日及手动工作流使用 direct、tickets 矩阵运行。当前本地环境缺少 `LITELLM_BASE_URL` 和 `PI_MODEL`，因此本轮未执行。

## 五、安全审计

已将 Harness 依赖升级到：

- `@ai-sdk/harness@1.0.85`
- `@ai-sdk/harness-pi@1.0.87`
- `@ai-sdk/sandbox-just-bash@1.0.85`

并覆盖可安全升级的公共传递依赖版本。但 `@ai-sdk/harness-pi` 内部的 `@earendil-works/pi-coding-agent@0.80.10` 使用自身 npm shrinkwrap，项目级 override 无法替换其中的：

- `undici@8.5.0`：高危；
- `brace-expansion@5.0.6`：高危；
- `protobufjs@7.6.4`：中危。

完整生产审计结果为：**2 高危、3 中危、0 严重**。CI 当前对严重漏洞执行阻断，同时保留完整审计输出；这不是“无漏洞”结论。

建议向 `@ai-sdk/harness-pi` 上游升级其 shrinkwrap 中的 `pi-coding-agent`，或发布使用 `pi-coding-agent >= 0.84.2` 的版本。上游修复前，不建议将安全审计标记为完全通过。

## 六、执行证据

```text
npm run check:v5       32 passed，Vite build passed
npm run test:e2e:api   15 passed
npm run test:e2e:ui    3 passed
npm audit --omit=dev   2 high，3 moderate
```

## 七、发布前剩余条件

1. 在具备有效模型密钥的受信任环境执行 direct 和 tickets 真实模型 E2E；
2. 记录模型名称、执行耗时、工具调用和产物；
3. 升级或替换带漏洞 shrinkwrap 的上游 Pi 依赖，或由安全负责人正式接受限时风险；
4. 完成上述条件后，将发布结论更新为 GO。
