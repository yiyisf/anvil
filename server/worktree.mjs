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

/**
 * 检出 worktree 时不做换行转换（只对这一条命令生效，不动用户仓库的配置）
 *
 * ⚠️ Windows 上 Git for Windows 安装器默认 core.autocrlf=true，检出会把库里的 LF
 * 展开成 CRLF。代理的 edit 工具是【逐字节 indexOf】：
 *     current.indexOf(oldText) === -1 → "Text to replace was not found"
 * 而模型产出的 old_string 几乎总是 LF。文件里是 \r\n、模型给的是 \n，永远匹配不上，
 * 于是 read 正常、edit 必失败，代理只能退而用 write 整篇重写 —— 改动面被放大，
 * review 也失去意义。
 *
 * 用 -c 而不是改仓库配置：只影响 anvil 自己建的 worktree，开发者的主工作区不受牵连。
 * 库里存的始终是 LF，提交内容不受影响；项目若确实需要 CRLF，
 * .gitattributes 的 eol=crlf 优先级更高，仍然照旧生效（已验证）。
 */
const LF_CHECKOUT = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"];

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
  await git(project, [...LF_CHECKOUT, "worktree", "add", p, "-b", branchOf(reqId), base]);
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

/**
 * 本需求相对基线的改动清单
 *
 * ⚠️ 只看 git status 是不够的：runner 每跑完一个 skill 就 commitAll 一次
 * （runner.mjs / index.mjs 都有），等前端来问的时候工作区早就干净了，
 * 于是「改动文件」恒为 0、清单永远空白 —— 看起来像代理什么都没干。
 * 必须把【已提交到本需求分支的部分】也算进来。
 *
 * 两个来源合并，未提交的覆盖已提交的（它是更新的状态）。
 */
export async function changedFiles(project, reqId) {
  const p = treePath(project, reqId);
  const byFile = new Map(); // file → status

  // 1) 已提交：base...HEAD 从分叉点比，只算本需求自己的改动
  try {
    const base = await resolveBase(project);
    const { stdout } = await git(project, ["diff", "--name-status", `${base}...HEAD`], p);
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const cols = line.split("\t");
      const status = cols[0].trim();
      // 改名/复制是 R100\t旧路径\t新路径，要的是新路径
      const file = (cols.length > 2 ? cols[cols.length - 1] : cols[1] || "").trim();
      if (file) byFile.set(file, status[0]); // R100 → R
    }
  } catch {
    /* 分支还没提交过，或基线解析不出来 */
  }

  // 2) 未提交：上一个 skill 之后、下一次 commitAll 之前的中间状态
  try {
    const { stdout } = await git(project, ["status", "--porcelain"], p);
    // 注意：不能对整段 stdout 用 trim()，会吃掉首行的前导空格（" M file" → "M file"）导致列偏移
    for (const l of stdout.split("\n")) {
      if (l.length <= 3) continue;
      const raw = l.slice(3).trim();
      const file = raw.includes(" -> ") ? raw.slice(raw.indexOf(" -> ") + 4) : raw; // 改名取新路径
      byFile.set(file, l.slice(0, 2).trim());
    }
  } catch {
    /* worktree 不在了 */
  }

  return [...byFile].map(([file, status]) => ({ file, status }));
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
