/**
 * 验证两件事：
 *   1. Agent 工具层按阶段限定（与 sandbox 环境依赖是两层）
 *   2. 实现阶段每个工单一个独立会话（避免上下文累积触发压缩）
 * 运行：node layering-test.mjs
 */
import { agentToolProfile, agentToolSettings, resolveToolConfig } from "./server/tools.mjs";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";

let bad = 0;
const chk = (n, ok, ex = "") => { if (!ok) bad++; console.log(`${ok ? "✔" : "✗"} ${n}${ex ? " → " + ex : ""}`); };

/* ── 1. 两层是否分离 ── */
console.log("【第一层：sandbox 环境依赖】");
const P = "/tmp/layer-demo/proj";
await rm("/tmp/layer-demo", { recursive: true, force: true });
await mkdir(P, { recursive: true });
await writeFile(`${P}/agent.config.json`, JSON.stringify({
  sandboxTools: ["node", "mvn"],
  agentTools: { analysis: { allow: ["read"] } },
}));
const sb = resolveToolConfig(P);
chk("sandboxTools 生效", sb.tools.join(",") === "node,mvn", sb.tools.join(","));

console.log("\n【第二层：agent 可用工具】");
const a = agentToolProfile("analysis", P);
chk("项目可覆盖分析阶段工具", a.allow.join(",") === "read", a.allow.join(","));

/* 默认档位 */
const d = "/tmp/layer-demo/nocfg";
await mkdir(d, { recursive: true });
chk("分析阶段默认只读", agentToolProfile("analysis", d).allow.join(",") === "read,grep,glob",
    agentToolProfile("analysis", d).allow.join(","));
chk("移交阶段可写文件", agentToolProfile("spec", d).allow.includes("write"),
    agentToolProfile("spec", d).allow.join(","));
chk("移交阶段仍无 bash", !agentToolProfile("spec", d).allow.includes("bash"));
chk("实现阶段不过滤（全部工具）", agentToolProfile("impl", d).allow === null);

/* 组装出的设置 */
const s1 = agentToolSettings("analysis", d);
chk("分析阶段生成 allow 过滤", s1.builtinToolFiltering?.mode === "allow");
chk("分析阶段无 write/edit/bash",
    !s1.builtinToolFiltering.toolNames.some((t) => ["write", "edit", "bash"].includes(t)),
    s1.builtinToolFiltering.toolNames.join(","));
const s3 = agentToolSettings("impl", d);
chk("实现阶段不带过滤项", s3.builtinToolFiltering === undefined);
chk("统一 allow-all 避免审批卡住", s1.permissionMode === "allow-all" && s3.permissionMode === "allow-all");

/* ── 2. 会话按工单隔离 ── */
console.log("\n【会话隔离】");
process.env.DATA_DIR = "/tmp/layer-demo/.data";
const { saveSession, loadSession, clearSessions } = await import("./server/store.mjs");
await saveSession("REQ-1--impl-T-1", { jsonl: "a", sessionFileName: "a.jsonl" });
await saveSession("REQ-1--impl-T-2", { jsonl: "b", sessionFileName: "b.jsonl" });
await saveSession("REQ-1--analysis", { jsonl: "keep", sessionFileName: "k.jsonl" });

const t1 = await loadSession("REQ-1--impl-T-1");
const t2 = await loadSession("REQ-1--impl-T-2");
chk("两个工单会话互不干扰", t1.jsonl === "a" && t2.jsonl === "b", `${t1.jsonl}/${t2.jsonl}`);

await clearSessions("REQ-1--impl");
const after1 = await loadSession("REQ-1--impl-T-1");
const after2 = await loadSession("REQ-1--impl-T-2");
const keep = await loadSession("REQ-1--analysis");
chk("作废重跑清空全部工单会话", after1 === null && after2 === null);
chk("分析会话不受影响", keep?.jsonl === "keep", String(keep?.jsonl));

console.log(bad === 0 ? "\n分层与会话隔离全部通过。" : `\n${bad} 项未通过。`);
process.exit(bad ? 1 : 0);
