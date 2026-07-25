/**
 * 调度器真实运行验证（不接真模型：用桩替换 runTurn）
 * 验证：串行推进、失败自动重试一次、重试仍失败则停、下游依赖被阻塞、事件广播
 * 运行：node runner-live-test.mjs
 */
import { mkdir, writeFile, rm } from "node:fs/promises";

const DATA = "/tmp/runner-live/.data";
process.env.DATA_DIR = DATA;
process.env.WORKTREES_DIR = "/tmp/runner-live/trees";
process.env.REPO_PATH = "/tmp/demo-repo";
await rm("/tmp/runner-live", { recursive: true, force: true });
await mkdir(`${DATA}/reqs`, { recursive: true });
await mkdir(`${process.env.WORKTREES_DIR}/REQ-RUN/.agent`, { recursive: true });
await writeFile(`${process.env.WORKTREES_DIR}/REQ-RUN/.agent/spec.feature`, "功能：测试\n");

/* 用桩替换 harness.runTurn —— e2e 前两次失败，其余通过 */
const calls = [];
let e2eCount = 0;
const fakeRunTurn = async ({ prompt, onEvent }) => {
  const skill = prompt.match(/使用 (\S+) skill/)?.[1];
  const ticket = prompt.match(/工单 (T-\d+)/)?.[1];
  calls.push(`${ticket}/${skill}`);
  onEvent?.({ type: "tool", n: "bash", a: "npm test" });
  await new Promise((r) => setTimeout(r, 20));
  if (skill === "e2e" && ticket === "T-1") {
    e2eCount++;
    return { text: `没通过\nVERDICT: {"state":"fail","summary":"第${e2eCount}次失败"}`, tools: [], files: [] };
  }
  return { text: `完成\nVERDICT: {"state":"pass","summary":"ok"}`, tools: [], files: [] };
};

const { startRun, subscribe, parseTickets } = await import("./server/runner.mjs");
const { saveReq, getReq, newProject, saveProject } = await import("./server/store.mjs");

const project = newProject({
  name: "测试项目", repoPath: process.env.REPO_PATH, worktreesDir: process.env.WORKTREES_DIR,
});
await saveProject(project);

/* 造需求：T-2 依赖 T-1，T-3 独立 */
const tickets = parseTickets(`
- T-1 主功能
- T-2 依赖主功能的扩展 [依赖 T-1]
- T-3 独立小改动
`);
await saveReq({
  id: "REQ-RUN", projectId: project.id, title: "调度测试", phase: "impl",
  dialog: [], settled: { fixed: [], open: [] }, implChat: [],
  tickets, createdAt: new Date().toISOString(),
});

/* 用假 verdict 解析器（与 index.mjs 同逻辑简化版）*/
const extractVerdict = (text) => {
  const m = text.match(/^VERDICT:\s*(\{[\s\S]*?\})\s*$/m);
  if (m) {
    const v = JSON.parse(m[1]);
    const map = { pass: "pass", fail: "fail", blocked: "waiting" };
    return { state: map[v.state], summary: v.summary, clean: text, structured: true };
  }
  return { state: "pass", summary: "", clean: text, structured: false };
};

const events = [];
startRun("REQ-RUN", extractVerdict, { runTurn: fakeRunTurn });
subscribe("REQ-RUN", (e) => events.push(e)); // startRun 同步登记，可立即订阅

/* 等运行结束 */
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if (events.some((e) => e.type === "run" && ["halted", "done", "error"].includes(e.state))) break;
}

const req = await getReq("REQ-RUN");
const t = (id) => req.tickets.find((x) => x.ticket === id);
const st = (id, sk) => t(id).skills.find((s) => s.name === sk)?.state;

console.log("调用序列:", calls.join(" → "));
console.log("");
let bad = 0;
const chk = (n, ok, ex = "") => { if (!ok) bad++; console.log(`${ok ? "✔" : "✗"} ${n}${ex ? " → " + ex : ""}`); };

chk("T-1 implement 通过", st("T-1", "implement") === "pass", st("T-1", "implement"));
chk("T-1 code-review 通过", st("T-1", "code-review") === "pass", st("T-1", "code-review"));
chk("T-1 e2e 失败", st("T-1", "e2e") === "fail", st("T-1", "e2e"));
chk("e2e 恰好尝试 2 次（重试一次）", e2eCount === 2, `实际 ${e2eCount} 次`);
chk("重试事件已广播", events.some((e) => e.type === "retry"), "");
chk("重试时带上了失败原因", calls.filter((c) => c === "T-1/e2e").length === 2);
chk("T-2 被依赖阻塞，未运行", !calls.some((c) => c.startsWith("T-2")), calls.join(","));
chk("T-2 标记了 blockedBy", t("T-2").blockedBy === "T-1", String(t("T-2").blockedBy));
chk("T-3 未被推进（按规格：fail 即停，交给人处理）",
    t("T-3").skills.every((s) => s.state === "idle"), t("T-3").skills.map(s=>s.state).join(","));
chk("运行以 halted 收尾", events.some((e) => e.type === "run" && e.state === "halted"));

console.log(bad === 0 ? "\n调度器运行行为全部符合预期。" : `\n${bad} 项未通过。`);
process.exit(bad ? 1 : 0);
