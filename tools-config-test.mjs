/**
 * 验证按项目工具白名单：agent.config.json > 环境变量 > 内置默认
 * 运行：node tools-config-test.mjs
 */
import { resolveToolConfig, registerTools } from "./server/tools.mjs";
import { Sandbox, ReadWriteFs } from "just-bash";
import { mkdir, writeFile, rm } from "node:fs/promises";

const ROOT = "/tmp/cfg-demo";
const P = `${ROOT}/proj`;
await rm(ROOT, { recursive: true, force: true });
await mkdir(P, { recursive: true });

console.log("=== 1. 无配置文件（用环境变量或默认）===");
delete process.env.SANDBOX_TOOLS;
let c = resolveToolConfig(P);
console.log(`  ${c.tools.join(",")} | 来源 ${c.source} | 超时 ${c.timeout}`);

console.log("=== 2. 环境变量覆盖 ===");
process.env.SANDBOX_TOOLS = "node,git";
c = resolveToolConfig(P);
console.log(`  ${c.tools.join(",")} | 来源 ${c.source}`);

console.log("=== 3. 项目配置文件优先级最高 ===");
await writeFile(`${P}/agent.config.json`, JSON.stringify({ tools: ["node", "pnpm", "mvn"], toolTimeoutMs: 300000 }));
c = resolveToolConfig(P);
console.log(`  ${c.tools.join(",")} | 来源 ${c.source} | 超时 ${c.timeout}`);

console.log("=== 4. 配置文件损坏时回退 ===");
await writeFile(`${P}/agent.config.json`, "{ 不是合法 JSON");
c = resolveToolConfig(P);
console.log(`  ${c.tools.join(",")} | 来源 ${c.source}（应回退到 env）`);

console.log("\n=== 5. 实际生效验证：项目只允许 node，git 应不可用 ===");
await writeFile(`${P}/agent.config.json`, JSON.stringify({ tools: ["node"] }));
const sb = await Sandbox.create({ fs: new ReadWriteFs({ root: ROOT }), cwd: "/", useDefaultLayout: false });
const cfg = registerTools(sb, ROOT, P);
console.log(`  注册: ${cfg.tools.join(",")}`);
const run = async (cmd) => {
  const c2 = await sb.runCommand({ cmd: "bash", args: ["-c", cmd] });
  const r = await (c2.wait ? c2.wait() : c2.resultPromise);
  const o = await (typeof r.stdout === "function" ? r.stdout() : r.stdout);
  const e = await (typeof r.stderr === "function" ? r.stderr() : r.stderr);
  return `exit=${r.exitCode} ${String(o || e || "").trim().slice(0, 60)}`;
};
console.log("  node --version →", await run("cd /proj && node --version"));
console.log("  git --version  →", await run("cd /proj && git --version"));

process.exit(0);
