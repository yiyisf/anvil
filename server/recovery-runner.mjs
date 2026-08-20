import { classifyFailure } from "./failure-classifier.mjs";
import { newInterruption } from "./interruption.mjs";
import { recoveryDecision } from "./recovery-policy.mjs";
import { listInterruptions, saveActivity, saveInterruption, saveWork } from "./store-v5.mjs";

/**
 * Convert an execution error into durable control-plane state.
 * Actual retry/skill execution stays in the activity runner so there is one
 * place that owns agent sessions and Harness calls.
 */
export async function planRecovery({ error, work, activity, runId = null }) {
  const classified = classifyFailure(error, { activityId: activity.id, ticketId: activity.ticketId });
  const interruption = newInterruption({
    workId: work.id, activityId: activity.id, ticketId: activity.ticketId,
    ...classified, source: { kind: "agent_run", runId },
  });
  const history = await listInterruptions(work.id, activity.id);
  const decision = recoveryDecision(interruption, history);
  interruption.recovery = {
    strategy: decision.strategy,
    attempt: decision.attempt || 0,
    maxAttempts: decision.maxAttempts || 0,
    skill: decision.skill || null,
  };
  interruption.status = decision.action === "recover" ? "recovering" : "waiting_user";
  await saveInterruption(interruption);

  if (decision.action === "recover") {
    activity.status = "recovering";
    work.status = "active";
  } else {
    activity.status = "waiting_user";
    activity.gate = {
      kind: decision.gateKind || "escalation", required: true, status: "waiting",
      prompt: decision.reason === "recovery_budget_exhausted"
        ? "自动恢复已达到安全上限，需要工程师确认下一步。"
        : "执行需要外部条件或人工判断后才能继续。",
      decision: null, decidedAt: null,
    };
    work.status = "waiting_user";
  }
  await saveActivity(activity); await saveWork(work);
  return { interruption, decision };
}
