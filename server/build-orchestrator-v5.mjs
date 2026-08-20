import { getWork, saveWork, getActivity, saveActivity, listActivities } from "./store-v5.mjs";
import { runActivity } from "./activity-runner-v5.mjs";
import { ensureImplementationActivities, runFrontierTicket } from "./implementation-v5.mjs";
import { getTicketFrontier } from "./ticket-frontier-v5.mjs";

const BUILD_ORDER = ["alignment", "specification", "planning"];

export function decideNextBuildStep({ work, activities, frontier = null }) {
  const ordered = BUILD_ORDER.map((type) => activities.find((a) => a.type === type)).filter(Boolean);
  for (const activity of ordered) {
    if (activity.status === "waiting_user") return { kind: "gate", activity };
    if (activity.status === "failed") return { kind: "failed", activity };
    if (activity.status !== "completed") return { kind: "activity", activity };
  }
  if (!frontier) return { kind: "prepare_implementation" };
  if (frontier.counts.total > 0 && frontier.counts.completed === frontier.counts.total) return { kind: "complete" };
  if (frontier.frontier?.length) return { kind: "ticket", ticket: frontier.frontier[0] };
  if (frontier.counts.running > 0) return { kind: "running" };
  return { kind: "blocked" };
}

export async function decideHumanGate({ workId, activityId, decision }) {
  if (!new Set(["approve", "revise"]).has(decision)) throw new Error("decision 必须是 approve 或 revise");
  const work = await getWork(workId); if (!work) throw new Error(`Work 不存在: ${workId}`);
  const activity = await getActivity(activityId); if (!activity || activity.workId !== workId) throw new Error(`Activity 不存在: ${activityId}`);
  if (activity.status !== "waiting_user" || !activity.gate) throw new Error("当前 Activity 不在等待确认状态");
  activity.gate.status = decision === "approve" ? "approved" : "revision_requested";
  activity.gate.decision = decision; activity.gate.decidedAt = new Date().toISOString();
  activity.status = decision === "approve" ? "completed" : "idle";
  work.status = decision === "approve" ? "active" : "waiting_user";
  await saveActivity(activity); await saveWork(work);
  return { work, activity };
}

export async function advanceBuild({ workId, project, onEvent, maxSteps = 50 }) {
  let steps = 0;
  while (steps++ < maxSteps) {
    const work = await getWork(workId); if (!work) throw new Error(`Work 不存在: ${workId}`);
    const activities = await listActivities(workId);
    const planning = activities.find((a) => a.type === "planning");
    let frontier = null;
    if (planning?.status === "completed") {
      await ensureImplementationActivities({ work, project });
      frontier = await getTicketFrontier({ work, project });
    }
    const next = decideNextBuildStep({ work, activities: await listActivities(workId), frontier });
    onEvent?.({ type: "orchestrator", state: next.kind });
    if (next.kind === "gate" || next.kind === "failed" || next.kind === "blocked" || next.kind === "running") return { reason: next.kind, work: await getWork(workId), next };
    if (next.kind === "complete") { work.status = "completed"; work.currentActivityId = null; await saveWork(work); return { reason: "completed", work, next }; }
    if (next.kind === "prepare_implementation") continue;
    if (next.kind === "activity") { await runActivity({ workId, activityId: next.activity.id, project, onEvent }); continue; }
    if (next.kind === "ticket") { await runFrontierTicket({ workId, ticketId: next.ticket.id, project, onEvent }); continue; }
  }
  throw new Error(`BUILD 自动推进超过 ${maxSteps} 步，已停止以避免循环`);
}
