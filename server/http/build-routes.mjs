import { getProject } from "../persistence/project-repository.mjs";
import { ensureWorktree } from "../platform/workspace-manager.mjs";
import { createBuildWork, getBuildWork, listWorks } from "../build/service.mjs";
import { runActivity } from "../build/activity-runner.mjs";
import { getWork, getActivity } from "../persistence/build-repository.mjs";
import { getTicketFrontier } from "../build/ticket-frontier.mjs";
import {
  ensureImplementationActivities,
  runFrontierTicket,
} from "../build/implementation.mjs";
import { advanceBuild, decideHumanGate } from "../build/orchestrator.mjs";
import { badRequest, conflict, notFound } from "./http-error.mjs";

async function requireWorkProject(work) {
  const project = await getProject(work.projectId);
  if (!project)
    throw notFound(`Work ${work.id} 找不到所属项目 ${work.projectId}`);
  return project;
}

export const buildRoutes = {
  "GET /api/v5/works": async ({ q }) => listWorks(q.projectId || null),
  "POST /api/v5/works": async ({ body }) => {
    const project = await getProject(body.projectId);
    if (!project) throw notFound("项目不存在");
    const created = await createBuildWork({
      projectId: project.id,
      title: body.title?.trim() || "未命名工作",
    });
    await ensureWorktree(project, created.work.id);
    return created;
  },
  "GET /api/v5/works/:id": async ({ q }) => {
    const work = await getBuildWork(q.id);
    if (!work) throw notFound("Work 不存在");
    return work;
  },
  "GET /api/v5/activities/:id": async ({ q }) => {
    const activity = await getActivity(q.id);
    if (!activity) throw notFound("Activity 不存在");
    return activity;
  },
  "GET /api/v5/works/:id/tickets": async ({ q }) => {
    const work = await getWork(q.id);
    if (!work) throw notFound("Work 不存在");
    return getTicketFrontier({
      work,
      project: await requireWorkProject(work),
      featureSlug: q.feature || null,
    });
  },
  "POST /api/v5/works/:id/implementation/prepare": async ({ q }) => {
    const work = await getWork(q.id);
    if (!work) throw notFound("Work 不存在");
    return ensureImplementationActivities({
      work,
      project: await requireWorkProject(work),
    });
  },
  "POST /api/v5/activities/:id/gate": async ({ q, body }) => {
    if (!body.workId || !body.decision)
      throw badRequest("workId 和 decision 必填");
    try {
      return await decideHumanGate({
        workId: body.workId,
        activityId: q.id,
        decision: body.decision,
        route: body.route || null,
      });
    } catch (error) {
      if (/不存在/.test(error.message)) throw notFound(error.message);
      if (/等待确认状态/.test(error.message)) throw conflict(error.message);
      if (/非法 decision/.test(error.message)) throw badRequest(error.message);
      throw error;
    }
  },
};

export const buildStreamRoutes = {
  "POST /api/v5/build/advance": async ({ q, body, emit }) => {
    const work = await getWork(body.workId || q.workId);
    if (!work) throw new Error("Work 不存在");
    return advanceBuild({
      workId: work.id,
      project: await requireWorkProject(work),
      onEvent: emit,
    });
  },
  "POST /api/v5/activities/run": async ({ q, body, emit }) => {
    const work = await getWork(body.workId || q.workId);
    if (!work) throw new Error("Work 不存在");
    return runActivity({
      workId: work.id,
      activityId: body.activityId || q.activityId,
      project: await requireWorkProject(work),
      prompt: body.prompt || "",
      onEvent: emit,
    });
  },
  "POST /api/v5/activities/:id/reply": async ({ q, body, emit }) => {
    const activity = await getActivity(q.id);
    if (!activity || activity.workId !== body.workId)
      throw new Error("Activity 不存在");
    if (activity.type !== "alignment")
      throw new Error("只有需求澄清 Activity 支持对话回复");
    const work = await getWork(body.workId);
    activity.status = "idle";
    if (activity.gate) activity.gate.status = "pending";
    return runActivity({
      workId: work.id,
      activityId: activity.id,
      project: await requireWorkProject(work),
      prompt: body.text || "",
      onEvent: emit,
    });
  },
  "POST /api/v5/implementation/run": async ({ q, body, emit }) => {
    const work = await getWork(body.workId || q.workId);
    if (!work) throw new Error("Work 不存在");
    return runFrontierTicket({
      workId: work.id,
      ticketId: body.ticketId || null,
      project: await requireWorkProject(work),
      onEvent: emit,
    });
  },
};
