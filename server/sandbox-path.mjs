/**
 * sandbox 路径层补丁
 *
 * 症状：Windows 上代理调用 pi 的 read 工具，稳定报「路径不可用」
 *       （原文 `Unable to resolve path: <路径>`），文件明明就在 worktree 里。
 *       write / edit / grep / glob / ls 也是同一条路，一起不可用。
 *
 * 两个必须一起修的点：
 *
 * 【一】just-bash 没有 realpath 命令
 *
 * harness-pi 的每个文件工具在动手前，都会先在【沙箱里】跑一段 shell 把路径规范化：
 *
 *     if [ ! -e "$target" ]; then echo __PI_REALPATH_NOT_FOUND__; exit 2; fi
 *     resolved=$(realpath "$target" 2>/dev/null) || { echo __PI_REALPATH_FAILED__; exit 3; }
 *
 * just-bash 的内建命令表里有 readlink、没有 realpath，于是子 shell 直接
 * 127 command not found，走进 __PI_REALPATH_FAILED__ 分支，pi 抛
 * "Unable to resolve path"。注意它跟"文件在不在"无关 —— 第一行的 [ -e ] 已经过了，
 * 卡在第二行，所以从报错去查文件是否存在会全程查不出东西。
 *
 * 也不能靠 SANDBOX_TOOLS 桥接宿主的 realpath 绕过：
 *   - Windows 上压根没有这个二进制；
 *   - 就算有，桥接过去的参数是沙箱路径（/REQ-1/src/a.js），宿主上并不存在。
 * 只能在沙箱内自己实现一个，直接走沙箱 VFS。
 *
 * 【二】Windows 上 ReadWriteFs 交出来的"虚拟路径"带反斜杠
 *
 * 它的做法是把宿主真实路径的 root 前缀切掉：
 *     realpath("/REQ-1/src/a.js")
 *       → 宿主 "D:\trees\REQ-1\src\a.js"，slice 掉 "D:\trees"
 *       → "\REQ-1\src\a.js"          ← 反斜杠，不是合法的 posix 绝对路径
 *
 * pi 拿到这个结果后用 path.posix 判断它是否还在工作区内，反斜杠串一律判为越界，
 * 于是即便补上了 realpath 命令，也会换个错法失败（Pi path escapes the readable roots）。
 * pwd -P、readlink 是同一个出口，所以在 fs 层统一修，而不是在命令里补。
 */
import { defineCommand } from "just-bash";

const IS_WIN = process.platform === "win32";

/** 宿主分隔符 → 沙箱分隔符。沙箱路径永远是 posix，这一点没有例外 */
const toPosixPath = (p) => String(p).replace(/\\/g, "/");

/** IFileSystem 里只有这两个方法会把"虚拟路径"当返回值交出去 */
const PATH_RETURNING = new Set(["realpath", "readlink"]);

/**
 * 包一层，保证 fs 返回的虚拟路径始终是 posix 形式。
 * 非 Windows 上原样返回，不引入任何开销。
 */
export function posixVirtualFs(fs) {
  if (!IS_WIN) return fs;
  return new Proxy(fs, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== "function") return v;
      const fn = v.bind(target);
      if (!PATH_RETURNING.has(prop)) return fn;
      return async (...args) => {
        const r = await fn(...args);
        return typeof r === "string" ? toPosixPath(r) : r;
      };
    },
  });
}

/* ── 沙箱内的 posix 路径运算（不能用 node:path，那是宿主语义）── */

const dirnameOf = (p) => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};
const basenameOf = (p) => p.slice(p.lastIndexOf("/") + 1);
const joinOf = (dir, base) => (dir === "/" ? `/${base}` : `${dir}/${base}`);

/** 纯字符串规范化：消掉 . 与 ..，不看文件系统 */
function normalizeAbs(p) {
  const out = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}

const absolutize = (cwd, p) => normalizeAbs(p.startsWith("/") ? p : `${cwd || "/"}/${p}`);

/**
 * 解析到规范路径。
 * mustExist=false 时按 GNU realpath -m 的语义：从尾部逐级往上退，
 * 找到第一个真实存在的祖先解析它，再把缺失的部分接回去。
 */
async function canonicalize(fs, abs, mustExist) {
  try {
    return toPosixPath(await fs.realpath(abs));
  } catch (e) {
    if (mustExist) throw e;
  }
  const parent = dirnameOf(abs);
  if (parent === abs) return abs; // 已经到根，没得再退
  return joinOf(await canonicalize(fs, parent, false), basenameOf(abs));
}

/**
 * 沙箱内建 realpath
 *
 * 只实现 GNU realpath 里会被实际用到的选项；未知选项报错而不是默默忽略，
 * 否则脚本会拿到一个语义不符的结果，比直接失败更难查。
 *
 * ⚠️ 输出纪律：pi 把 stdout 与 stderr 合并后取【最后一行非空输出】当结果，
 *    所以正常路径下除了结果本身不能再往任何一个流里写东西。
 */
function realpathCommand() {
  return defineCommand("realpath", async (args, ctx) => {
    let mustExist = true; // GNU 默认：路径的每一级都必须存在
    let symlinks = true;
    let quiet = false;
    let sep = "\n";
    const targets = [];
    let endOfFlags = false;

    const badFlag = (f) => ({
      stdout: "",
      stderr: `realpath: 无法识别的选项 '${f}'\n`,
      exitCode: 1,
    });

    for (const a of args) {
      if (!endOfFlags && a === "--") { endOfFlags = true; continue; }
      if (endOfFlags || !a.startsWith("-") || a === "-") { targets.push(a); continue; }

      if (a.startsWith("--")) {
        if (a === "--canonicalize-missing") mustExist = false;
        else if (a === "--canonicalize-existing") mustExist = true;
        else if (a === "--no-symlinks" || a === "--strip") symlinks = false;
        else if (a === "--quiet" || a === "--silent") quiet = true;
        else if (a === "--zero") sep = "\0";
        else if (a === "--logical" || a === "--physical") symlinks = true;
        else return badFlag(a);
        continue;
      }
      for (const c of a.slice(1)) {
        if (c === "m") mustExist = false;
        else if (c === "e") mustExist = true;
        else if (c === "s") symlinks = false;
        else if (c === "q") quiet = true;
        else if (c === "z") sep = "\0";
        else if (c === "L" || c === "P") symlinks = true;
        else return badFlag(`-${c}`);
      }
    }

    if (!targets.length) {
      return { stdout: "", stderr: "realpath: 缺少操作数\n", exitCode: 1 };
    }

    let stdout = "";
    let stderr = "";
    let failed = false;

    for (const t of targets) {
      try {
        if (t === "") throw new Error("ENOENT"); // GNU 对空操作数也报错，不当成 cwd
        const abs = absolutize(ctx.cwd, t);
        // -s 不跟随符号链接，但除非同时给了 -m，路径本身仍须存在
        let resolved;
        if (symlinks) {
          resolved = await canonicalize(ctx.fs, abs, mustExist);
        } else {
          if (mustExist && !(await ctx.fs.exists(abs))) throw new Error("ENOENT");
          resolved = abs;
        }
        stdout += resolved + sep;
      } catch {
        failed = true;
        if (!quiet) stderr += `realpath: ${t}: 没有那个文件或目录\n`;
      }
    }

    return { stdout, stderr, exitCode: failed ? 1 : 0 };
  });
}

/**
 * 注册沙箱内建命令（与桥接宿主二进制的 SANDBOX_TOOLS 是两回事：
 * 这些是纯 JS 实现、直接操作沙箱 VFS，不受白名单控制，也必须永远存在 ——
 * 少一个 realpath，pi 的全部文件工具就没法用了）。
 */
const SANDBOX_BUILTINS = ["realpath"];

export function registerSandboxBuiltins(sandbox) {
  sandbox.bashEnvInstance.registerCommand(realpathCommand());
  return SANDBOX_BUILTINS;
}
