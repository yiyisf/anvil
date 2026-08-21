import { runTurn } from "./harness.mjs";
import { buildSkillInvocation, loadMattSkillBundle } from "./skill-adapter.mjs";

/**
 * A fresh model session should not mean a fresh engineering context.
 * Before rotating a session, ask Matt's handoff skill to compress the live
 * conversation into a continuation note. Durable artifacts stay referenced
 * in the worktree instead of being copied into the note.
 */
export async function createSessionHandoff({ work, activity, project, onEvent }) {
  const skills = await loadMattSkillBundle("handoff");
  const out = await runTurn({
    reqId: work.id,
    worktreesDir: project.worktreesDir,
    sessionKey: `activity-${activity.id}`,
    phase: activity.type === "implementation" ? "impl" : "spec",
    instructions: "Prepare a concise handoff for a fresh agent session. Preserve decisions, current state, blockers, next action, and references to durable artifacts. Do not continue implementation.",
    skills,
    prompt: buildSkillInvocation("handoff", "Prepare a continuation handoff for the current Anvil activity."),
    onEvent,
  });
  return {
    text: out.text.trim(),
    files: out.files,
    createdAt: new Date().toISOString(),
  };
}

export function continuationPrompt(handoff, originalPrompt = "") {
  const task = String(originalPrompt || "").trim();
  return [
    "Continue the same Anvil activity in a fresh agent session.",
    "Treat the following handoff as continuation context; verify referenced durable worktree artifacts when needed.",
    "",
    handoff?.text || "No handoff text was available; recover state from durable worktree artifacts.",
    task ? `\nOriginal activity instruction:\n${task}` : "",
  ].join("\n");
}
