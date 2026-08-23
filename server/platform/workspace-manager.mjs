/**
 * worktree 管理
 * 每个需求一个独立 worktree + 分支，分析产物（spec/tracker）与代码改动都在里面。
 * 作废重跑 = 销毁 worktree 与分支后重建，回到基线干净状态。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const run = promisify(execFile);
const git = (project, args, cwd = project.repoPath) =>
  run("git", args, { cwd, maxBuffer: 1024 * 1024 * 8 });
const baseCache = new Map();

async function resolveBase(project) {
  if (baseCache.has(project.id)) return baseCache.get(project.id);
  if (project.baseBranch) {
    try {
      await git(project, [
        "rev-parse",
        "--verify",
        `${project.baseBranch}^{commit}`,
      ]);
      baseCache.set(project.id, project.baseBranch);
      return project.baseBranch;
    } catch {
      console.warn(
        `[worktree] baseBranch=${project.baseBranch} 不存在，改用当前 HEAD`,
      );
    }
  }
  try {
    const { stdout } = await git(project, ["symbolic-ref", "--short", "HEAD"]);
    const head = stdout.trim();
    await git(project, ["rev-parse", "--verify", `${head}^{commit}`]);
    baseCache.set(project.id, head);
    return head;
  } catch {}
  let branches = "";
  try {
    const { stdout } = await git(project, [
      "branch",
      "--format=%(refname:short)",
    ]);
    branches = stdout.trim().split("\n").filter(Boolean).join(", ");
  } catch {}
  throw new Error(
    branches
      ? `无法确定基线分支。repoPath=${project.repoPath} 可用分支：${branches}。请在项目配置里设置 baseBranch。`
      : `repoPath=${project.repoPath} 还没有任何提交，git worktree 需要至少一个提交。先在仓库里 commit 一次。`,
  );
}

// Work IDs use UUIDs for globally unique domain identity, but putting the full ID in
// a Windows worktree path consumes ~41 characters before the repository's own paths.
// Use a stable compact filesystem key instead. It is deterministic, collision-resistant
// for local workspace scale, and also keeps the generated Git branch readable.
export function workspaceKey(reqId) {
  const raw = String(reqId || "work");
  const tail = raw.match(
    /[0-9a-f]{8}(?=-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$)/i,
  )?.[0];
  return (
    tail || crypto.createHash("sha256").update(raw).digest("hex").slice(0, 10)
  );
}
export const treePath = (project, reqId) =>
  path.join(project.worktreesDir, workspaceKey(reqId));
const branchOf = (reqId) => `agent/${workspaceKey(reqId)}`;
const LF_CHECKOUT = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"];

export async function ensureWorktree(project, reqId) {
  await mkdir(project.worktreesDir, { recursive: true });
  const p = treePath(project, reqId);
  try {
    await git(project, ["rev-parse", "--git-dir"], p);
    return p;
  } catch {}
  try {
    await git(project, ["worktree", "prune"]);
  } catch {}
  try {
    await git(project, ["branch", "-D", branchOf(reqId)]);
  } catch {}
  const base = await resolveBase(project);
  await git(project, [
    ...LF_CHECKOUT,
    "worktree",
    "add",
    p,
    "-b",
    branchOf(reqId),
    base,
  ]);
  await mkdir(path.join(p, ".agent"), { recursive: true });
  return p;
}

export async function resetWorktree(project, reqId) {
  const p = treePath(project, reqId);
  try {
    await git(project, ["worktree", "remove", "--force", p]);
  } catch {}
  try {
    await git(project, ["worktree", "prune"]);
  } catch {}
  try {
    await git(project, ["branch", "-D", branchOf(reqId)]);
  } catch {}
  return ensureWorktree(project, reqId);
}

export async function writeArtifact(project, reqId, rel, content) {
  const p = path.join(treePath(project, reqId), ".agent", rel);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content, "utf8");
}
export async function readArtifact(project, reqId, rel) {
  try {
    return await readFile(
      path.join(treePath(project, reqId), ".agent", rel),
      "utf8",
    );
  } catch {
    return null;
  }
}

export async function changedFiles(project, reqId) {
  const p = treePath(project, reqId);
  const byFile = new Map();
  try {
    const base = await resolveBase(project);
    const { stdout } = await git(
      project,
      ["diff", "--name-status", `${base}...HEAD`],
      p,
    );
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const cols = line.split("\t");
      const status = cols[0].trim();
      const file = (
        cols.length > 2 ? cols[cols.length - 1] : cols[1] || ""
      ).trim();
      if (file) byFile.set(file, status[0]);
    }
  } catch {}
  try {
    const { stdout } = await git(project, ["status", "--porcelain"], p);
    for (const l of stdout.split("\n")) {
      if (l.length <= 3) continue;
      const raw = l.slice(3).trim();
      const file = raw.includes(" -> ")
        ? raw.slice(raw.indexOf(" -> ") + 4)
        : raw;
      byFile.set(file, l.slice(0, 2).trim());
    }
  } catch {}
  return [...byFile].map(([file, status]) => ({ file, status }));
}

export async function commitAll(project, reqId, message) {
  const p = treePath(project, reqId);
  try {
    await git(project, ["add", "-A"], p);
    await git(
      project,
      [
        "-c",
        "user.email=agent@local",
        "-c",
        "user.name=agent",
        "commit",
        "-m",
        message,
      ],
      p,
    );
    const { stdout } = await git(project, ["rev-parse", "--short", "HEAD"], p);
    return stdout.trim();
  } catch {
    return null;
  }
}
