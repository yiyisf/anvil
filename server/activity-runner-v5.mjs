import { runTurn } from "./harness.mjs";
import { buildSkillInvocation, loadMattSkillBundle } from "./skill-adapter.mjs";
import { newAgentSession, newSkillRun } from "./model-v5.mjs";
import { getActivity, saveActivity, getWork, saveWork, saveAgentSession, saveSkillRun } from "./store-v5.mjs";
import { planRecovery } from "./recovery-runner.mjs";

const ACTIVITY_PHASE = { alignment: "analysis", specification: "spec", planning: "spec", implementation: "impl" };
function instructionsFor(activity) { return `You are executing an Anvil engineering activity. Follow the requested Matt Pocock skill as the source of engineering method. Do not invent a parallel Anvil methodology. Current activity: ${activity.type}.`; }

async function executeTurn({ work, activity, project, prompt, onEvent, session, run }) {
  const skill = activity.technical.skill;
  const invocation = buildSkillInvocation(skill, prompt);
  const skills = await loadMattSkillBundle(skill);
  return runTurn({ reqId: work.id, worktreesDir: project.worktreesDir, sessionKey: `activity-${activity.id}`, phase: ACTIVITY_PHASE[activity.type] || "impl", instructions: instructionsFor(activity), skills, prompt: invocation, onEvent });
}

export async function runActivity({ workId, activityId, project, prompt = "", onEvent }) {
  const work = await getWork(workId); if (!work) throw new Error(`Work 不存在: ${workId}`);
  const activity = await getActivity(activityId); if (!activity || activity.workId !== workId) throw new Error(`Activity 不存在: ${activityId}`);
  const skill = activity.technical?.skill; if (!skill) throw new Error(`Activity ${activityId} 没有关联 skill`);
  const session = newAgentSession({ workId, activityId, ticketId: activity.ticketId });
  const run = newSkillRun({ activityId, sessionId: session.id, skill });
  session.status = "active"; run.status = "running"; activity.status = "running"; activity.sessionId = session.id; activity.startedAt ||= new Date().toISOString(); work.currentActivityId = activity.id; work.status = "active";
  await saveAgentSession(session); await saveSkillRun(run); await saveActivity(activity); await saveWork(work);
  try {
    const out = await executeTurn({ work, activity, project, prompt, onEvent, session, run });
    run.status = "completed"; run.summary = out.text.slice(0, 500); run.tools = out.tools.slice(0, 50); run.files = out.files; run.finishedAt = new Date().toISOString(); session.status = "completed";
    if (activity.gate?.required) { activity.status = "waiting_user"; activity.gate.status = "waiting"; work.status = "waiting_user"; }
    else { activity.status = "completed"; work.status = "active"; }
    activity.finishedAt = new Date().toISOString();
    await saveSkillRun(run); await saveAgentSession(session); await saveActivity(activity); await saveWork(work); return { work, activity, run, output: out };
  } catch (error) {
    // A failed agent turn is an interruption first. Recovery policy decides
    // whether it is recoverable, blocked on a human, or eventually terminal.
    run.status = "interrupted"; run.summary = error.message; run.finishedAt = new Date().toISOString(); session.status = "interrupted";
    await saveSkillRun(run); await saveAgentSession(session);
    const recovery = await planRecovery({ error, work, activity, runId: run.id });
    return { work, activity, run, interruption: recovery.interruption, recovery: recovery.decision };
  }
}
