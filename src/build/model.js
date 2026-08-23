export const BUILD_PHASES = [
  ["alignment", "理解需求"],
  ["planning", "制定方案"],
  ["implementation", "开发实现"],
  ["completed", "完成验证"],
];

export function phaseState(type, data) {
  const activities = data.activities || [];
  if (type === "completed")
    return data.work.status === "completed" ? "done" : "todo";
  if (type === "implementation") {
    if (data.work.status === "completed") return "done";
    return activities.find((activity) => activity.type === "planning")
      ?.status === "completed"
      ? "active"
      : "todo";
  }
  const activity = activities.find((candidate) => candidate.type === type);
  if (!activity) return "todo";
  if (activity.status === "completed") return "done";
  return ["running", "waiting_user", "recovering"].includes(activity.status)
    ? "active"
    : "todo";
}

export function requirementUnderstanding(activity) {
  const conversation = activity?.conversation || [];
  const userMessages = conversation
    .filter((message) => message.role === "user")
    .map((message) => message.text.trim())
    .filter(Boolean);
  const agentMessages = conversation
    .filter((message) => message.role !== "user")
    .map((message) => message.text.trim())
    .filter(Boolean);
  const latestQuestion = [...agentMessages]
    .reverse()
    .find((text) => /[?？]|确认|需要|是否|哪|什么|如何|范围|边界/.test(text));

  return {
    confirmed: userMessages.slice(-4),
    open:
      activity?.status === "waiting_user" && latestQuestion
        ? [latestQuestion]
        : [],
    impact: activity?.technical?.files || activity?.technical?.areas || [],
  };
}
