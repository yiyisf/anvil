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
  const userMessages = [];
  const decisions = [];
  let latestAgentMessage = null;
  let unansweredQuestion = null;

  for (const message of conversation) {
    const text = String(message.text || "").trim();
    if (!text) continue;
    if (message.role === "user") {
      userMessages.push(text);
      if (latestAgentMessage)
        decisions.push({ question: latestAgentMessage, answer: text });
      unansweredQuestion = null;
    } else {
      latestAgentMessage = text;
      unansweredQuestion = text;
    }
  }

  const decision = activity?.alignmentDecision || null;
  return {
    overview: userMessages[0] || "",
    // Retained for callers that only need a compact list of confirmed inputs.
    confirmed: userMessages.slice(-4),
    decisions: decisions.slice(-6),
    open:
      activity?.status === "waiting_user" && unansweredQuestion
        ? [unansweredQuestion]
        : [],
    outcome:
      decision?.status === "ready"
        ? {
            route: decision.route,
            reason: decision.reason || "",
            risk: decision.risk || "medium",
          }
        : null,
    impact: activity?.technical?.files || activity?.technical?.areas || [],
  };
}
