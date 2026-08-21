import { getWork, saveWork, getActivity, saveActivity, listActivities } from "./store-v5.mjs";
import { runActivity, continueActivitySession } from "./activity-runner-v5.mjs";
import { ensureImplementationActivities, runFrontierTicket } from "./implementation-v5.mjs";
import { getTicketFrontier } from "./ticket-frontier-v5.mjs";
import { setBuildRoute } from "./domain-model.mjs";

const ROUTE_ORDER = Object.freeze({ direct: ["alignment"], spec: ["alignment", "specification"], tickets: ["alignment", "specification", "planning"] });
export function buildOrder(work) { return ROUTE_ORDER[work.buildRoute] || ROUTE_ORDER.tickets; }
export function decideNextBuildStep({ work, activities, frontier = null }) {
  const ordered = buildOrder(work).map((type) => activities.find((a) => a.type === type)).filter(Boolean);
  for (const activity of ordered) { if (activity.status === "waiting_user") return { kind: "gate", activity }; if (activity.status === "failed") return { kind: "failed", activity }; if (activity.status !== "completed") return { kind: "activity", activity }; }
  if (work.buildRoute === "direct") return { kind: "direct_implementation", activity: activities.find((a) => a.type === "alignment") };
  if (work.buildRoute === "spec") return { kind: "spec_implementation", activity: activities.find((a) => a.type === "specification") };
  const implementationGate = activities.find((a) => a.type === "implementation" && a.status === "waiting_user" && a.gate); if (implementationGate) return { kind: "gate", activity: implementationGate };
  if (!frontier) return { kind: "prepare_implementation" };
  if (frontier.counts.total > 0 && frontier.counts.completed === frontier.counts.total) return { kind: "complete" };
  if (frontier.frontier?.length) return { kind: "ticket", ticket: frontier.frontier[0] };
  if (frontier.counts.running > 0) return { kind: "running" }; return { kind: "blocked" };
}

export async function decideHumanGate({ workId, activityId, decision, route = null }) {
  const work = await getWork(workId); if (!work) throw new Error(`Work 不存在: ${workId}`); const activity = await getActivity(activityId); if (!activity || activity.workId !== workId) throw new Error(`Activity 不存在: ${activityId}`); if (activity.status !== "waiting_user" || !activity.gate) throw new Error("当前 Activity 不在等待确认状态"); const allowed = activity.gate.options?.map((x) => x.action) || ["approve", "revise"]; if (!allowed.includes(decision)) throw new Error(`非法 decision: ${decision}`); const decidedAt = new Date().toISOString(); activity.gate.decision = decision; activity.gate.decidedAt = decidedAt;
  if (activity.gate.kind === "escalation" || activity.gate.kind === "external_action") { activity.gate.status = "decided"; if (decision === "retry") { activity.status = "idle"; activity.gate = null; work.status = "active"; } else if (decision === "replan") { activity.status = "blocked"; const planning = (await listActivities(workId)).find((a) => a.type === "planning"); if (!planning) throw new Error("找不到 planning Activity"); planning.status = "idle"; planning.gate = null; planning.finishedAt = null; await saveActivity(planning); work.currentActivityId = planning.id; work.status = "active"; } else if (decision === "stop") { activity.status = "failed"; work.status = "cancelled"; } await saveActivity(activity); await saveWork(work); return { work, activity }; }
  if (activity.type === "alignment" && decision === "approve") {
    const selectedRoute = route || activity.routeRecommendation?.route || "tickets";
    setBuildRoute(work, selectedRoute);
  }
  activity.gate.status = decision === "approve" ? "approved" : "revision_requested"; activity.status = decision === "approve" ? "completed" : "idle"; work.status = decision === "approve" ? "active" : "waiting_user"; await saveActivity(activity); await saveWork(work); return { work, activity };
}

export async function advanceBuild({ workId, project, onEvent, maxSteps = 50 }) {
  let steps = 0; while (steps++ < maxSteps) {
    const work = await getWork(workId); if (!work) throw new Error(`Work 不存在: ${workId}`); const activities = await listActivities(workId); const planning = activities.find((a) => a.type === "planning"); let frontier = null;
    if (work.buildRoute === "tickets" && planning?.status === "completed") { await ensureImplementationActivities({ work, project }); frontier = await getTicketFrontier({ work, project }); }
    const next = decideNextBuildStep({ work, activities: await listActivities(workId), frontier }); onEvent?.({ type: "orchestrator", state: next.kind });
    if (["gate", "failed", "blocked", "running"].includes(next.kind)) return { reason: next.kind, work: await getWork(workId), next };
    if (next.kind === "direct_implementation") { await continueActivitySession({ workId, activityId: next.activity.id, project, phase: "impl", prompt: "The requirement is confirmed and this is a small task that does not need a separate spec or ticket plan. Continue in this same session and implement the confirmed requirement now. Validate the change when finished.", onEvent }); work.status = "completed"; work.currentActivityId = null; await saveWork(work); return { reason: "completed", work, next }; }
    if (next.kind === "spec_implementation") return { reason: next.kind, work: await getWork(workId), next };
    if (next.kind === "complete") { work.status = "completed"; work.currentActivityId = null; await saveWork(work); return { reason: "completed", work, next }; }
    if (next.kind === "prepare_implementation") continue; if (next.kind === "activity") { await runActivity({ workId, activityId: next.activity.id, project, onEvent }); continue; } if (next.kind === "ticket") { await runFrontierTicket({ workId, ticketId: next.ticket.id, project, onEvent }); continue; }
  } throw new Error(`BUILD 自动推进超过 ${maxSteps} 步，已停止以避免循环`);
}