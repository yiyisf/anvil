import { BUILD_SKILLS } from "../platform/skill-adapter.mjs";
import { newActivity } from "./domain.mjs";

export const BUILD_ACTIVITY_DEFINITIONS = Object.freeze([
  {
    type: "alignment",
    label: "确认需求",
    skill: BUILD_SKILLS.alignment,
  },
  {
    type: "specification",
    label: "整理实现方案",
    skill: BUILD_SKILLS.specification,
  },
  {
    type: "planning",
    label: "拆分开发任务",
    skill: BUILD_SKILLS.planning,
  },
]);

export function createBuildActivities(workId) {
  return BUILD_ACTIVITY_DEFINITIONS.map((definition) =>
    newActivity({ workId, ...definition }),
  );
}

export function createImplementationActivity(workId, ticket) {
  return newActivity({
    workId,
    ticketId: ticket.id,
    type: "implementation",
    label: `开发：${ticket.title}`,
    skill: BUILD_SKILLS.implementation,
  });
}

export function isGateWaiting(activity) {
  return activity?.gate?.required && activity.gate.status === "waiting";
}

export function nextBuildActivity(activities) {
  return activities.find((activity) => activity.status !== "completed") || null;
}
