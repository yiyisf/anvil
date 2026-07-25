/**
 * 验证：把宿主真实二进制（node/npm/git/python3/mvn）桥接进 just-bash sandbox
 *
 * 背景：just-bash 是 JS 实现的 bash，内建命令都是 JS 版，没有任何真实二进制，
 *       直接跑 `node --version` 会 127 command not found。
 * 方案：用 defineCommand + bashEnvInstance.registerCommand 注册桥接命令，
 *       转发到宿主 child_process，并把沙箱路径映射回真实路径执行。
 */
import { Sandbox, ReadWriteFs, defineCommand } from "just-bash";
import { execFile } from "node:child_process";
import path from "node:path";

const ROOT = "/tmp/bridge-demo";           // 挂载根（对应 WORKTREES_DIR）
const TOOLS = ["node", "npm", "npx", "git", "python3", "mvn"];

/** 沙箱路径 → 宿主真实路径 */
const toHost = (sandboxPath) => path.join(ROOT, sandboxPath.replace(/^\/+/, ""));

function bridge(name, { timeout = 120000 } = {}) {
  return defineCommand(name, async (args, ctx) => {
    const cwd = toHost(ctx.cwd || "/");
    return new Promise((resolve) => {
      execFile(
        name, args,
        { cwd, timeout, maxBuffer: 1024 * 1024 * 16, env: { ...process.env, ...Object.fromEntries(ctx.env || []) } },
        (err, stdout, stderr) => {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? (err && !stdout && !stderr ? String(err.message) : ""),
            exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          });
        }
      );
    });
  });
}

const sandbox = await Sandbox.create({
  fs: new ReadWriteFs({ root: ROOT }),
  cwd: "/",
  useDefaultLayout: false,
});

// 注册桥接命令
for (const t of TOOLS) sandbox.bashEnvInstance.registerCommand(bridge(t));

const run = async (cmd, cwd) => {
  const c = await sandbox.runCommand({ cmd: "bash", args: ["-c", cmd], ...(cwd ? { cwd } : {}) });
  const r = await (c.wait ? c.wait() : c.resultPromise);
  const s = await (typeof r.stdout === "function" ? r.stdout() : r.stdout);
  const e = await (typeof r.stderr === "function" ? r.stderr() : r.stderr);
  return { code: r.exitCode, out: String(s || "").trim(), err: String(e || "").trim() };
};

console.log("=== 桥接后在 sandbox 内执行真实工具 ===");
for (const cmd of ["node --version", "npm --version", "git --version", "python3 --version"]) {
  const r = await run(cmd);
  console.log(`$ ${cmd}\n  exit=${r.code} → ${r.out || r.err.slice(0, 80)}`);
}

console.log("\n=== 真实执行验证：在项目目录跑 node 脚本 ===");
const r1 = await run("node -e \"console.log('运行于:', process.cwd())\"", "/proj");
console.log(`  ${r1.out || r1.err}`);

console.log("\n=== 内建命令仍走 just-bash（未被影响）===");
const r2 = await run("echo builtin-ok && ls /proj");
console.log(`  ${r2.out}`);

process.exit(0);
