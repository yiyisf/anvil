# Anvil

Anvil 将 Coding Agent 的工程能力组织为对用户可见、可确认、可恢复的工作生命周期，同时隐藏不必要的工程编排细节。

## Language

**BUILD**:
一次从需求澄清到实现与验证的用户可见工作生命周期。
_Avoid_: Requirement, Request, Job

**Work**:
一项 BUILD 的完整生命周期，包含所选工程路径、当前状态和工作空间。
_Avoid_: Requirement, Ticket

**Work Timeline**:
一个 Work 内按 sequence 排列的追加式 WorkEvent，是用户对话、阶段变化、Artifact、验证和恢复的产品事实流。
_Avoid_: Chat History, Activity List

**Work Event**:
Work Timeline 中不可变的领域事实，例如用户消息、阶段转换、Artifact 更新或验证结果。
_Avoid_: UI State, Log Line, Model Token

**Activity**:
Work 中一次有明确工程目的的执行，例如需求澄清、方案制定、实现或验证。
_Avoid_: Step, Stage, Task

**Artifact**:
Agent 为帮助用户理解、反馈或验证工作而生成的版本化产物，例如需求摘要、实现计划、任务列表、截图、验证报告或 Walkthrough。
_Avoid_: Raw Tool Log, Assistant Message

**Gate**:
仅在高风险、不可逆或存在重要未决选择时动态创建的人类决策点，不是固定阶段。
_Avoid_: Activity, Approval Step, Mandatory Stage

**Agent Session**:
Coding Agent 在一次或连续多次 Activity 执行中保持的对话与执行上下文。
_Avoid_: Skill Run, Activity

**Skill Run**:
一次可观察的 Skill 执行记录。
_Avoid_: Agent Session, Activity

**Ticket**:
仅在工程工作确实需要拆分时产生的可依赖、可执行工作项。
_Avoid_: Work, Activity

**Alignment Observer**:
独立于 Alignment Skill 的结构化判断器，用于识别未决问题、共同理解和来自用户消息的确认；它不能直接推进 Work。
_Avoid_: Alignment Agent, Route Selector

**Alignment Assessment**:
Alignment Observer 对当前需求对齐状态的版本化结构结果。
_Avoid_: Assistant Response, ANVIL_DECISION

**BUILD Controller**:
唯一允许校验命令、提交阶段转换并追加领域事件的组件。
_Avoid_: Agent, Skill, Frontend

**Verification**:
实现后的独立 Activity，以测试、截图或其他证据判断验收标准是否满足。
_Avoid_: Implementation Summary, Optional Final Message

**Build Route**:
需求对齐被确认后由 Route Selector 选择的工程形态：直接开发、先形成方案，或拆分开发任务。协议失败不得默认选择任一路线。
_Avoid_: Fixed Pipeline, Workflow, Fallback Route
