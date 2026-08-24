# Anvil

Anvil 将 Coding Agent 的工程能力组织为对用户可见、可确认、可恢复的工作生命周期，同时隐藏不必要的工程编排细节。

## Language

**BUILD**:
一次从需求澄清到实现与验证的用户可见工作生命周期。
_Avoid_: Requirement, Request, Job

**Work**:
一项 BUILD 的完整生命周期，包含所选工程路径、当前状态和工作空间。
_Avoid_: Requirement, Ticket

**Activity**:
Work 中一次有明确工程目的的交互，例如需求澄清、方案制定或实现。
_Avoid_: Step, Stage, Task

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

**Build Route**:
Alignment 在需求明确后结构化选择的工程形态：直接开发、先形成方案，或拆分开发任务。协议失败不得默认选择任一路线。
_Avoid_: Fixed Pipeline, Workflow, Fallback Route
