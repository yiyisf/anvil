import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const dataDirectory = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const projectFile = (id) => path.join(dataDirectory, "projects", `${id}.json`);

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function listProjects() {
  try {
    const directory = path.join(dataDirectory, "projects");
    const files = await readdir(directory);
    const projects = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJson(path.join(directory, file))),
    );
    return projects
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}

export const getProject = (id) => readJson(projectFile(id));

export async function saveProject(project) {
  const file = projectFile(project.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(project, null, 2), "utf8");
  return project;
}

export function newProject({ name, repoPath, worktreesDir, baseBranch }) {
  return {
    id: `PRJ-${Date.now().toString(36).slice(-5).toUpperCase()}`,
    name,
    repoPath,
    worktreesDir,
    baseBranch: baseBranch || "",
    createdAt: new Date().toISOString(),
  };
}
