/**
 * worktree 管理
 * 每个需求一个独立 worktree + 分支，分析产物（spec/tracker）与代码改动都在里面。
 * 作废重跑 = 销毁 worktree 与分支后重建，回到基线干净状态。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const { REPO_PATH, WORKTREES_DIR, BASE_BRANCH } = process.env;

const git = (args, cwd = REPO_PATH) =>
  run("git", args, { cwd, maxBuffer: 1024 * 1024 * 8 });

/**
 * 基线分支：优先用 BASE_BRANCH，无效则回退到仓库当前 HEAD。
 * 常见坑：仓库默认分支是 master 而非 main，写死 main 会报
 *        fatal: invalid reference: main
 */
let cachedBase = null;
async function resolveBase() {
  if (cachedBase) return cachedBase;

  if (BASE_BRANCH) {
    try {
      await git(["rev-parse", "--verify", `${BASE_BRANCH}^{commit}`]);
      cachedBase = BASE_BRANCH;
      return cachedBase;
    } catch {
      console.warn(`[worktree] BASE_BRANCH=${BASE_BRANCH} 不存在，改用当前 HEAD`);
    }
  }

  try {
    const { stdout } = await git(["symbolic-ref", "--short", "HEAD"]);
    const head = stdout.trim();
    // symbolic-ref 在没有任何提交时也会返回分支名，必须再确认它指向一个提交
    await git(["rev-parse", "--verify", `${head}^{commit}`]);
    cachedBase = head;
    return cachedBase;
  } catch {
    /* 继续尝试 */
  }

  // 仓库可能没有任何提交
  let branches = "";
  try {
    const { stdout } = await git(["branch", "--format=%(refname:short)"]);
    branches = stdout.trim().split("\n").filter(Boolean).join(", ");
  } catch {}
  throw new Error(
    branches
      ? `无法确定基线分支。REPO_PATH=${REPO_PATH} 可用分支：${branches}。请在 .env 里设置 BASE_BRANCH。`
      : `REPO_PATH=${REPO_PATH} 还没有任何提交，git worktree 需要至少一个提交。先在仓库里 commit 一次。`
  );
}

export const treePath = (reqId) => path.join(WORKTREES_DIR, reqId);
const branchOf = (reqId) => `agent/${reqId}`;

export async function ensureWorktree(reqId) {
  await mkdir(WORKTREES_DIR, { recursive: true });
  const p = treePath(reqId);
  try {
    await git(["rev-parse", "--git-dir"], p);
    return p; // 已存在
  } catch {
    /* 需要创建 */
  }
  // 顺序要紧：先 prune 清掉失效注册，再删分支。
  // 反过来的话，分支仍被已注册（但目录已不存在）的 worktree 占用，branch -D 会被拒绝，
  // 随后 worktree add -b 又因分支已存在而失败。
  try { await git(["worktree", "prune"]); } catch {}
  try { await git(["branch", "-D", branchOf(reqId)]); } catch {}
  const base = await resolveBase();
  await git(["worktree", "add", p, "-b", branchOf(reqId), base]);
  await mkdir(path.join(p, ".agent"), { recursive: true });
  return p;
}

/** 作废重跑：销毁并重建，产物全部清空 */
export async function resetWorktree(reqId) {
  const p = treePath(reqId);
  try { await git(["worktree", "remove", "--force", p]); } catch {}
  try { await git(["worktree", "prune"]); } catch {}
  try { await git(["branch", "-D", branchOf(reqId)]); } catch {}
  return ensureWorktree(reqId);
}

export async function writeArtifact(reqId, rel, content) {
  const p = path.join(treePath(reqId), ".agent", rel);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content, "utf8");
}

export async function readArtifact(reqId, rel) {
  try {
    return await readFile(path.join(treePath(reqId), ".agent", rel), "utf8");
  } catch {
    return null;
  }
}

/** 本需求相对基线的改动清单 */
export async function changedFiles(reqId) {
  const p = treePath(reqId);
  try {
    const { stdout } = await git(["status", "--porcelain"], p);
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
export async function commitAll(reqId, message) {
  const p = treePath(reqId);
  try {
    await git(["add", "-A"], p);
    await git(
      ["-c", "user.email=agent@local", "-c", "user.name=agent", "commit", "-m", message],
      p
    );
    const { stdout } = await git(["rev-parse", "--short", "HEAD"], p);
    return stdout.trim();
  } catch {
    return null; // 无改动
  }
}
