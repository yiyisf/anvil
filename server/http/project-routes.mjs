import {
  listProjects,
  getProject,
  saveProject,
  newProject,
} from "../persistence/project-repository.mjs";
import { badRequest, notFound } from "./http-error.mjs";
export const projectRoutes = {
  "GET /api/projects": async () => listProjects(),
  "POST /api/projects": async ({ body }) => {
    const project = newProject({
      name: body.name?.trim() || "未命名项目",
      repoPath: body.repoPath?.trim(),
      worktreesDir: body.worktreesDir?.trim(),
      baseBranch: body.baseBranch?.trim() || "",
    });
    if (!project.repoPath || !project.worktreesDir)
      throw badRequest("repoPath 和 worktreesDir 必填");
    return saveProject(project);
  },
  "GET /api/projects/:id": async ({ q }) => {
    const project = await getProject(q.id);
    if (!project) throw notFound("项目不存在");
    return project;
  },
};
