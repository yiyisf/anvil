import { runTurn } from "./harness.mjs";
import { buildSkillInvocation, loadMattSkillBundle } from "./skill-adapter.mjs";
import { newActivity, newAgentSession, newSkillRun } from "./model-v5.mjs";
import { classifyFailure } from "./failure-classifier.mjs";
import { newInterruption, resolveInterruption } from "./interruption.mjs";
import { recoveryDecision } from "./recovery-policy.mjs";
import { listInterruptions, saveActivity, saveInterruption, saveWork, saveAgentSession, saveSkillRun } from "./store-v5.mjs";

function escalationGate(decision, interruption) {
  const exhausted = decision.reason === "recovery_budget_exhausted";
  return {
    kind: decision.gateKind || "escalation", required: true, status: "waiting",
    prompt: exhausted ? "自动恢复已达到安全上限，需要决定如何继续。" : "执行需要外部条件或人工判断后才能继续。",
    context: { interruptionId: interruption.id, type: interruption.type, evidence: interruption.evidence },
    options: exhausted
      ? [
          { id: "retry", label: "再试一次", action: "retry" },
          { id: "replan", label: "重新规划", action: "replan" },
          { id: "stop", label: "停止 BUILD", action: "stop" },
        ]
      : [
          { id: "retry", label: "条件已处理，继续", action: "retry" },
          { id: "stop", label: "停止 BUILD", action: "stop" },
        ],
    decision: null, decidedAt: null,
  };
}

export async function planRecovery({ error, work, activity, runId = null }) {
  const classified = classifyFailure(error, { activityId: activity.id, ticketId: activity.ticketId });
  const interruption = newInterruption({ workId: work.id, activityId: activity.id, ticketId: activity.ticketId, ...classified, source: { kind: "agent_run", runId } });
  const history = await listInterruptions(work.id, activity.id);
  const decision = recoveryDecision(interruption, history);
  interruption.recovery = { strategy: decision.strategy, attempt: decision.attempt || 0, maxAttempts: decision.maxAttempts || 0, skill: decision.skill || null };
  interruption.status = decision.action === "recover" ? "recovering" : "waiting_user";
  await saveInterruption(interruption);
  if (decision.action === "recover") { activity.status = "recovering"; work.status = "active"; }
  else { activity.status = "waiting_user"; activity.gate = escalationGate(decision, interruption); work.status = "waiting_user"; }
  await saveActivity(activity); await saveWork(work);
  return { interruption, decision };
}

function retryPrompt(interruption) {
  const evidence = interruption.evidence?.message || "执行未完成";
  return `上一次执行被中断。请继续当前 Activity，不扩大范围。先检查当前仓库状态，再解决以下问题并完成原任务：\n\n${evidence}`;
}

async function runRecoverySkill({ work, activity, interruption, project, onEvent }) {
  const skill = interruption.recovery.skill;
  const recovery = newActivity({ workId: work.id, type: "recovery", label: `恢复：${skill}`, skill, ticketId: activity.ticketId, parentActivityId: activity.id, recoveryFor: interruption.id });
  const session = newAgentSession({ workId: work.id, activityId: recovery.id, ticketId: activity.ticketId, continuationOf: activity.sessionId });
  const run = newSkillRun({ activityId: recovery.id, sessionId: session.id, skill });
  recovery.status = "running"; recovery.sessionId = session.id; recovery.startedAt = new Date().toISOString(); session.status = "active"; run.status = "running"; run.startedAt = recovery.startedAt;
  await saveActivity(recovery); await saveAgentSession(session); await saveSkillRun(run);
  const skills = await loadMattSkillBundle(skill);
  const prompt = buildSkillInvocation(skill, `处理 Activity ${activity.id} 的恢复问题。证据：${interruption.evidence?.message || "未知"}`);
  try {
    const out = await runTurn({ reqId: work.id, worktreesDir: project.worktreesDir, sessionKey: `recovery-${recovery.id}`, phase: "impl", instructions: "You are executing a bounded recovery activity. Resolve only the interruption, verify the repository is safe, then stop.", skills, prompt, onEvent });
    const finishedAt = new Date().toISOString(); run.status = "completed"; run.summary = out.text.slice(0, 500); run.tools = out.tools.slice(0, 50); run.files = out.files; run.finishedAt = finishedAt; session.status = "completed"; recovery.status = "completed"; recovery.finishedAt = finishedAt;
    await saveSkillRun(run); await saveAgentSession(session); await saveActivity(recovery); return recovery;
  } catch (error) {
    const finishedAt = new Date().toISOString(); run.status = "failed"; run.summary = error.message; run.finishedAt = finishedAt; session.status = "failed"; recovery.status = "failed"; recovery.finishedAt = finishedAt;
    await saveSkillRun(run); await saveAgentSession(session); await saveActivity(recovery); throw error;
  }
}

export async function executeRecovery({ work, activity, interruption, project, runOriginal, onEvent }) {
  const strategy = interruption.recovery?.strategy;
  if (!strategy || strategy === "human_gate") return { recovered: false, reason: "human_gate" };
  try {
    if (strategy === "skill_recovery") await runRecoverySkill({ work, activity, interruption, project, onEvent });
    const fresh = strategy === "fresh_session" || strategy === "skill_recovery";
    const result = await runOriginal({ prompt: retryPrompt(interruption), freshSession: fresh });
    resolveInterruption(interruption); await saveInterruption(interruption);
    return { recovered: true, result };
  } catch (error) {
    interruption.status = "failed_recovery"; interruption.updatedAt = new Date().toISOString(); await saveInterruption(interruption);
    return { recovered: false, error };
  }
}
