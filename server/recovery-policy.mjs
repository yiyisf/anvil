export const DEFAULT_RECOVERY_POLICY = Object.freeze({
  maxAutomaticRecoveries: 5,
  maxSameFailure: 2,
  maxSessionRestarts: 2,
});

const STRATEGIES = Object.freeze({
  provider_rate_limit: { strategy: "transient_retry", maxAttempts: 2 },
  network_failure: { strategy: "transient_retry", maxAttempts: 2 },
  tool_timeout: { strategy: "same_session_retry", maxAttempts: 2 },
  implementation_unresolved: { strategy: "same_session_retry", maxAttempts: 2 },
  unknown_regression: { strategy: "skill_recovery", skill: "diagnosing-bugs", maxAttempts: 1 },
  merge_conflict: { strategy: "skill_recovery", skill: "resolving-merge-conflicts", maxAttempts: 1 },
  context_exhausted: { strategy: "fresh_session", maxAttempts: 2 },
  external_dependency: { strategy: "human_gate", gateKind: "external_action", maxAttempts: 0 },
  unknown_execution: { strategy: "fresh_session", maxAttempts: 1 },
});

export function recoveryDecision(interruption, history = [], policy = DEFAULT_RECOVERY_POLICY) {
  const spec = STRATEGIES[interruption.type] || STRATEGIES.unknown_execution;
  const automatic = history.filter((x) => x.recovery?.strategy && x.recovery.strategy !== "human_gate").length;
  const same = history.filter((x) => x.signature === interruption.signature).length;
  if (interruption.severity === "blocked" || spec.strategy === "human_gate") return { ...spec, action: "human_gate" };
  if (automatic >= policy.maxAutomaticRecoveries || same >= Math.min(spec.maxAttempts, policy.maxSameFailure)) {
    return { strategy: "human_gate", gateKind: "escalation", action: "human_gate", reason: "recovery_budget_exhausted" };
  }
  return { ...spec, action: "recover", attempt: same + 1 };
}
