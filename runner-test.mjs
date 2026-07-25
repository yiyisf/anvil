/**
 * 调度逻辑自检：依赖解析、拓扑顺序、成环检测、阻塞传播
 * 运行：node runner-test.mjs
 */
import { parseTickets, findCycle, nextTicket } from "./server/runner.mjs";

let bad = 0;
const check = (name, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✔" : "✗"} ${name}${extra ? " → " + extra : ""}`);
};

/* 1. 解析 */
const md = `
- T-1 导出服务与分页
- T-2 接入权限校验 [依赖 T-1]
- T-3 脱敏与审计日志 [依赖 T-1, T-2]
- T-4 前端导出按钮
`;
const ts = parseTickets(md);
check("解析出 4 个工单", ts.length === 4);
check("T-1 无依赖", ts[0].deps.length === 0);
check("T-2 依赖 T-1", JSON.stringify(ts[1].deps) === '["T-1"]');
check("T-3 依赖两个", JSON.stringify(ts[2].deps) === '["T-1","T-2"]');
check("标题不含依赖标记", ts[1].title === "接入权限校验", ts[1].title);
check("中文括号也支持", parseTickets("- T-9 标题 ［依赖 T-1］")[0].deps[0] === "T-1");

/* 2. 成环检测 */
check("无环时返回空", findCycle(ts).length === 0);
const cyc = parseTickets("- T-1 A [依赖 T-2]\n- T-2 B [依赖 T-1]");
check("检测出环", findCycle(cyc).length > 0, findCycle(cyc).join("→"));

/* 3. 拓扑顺序 */
const pass = (t) => t.skills.forEach((s) => (s.state = "pass"));
let n = nextTicket(ts);
check("第一个可跑的是 T-1", n?.ticket === "T-1", n?.ticket);

pass(ts[0]);
n = nextTicket(ts);
check("T-1 完成后轮到 T-2", n?.ticket === "T-2", n?.ticket);

pass(ts[1]);
n = nextTicket(ts);
check("T-2 完成后轮到 T-3", n?.ticket === "T-3", n?.ticket);

pass(ts[2]);
n = nextTicket(ts);
check("最后跑无依赖的 T-4", n?.ticket === "T-4", n?.ticket);

/* 4. 阻塞传播：T-1 失败，下游都不该被选中 */
const ts2 = parseTickets(md);
ts2[0].skills[0].state = "fail";
const picked = [];
for (let i = 0; i < 5; i++) {
  const t = nextTicket(ts2);
  if (!t) break;
  picked.push(t.ticket);
  pass(t);
}
check("T-1 失败后不选 T-2/T-3", !picked.includes("T-2") && !picked.includes("T-3"), picked.join(",") || "(无)");
check("但独立的 T-4 仍可跑", picked.includes("T-4"), picked.join(",") || "(无)");

/* 5. blocked（等人确认）同样阻塞下游 */
const ts3 = parseTickets(md);
ts3[0].skills[0].state = "waiting";
const n3 = nextTicket(ts3);
check("T-1 等人时不推进 T-2", n3?.ticket !== "T-2", n3?.ticket || "(无)");

console.log(bad === 0 ? "\n调度逻辑全部通过。" : `\n${bad} 项未通过。`);
process.exit(bad ? 1 : 0);
