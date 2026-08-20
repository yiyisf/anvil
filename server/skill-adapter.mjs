import fs from "node:fs/promises";
import path from "node:path";

export const BUILD_SKILLS = Object.freeze({
  alignment: "grill-with-docs",
  specification: "to-spec",
  planning: "to-tickets",
  implementation: "implement",
});

const ENGINEERING_SKILLS = new Set([
  "grill-with-docs",
  "to-spec",
  "to-tickets",
  "implement",
  "code-review",
  "tdd",
  "prototype",
  "wayfinder",
  "research",
  "diagnosing-bugs",
]);

export function resolveMattSkillsRoot(env = process.env) {
  const configured = env.MATT_SKILLS_ROOT?.trim();
  if (!configured) return null;
  return path.resolve(configured);
}

export function skillPath(root, skillName) {
  if (!root) throw new Error("MATT_SKILLS_ROOT 未配置");
  if (!ENGINEERING_SKILLS.has(skillName)) {
    throw new Error(`未注册的 Matt engineering skill: ${skillName}`);
  }
  return path.join(root, "skills", "engineering", skillName, "SKILL.md");
}

export async function loadMattSkill(skillName, { root = resolveMattSkillsRoot() } = {}) {
  const file = skillPath(root, skillName);
  const content = await fs.readFile(file, "utf8");
  return { name: skillName, file, content };
}

export async function assertBuildSkillsAvailable(options = {}) {
  const results = [];
  for (const skillName of Object.values(BUILD_SKILLS)) {
    const skill = await loadMattSkill(skillName, options);
    results.push({ name: skill.name, file: skill.file });
  }
  return results;
}

export function buildSkillInvocation(skillName, argument = "") {
  const suffix = String(argument || "").trim();
  return `/${skillName}${suffix ? ` ${suffix}` : ""}`;
}
