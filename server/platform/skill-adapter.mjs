import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const BUILD_SKILLS = Object.freeze({
  alignment: "grill-with-docs",
  specification: "to-spec",
  planning: "to-tickets",
  implementation: "implement",
});

const SKILL_GROUPS = Object.freeze({
  "grill-with-docs": "engineering",
  "to-spec": "engineering",
  "to-tickets": "engineering",
  implement: "engineering",
  "code-review": "engineering",
  tdd: "engineering",
  prototype: "engineering",
  wayfinder: "engineering",
  research: "engineering",
  "diagnosing-bugs": "engineering",
  "codebase-design": "engineering",
  "domain-modeling": "engineering",
  "resolving-merge-conflicts": "engineering",
  handoff: "productivity",
});

const SKILL_DEPENDENCIES = Object.freeze({ implement: ["tdd", "code-review"] });

export function resolveMattSkillsRoot(env = process.env) {
  const configured = env.MATT_SKILLS_ROOT?.trim();
  return configured
    ? path.resolve(configured)
    : path.resolve(".agents", "skills");
}

export function skillPath(root, skillName) {
  if (!root) throw new Error("Matt Skills 根目录未配置");
  const group = SKILL_GROUPS[skillName];
  if (!group) throw new Error(`未注册的 Matt skill: ${skillName}`);
  const installed = path.join(root, skillName, "SKILL.md");
  if (existsSync(installed)) return installed;
  return path.join(root, "skills", group, skillName, "SKILL.md");
}

function parseFrontmatter(markdown) {
  const match = String(markdown).match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  if (match) {
    for (const line of match[1].split("\n")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      meta[key] = value;
    }
  }
  return { meta, body: match ? markdown.slice(match[0].length) : markdown };
}

export async function loadMattSkill(
  skillName,
  { root = resolveMattSkillsRoot() } = {},
) {
  const file = skillPath(root, skillName);
  const markdown = await fs.readFile(file, "utf8");
  const { meta, body } = parseFrontmatter(markdown);
  return {
    name: meta.name || skillName,
    description: meta.description || `Matt Pocock skill: ${skillName}`,
    content: body.trim(),
    file,
    metadata: meta,
  };
}

export async function loadMattSkillBundle(skillName, options = {}) {
  const names = [skillName, ...(SKILL_DEPENDENCIES[skillName] || [])];
  return Promise.all(names.map((name) => loadMattSkill(name, options)));
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
