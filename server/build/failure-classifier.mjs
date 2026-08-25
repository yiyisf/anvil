import crypto from "node:crypto";

function fingerprint(parts) {
  return crypto
    .createHash("sha1")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Prefer deterministic classification. Semantic conflicts should eventually
 * come from structured agent output rather than brittle prose guessing.
 */
export function classifyFailure(error, context = {}) {
  const message = String(error?.message || error || "unknown error");
  const lower = message.toLowerCase();
  let category = "execution",
    type = "unknown_execution",
    severity = "recoverable";

  if (/429|rate.?limit|too many requests/.test(lower))
    type = "provider_rate_limit";
  else if (/timeout|timed out|etimedout/.test(lower)) type = "tool_timeout";
  else if (
    /econnreset|econnrefused|enotfound|network|socket hang up/.test(lower)
  )
    type = "network_failure";
  else if (
    /context.{0,20}(length|window|limit)|token.{0,20}limit/.test(lower)
  ) {
    category = "context";
    type = "context_exhausted";
  } else if (/merge conflict|unmerged paths|conflict \(content\)/.test(lower)) {
    category = "engineering";
    type = "merge_conflict";
  } else if (
    /flaky|intermittent|regression|nondeterministic|race condition|root cause unknown|cannot reproduce/.test(
      lower,
    )
  ) {
    category = "engineering";
    type = "unknown_regression";
  } else if (/test(s)? failed|typecheck failed|assertionerror/.test(lower)) {
    category = "engineering";
    type = "implementation_unresolved";
  } else if (/credential|api key|permission denied|eacces/.test(lower)) {
    category = "infrastructure";
    type = "external_dependency";
    severity = "blocked";
  }

  return {
    category,
    type,
    severity,
    evidence: { message: message.slice(0, 1200) },
    signature: `${type}:${fingerprint([type, context.activityId, context.ticketId, message.replace(/\d+/g, "#").slice(0, 500)])}`,
  };
}
