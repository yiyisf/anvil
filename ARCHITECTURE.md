# Anvil Architecture

## Product intent

Anvil productizes a proven engineering-skill workflow for people who should not need to understand or manually orchestrate individual coding-agent skills. The coding agent remains responsible for executing the upstream Matt Pocock skills; Anvil owns the product experience, lifecycle, safety boundaries, visibility, recovery and human interaction around that execution.

The upper layer therefore does **not** implement a skill marketplace or duplicate skill logic. Skills are engineering capabilities selected when useful, not mandatory BPM steps.

## Logical layers

```text
┌──────────────────────────────────────────────────────────────┐
│ Product UI                                                   │
│ requirement conversation · understanding · approval · status │
├──────────────────────────────────────────────────────────────┤
│ BUILD Orchestrator                                           │
│ Work / Activity / Gate · adaptive route · recovery · frontier│
├──────────────────────────────────────────────────────────────┤
│ Coding Agent Session                                         │
│ conversation continuity · context · tool execution           │
├──────────────────────────────────────────────────────────────┤
│ Skill Adapter                                                │
│ loads and invokes upstream Matt Pocock skills                │
├──────────────────────────────────────────────────────────────┤
│ Harness / Sandbox / Worktree                                 │
│ isolated files · command bridge · git lifecycle · validation │
└──────────────────────────────────────────────────────────────┘
```

## Source dependency direction

BUILD 是唯一受支持的产品生命周期。项目不提供 v4 Requirement 的兼容或迁移能力；Project、Session、Agent、Sandbox 与 Worktree 作为共享模块保留。

```text
BUILD ──────► Platform / Persistence / HTTP
```

源码按该方向组织：

- `server/build/`：BUILD 领域与用例；
- `server/platform/`：Agent、Skill、Sandbox、Worktree；
- `server/persistence/`：按领域分离的存储接口和共享 JSON 文件机制；
- `server/http/`：HTTP/NDJSON 传输及路由注册；
- `src/build/`、`src/shared/`：BUILD 界面与共享传输模块。

外部 `/api/v5/*` 路径保持稳定；内部 BUILD 文件不再使用 `v5` 后缀。历史 `.data/reqs` 数据不再由应用读取，也不提供迁移流程。

## Adaptive BUILD flow

Requirement clarification is interactive. The Alignment Agent uses `grill-with-docs`, inspects the project and asks only questions that matter to implementation. Every turn ends with a structured `ANVIL_DECISION` outcome. `needs_input` keeps the natural-language conversation open; `ready` selects `direct`, `spec` or `tickets`. Low-risk ready decisions emit a `route_selected` event, making the selected route and reason visible before execution continues in the same stream. High-risk, irreversible, destructive, security-sensitive, external-system or scope-expanding decisions create a dynamic human Gate.

```text
/grill-with-docs
      │
      ├── direct ───────────────► implement in the same agent session
      │
      ├── spec ─► /to-spec ────► implement from the specification context
      │
      └── tickets ─► /to-spec ─► /to-tickets ─► ticket implementation
```

The routes mean:

- **direct** — small, clear work that should remain a single coding-agent session. No durable spec or ticket decomposition is manufactured merely to satisfy Anvil.
- **spec** — the work benefits from a durable implementation specification, but decomposition into tickets would add ceremony without execution value.
- **tickets** — decomposition is genuinely useful, for example because of multiple independent/dependent units of work or a larger execution surface.

A missing or invalid structured decision is a recoverable protocol error. It never defaults to `tickets`: protocol failure must not silently choose the most expensive execution route. The `tickets` route is valid only when the Agent explicitly identifies useful decomposition. Planning publishes local tickets automatically; it does not add a generic approval round.

## Session continuity

A route transition does not imply that Anvil must create a new conceptual methodology. `direct` continues the Alignment coding-agent session into implementation. `spec` continues from the specification Activity's agent session, preserving the implementation context established by `/to-spec`. The ticket route uses ticket-oriented implementation Activities because decomposition is part of that route's engineering intent.

## Domain model

- **Work** — one user-visible BUILD lifecycle. Holds mode, status, workspace and selected `buildRoute`.
- **Activity** — a meaningful engineering interaction such as alignment, specification, planning or implementation. It may reference an upstream skill and an Agent Session.
- **AgentSession** — coding-agent conversational/execution context.
- **SkillRun** — one observable skill/session execution record.
- **Gate** — an explicit human decision created only when risk or an unresolved consequential choice requires it. It is not a mandatory stage boundary.
- **Ticket** — only required by the `tickets` route.

## Skill boundary

Current BUILD mapping:

| Product purpose                     | Upstream skill                              |
| ----------------------------------- | ------------------------------------------- |
| clarify requirement                 | `grill-with-docs`                           |
| create implementation specification | `to-spec`                                   |
| decompose larger work               | `to-tickets`                                |
| implementation engineering          | `implement` (+ its configured dependencies) |

Other upstream skills such as `prototype`, `wayfinder`, `handoff`, `research`, `diagnosing-bugs`, `codebase-design` and `domain-modeling` remain capabilities to introduce at appropriate product scenarios rather than mandatory global stages.

The canonical domain language is recorded in `CONTEXT.md`.

## Safety and execution boundary

The harness restricts tools by phase. Analysis is read-oriented, specification can write its artifacts, and implementation can modify code and execute configured commands. Each Work executes in an isolated git worktree. Recovery is modeled explicitly so recoverable execution failures can retry or resume without silently discarding the Work lifecycle.

## Current implementation status

Implemented in the current alpha BUILD path:

- interactive requirement clarification and reply API;
- requirement-understanding UI projection;
- structured Alignment decisions with explicit readiness, route, confidence and risk;
- automatic low-risk route adoption and dynamic high-risk approval;
- `direct`, `spec`, and `tickets` orchestration paths;
- same-session direct implementation;
- specification-context implementation without forced tickets;
- ticket frontier implementation for decomposed work;
- execution interruption/recovery model;
- isolated worktree and tool/sandbox controls.

The product UI should describe these choices in user language (for example, “直接开发”, “先制定方案”, “拆分开发任务”) rather than requiring non-engineers to understand skill names or route enum values.
