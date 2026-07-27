/**
 * sandbox 工具桥接
 *
 * 背景：just-bash 是 JS 实现的 bash，内建命令（ls/cat/echo/mkdir…）都是 JS 版，
 *       **没有任何真实二进制**。直接跑 `node --version` 会 127 command not found，
 *       意味着 implement / e2e 这类 skill 无法执行测试。
 *
 * 方案：用 defineCommand 注册桥接命令，转发到宿主 child_process，
 *       并把沙箱路径映射回真实 worktree 路径执行。
 *
 * ⚠️ 安全边界：桥接等于把宿主的命令执行能力交给了代理。
 *    - 文件读写被 ReadWriteFs 的 root 限制在 WORKTREES_DIR 内；
 *    - 但被桥接的工具本身不受此限制（例如 `node -e` 可以读写任意路径）。
 *    因此 SANDBOX_TOOLS 应按需最小化配置；对不可信输入，应把整个服务放进容器运行。
 */
import { defineCommand } from "just-bash";
import { execFileSync } from "node:child_process";
import crossSpawn from "cross-spawn";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { registerSandboxBuiltins } from "./sandbox-path.mjs";

const DEFAULT_TOOLS = "node,npm,npx,git";
const CONFIG_NAME = "agent.config.json";

/**
 * Agent 工具层的默认档位（与 sandbox 环境依赖是两回事）
 *
 * 两层的嵌套关系：
 *   agent 有没有 bash 工具  → 决定它能不能执行命令
 *   sandbox 里有没有 node   → 决定 bash 里能跑什么
 * 关掉 bash 工具，sandboxTools 配再多也没用。
 *
 * 内建工具共七个：read / write / edit / bash / grep / glob / webSearch
 *
 * 说明：用 builtinToolFiltering（直接把工具摘掉）而非 permissionMode 做主控制，
 * 因为过滤是确定性的；permissionMode 走的是审批流，当前没有内建工具的审批 UI，
 * 设成需要审批会让运行卡住。故 permissionMode 统一 allow-all，
 * 由"有哪些工具"来划边界。
 */
const AGENT_TOOL_PROFILES = {
  // 需求分析：只需读代码理解上下文，不该改任何东西
  analysis: { allow: ["read", "grep", "glob"], permissionMode: "allow-all" },
  // 生成规格/工单：要写 .agent 下的文件，但不需要执行命令
  spec: { allow: ["read", "write", "edit", "grep", "glob"], permissionMode: "allow-all" },
  // 实现：全套
  impl: { allow: null, permissionMode: "allow-all" }, // null = 不过滤
};

/** 取某阶段的 agent 工具配置（项目配置可覆盖） */
export function agentToolProfile(phase, projectDir) {
  const base = AGENT_TOOL_PROFILES[phase] || AGENT_TOOL_PROFILES.impl;
  if (!projectDir) return base;
  try {
    const cfg = JSON.parse(readFileSync(path.join(projectDir, CONFIG_NAME), "utf8"));
    const o = cfg.agentTools?.[phase];
    if (!o) return base;
    return {
      allow: Array.isArray(o.allow) ? o.allow.map(String) : base.allow,
      permissionMode: o.permissionMode || base.permissionMode,
    };
  } catch {
    return base;
  }
}

/** 组装成 HarnessAgent 能直接用的设置片段 */
export function agentToolSettings(phase, projectDir) {
  const p = agentToolProfile(phase, projectDir);
  return {
    permissionMode: p.permissionMode,
    ...(p.allow ? { builtinToolFiltering: { mode: "allow", toolNames: p.allow } } : {}),
  };
}

/**
 * 按项目解析工具配置。
 * 优先级：项目根的 agent.config.json > 环境变量 > 内置默认
 *
 * 项目里放一个 agent.config.json（建议提交到仓库，团队共享同一套）：
 *   {
 *     "tools": ["node", "pnpm", "git", "mvn"],
 *     "toolTimeoutMs": 300000
 *   }
 *
 * 因为 worktree 是仓库的检出，配置文件会随之带进每个需求的工作副本，
 * 天然做到"按项目"生效；将来支持多项目时无需改动这里。
 */
export function resolveToolConfig(projectDir) {
  const fromEnv = {
    tools: (process.env.SANDBOX_TOOLS ?? DEFAULT_TOOLS).split(",").map((s) => s.trim()).filter(Boolean),
    timeout: Number(process.env.TOOL_TIMEOUT_MS || 180000),
    source: process.env.SANDBOX_TOOLS ? "env" : "default",
  };
  if (!projectDir) return fromEnv;

  try {
    const raw = readFileSync(path.join(projectDir, CONFIG_NAME), "utf8");
    const cfg = JSON.parse(raw);
    // sandboxTools 是新键名（与 agentTools 并列，语义更清晰）；tools 兼容旧配置
    const list = cfg.sandboxTools ?? cfg.tools;
    return {
      tools: Array.isArray(list) && list.length
        ? list.map(String).map((s) => s.trim()).filter(Boolean)
        : fromEnv.tools,
      timeout: Number(cfg.toolTimeoutMs) > 0 ? Number(cfg.toolTimeoutMs) : fromEnv.timeout,
      source: CONFIG_NAME,
    };
  } catch {
    return fromEnv; // 没有配置文件或格式错误 → 回退
  }
}

/**
 * 解析命令的绝对路径（结果缓存）
 *
 * ⚠️ Windows 上不能直接 execFile("mvn")：
 *   - mvn / npm / npx / gradle 实际是 .cmd / .bat 批处理，execFile 不经 shell 起不来，报 ENOENT；
 *   - 若从 git-bash 启动服务，PATH 里可能是 /usr/bin/git 这类 POSIX 路径，Windows 的 Node 解析不了。
 * 两种情况的报错都是 spawn <cmd> ENOENT，与"没装这个命令"无法区分。
 * 因此先用 where/which 解析出绝对路径，再按扩展名决定怎么起。
 */
const IS_WIN = process.platform === "win32";
const resolveCache = new Map();

/**
 * 从 where/which 的多行输出里挑出真正能执行的那个（Windows 专用）
 *
 * ⚠️ 典型坑：Maven 的 bin 目录同时有 `mvn`（Unix shell 脚本，无扩展名）和 `mvn.cmd`。
 * `where mvn` 两个都返回，取第一行往往是无扩展名的那个 —— Windows 根本执行不了，
 * 报错是 spawn ENOENT，看起来又像"没装"。必须按 PATHEXT 挑。
 * npm / npx / gradle / yarn 也是同样的情况。
 */
function pickWindowsBinary(lines) {
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";").map((e) => e.trim().toLowerCase()).filter(Boolean);

  // 1) 直接命中 PATHEXT 里的扩展名
  const direct = lines.find((l) => exts.some((e) => l.toLowerCase().endsWith(e)));
  if (direct) return direct;

  // 2) where 只给了无扩展名的脚本：试着补上常见可执行扩展
  for (const l of lines) {
    for (const e of [".cmd", ".bat", ".exe"]) {
      if (existsSync(l + e)) return l + e;
    }
  }
  return lines[0] ?? null;
}

export function resolveBinary(name) {
  if (resolveCache.has(name)) return resolveCache.get(name);
  let info = null;
  try {
    const out = execFileSync(IS_WIN ? "where" : "which", [name], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const chosen = IS_WIN ? pickWindowsBinary(lines) : lines[0];
    if (chosen) {
      info = { path: chosen, isBatch: IS_WIN && /\.(cmd|bat)$/i.test(chosen) };
    }
  } catch {
    info = null;
  }
  resolveCache.set(name, info);
  return info;
}

/**
 * 合并环境变量给宿主进程用。
 *
 * ⚠️ 关键：just-bash 的 ctx.env 里带着它自己的【虚拟 PATH】（如 "/usr/bin:/bin"）。
 * 如果直接 { ...process.env, ...ctx.env }，虚拟 PATH 会覆盖宿主真实 PATH，
 * execFile 就只在那两个目录里找命令 —— 装在 sdkman / /opt / Program Files 下的
 * java、mvn 全部 ENOENT，且报错与"命令不存在"完全一样，极难排查。
 *
 * 处理：宿主 PATH 始终胜出；同时滤掉 bash 内部变量（$0 $# $@ IFS SHELLOPTS…），
 * 它们不是合法的进程环境变量名。用户在命令里显式设置的变量（如 JAVA_HOME=x mvn）仍会透传。
 */
// just-bash 会给出一整套自己的默认环境变量，它们描述的是【虚拟沙箱】而非宿主，
// 一旦覆盖宿主同名变量就会出各种怪问题，例如：
//   HOME 被覆盖成 "/" → git 去找 //.config/git/config → Windows 上 Invalid argument
//   PATH 被覆盖成 /usr/bin:/bin → 装在别处的 java/mvn 全部 ENOENT
// 因此这些一律不透传，只放行用户在命令里显式设置的变量（如 JAVA_HOME=x mvn test）。
const BASH_INTERNAL = new Set([
  // just-bash 默认注入的
  "PATH", "Path", "HOME", "PWD", "OLDPWD", "IFS", "OPTIND",
  "SHELLOPTS", "BASHOPTS", "OSTYPE", "MACHTYPE", "HOSTTYPE", "HOSTNAME",
  // Windows 上与家目录相关的，同样不能被虚拟值覆盖
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "SHELL", "USER", "LOGNAME",
]);
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function mergeEnv(ctx) {
  const fromCtx = {};
  for (const [k, v] of Object.entries(Object.fromEntries(ctx.env || []))) {
    if (BASH_INTERNAL.has(k) || !VALID_NAME.test(k)) continue;
    fromCtx[k] = String(v);
  }
  return { ...process.env, ...fromCtx }; // 宿主 PATH 保留
}

/** 终止进程及其子孙（Windows 上杀 cmd.exe 不会连带杀掉 mvn 起的 java） */
function killTree(child) {
  if (!child.pid) return;
  try {
    if (IS_WIN) {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
    } else {
      process.kill(-child.pid, "SIGKILL"); // detached 起的进程组
    }
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

/**
 * 造一个桥接命令：沙箱里的 <name> → 宿主真实 <name>
 * @param name    命令名
 * @param root    沙箱根对应的宿主目录（= WORKTREES_DIR）
 * @param timeout 单条命令的超时（毫秒）
 */
function bridge(name, root, timeout) {
  return defineCommand(name, async (args, ctx) => {
    // 沙箱 cwd 形如 /REQ-XXXX/sub → 宿主 <root>/REQ-XXXX/sub
    const cwd = path.join(root, String(ctx.cwd || "/").replace(/^\/+/, ""));

    // ⚠️ execFile 的 ENOENT 有两种含义：命令不存在，或【工作目录不存在】。
    // 两者报错完全一样（都是 spawn <cmd> ENOENT），不先判断会把
    // "worktree 没建出来" 误诊成 "宿主没装这个命令"，排查方向全错。
    if (!existsSync(cwd)) {
      return {
        stdout: "",
        stderr:
          `[bridge] 工作目录不存在：${cwd}\n` +
          `         （沙箱 cwd=${ctx.cwd || "/"}，挂载根=${root}）\n` +
          `         多为该需求的 worktree 未创建或已被删除；重建需求或做一次「作废重跑」。`,
        exitCode: 127,
      };
    }

    // 执行交给 cross-spawn：它负责 PATHEXT 解析、.cmd/.bat 经 cmd.exe 启动、
    // Windows 参数转义、shebang 脚本、ENOENT 归一化 —— 这些自己写极易在边界情况出错。
    return new Promise((resolve) => {
      const child = crossSpawn(name, args, {
        cwd,
        env: mergeEnv(ctx),
        windowsHide: true,
        // POSIX 下独立进程组，超时时能连子孙进程一起收掉
        ...(IS_WIN ? {} : { detached: true }),
      });

      const LIMIT = 1024 * 1024 * 16;
      let out = "", err = "", truncated = false, done = false;
      const take = (buf, isErr) => {
        if (truncated) return;
        const t = buf.toString();
        if (out.length + err.length + t.length > LIMIT) {
          truncated = true;
          err += `\n[bridge] 输出超过 16MB，已截断并终止`;
          killTree(child);
          return;
        }
        if (isErr) err += t; else out += t;
      };
      child.stdout?.on("data", (b) => take(b, false));
      child.stderr?.on("data", (b) => take(b, true));

      const timer = setTimeout(() => {
        if (done) return;
        err += `\n[bridge] ${name} 超过 ${timeout}ms，已终止`;
        killTree(child);
      }, timeout);

      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ stdout: out, stderr: err, exitCode: code });
      };

      child.on("error", (e) => {
        if (e.code === "ENOENT") {
          const bin = resolveBinary(name);
          err +=
            `[bridge] 无法启动 ${name}\n` +
            (bin
              ? `         已解析到 ${bin.path}，但启动失败；若它是无扩展名脚本，` +
                `请确认同目录有 ${name}.cmd/.bat 且 PATHEXT 含 .CMD。`
              : `         宿主 PATH 里找不到它（服务进程视角）。` +
                `从 IDE / git-bash 启动时 PATH 可能与登录 shell 不同。`);
          return finish(127);
        }
        err += `\n[bridge] ${name} 启动失败：${e.message}`;
        finish(1);
      });
      child.on("close", (code) => finish(code == null ? 1 : code));
    });
  });
}

/**
 * 给一个 Sandbox 实例注册桥接工具
 * @param sandbox     just-bash Sandbox 实例
 * @param root        沙箱根对应的宿主目录（= WORKTREES_DIR）
 * @param projectDir  读取 agent.config.json 的目录（通常是该需求的 worktree）
 */
export function registerTools(sandbox, root, projectDir) {
  const { tools, timeout, source } = resolveToolConfig(projectDir);
  for (const n of tools) sandbox.bashEnvInstance.registerCommand(bridge(n, root, timeout));
  // 沙箱内建命令：不受白名单控制，必须每个 sandbox 都有。
  // 放在这里而不是各调用点，是为了不可能漏 —— 少了 realpath，pi 的文件工具全线不可用。
  const builtins = registerSandboxBuiltins(sandbox);
  return { tools, timeout, source, builtins };
}
