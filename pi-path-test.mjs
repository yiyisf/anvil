/**
 * 验证 pi 文件工具（read/write/edit/grep/glob）的路径解析在沙箱内可用
 * 运行：node pi-path-test.mjs
 *
 * 复现的是 Windows 上"read 工具报路径不可用"的那条链路：
 * harness-pi 每次读文件前都会在沙箱里跑一段 shell 先把路径规范化，
 * 其中用到 realpath —— just-bash 没有这个命令，于是必然失败。
 * 这里直接跑那段一模一样的 shell，外加对 realpath 各选项与
 * "返回值必须是 posix 绝对路径"的检查。
 */
import { Sandbox, ReadWriteFs } from "just-bash";
import { registerTools } from "./server/tools.mjs";
import { posixVirtualFs, toPosixPath } from "./server/sandbox-path.mjs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const ROOT = path.join(tmpdir(), "pi-path-demo");
const REQ = "REQ-00001";

await rm(ROOT, { recursive: true, force: true });
await mkdir(path.join(ROOT, REQ, "src"), { recursive: true });
await mkdir(path.join(ROOT, REQ, ".agent"), { recursive: true });
await writeFile(path.join(ROOT, REQ, "src", "a.js"), "console.log(1)\n");
await writeFile(path.join(ROOT, REQ, ".agent", "spec.feature"), "功能: 示例\n");

const sb = await Sandbox.create({
  fs: posixVirtualFs(new ReadWriteFs({ root: ROOT })),
  cwd: "/",
  useDefaultLayout: false,
});
registerTools(sb, ROOT, path.join(ROOT, REQ));

const run = async (command, cwd) => {
  const c = await sb.runCommand({ cmd: "bash", args: ["-c", command], ...(cwd ? { cwd } : {}) });
  const r = await (c.wait ? c.wait() : c.resultPromise);
  const out = await (typeof r.stdout === "function" ? r.stdout() : r.stdout);
  const err = await (typeof r.stderr === "function" ? r.stderr() : r.stderr);
  return { code: r.exitCode, out: String(out || "").trim(), err: String(err || "").trim() };
};

let bad = 0;
const chk = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✔" : "✗"} ${name}${detail ? `\n    ${detail}` : ""}`);
};

/* ── 1. harness-pi 内部那段 shell，原样照搬 ── */
const piResolve = async (target) => {
  const r = await run(
    [
      `target='${target}'`,
      `if [ ! -e "$target" ]; then echo "__PI_REALPATH_NOT_FOUND__"; exit 2; fi`,
      `resolved=$(realpath "$target" 2>/dev/null) || { echo "__PI_REALPATH_FAILED__"; exit 3; }`,
      `printf '%s\\n' "$resolved"`,
    ].join("; ")
  );
  return `${r.out}${r.err}`.trim().split("\n").filter(Boolean).at(-1) || "";
};

console.log("=== 1. pi 的路径规范化流程 ===");
for (const t of [`/${REQ}`, `/${REQ}/src/a.js`, `/${REQ}/.agent/spec.feature`]) {
  const got = await piResolve(t);
  chk(`pi 能解析 ${t}`, got === t, `得到 ${got}`);
}

const missing = await piResolve(`/${REQ}/src/nope.js`);
chk(
  "不存在的文件走 NOT_FOUND 分支（不是 FAILED）",
  missing === "__PI_REALPATH_NOT_FOUND__",
  `得到 ${missing}`
);

/* ── 2. 返回值必须是 posix 绝对路径 ── */
console.log("\n=== 2. 结果必须是 posix 绝对路径 ===");
// pi 用 path.posix 判断结果是否还在工作区内。带反斜杠 / 相对路径都会被判越界。
for (const t of [`/${REQ}`, `/${REQ}/src/a.js`]) {
  const got = await piResolve(t);
  chk(
    `${t} 的结果不含反斜杠且以 / 开头`,
    got.startsWith("/") && !got.includes("\\"),
    `得到 ${JSON.stringify(got)}`
  );
}
chk(
  "fs.realpath 直接调用也返回 posix 路径",
  (await sb.bashEnvInstance.fs.realpath(`/${REQ}/src/a.js`)) === `/${REQ}/src/a.js`,
  `得到 ${await sb.bashEnvInstance.fs.realpath(`/${REQ}/src/a.js`)}`
);
chk("toPosixPath 转换宿主分隔符", toPosixPath("\\REQ-1\\src\\a.js") === "/REQ-1/src/a.js");

// Windows 分支在 Linux/mac 上也要能验：ReadWriteFs 在 Windows 上返回的是
// 切掉 root 前缀后的宿主路径（\REQ-1\src\a.js），包装层必须把它掰回 posix。
const winLikeFs = {
  realpath: async () => "\\REQ-1\\src\\a.js",
  readlink: async () => "..\\lib\\x.js",
  async readFile() { return "内容"; },
  marker: 42,
};
const wrapped = posixVirtualFs(winLikeFs, true);
chk("Windows 分支：realpath 掰回 posix", (await wrapped.realpath("/x")) === "/REQ-1/src/a.js");
chk("Windows 分支：readlink 掰回 posix", (await wrapped.readlink("/x")) === "../lib/x.js");
chk("Windows 分支：其他方法不受影响", (await wrapped.readFile("/x")) === "内容");
chk("Windows 分支：非函数属性透传", wrapped.marker === 42);
chk("非 Windows 原样返回同一个对象", posixVirtualFs(winLikeFs, false) === winLikeFs);

/* ── 3. realpath 命令本身的行为 ── */
console.log("\n=== 3. realpath 命令 ===");
let r = await run(`realpath src/a.js`, `/${REQ}`);
chk("相对路径按 cwd 解析", r.code === 0 && r.out === `/${REQ}/src/a.js`, `exit=${r.code} ${r.out}`);

r = await run(`realpath /${REQ}/src/../src/./a.js`);
chk("消掉 . 与 ..", r.code === 0 && r.out === `/${REQ}/src/a.js`, `exit=${r.code} ${r.out}`);

r = await run(`realpath /${REQ}/src/nope.js`);
chk("默认要求存在，不存在则非零退出", r.code !== 0, `exit=${r.code} ${r.out}${r.err}`);

r = await run(`realpath -m /${REQ}/src/nope.js`);
chk("-m 允许不存在", r.code === 0 && r.out === `/${REQ}/src/nope.js`, `exit=${r.code} ${r.out}`);

r = await run(`realpath -m /${REQ}/a/b/c/d.txt`);
chk("-m 允许整段不存在", r.code === 0 && r.out === `/${REQ}/a/b/c/d.txt`, `exit=${r.code} ${r.out}`);

r = await run(`realpath -q /${REQ}/src/nope.js`);
chk("-q 不往 stderr 写东西", r.code !== 0 && r.err === "", `err=${JSON.stringify(r.err)}`);

r = await run(`realpath /${REQ}/src/a.js /${REQ}/.agent`);
chk(
  "多个操作数每行一个",
  r.code === 0 && r.out === `/${REQ}/src/a.js\n/${REQ}/.agent`,
  `exit=${r.code} ${JSON.stringify(r.out)}`
);

r = await run(`realpath`);
chk("缺操作数报错", r.code === 1 && /缺少操作数/.test(r.err), `exit=${r.code} ${r.err}`);

r = await run(`realpath --nonsense /${REQ}`);
chk("未知选项报错而不是默默忽略", r.code === 1, `exit=${r.code} ${r.err}`);

r = await run(`realpath -- /${REQ}`);
chk("-- 之后按路径处理", r.code === 0 && r.out === `/${REQ}`, `exit=${r.code} ${r.out}`);

r = await run(`realpath /`);
chk("根目录", r.code === 0 && r.out === "/", `exit=${r.code} ${r.out}`);

/* ── 4. pi 写路径用的那段（write/edit 走它）── */
console.log("\n=== 4. pi 写入路径解析（父目录存在、文件还没有）===");
r = await run(
  [
    `target='/${REQ}/src/new.js'`,
    `dir=$(dirname "$target")`,
    `base=$(basename "$target")`,
    `resolved_dir=$(realpath "$dir" 2>/dev/null) || { echo "__PI_REALPATH_FAILED__"; exit 3; }`,
    `printf '%s/%s\\n' "$resolved_dir" "$base"`,
  ].join("; ")
);
chk("新文件路径能算出来", r.code === 0 && r.out === `/${REQ}/src/new.js`, `exit=${r.code} ${r.out}${r.err}`);

/* ── 5. 桥接的宿主命令不受影响 ── */
console.log("\n=== 5. 桥接命令仍然正常 ===");
r = await run(`node --version`, `/${REQ}`);
chk("node 桥接仍可用", r.code === 0 && /^v\d/.test(r.out), `exit=${r.code} ${r.out || r.err}`);

await rm(ROOT, { recursive: true, force: true });
console.log(bad === 0 ? "\npi 路径解析全部通过。" : `\n${bad} 项未通过。`);
process.exit(bad ? 1 : 0);
