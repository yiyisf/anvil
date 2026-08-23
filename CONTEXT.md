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
Work 推进过程中必须由人作出明确决定的位置。
_Avoid_: Activity, Approval Step

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
根据工作复杂度选择的工程形态：直接开发、先形成方案，或拆分开发任务。
_Avoid_: Fixed Pipeline, Workflow
