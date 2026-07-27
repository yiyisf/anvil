/**
 * harness 工厂 —— 封装全部已验证的接入模式
 * 每一处 ⚠️ 都是实测踩出来的坑，改动前请先看 v4-设计说明.md 第十一、十二节
 */
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createPi } from "@ai-sdk/harness-pi";
import { createJustBashSandbox } from "@ai-sdk/sandbox-just-bash";
import { ReadWriteFs, Sandbox } from "just-bash";
import { registerTools, agentToolSettings, resolveToolConfig } from "./tools.mjs";
import { posixVirtualFs } from "./sandbox-path.mjs";
import { mapStreamPart } from "./stream-map.mjs";
import { envHint } from "./skills.mjs";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSession, saveSession } from "./store.mjs";

// ⚠️ Pi 是 host process 会继承系统 env；harness-pi 注册 anthropic 时只读 customEnv，
//    不读 process.env → 系统里的 ANTHROPIC_* 会让请求打到官方 API 而非你的 LiteLLM。
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const {
  LITELLM_BASE_URL,
  LITELLM_API_KEY = "sk-noauth",
  PI_MODEL,
  PI_PROVIDER = "anthropic", // anthropic(/v1/messages) | openai(/v1/responses)
} = process.env;

const shq = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";

/**
 * ⚠️ just-bash 是内存 sandbox，没实现 resumeSession，
 *    harness core 在 isResume 时会检查 provider.resumeSession，缺失就抛
 *    "Sandbox provider 'just-bash-sandbox' does not support resume."
 * 这里补一个最小实现：resume 语义改为【建全新 sandbox】，
 * 历史不靠 sandbox 恢复，而靠 onSession 回填 jsonl + resumeState.data.sessionFileName。
 * 缺了这段，第二轮对话必然报错。
 */
function wrapResumable(provider) {
  if (provider.resumeSession == null) {
    provider.resumeSession = async (opts) =>
      provider.createSession({
        sessionId: opts?.sessionId,
        ...(opts?.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      });
  }
  return provider;
}

function buildHarness() {
  // ⚠️ 协议要与 LiteLLM 实际暴露的一致
  const customEnv =
    PI_PROVIDER === "anthropic"
      ? { ANTHROPIC_API_KEY: LITELLM_API_KEY, ANTHROPIC_BASE_URL: LITELLM_BASE_URL }
      : { OPENAI_API_KEY: LITELLM_API_KEY, OPENAI_BASE_URL: LITELLM_BASE_URL };

  // ⚠️ 必须显式传 model，否则 Pi 回退到内置默认模型
  return createPi({ model: PI_MODEL, auth: { customEnv } });
}

/**
 * 每个需求一个 worktree，挂载为 sandbox 的真实文件系统
 * ⚠️ 挂载 worktree 的【父目录】，workDir 填目录名 —— workDir 不能是 "."
 * ⚠️ useDefaultLayout:false，否则会在 worktree 里创建 /home/user 污染仓库
 */
/**
 * 自建 Sandbox 实例（而非让 provider 内部创建），
 * 目的是在交给 provider 之前把真实工具（node/npm/git…）注册进去。
 * provider 支持 createJustBashSandbox({ sandbox }) 直接接收实例。
 */
async function buildAgent({ reqId, worktreesDir, instructions, skills, restore, phase = "impl" }) {
  const raw = await Sandbox.create({
    // ⚠️ posixVirtualFs：Windows 上 ReadWriteFs 会把宿主路径切出反斜杠形式的"虚拟路径"
    //    （\REQ-1\src\a.js），pi 用 path.posix 校验会判成越界工作区。详见 sandbox-path.mjs
    fs: posixVirtualFs(new ReadWriteFs({ root: worktreesDir })),
    cwd: "/",
    useDefaultLayout: false,
  });
  // 从该需求的 worktree 读 agent.config.json（随仓库带入），实现按项目白名单
  const toolCfg = registerTools(raw, worktreesDir, path.join(worktreesDir, reqId));
  // 常驻日志：桥接结果一眼可见，避免"配了却没生效"这类问题排查困难
  console.log(
    `[tools] ${reqId}/${phase} sandbox=[${toolCfg.tools.join(",")}] 来源=${toolCfg.source}`
  );

  const sandbox = wrapResumable(createJustBashSandbox({ sandbox: raw }));

  // Agent 工具层：按阶段限定 LLM 能调用哪些工具（与 sandbox 环境依赖是两层）
  const toolSettings = agentToolSettings(phase, path.join(worktreesDir, reqId));
  console.log(
    `[tools] ${reqId}/${phase} agent=[${toolSettings.builtinToolFiltering?.toolNames?.join(",") || "全部内建工具"}]`
  );

  return new HarnessAgent({
    harness: buildHarness(),
    sandbox,
    // 实现阶段把"当前系统 + 可用命令"告诉代理，否则它会写出跑不通的命令
    instructions: phase === "impl" ? instructions + envHint(toolCfg.tools) : instructions,
    ...toolSettings,
    ...(skills?.length ? { skills } : {}),
    sandboxConfig: {
      workDir: reqId, // → sessionWorkDir = /<reqId> ↔ 真实 <WORKTREES_DIR>/<reqId>
      onSession: async ({ session, sessionWorkDir }) => {
        // ⚠️ just-bash 的 run() 不注入 env，框架的 mkdir -p "$WORK_DIR" 会展开成空 → 必须字面量
        await session.run({ command: `mkdir -p ${shq(sessionWorkDir)}` });
        // 无状态：把上一轮的会话文件回填进这个全新 sandbox
        if (restore?.jsonl && restore?.sessionFileName) {
          const dir = `${sessionWorkDir}/.pi-sessions`;
          await session.run({ command: `mkdir -p ${shq(dir)}` });
          await session.writeTextFile({
            path: `${dir}/${restore.sessionFileName}`,
            content: restore.jsonl,
          });
        }
      },
    },
  });
}

/** harness-pi 把会话 jsonl 落在 host 临时目录，按 sessionId 分目录 */
function hostSessionDir(sessionId) {
  const safe = sessionId.replace(/[\\/: ]/g, "-");
  return path.join(tmpdir(), "ai-sdk-harness", "pi", safe, "sessions");
}

/** ⚠️ 必须在 stop() 之前调用：session 结束时 host 临时目录会被清理 */
async function grabJsonl(sessionId) {
  const dir = hostSessionDir(sessionId);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    if (!files.length) return null;
    let newest = null;
    for (const f of files) {
      const st = await stat(path.join(dir, f));
      if (!newest || st.mtimeMs > newest.m) newest = { f, m: st.mtimeMs };
    }
    return { jsonl: await readFile(path.join(dir, newest.f), "utf8"), sessionFileName: newest.f };
  } catch {
    return null;
  }
}

/**
 * 跑一轮（无状态：每次全新 sandbox，靠 jsonl 续接记忆）
 * @returns {{ text:string, tools:Array, files:Array }}
 */
export async function runTurn({ reqId, worktreesDir, sessionKey, prompt, instructions, skills = [], onEvent, phase = "impl" }) {
  if (!LITELLM_BASE_URL) throw new Error("未配置 LITELLM_BASE_URL");
  if (!worktreesDir) throw new Error("未配置 worktreesDir");

  const sessionId = `${reqId}--${sessionKey}`; // 分析与实现各自独立会话
  const saved = await loadSession(sessionId);

  const agent = await buildAgent({ reqId, worktreesDir, instructions, skills, restore: saved, phase });
  const session = await agent.createSession({
    sessionId,
    ...(saved?.resumeState ? { resumeFrom: saved.resumeState } : {}),
  });

  const out = { text: "", tools: [], files: [] };
  const emit = (e) => { try { onEvent?.(e); } catch { /* 推送失败不影响运行 */ } };
  try {
    const res = await agent.stream({ session, prompt });
    for await (const part of res.stream) {
      const e = mapStreamPart(part);
      if (!e) continue;
      if (e.type === "text") out.text += e.text;
      else if (e.type === "tool") out.tools.push({ n: e.n, a: e.a });
      else if (e.type === "file") {
        if (out.files.includes(e.path)) continue; // 同一文件反复改只记一次
        out.files.push(e.path);
      }
      emit(e);
    }
  } finally {
    // ⚠️ 顺序：先取 jsonl，再 stop
    const grabbed = await grabJsonl(sessionId);
    let resumeState = null;
    try {
      resumeState = await session.stop();
    } catch {
      /* 已结束 */
    }
    await saveSession(sessionId, {
      resumeState,
      jsonl: grabbed?.jsonl ?? saved?.jsonl ?? null,
      sessionFileName:
        grabbed?.sessionFileName ?? resumeState?.data?.sessionFileName ?? saved?.sessionFileName ?? null,
    });
  }
  return out;
}
