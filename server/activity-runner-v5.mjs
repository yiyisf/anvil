import { runTurn } from "./harness.mjs";
import { buildSkillInvocation, loadMattSkillBundle } from "./skill-adapter.mjs";
import { newAgentSession, newSkillRun } from "./model-v5.mjs";
import { getActivity, saveActivity, getWork, saveWork, saveAgentSession, saveSkillRun } from "./store-v5.mjs";
import { executeRecovery, planRecovery } from "./recovery-runner.mjs";

const ACTIVITY_PHASE = { alignment: "analysis", specification: "spec", planning: "spec", implementation: "impl", recovery: "impl" };
function instructionsFor(activity) { return `You are executing an Anvil engineering activity. Follow the requested Matt Pocock skill as the source of engineering method. Do not invent a parallel Anvil methodology. Current activity: ${activity.type}.`; }

export async function runActivity({ workId, activityId, project, prompt = "", onEvent }) {
  const work = await getWork(workId); if (!work) throw new Error(`Work 不存在: ${workId}`);
  const activity = await getActivity(activityId); if (!activity || activity.workId !== workId) throw new Error(`Activity 不存在: ${activityId}`);
  const skill = activity.technical?.skill; if (!skill) throw new Error(`Activity ${activityId} 没有关联 skill`);

  async function executeOnce({ prompt: nextPrompt = prompt, freshSession = false } = {}) {
    const previousSessionId = activity.sessionId;
    const session = newAgentSession({ workId, activityId, ticketId: activity.ticketId, continuationOf: freshSession ? previousSessionId : null });
    const run = newSkillRun({ activityId, sessionId: session.id, skill });
    session.status = "active"; run.status = "running"; run.startedAt = new Date().toISOString(); activity.status = "running"; activity.sessionId = session.id; activity.startedAt ||= run.startedAt; work.currentActivityId = activity.id; work.status = "active";
    await saveAgentSession(session); await saveSkillRun(run); await saveActivity(activity); await saveWork(work);
    const invocation = buildSkillInvocation(skill, nextPrompt); const skills = await loadMattSkillBundle(skill);
    try {
      const out = await runTurn({ reqId: work.id, worktreesDir: project.worktreesDir, sessionKey: freshSession ? `activity-${activity.id}-${session.id}` : `activity-${activity.id}`, phase: ACTIVITY_PHASE[activity.type] || "impl", instructions: instructionsFor(activity), skills, prompt: invocation, onEvent });
      run.status = "completed"; run.summary = out.text.slice(0, 500); run.tools = out.tools.slice(0, 50); run.files = out.files; run.finishedAt = new Date().toISOString(); session.status = "completed";
      if (activity.gate?.required) { activity.status = "waiting_user"; activity.gate.status = "waiting"; work.status = "waiting_user"; }
      else { activity.status = "completed"; work.status = "active"; }
      activity.finishedAt = new Date().toISOString();
      await saveSkillRun(run); await saveAgentSession(session); await saveActivity(activity); await saveWork(work); return { work, activity, run, output: out };
    } catch (error) {
      run.status = "interrupted"; run.summary = error.message; run.finishedAt = new Date().toISOString(); session.status = "interrupted";
      await saveSkillRun(run); await saveAgentSession(session); error.runId = run.id; throw error;
    }
  }

  try { return await executeOnce(); }
  catch (error) {
    const planned = await planRecovery({ error, work, activity, runId: error.runId });
    if (planned.decision.action !== "recover") return { work, activity, interruption: planned.interruption, recovery: planned.decision };
    const recovered = await executeRecovery({ work, activity, interruption: planned.interruption, project, runOriginal: executeOnce, onEvent });
    if (recovered.recovered) return recovered.result;
    const next = await planRecovery({ error: recovered.error || error, work, activity, runId: error.runId });
    return { work, activity, interruption: next.interruption, recovery: next.decision };
  }
}
