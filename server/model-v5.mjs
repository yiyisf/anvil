import crypto from "node:crypto";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;

export const WORK_MODES = new Set(["build", "fix", "explore"]);
export const WORK_STATUSES = new Set([
  "draft", "active", "waiting_user", "completed", "failed", "cancelled",
]);

export function newWork({ projectId, title, mode = "build", legacyReqId = null }) {
  if (!projectId) throw new Error("projectId 必填");
  if (!WORK_MODES.has(mode)) throw new Error(`非法 work mode: ${mode}`);
  const timestamp = now();
  return {
    id: id("WORK"), projectId, legacyReqId,
    title: title?.trim() || "未命名工作", mode, status: "draft",
    currentActivityId: null, workspace: {},
    createdAt: timestamp, updatedAt: timestamp,
  };
}

export function newActivity({ workId, type, label, skill = null, ticketId = null, gate = null }) {
  if (!workId) throw new Error("workId 必填");
  const timestamp = now();
  return {
    id: id("ACT"), workId, ticketId, type, label, status: "idle",
    technical: skill ? { skill } : {},
    gate: gate ? {
      kind: gate.kind || "approval",
      required: gate.required !== false,
      status: "pending",
      prompt: gate.prompt || null,
      decision: null,
      decidedAt: null,
    } : null,
    sessionId: null, startedAt: null, finishedAt: null,
    createdAt: timestamp, updatedAt: timestamp,
  };
}

export function newAgentSession({ workId, activityId, ticketId = null, continuationOf = null }) {
  return { id: id("SESSION"), workId, activityId, ticketId, status: "idle", continuationOf, context: {}, createdAt: now(), updatedAt: now() };
}

export function newSkillRun({ activityId, sessionId, skill }) {
  return { id: id("RUN"), activityId, sessionId, skill, status: "idle", summary: null, tools: [], files: [], startedAt: null, finishedAt: null };
}
