/**
 * 端到端自检（不接模型的部分）：需求创建 → worktree 隔离 → 作废重跑
 * 运行：node e2e-test.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const srv = spawn("node", ["--env-file=.env", "server/index.mjs"], {
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.resume();  // 必须消费，否则管道缓冲满会阻塞服务
srv.stderr.on("data", (d) => process.stdout.write("[srv:err] " + d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = async (m, u, b) => {
  const r = await fetch("http://127.0.0.1:8787" + u, {
    method: m,
    ...(b ? { headers: { "content-type": "application/json" }, body: JSON.stringify(b) } : {}),
  });
  return r.json();
};

const TREES = process.env.WORKTREES_DIR || "/tmp/demo-trees";
const REPO = process.env.REPO_PATH || "/tmp/demo-repo";

async function waitReady(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch("http://127.0.0.1:8787/api/reqs");
      return true;
    } catch {
      await wait(300);
    }
  }
  throw new Error("服务未在预期时间内就绪");
}

try {
  await waitReady();

  const projects = await J("GET", "/api/projects");
  const projectId = projects[0]?.id;
  console.log("0) 默认项目:", projectId);

  const req = await J("POST", "/api/reqs", { title: "用户导出", projectId });
  console.log("1) 创建需求:", req.id, "| 阶段:", req.phase);

  const tree = `${TREES}/${req.id}`;
  console.log("2) worktree 建立:", !!(await fs.stat(tree).catch(() => null)));

  await fs.appendFile(`${tree}/src/math.js`, "\n// changed by agent");
  await fs.writeFile(`${tree}/.agent/spec.feature`, "功能：用户导出\n");
  const d = await J("GET", `/api/req?id=${req.id}`);
  console.log("3) 改动识别:", d.changed.map((c) => `${c.status} ${c.file}`).join(", "));

  const main = await fs.readFile(`${REPO}/src/math.js`, "utf8");
  console.log("4) 主仓库未污染:", !main.includes("changed by agent"));

  await J("POST", `/api/invalidate?id=${req.id}`, {});
  const after = await fs.readFile(`${tree}/src/math.js`, "utf8");
  const agentFiles = await fs.readdir(`${tree}/.agent`).catch(() => []);
  console.log(
    "5) 作废重跑 → 代码回基线:", !after.includes("changed by agent"),
    "| 产物清空:", agentFiles.length === 0
  );

  const d2 = await J("GET", `/api/req?id=${req.id}`);
  console.log("6) 运行记录已清:", (d2.tickets || []).length === 0, "| 阶段:", d2.phase);
  console.log("\n未接模型的部分全部通过。");
} catch (e) {
  console.log("失败:", e.message);
}
srv.kill();
process.exit(0);
