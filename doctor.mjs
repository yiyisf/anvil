/**
 * 工具桥接诊断
 * 逐层检查为什么 sandbox 里用不了 java / mvn / git
 *
 * 运行：node doctor.mjs [Work ID]
 *   不传 Work ID 时，检查 WORKTREES_DIR 下第一个目录。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Sandbox, ReadWriteFs } from "just-bash";
import { createJustBashSandbox } from "@ai-sdk/sandbox-just-bash";
import {
  registerTools,
  resolveToolConfig,
  agentToolProfile,
  resolveBinary,
} from "./server/platform/tools.mjs";
import { posixVirtualFs } from "./server/platform/sandbox-path.mjs";
import { workspaceKey } from "./server/platform/workspace-manager.mjs";

const { WORKTREES_DIR, REPO_PATH } = process.env;
const abs = (p) => (p ? path.resolve(p) : p);
const line = (s = "") => console.log(s);
const ok = (s) => console.log("  ✔ " + s);
const no = (s) => console.log("  ✗ " + s);

if (!WORKTREES_DIR) {
  console.log("未设置 WORKTREES_DIR，请用 node --env-file=.env doctor.mjs");
  process.exit(1);
}

/* ── 0. 环境（doctor 与服务必须看同一个目录）── */
line("【0】环境");
line(`  当前工作目录：${process.cwd()}`);
line(
  `  WORKTREES_DIR：${WORKTREES_DIR}${WORKTREES_DIR !== abs(WORKTREES_DIR) ? `  → 解析为 ${abs(WORKTREES_DIR)}` : ""}`,
);
line(
  `  REPO_PATH    ：${REPO_PATH}${REPO_PATH && REPO_PATH !== abs(REPO_PATH) ? `  → 解析为 ${abs(REPO_PATH)}` : ""}`,
);
// Windows 上用 POSIX 风格路径（/d/trees、/c/repo）Node 解析不了
if (
  process.platform === "win32" &&
  /^\/[a-zA-Z]\//.test(String(WORKTREES_DIR || "") + String(REPO_PATH || ""))
) {
  line("");
  no("  路径像是 git-bash 风格（/d/xxx）。Windows 的 Node 解析不了这种路径，");
  line("    请改成 D:/xxx 或 D:\\xxx 形式。");
}
if (WORKTREES_DIR !== abs(WORKTREES_DIR)) {
  line("");
  line("  ⚠ WORKTREES_DIR 是相对路径。doctor 与 API 服务若从不同目录启动，");
  line(
    "    解析出的绝对路径就不同，会出现「服务建好了但 doctor 找不到」。建议改成绝对路径。",
  );
}

/* 交叉比对 git 自己的记录 */
line("");
line("  git 记录的 worktree：");
try {
  const out = execFileSync("git", ["worktree", "list"], {
    cwd: REPO_PATH,
    encoding: "utf8",
  }).trim();
  for (const l of out.split("\n")) line("    " + l);
} catch (e) {
  no(
    "  读不到（REPO_PATH 不对，或不是 git 仓库）：" +
      String(e.message).split("\n")[0],
  );
}

line("");
line("  WORKTREES_DIR 下的条目：");
try {
  const entries = readdirSync(abs(WORKTREES_DIR)).filter(
    (d) => !d.startsWith("."),
  );
  if (!entries.length) line("    （空）");
  for (const d of entries) {
    const full = path.join(abs(WORKTREES_DIR), d);
    line(
      `    ${d}  ${existsSync(path.join(full, ".git")) ? "✔ 是 worktree" : "✗ 不是 worktree（缺 .git）"}`,
    );
  }
} catch {
  no(`    目录不存在：${abs(WORKTREES_DIR)}`);
}

/* ── 1. 定位 worktree ── */
line("\n【1】worktree");
const ROOT = abs(WORKTREES_DIR);
const isWorktree = (d) => existsSync(path.join(d, ".git"));
const requestedWorkId = process.argv[2];
let workspaceName = requestedWorkId ? workspaceKey(requestedWorkId) : null;
if (!workspaceName) {
  const dirs = existsSync(ROOT)
    ? readdirSync(ROOT).filter(
        (d) => !d.startsWith(".") && isWorktree(path.join(ROOT, d)),
      )
    : [];
  workspaceName = dirs[0];
}
if (!workspaceName) {
  no(`${ROOT} 下没有有效的 worktree`);
  line("");
  line("  先在界面里创建一个 BUILD（会自动建 worktree），再跑 doctor。");
  line("  也可以指定：node --env-file=.env doctor.mjs WORK-<uuid>");
  line("");
  line("  ⚠ 没有 worktree 时，桥接命令的工作目录不存在，");
  line("    执行任何工具都会失败，且报错看起来像「宿主上没装这个命令」——");
  line("    实际是目录不存在。别被误导。");
  process.exit(1);
}
const tree = path.join(ROOT, workspaceName);
if (!existsSync(tree)) {
  no(`${tree} 不存在`);
  process.exit(1);
}
if (!isWorktree(tree)) {
  no(`${tree} 存在但不是 git worktree（缺 .git）`);
  line("    做一次「作废重跑」重建，或删掉这个目录后新建需求。");
  process.exit(1);
}
ok(`${tree}`);

/* ── 2. 配置文件在哪 ── */
line("\n【2】agent.config.json 位置");
const inTree = path.join(tree, "agent.config.json");
const inRepo = REPO_PATH ? path.join(REPO_PATH, "agent.config.json") : null;
const hasTree = existsSync(inTree);
const hasRepo = inRepo && existsSync(inRepo);

if (hasTree) ok(`worktree 里有：${inTree}`);
else {
  no(`worktree 里没有：${inTree}`);
  if (hasRepo) {
    line("");
    line("  ⚠ 主仓库里有这个文件，但 worktree 里没有。");
    line(
      "    worktree 是从分支检出的，【未提交的文件不会出现在 worktree 里】。",
    );
    line("    解决：在主仓库把它提交进去");
    line(
      `      cd ${REPO_PATH} && git add agent.config.json && git commit -m "add agent config"`,
    );
    line("    然后对已存在的需求做一次「作废重跑」重新检出，或新建需求。");
  } else {
    line("  （主仓库也没有，将使用环境变量 SANDBOX_TOOLS 或内置默认）");
  }
}
if (hasTree) {
  let treeCfg = null;
  try {
    treeCfg = JSON.parse(readFileSync(inTree, "utf8"));
    line("  worktree 内容：" + JSON.stringify(treeCfg));
  } catch (e) {
    no("解析失败，格式有误：" + e.message);
  }

  // worktree 是创建那一刻从分支检出的：之后往主仓库提交的新配置不会同步过来
  if (hasRepo && treeCfg) {
    let repoCfg = null;
    try {
      repoCfg = JSON.parse(readFileSync(inRepo, "utf8"));
    } catch {}
    if (repoCfg && JSON.stringify(repoCfg) !== JSON.stringify(treeCfg)) {
      line("  主仓库内容：" + JSON.stringify(repoCfg));
      line("");
      line("  ⚠ 两份配置不一致：worktree 用的是【创建时】那一版。");
      line("    worktree 从分支检出后就不会自动跟进主仓库的新提交，");
      line("    所以后来新增的工具（如 mvn）在这个需求里不生效。");
      line("    解决：对该需求做一次「作废重跑」重新检出，或新建需求。");
    }
  }
}

/* ── 3. 实际生效的配置 ── */
line("\n【3】实际生效的配置");
const cfg = resolveToolConfig(tree);
line(`  sandboxTools：${cfg.tools.join(", ")}`);
line(`  来源：${cfg.source}   超时：${cfg.timeout}ms`);
line(`  env SANDBOX_TOOLS = ${process.env.SANDBOX_TOOLS ?? "(未设置)"}`);
const ap = agentToolProfile("impl", tree);
line(`  agentTools[impl]：${ap.allow ? ap.allow.join(", ") : "全部内建工具"}`);
if (ap.allow && !ap.allow.includes("bash")) {
  no(
    "impl 阶段没有 bash 工具 → 代理根本无法执行命令，sandboxTools 配了也用不上",
  );
}

/* ── 4. 宿主上这些命令存在吗 ── */
line("\n【4】宿主 PATH 中是否存在（服务进程视角）");
for (const t of cfg.tools) {
  const bin = resolveBinary(t);
  if (!bin) {
    no(`${t} 不在 PATH 中 —— 桥接会返回「宿主上找不到 ${t}」`);
    continue;
  }
  ok(
    `${t} → ${bin.path}${bin.isBatch ? "   [批处理，将经 cmd.exe 启动]" : ""}`,
  );
}
if (process.platform === "win32") {
  line("  （Windows 提示：mvn/npm/npx/gradle 通常是 .cmd 批处理，");
  line("    必须经 cmd.exe 启动；桥接已按解析出的扩展名自动处理）");
}
line(
  `  （服务进程的 PATH：${(process.env.PATH || "").split(path.delimiter).slice(0, 6).join(path.delimiter)} …）`,
);

/* ── 5. 通过真实 sandbox 会话执行 ── */
line("\n【5】在 sandbox 会话里实际执行");
const raw = await Sandbox.create({
  fs: posixVirtualFs(new ReadWriteFs({ root: WORKTREES_DIR })),
  cwd: "/",
  useDefaultLayout: false,
});
const registered = registerTools(raw, WORKTREES_DIR, tree);
line(`  已注册：${registered.tools.join(", ")}`);
line(`  沙箱内建：${registered.builtins.join(", ")}`);

const provider = createJustBashSandbox({ sandbox: raw });
const session = (
  await provider.createSession({ sessionId: "doctor" })
).restricted();

for (const t of registered.tools) {
  // 不用管道，避免 head 把退出码吃掉
  const r = await session.run({
    command: `cd /${workspaceName} && ${t} --version 2>&1`,
  });
  const out = (r.stdout || r.stderr || "").trim().split("\n")[0] || "(无输出)";
  if (/command not found/.test(out))
    no(`${t}：未注册进 bash —— 配置没读到，或服务未重启`);
  else if (/工作目录不存在/.test(out))
    no(`${t}：工作目录不存在 —— worktree 缺失，与命令本身无关`);
  else if (/宿主上找不到命令/.test(out))
    no(`${t}：已注册，但服务进程的 PATH 里没有它`);
  else if (r.exitCode === 0) ok(`${t}：${out.slice(0, 70)}`);
  else no(`${t}：exit=${r.exitCode} ${out.slice(0, 70)}`);
}

/* ── 6. pi 文件工具的路径解析（read/write/edit/grep/glob 都走这一步）── */
line("\n【6】pi 路径解析（read 工具报「路径不可用」就看这里）");
// 这段 shell 与 harness-pi 内部用的完全一致：先判存在，再用 realpath 规范化。
// 少了 realpath 命令时，第一行过、第二行挂，报错却只说"路径不可用"，极具误导性。
const piProbe = async (target) => {
  const r = await session.run({
    command: [
      `target='${target}'`,
      `if [ ! -e "$target" ]; then echo "__PI_REALPATH_NOT_FOUND__"; exit 2; fi`,
      `resolved=$(realpath "$target" 2>/dev/null) || { echo "__PI_REALPATH_FAILED__"; exit 3; }`,
      `printf '%s\\n' "$resolved"`,
    ].join("; "),
  });
  return (
    `${r.stdout || ""}${r.stderr || ""}`
      .trim()
      .split("\n")
      .filter(Boolean)
      .at(-1) || ""
  );
};

for (const target of [`/${workspaceName}`, `/${workspaceName}/.agent`]) {
  const out = await piProbe(target);
  if (out === "__PI_REALPATH_FAILED__") {
    no(
      `${target}：realpath 不可用 → pi 会报「路径不可用 / Unable to resolve path」`,
    );
    line("    沙箱内建 realpath 没注册上（服务未重启，或改动没生效）。");
  } else if (out === "__PI_REALPATH_NOT_FOUND__") {
    no(`${target}：沙箱里不存在（worktree 缺失）`);
  } else if (!out.startsWith("/")) {
    no(`${target} → ${out}`);
    line(
      "    结果不是 posix 绝对路径（多为 Windows 反斜杠），pi 会判成越出工作区。",
    );
  } else {
    ok(`${target} → ${out}`);
  }
}

line("\n【结论提示】");
line(
  "  · command not found  → 配置没生效（多为 agent.config.json 未提交到仓库，或服务未重启）",
);
line(
  "  · 工作目录不存在      → worktree 没建出来，与命令无关（重建需求或作废重跑）",
);
line(
  "  · 宿主上找不到命令 X  → 桥接正常，是服务进程 PATH 缺它（注意 IDE 启动时 PATH 可能不同）",
);
line("  · impl 无 bash 工具  → 先在 agentTools.impl.allow 里加回 bash");
line(
  "  · 路径不可用          → 【6】没过。跟文件在不在无关，是 realpath 那一步挂了",
);
process.exit(0);
