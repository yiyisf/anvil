/**
 * worktree 管理
 * 每个需求一个独立 worktree + 分支，分析产物（spec/tracker）与代码改动都在里面。
 * 作废重跑 = 销毁 worktree 与分支后重建，回到基线干净状态。
 *
 * 多仓库：所有函数第一个参数是 project（{id, repoPath, worktreesDir, baseBranch}），
 * 不再依赖模块级 REPO_PATH/WORKTREES_DIR/BASE_BRANCH。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

const git = (project, args, cwd = project.repoPath) =>
  run("git", args, { cwd, maxBuffer: 1024 * 1024 * 8 });

/**
 * 基线分支：优先用 project.baseBranch，无效则回退到仓库当前 HEAD。
 * 常见坑：仓库默认分支是 master 而非 main，写死 main 会报
 *        fatal: invalid reference: main
 * 按 project.id 分桶缓存，避免多项目 baseBranch 互相串。
 */
const baseCache = new Map(); // projectId → base

async function resolveBase(project) {
  if (baseCache.has(project.id)) return baseCache.get(project.id);

  if (project.baseBranch) {
    try {
      await git(project, ["rev-parse", "--verify", `${project.baseBranch}^{commit}`]);
      baseCache.set(project.id, project.baseBranch);
      return project.baseBranch;
    } catch {
      console.warn(`[worktree] baseBranch=${project.baseBranch} 不存在，改用当前 HEAD`);
    }
  }

  try {
    const { stdout } = await git(project, ["symbolic-ref", "--short", "HEAD"]);
    const head = stdout.trim();
    // symbolic-ref 在没有任何提交时也会返回分支名，必须再确认它指向一个提交
    await git(project, ["rev-parse", "--verify", `${head}^{commit}`]);
    baseCache.set(project.id, head);
    return head;
  } catch {
    /* 继续尝试 */
  }

  // 仓库可能没有任何提交
  let branches = "";
  try {
    const { stdout } = await git(project, ["branch", "--format=%(refname:short)"]);
    branches = stdout.trim().split("\n").filter(Boolean).join(", ");
  } catch {}
  throw new Error(
    branches
      ? `无法确定基线分支。repoPath=${project.repoPath} 可用分支：${branches}。请在项目配置里设置 baseBranch。`
      : `repoPath=${project.repoPath} 还没有任何提交，git worktree 需要至少一个提交。先在仓库里 commit 一次。`
  );
}

export const treePath = (project, reqId) => path.join(project.worktreesDir, reqId);
const branchOf = (reqId) => `agent/${reqId}`;

export async function ensureWorktree(project, reqId) {
  await mkdir(project.worktreesDir, { recursive: true });
  const p = treePath(project, reqId);
  try {
    await git(project, ["rev-parse", "--git-dir"], p);
    return p; // 已存在
  } catch {
    /* 需要创建 */
  }
  // 顺序要紧：先 prune 清掉失效注册，再删分支。
  // 反过来的话，分支仍被已注册（但目录已不存在）的 worktree 占用，branch -D 会被拒绝，
  // 随后 worktree add -b 又因分支已存在而失败。
  try { await git(project, ["worktree", "prune"]); } catch {}
  try { await git(project, ["branch", "-D", branchOf(reqId)]); } catch {}
  const base = await resolveBase(project);
  await git(project, ["worktree", "add", p, "-b", branchOf(reqId), base]);
  await mkdir(path.join(p, ".agent"), { recursive: true });
  return p;
}

/** 作废重跑：销毁并重建，产物全部清空 */
export async function resetWorktree(project, reqId) {
  const p = treePath(project, reqId);
  try { await git(project, ["worktree", "remove", "--force", p]); } catch {}
  try { await git(project, ["worktree", "prune"]); } catch {}
  try { await git(project, ["branch", "-D", branchOf(reqId)]); } catch {}
  return ensureWorktree(project, reqId);
}

export async function writeArtifact(project, reqId, rel, content) {
  const p = path.join(treePath(project, reqId), ".agent", rel);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content, "utf8");
}

export async function readArtifact(project, reqId, rel) {
  try {
    return await readFile(path.join(treePath(project, reqId), ".agent", rel), "utf8");
  } catch {
    return null;
  }
}

/** 本需求相对基线的改动清单 */
export async function changedFiles(project, reqId) {
  const p = treePath(project, reqId);
  try {
    const { stdout } = await git(project, ["status", "--porcelain"], p);
    // 注意：不能对整段 stdout 用 trim()，会吃掉首行的前导空格（" M file" → "M file"）导致列偏移
    return stdout
      .split("\n")
      .filter((l) => l.length > 3)
      .map((l) => ({ status: l.slice(0, 2).trim(), file: l.slice(3).trim() }));
  } catch {
    return [];
  }
}

/** 把当前产物提交到该需求分支，便于 review 与回溯 */
export async function commitAll(project, reqId, message) {
  const p = treePath(project, reqId);
  try {
    await git(project, ["add", "-A"], p);
    await git(
      project,
      ["-c", "user.email=agent@local", "-c", "user.name=agent", "commit", "-m", message],
      p
    );
    const { stdout } = await git(project, ["rev-parse", "--short", "HEAD"], p);
    return stdout.trim();
  } catch {
    return null; // 无改动
  }
}
