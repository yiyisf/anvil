import { runTurn } from "../platform/agent-runtime.mjs";
import {
  buildSkillInvocation,
  loadMattSkillBundle,
} from "../platform/skill-adapter.mjs";
import { newAgentSession, newSkillRun, setBuildRoute } from "./domain.mjs";
import {
  dynamicApprovalGate,
  parseAlignmentDecision,
} from "./decision-protocol.mjs";
import {
  getActivity,
  saveActivity,
  getWork,
  saveWork,
  saveAgentSession,
  saveSkillRun,
} from "../persistence/build-repository.mjs";
import { executeRecovery, planRecovery } from "./recovery-runner.mjs";

const ACTIVITY_PHASE = {
  alignment: "analysis",
  specification: "spec",
  planning: "spec",
  implementation: "impl",
  recovery: "impl",
};
function instructionsFor(activity) {
  let activityProtocol = "";
  if (activity.type === "alignment") {
    activityProtocol =
      ' End every response with exactly one single-line marker: ANVIL_DECISION: {"status":"needs_input|ready","route":"direct|spec|tickets|null","confidence":0.0,"reason":"brief reason","risk":"low|medium|high|critical","requiresApproval":false,"question":"next question or empty"}. Use needs_input while any implementation-significant question remains. Use ready only when work can start. Choose direct for clear single-session work, spec when a durable design is useful without decomposition, and tickets only when multiple dependent or independently verifiable slices make decomposition valuable. Set requiresApproval only for high-risk, irreversible, external, destructive, security-sensitive, or scope-expanding work.';
  } else if (activity.type === "planning") {
    activityProtocol =
      " Anvil has already selected the tickets route. Produce a tracer-bullet breakdown and publish it immediately to the configured local tracker under .scratch/<feature-slug>/issues/, one Markdown file per ticket. Do not pause for a generic approval round. Stop only when a genuinely unresolved product, architecture, destructive, security, or external-system decision requires user input.";
  }
  return `You are executing an Anvil engineering activity. Follow the requested Matt Pocock skill as the source of engineering method. Do not invent a parallel Anvil methodology. Current activity: ${activity.type}.${activityProtocol}`;
}
function appendConversation(activity, role, text) {
  const clean = String(text || "").trim();
  if (!clean) return;
  activity.conversation ||= [];
  activity.conversation.push({
    role,
    text: clean,
    at: new Date().toISOString(),
  });
}

export function createActivityRunner({
  executeTurn = runTurn,
  loadSkillBundle = loadMattSkillBundle,
} = {}) {
  async function continueActivitySession({
    workId,
    activityId,
    project,
    prompt,
    phase = null,
    onEvent,
  }) {
    const work = await getWork(workId);
    if (!work) throw new Error(`Work 不存在: ${workId}`);
    const activity = await getActivity(activityId);
    if (!activity || activity.workId !== workId)
      throw new Error(`Activity 不存在: ${activityId}`);
    if (!activity.sessionId)
      throw new Error(`Activity ${activityId} 尚未建立 Agent Session`);
    const skill = activity.technical?.skill;
    const skills = skill ? await loadSkillBundle(skill) : [];
    const run = newSkillRun({
      activityId,
      sessionId: activity.sessionId,
      skill: skill || "session-continuation",
    });
    run.status = "running";
    run.startedAt = new Date().toISOString();
    activity.status = "running";
    work.currentActivityId = activity.id;
    work.status = "active";
    await saveSkillRun(run);
    await saveActivity(activity);
    await saveWork(work);
    try {
      const out = await executeTurn({
        reqId: work.id,
        worktreesDir: project.worktreesDir,
        sessionKey: `activity-${activity.id}`,
        phase: phase || ACTIVITY_PHASE[activity.type] || "impl",
        instructions: `${instructionsFor(activity)} Continue the existing coding-agent session. Do not restart requirement discovery or create spec/tickets unless the task itself now requires them.`,
        skills,
        prompt,
        onEvent,
      });
      run.status = "completed";
      run.summary = out.text.slice(0, 500);
      run.tools = out.tools.slice(0, 50);
      run.files = out.files;
      run.finishedAt = new Date().toISOString();
      activity.finishedAt = run.finishedAt;
      await saveSkillRun(run);
      await saveActivity(activity);
      await saveWork(work);
      return { work, activity, run, output: out };
    } catch (error) {
      run.status = "interrupted";
      run.summary = error.message;
      run.finishedAt = new Date().toISOString();
      await saveSkillRun(run);
      throw error;
    }
  }

  async function runActivity({
    workId,
    activityId,
    project,
    prompt = "",
    onEvent,
  }) {
    const work = await getWork(workId);
    if (!work) throw new Error(`Work 不存在: ${workId}`);
    const activity = await getActivity(activityId);
    if (!activity || activity.workId !== workId)
      throw new Error(`Activity 不存在: ${activityId}`);
    const skill = activity.technical?.skill;
    if (!skill) throw new Error(`Activity ${activityId} 没有关联 skill`);
    async function executeOnce({
      prompt: nextPrompt = prompt,
      freshSession = false,
    } = {}) {
      const previousSessionId = activity.sessionId;
      const session = newAgentSession({
        workId,
        activityId,
        ticketId: activity.ticketId,
        continuationOf: freshSession ? previousSessionId : null,
      });
      const run = newSkillRun({ activityId, sessionId: session.id, skill });
      if (activity.type === "alignment")
        appendConversation(activity, "user", nextPrompt);
      session.status = "active";
      run.status = "running";
      run.startedAt = new Date().toISOString();
      activity.status = "running";
      activity.sessionId = session.id;
      activity.startedAt ||= run.startedAt;
      work.currentActivityId = activity.id;
      work.status = "active";
      await saveAgentSession(session);
      await saveSkillRun(run);
      await saveActivity(activity);
      await saveWork(work);
      const invocation = buildSkillInvocation(skill, nextPrompt);
      const skills = await loadSkillBundle(skill);
      try {
        const out = await executeTurn({
          reqId: work.id,
          worktreesDir: project.worktreesDir,
          sessionKey: freshSession
            ? `activity-${activity.id}-${session.id}`
            : `activity-${activity.id}`,
          phase: ACTIVITY_PHASE[activity.type] || "impl",
          instructions: instructionsFor(activity),
          skills,
          prompt: invocation,
          onEvent,
        });
        const parsed =
          activity.type === "alignment"
            ? parseAlignmentDecision(out.text)
            : { clean: out.text, decision: null, error: null };
        if (activity.type === "alignment" && parsed.error)
          throw new Error(parsed.error);
        run.status = "completed";
        run.summary = parsed.clean.slice(0, 500);
        run.tools = out.tools.slice(0, 50);
        run.files = out.files;
        run.finishedAt = new Date().toISOString();
        session.status = "completed";
        if (activity.type === "alignment") {
          appendConversation(activity, "assistant", parsed.clean);
          activity.alignmentDecision = parsed.decision;
          activity.routeRecommendation = parsed.decision.route
            ? {
                route: parsed.decision.route,
                reason: parsed.decision.reason,
                at: parsed.decision.at,
              }
            : null;
          if (parsed.decision.status === "needs_input") {
            activity.gate = null;
            activity.status = "waiting_user";
            work.status = "waiting_user";
          } else {
            setBuildRoute(work, parsed.decision.route);
            activity.gate = dynamicApprovalGate(parsed.decision);
            if (activity.gate) {
              activity.status = "waiting_user";
              work.status = "waiting_user";
            } else {
              activity.status = "completed";
              work.status = "active";
            }
          }
        } else if (activity.gate?.required) {
          activity.status = "waiting_user";
          activity.gate.status = "waiting";
          work.status = "waiting_user";
        } else {
          activity.status = "completed";
          work.status = "active";
        }
        activity.finishedAt = new Date().toISOString();
        await saveSkillRun(run);
        await saveAgentSession(session);
        await saveActivity(activity);
        await saveWork(work);
        return { work, activity, run, output: { ...out, text: parsed.clean } };
      } catch (error) {
        run.status = "interrupted";
        run.summary = error.message;
        run.finishedAt = new Date().toISOString();
        session.status = "interrupted";
        await saveSkillRun(run);
        await saveAgentSession(session);
        error.runId = run.id;
        throw error;
      }
    }
    try {
      return await executeOnce();
    } catch (error) {
      const planned = await planRecovery({
        error,
        work,
        activity,
        runId: error.runId,
      });
      if (planned.decision.action !== "recover")
        return {
          work,
          activity,
          interruption: planned.interruption,
          recovery: planned.decision,
        };
      const recovered = await executeRecovery({
        work,
        activity,
        interruption: planned.interruption,
        project,
        runOriginal: executeOnce,
        onEvent,
      });
      if (recovered.recovered) return recovered.result;
      const next = await planRecovery({
        error: recovered.error || error,
        work,
        activity,
        runId: error.runId,
      });
      return {
        work,
        activity,
        interruption: next.interruption,
        recovery: next.decision,
      };
    }
  }

  return { runActivity, continueActivitySession };
}

const productionActivityRunner = createActivityRunner();
export const runActivity = (options) =>
  productionActivityRunner.runActivity(options);
export const continueActivitySession = (options) =>
  productionActivityRunner.continueActivitySession(options);
