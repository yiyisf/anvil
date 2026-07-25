/**
 * verdict 解析自检：覆盖结构化输出与旧关键词判定会误判的用例
 * 运行：node verdict-test.mjs
 */
function extractVerdict(text) {
  const m = text.match(/^VERDICT:\s*(\{[\s\S]*?\})\s*$/m);
  if (m) {
    try {
      const v = JSON.parse(m[1]);
      const map = { pass: "pass", fail: "fail", blocked: "waiting" };
      const state = map[v.state];
      if (state) {
        return { state, summary: String(v.summary || "").slice(0, 300), clean: text.replace(m[0], "").trim(), structured: true };
      }
    } catch {}
  }
  const state = /超出范围|需要确认|无法继续|停下等/.test(text)
    ? "waiting"
    : /未通过|不通过|失败|测试挂/.test(text) ? "fail" : "pass";
  return { state, summary: text.slice(0, 160), clean: text, structured: false };
}

const cases = [
  {
    name: "结构化 pass",
    text: '已实现并补测试。\nVERDICT: {"state":"pass","summary":"3 个测试通过"}',
    expect: "pass", structured: true,
  },
  {
    name: "结构化 fail",
    text: '跨月场景不符。\nVERDICT: {"state":"fail","summary":"期望 08:00 实际 00:00"}',
    expect: "fail", structured: true,
  },
  {
    name: "结构化 blocked → waiting",
    text: '需要改对外签名。\nVERDICT: {"state":"blocked","summary":"超出工单范围"}',
    expect: "waiting", structured: true,
  },
  {
    name: "旧逻辑会误判的句子（有 VERDICT 保护）",
    text: '本次没有未通过的场景，全部符合预期。\nVERDICT: {"state":"pass","summary":"5 个场景全过"}',
    expect: "pass", structured: true,
  },
  {
    name: "无 VERDICT 时退回兜底",
    text: "跨月对账场景未通过。",
    expect: "fail", structured: false,
  },
  {
    name: "VERDICT 里 state 非法 → 兜底",
    text: '说明\nVERDICT: {"state":"unknown","summary":"x"}',
    expect: "pass", structured: false,
  },
];

let bad = 0;
for (const c of cases) {
  const r = extractVerdict(c.text);
  const ok = r.state === c.expect && r.structured === c.structured;
  if (!ok) bad++;
  console.log(
    `${ok ? "✔" : "✗"} ${c.name} → ${r.state}/${r.structured ? "verdict" : "fallback"}` +
      (ok ? "" : `（期望 ${c.expect}/${c.structured ? "verdict" : "fallback"}）`)
  );
}
// 顺带确认 VERDICT 行已从展示文本中剥离
const cleaned = extractVerdict(cases[0].text).clean;
console.log(cleaned.includes("VERDICT") ? "✗ VERDICT 行未剥离" : "✔ VERDICT 行已从展示文本剥离");
console.log(bad === 0 ? "\n全部通过。" : `\n${bad} 项未通过。`);
