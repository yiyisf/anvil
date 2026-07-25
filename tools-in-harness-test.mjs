/**
 * 验证工具桥接在【完整 harness 链路】中生效
 * （不接模型：只验证 sandbox session 内能否执行真实工具、cwd 是否落在 worktree）
 * 运行：node tools-in-harness-test.mjs
 */
import { createJustBashSandbox } from "@ai-sdk/sandbox-just-bash";
import { ReadWriteFs, Sandbox } from "just-bash";
import { registerTools, toolList } from "./server/tools.mjs";
import { mkdir, writeFile } from "node:fs/promises";

const ROOT = process.env.WORKTREES_DIR || "/tmp/demo-trees";
const REQ = "TOOLS-TEST";
await mkdir(`${ROOT}/${REQ}`, { recursive: true });
await writeFile(`${ROOT}/${REQ}/package.json`, JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2));

const raw = await Sandbox.create({
  fs: new ReadWriteFs({ root: ROOT }),
  cwd: "/",
  useDefaultLayout: false,
});
const names = registerTools(raw, ROOT);
console.log("已桥接工具:", names.join(", "));

const provider = createJustBashSandbox({ sandbox: raw });
const netSession = await provider.createSession({ sessionId: "tt" });
const s = netSession.restricted();

const run = async (command) => {
  const r = await s.run({ command });
  return { code: r.exitCode, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
};

console.log("\n=== 在 harness 的 sandbox session 内执行 ===");
for (const cmd of [
  `cd /${REQ} && node --version`,
  `cd /${REQ} && npm --version`,
  `cd /${REQ} && git --version`,
  `cd /${REQ} && node -e "console.log('cwd:', process.cwd())"`,
  `cd /${REQ} && node -e "console.log('读到 package.json:', require('./package.json').name)"`,
  `cd /${REQ} && ls`,
]) {
  const r = await run(cmd);
  console.log(`$ ${cmd.replace(`cd /${REQ} && `, "")}\n  exit=${r.code} → ${(r.out || r.err).slice(0, 90)}`);
}

console.log("\n=== 未在白名单的工具应仍不可用 ===");
const r = await run(`cd /${REQ} && somerandomtool --x`);
console.log(`  exit=${r.code} → ${(r.err || r.out).slice(0, 80)}`);

process.exit(0);
