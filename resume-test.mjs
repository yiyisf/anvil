/**
 * 专项验证：第二轮对话的 resume 路径不再抛
 *   "Sandbox provider 'just-bash-sandbox' does not support resume."
 * 用假模型即可验证（只看 session 能否 resume 出来，不看模型输出）。
 * 运行：node resume-test.mjs
 */
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createPi } from "@ai-sdk/harness-pi";
import { createJustBashSandbox } from "@ai-sdk/sandbox-just-bash";
import { ReadWriteFs } from "just-bash";
import { mkdir } from "node:fs/promises";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;

const ROOT = process.env.WORKTREES_DIR || "/tmp/demo-trees";
const REQ = "RESUME-TEST";
await mkdir(`${ROOT}/${REQ}`, { recursive: true });

const shq = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";

function wrapResumable(p) {
  if (p.resumeSession == null) {
    p.resumeSession = async (o) =>
      p.createSession({ sessionId: o?.sessionId, ...(o?.abortSignal ? { abortSignal: o.abortSignal } : {}) });
  }
  return p;
}

function mkAgent(wrap) {
  const raw = createJustBashSandbox({
    fs: new ReadWriteFs({ root: ROOT }),
    cwd: "/",
    useDefaultLayout: false,
  });
  return new HarnessAgent({
    harness: createPi({
      model: process.env.PI_MODEL || "anthropic/fake",
      auth: { customEnv: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } },
    }),
    sandbox: wrap ? wrapResumable(raw) : raw,
    instructions: "test",
    sandboxConfig: {
      workDir: REQ,
      onSession: async ({ session, sessionWorkDir }) => {
        await session.run({ command: `mkdir -p ${shq(sessionWorkDir)}` });
      },
    },
  });
}

async function trial(label, wrap) {
  const a1 = mkAgent(wrap);
  const s1 = await a1.createSession({ sessionId: "rt" });
  let state = null;
  try {
    const r = await a1.stream({ session: s1, prompt: "hi" });
    for await (const _ of r.stream) { /* 假模型会失败，无所谓 */ }
  } catch { /* 预期连接失败 */ }
  try { state = await s1.stop(); } catch { }

  // 第二轮：全新 agent（模拟下一个 HTTP 请求）+ resumeFrom
  const a2 = mkAgent(wrap);
  try {
    await a2.createSession({ sessionId: "rt", resumeFrom: state });
    console.log(`${label}: ✔ resume 成功`);
  } catch (e) {
    console.log(`${label}: ✗ ${e.message}`);
  }
}

await trial("不加包装（复现你的报错）", false);
await trial("加了 wrapResumable（修复后）", true);
process.exit(0);
