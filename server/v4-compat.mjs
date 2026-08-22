export function projectLegacyReqToWork(req) {
  if (!req) return null;
  const status = req.phase === "done" ? "completed" : "active";
  const activityType = req.phase === "analysis" ? "alignment" : req.phase === "impl" ? "implementation" : "validation";
  return {
    id: `legacy:${req.id}`,
    legacyReqId: req.id,
    projectId: req.projectId,
    title: req.title,
    mode: "build",
    status,
    currentActivityId: `legacy:${req.id}:${activityType}`,
    compatibility: true,
  };
}
