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
    const implementations = activities.filter(
      (activity) => activity.type === "implementation",
    );
    if (
      data.work.status === "completed" ||
      implementations.some((activity) => activity.status === "completed")
    )
      return "done";
    if (
      implementations.some((activity) =>
        ["running", "waiting_user", "recovering"].includes(activity.status),
      )
    )
      return "active";
    return "todo";
  }
  const activity = activities.find((candidate) => candidate.type === type);
  if (!activity) return "todo";
  if (activity.status === "completed") return "done";
  return ["running", "waiting_user", "recovering"].includes(activity.status)
    ? "active"
    : "todo";
}

export function requirementUnderstanding(activity, overview = "") {
  const decision = activity?.alignmentDecision || null;
  const decisions = (activity?.decisionLog || []).slice(-6).map((entry) => ({
    question: String(entry.question || "").trim(),
    answer: String(entry.outcome || "").trim(),
  }));

  return {
    overview,
    // Only structured summaries are projected here. Raw assistant messages may
    // contain long explanations and must stay in the conversation transcript.
    confirmed: decisions.map((entry) => entry.answer).filter(Boolean).slice(-4),
    decisions: decisions.filter((entry) => entry.question && entry.answer),
    open:
      activity?.status === "waiting_user" &&
      decision?.status === "needs_input" &&
      decision.question
        ? [decision.question]
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
