/**
 * 流式验证：不接模型，直接检验 NDJSON 通道
 *   - 服务端能否边跑边推事件
 *   - 客户端解析逻辑（含跨 chunk 分行）是否正确
 *   - 最后一行 done 是否带完整 req
 * 运行：node stream-test.mjs
 */
import http from "node:http";

/* ── 1. 起一个最小服务，模拟 runTurn 的事件序列 ── */
const server = http.createServer((rq, rs) => {
  rs.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
  const emit = (e) => rs.write(JSON.stringify(e) + "\n");
  let i = 0;
  const seq = [
    { type: "step", ticket: "T-1", skill: "implement", state: "running" },
    { type: "reasoning", text: "先读文件" },
    { type: "tool", n: "read", a: "src/math.js" },
    { type: "text", text: "定位到" },
    { type: "text", text: "缺少时区参数。" },
    { type: "tool", n: "edit", a: "src/math.js" },
    { type: "file", path: "src/math.js" },
    { type: "tool", n: "bash", a: "npm test" },
  ];
  const timer = setInterval(() => {
    if (i < seq.length) emit(seq[i++]);
    else {
      clearInterval(timer);
      emit({ type: "done", req: { id: "REQ-X", phase: "impl", tickets: [] } });
      rs.end();
    }
  }, 30);
});
await new Promise((r) => server.listen(8899, r));

/* ── 2. 用与前端相同的解析逻辑消费 ── */
async function streamPost(url, body, onEvent) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", final = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "done") final = e.req;
      else if (e.type === "error") throw new Error(e.message);
      else onEvent?.(e);
    }
  }
  return final;
}

/* ── 3. 复现前端的状态归约 ── */
let live = { text: "", tools: [], files: [] };
const received = [];
const final = await streamPost("http://127.0.0.1:8899/api/run", {}, (e) => {
  received.push(e.type);
  if (e.type === "text") live.text += e.text;
  else if (e.type === "tool") live.tools.push(`${e.n} ${e.a}`);
  else if (e.type === "file") live.files.push(e.path);
});

console.log("收到事件序列:", received.join(" → "));
console.log("累积文本:", JSON.stringify(live.text));
console.log("工具调用:", live.tools.join(" | "));
console.log("改动文件:", live.files.join(", "));
console.log("最终 req:", final ? `${final.id} / ${final.phase}` : "(缺失)");

const ok =
  live.text === "定位到缺少时区参数。" &&
  live.tools.length === 3 &&
  live.files.length === 1 &&
  final?.id === "REQ-X";
console.log(ok ? "\n流式通道正常。" : "\n有问题，请检查。");

server.close();
process.exit(ok ? 0 : 1);
