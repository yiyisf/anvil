import {
  getWork,
  saveWork,
  getActivity,
  saveActivity,
  listActivities,
} from "../persistence/build-repository.mjs";
import { runActivity, continueActivitySession } from "./activity-runner.mjs";
import {
  ensureImplementationActivities,
  runFrontierTicket,
} from "./implementation.mjs";
import { getTicketFrontier } from "./ticket-frontier.mjs";
import { setBuildRoute } from "./domain.mjs";
import { createSingleSessionImplementationActivity } from "./flow.mjs";

const ROUTE_ORDER = Object.freeze({
  direct: ["alignment"],
  spec: ["alignment", "specification"],
  tickets: ["alignment", "specification", "planning"],
});
export function buildOrder(work) {
  // An absent route means Alignment has not produced a valid decision yet.
  // Never turn protocol failure into the most expensive execution route.
  return ROUTE_ORDER[work.buildRoute] || ["alignment"];
}
export function decideNextBuildStep({ work, activities, frontier = null }) {
  const ordered = buildOrder(work)
    .map((type) => activities.find((a) => a.type === type))
    .filter(Boolean);
  for (const activity of ordered) {
    if (activity.status === "waiting_user") return { kind: "gate", activity };
    if (activity.status === "failed") return { kind: "failed", activity };
    if (activity.status !== "completed") return { kind: "activity", activity };
  }
  if (work.buildRoute === "direct")
    return {
      kind: "direct_implementation",
      activity: activities.find((a) => a.type === "alignment"),
    };
  if (work.buildRoute === "spec")
    return {
      kind: "spec_implementation",
      activity: activities.find((a) => a.type === "specification"),
    };
  const implementationGate = activities.find(
    (a) => a.type === "implementation" && a.status === "waiting_user" && a.gate,
  );
  if (implementationGate) return { kind: "gate", activity: implementationGate };
  if (!frontier) return { kind: "prepare_implementation" };
  if (
    frontier.counts.total > 0 &&
    frontier.counts.completed === frontier.counts.total
  )
    return { kind: "complete" };
  if (frontier.frontier?.length)
    return { kind: "ticket", ticket: frontier.frontier[0] };
  if (frontier.counts.running > 0) return { kind: "running" };
  return { kind: "blocked" };
}

export async function decideHumanGate({
  workId,
  activityId,
  decision,
  route = null,
}) {
  const work = await getWork(workId);
  if (!work) throw new Error(`Work 不存在: ${workId}`);
  const activity = await getActivity(activityId);
  if (!activity || activity.workId !== workId)
    throw new Error(`Activity 不存在: ${activityId}`);
  if (activity.status !== "waiting_user" || !activity.gate)
    throw new Error("当前 Activity 不在等待确认状态");
  const allowed = activity.gate.options?.map((x) => x.action) || [
    "approve",
    "revise",
  ];
  if (!allowed.includes(decision))
    throw new Error(`非法 decision: ${decision}`);
  const decidedAt = new Date().toISOString();
  activity.gate.decision = decision;
  activity.gate.decidedAt = decidedAt;
  if (
    activity.gate.kind === "escalation" ||
    activity.gate.kind === "external_action"
  ) {
    activity.gate.status = "decided";
    if (decision === "retry") {
      activity.status = "idle";
      activity.gate = null;
      work.status = "active";
    } else if (decision === "replan") {
      activity.status = "blocked";
      const planning = (await listActivities(workId)).find(
        (a) => a.type === "planning",
      );
      if (!planning) throw new Error("找不到 planning Activity");
      planning.status = "idle";
      planning.gate = null;
      planning.finishedAt = null;
      await saveActivity(planning);
      work.currentActivityId = planning.id;
      work.status = "active";
    } else if (decision === "stop") {
      activity.status = "failed";
      work.status = "cancelled";
    }
    await saveActivity(activity);
    await saveWork(work);
    return { work, activity };
  }
  if (activity.type === "alignment" && decision === "approve") {
    const selectedRoute =
      route || activity.routeRecommendation?.route || work.buildRoute;
    if (!selectedRoute)
      throw new Error("Alignment 尚未产生有效执行路线，不能确认继续");
    setBuildRoute(work, selectedRoute);
  }
  activity.gate.status =
    decision === "approve" ? "approved" : "revision_requested";
  activity.status = decision === "approve" ? "completed" : "idle";
  work.status = decision === "approve" ? "active" : "waiting_user";
  await saveActivity(activity);
  await saveWork(work);
  return { work, activity };
}

async function finishSingleSessionImplementation({
  work,
  activity: sourceActivity,
  project,
  prompt,
  route,
  onEvent,
  continueSession,
}) {
  const activities = await listActivities(work.id);
  let implementation = activities.find(
    (candidate) =>
      candidate.type === "implementation" &&
      !candidate.ticketId &&
      candidate.parentActivityId === sourceActivity.id,
  );
  if (!implementation) {
    implementation = createSingleSessionImplementationActivity(
      work.id,
      sourceActivity,
      route,
    );
    await saveActivity(implementation);
  }
  if (implementation.status !== "completed") {
    await continueSession({
      workId: work.id,
      activityId: sourceActivity.id,
      progressActivityId: implementation.id,
      project,
      phase: "impl",
      prompt,
      onEvent,
    });
  }
  const latestWork = await getWork(work.id);
  latestWork.status = "completed";
  latestWork.currentActivityId = null;
  await saveWork(latestWork);
  return { reason: "completed", work: latestWork };
}

async function advanceBuildUnlocked({
  workId,
  project,
  onEvent,
  maxSteps = 50,
  activityRunner = runActivity,
  continueSession = continueActivitySession,
  prepareImplementation = ensureImplementationActivities,
  ticketRunner = runFrontierTicket,
}) {
  let steps = 0;
  while (steps++ < maxSteps) {
    const work = await getWork(workId);
    if (!work) throw new Error(`Work 不存在: ${workId}`);
    const activities = await listActivities(workId);
    const planning = activities.find(
      (activity) => activity.type === "planning",
    );
    let frontier = null;
    if (work.buildRoute === "tickets" && planning?.status === "completed") {
      await prepareImplementation({ work, project });
      frontier = await getTicketFrontier({ work, project });
      if (frontier.counts.total === 0) {
        // Keep the approved Planning activity resumable. This also repairs
        // BUILDs that an older release incorrectly marked completed before
        // /to-tickets had published its files.
        planning.status = "idle";
        planning.finishedAt = null;
        if (planning.gate) planning.gate.status = "approved";
        await saveActivity(planning);
        throw new Error(
          "方案已确认，但 /to-tickets 没有发布任何开发任务。请点击“重试推进”，并检查 docs/agents/issue-tracker.md 配置。",
        );
      }
    }
    const next = decideNextBuildStep({
      work,
      activities: await listActivities(workId),
      frontier,
    });
    onEvent?.({ type: "orchestrator", state: next.kind });
    if (["gate", "failed", "blocked", "running"].includes(next.kind))
      return { reason: next.kind, work: await getWork(workId), next };
    if (next.kind === "direct_implementation")
      return finishSingleSessionImplementation({
        work,
        activity: next.activity,
        project,
        prompt:
          "The requirement is confirmed and this is a small task that does not need a separate spec or ticket plan. Continue in this same session and implement the confirmed requirement now. Validate the change when finished.",
        route: "direct",
        onEvent,
        continueSession,
      });
    if (next.kind === "spec_implementation")
      return finishSingleSessionImplementation({
        work,
        activity: next.activity,
        project,
        prompt:
          "The implementation specification is complete and ticket decomposition is intentionally unnecessary for this task. Continue from this specification context and implement the full confirmed change now. Follow the spec, use the implementation engineering practices available to you, and validate the change when finished.",
        route: "spec",
        onEvent,
        continueSession,
      });
    if (next.kind === "complete") {
      work.status = "completed";
      work.currentActivityId = null;
      await saveWork(work);
      return { reason: "completed", work, next };
    }
    if (next.kind === "prepare_implementation") continue;
    if (next.kind === "activity") {
      await activityRunner({
        workId,
        activityId: next.activity.id,
        project,
        prompt: next.activity.type === "alignment" ? work.title : "",
        onEvent,
      });
      if (next.activity.type === "alignment") {
        const alignedWork = await getWork(workId);
        const alignedActivity = await getActivity(next.activity.id);
        if (
          alignedActivity?.status === "completed" &&
          alignedWork?.buildRoute
        ) {
          onEvent?.({
            type: "route_selected",
            route: alignedWork.buildRoute,
            reason: alignedActivity.alignmentDecision?.reason || "",
            confidence:
              alignedActivity.alignmentDecision?.confidence ?? null,
          });
        }
      }
      continue;
    }
    if (next.kind === "ticket") {
      await ticketRunner({
        workId,
        ticketId: next.ticket.id,
        project,
        onEvent,
      });
      continue;
    }
  }
  throw new Error(`BUILD 自动推进超过 ${maxSteps} 步，已停止以避免循环`);
}

const activeAdvances = new Map();

export function advanceBuild(options) {
  const active = activeAdvances.get(options.workId);
  if (active) return active;
  const task = advanceBuildUnlocked(options).finally(() => {
    if (activeAdvances.get(options.workId) === task)
      activeAdvances.delete(options.workId);
  });
  activeAdvances.set(options.workId, task);
  return task;
}
