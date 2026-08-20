import crypto from "node:crypto";

const now = () => new Date().toISOString();

export function newInterruption({ workId, activityId, ticketId = null, category, type, severity = "recoverable", source = null, evidence = null, signature = null, recovery = null }) {
  return {
    id: `INT-${crypto.randomUUID()}`,
    workId,
    activityId,
    ticketId,
    category,
    type,
    severity,
    source,
    evidence,
    signature,
    recovery: recovery || { strategy: null, attempt: 0, maxAttempts: 0 },
    status: "open",
    createdAt: now(),
    updatedAt: now(),
    resolvedAt: null,
  };
}

export function resolveInterruption(interruption, status = "resolved") {
  interruption.status = status;
  interruption.resolvedAt = now();
  interruption.updatedAt = interruption.resolvedAt;
  return interruption;
}
