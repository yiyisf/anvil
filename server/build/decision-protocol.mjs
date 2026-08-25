import { BUILD_ROUTES } from "./domain.mjs";

const DECISION_MARKER = /^ANVIL_DECISION:\s*(\{.*\})\s*$/gm;
const RISKS = new Set(["low", "medium", "high", "critical"]);
const STATUSES = new Set(["needs_input", "ready"]);

/**
 * Separates the user-facing response from the machine-readable Alignment outcome.
 * Invalid or missing decisions never select a route: the caller must retry or stop.
 */
export function parseAlignmentDecision(text) {
  const source = String(text || "");
  const matches = [...source.matchAll(DECISION_MARKER)];
  const marker = matches.at(-1);
  const clean = marker ? source.replace(marker[0], "").trim() : source.trim();
  if (!marker)
    return { clean, decision: null, error: "Alignment 缺少 ANVIL_DECISION" };

  try {
    const value = JSON.parse(marker[1]);
    if (!STATUSES.has(value.status))
      throw new Error(`非法 status: ${value.status}`);

    const risk = RISKS.has(value.risk) ? value.risk : "medium";
    const confidence = Number(value.confidence);
    const decision = {
      status: value.status,
      route: value.route || null,
      confidence: Number.isFinite(confidence)
        ? Math.max(0, Math.min(1, confidence))
        : null,
      reason: String(value.reason || "").slice(0, 500),
      risk,
      requiresApproval:
        Boolean(value.requiresApproval) || risk === "high" || risk === "critical",
      question: String(value.question || "").slice(0, 300),
      decisionSummary: String(value.decisionSummary || "").slice(0, 300),
      at: new Date().toISOString(),
    };

    if (decision.status === "ready" && !BUILD_ROUTES.has(decision.route))
      throw new Error(`ready 状态缺少有效 route: ${decision.route}`);
    if (decision.status === "needs_input") {
      decision.route = null;
      decision.requiresApproval = false;
    }
    return { clean, decision, error: null };
  } catch (error) {
    return {
      clean,
      decision: null,
      error: `Alignment 决策无法解析: ${error.message}`,
    };
  }
}

export function dynamicApprovalGate(decision) {
  if (decision?.status !== "ready" || !decision.requiresApproval) return null;
  return {
    kind: "approval",
    required: true,
    status: "waiting",
    prompt:
      decision.reason ||
      "该需求包含高风险或不可逆变更，是否确认按当前方案继续？",
    decision: null,
    decidedAt: null,
    options: [
      { action: "approve", label: "确认并继续" },
      { action: "revise", label: "继续讨论" },
    ],
  };
}
