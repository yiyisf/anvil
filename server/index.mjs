/**
 * API 服务器（草稿版：非流式，一轮一个 JSON 响应）
 * 启动：node server/index.mjs   默认 :8787
 */
import http from "node:http";
import { runTurn } from "./harness.mjs";
import {
  listReqs, getReq, saveReq, newReq, clearSession, clearSessions,
  listProjects, getProject, saveProject, newProject,
} from "./store.mjs";
import {
  ensureWorktree, resetWorktree, writeArtifact, readArtifact,
  changedFiles, commitAll, treePath,
} from "./worktree.mjs";
import {
  ANALYST_INSTRUCTIONS, SPEC_INSTRUCTIONS, IMPL_INSTRUCTIONS, SKILLS,
} from "./skills.mjs";
import {
  startRun, stopRun, subscribe, isRunning, parseTickets, findCycle,
} from "./runner.mjs";
import { resolveToolConfig } from "./tools.mjs";

const PORT = Number(process.env.PORT || 8787);

/** 需求归属项目未找到时统一报错，避免各路由各写一遍 */
async function requireProject(req) {
  const project = await getProject(req.projectId);
  if (!project) throw new Error(`需求 ${req.id} 找不到所属项目 ${req.projectId}`);
  return project;
}

/**
 * 首次启动迁移：若还没有任何项目，但 .env 里配了旧的单仓库变量，
 * 自动建一个"默认项目"，并把没有 projectId 的旧需求都挂上去，避免升级丢数据。
 */
async function migrateLegacyProject() {
  const projects = await listProjects();
  if (projects.length) return;
  const { REPO_PATH, WORKTREES_DIR, BASE_BRANCH } = process.env;
  if (!REPO_PATH || !WORKTREES_DIR) return;

  const project = newProject({
    name: "默认项目",
    repoPath: REPO_PATH,
    worktreesDir: WORKTREES_DIR,
    baseBranch: BASE_BRANCH || "",
  });
  await saveProject(project);
  console.log(`[migrate] 创建默认项目 ${project.id}（repoPath=${REPO_PATH}）`);

  const reqs = await listReqs();
  for (const r of reqs) {
    if (!r.projectId) {
      r.projectId = project.id;
      await saveReq(r);
    }
  }
}

/* 从模型回复里抽出 SETTLED 汇报行 */
function extractSettled(text) {
  const m = text.match(/SETTLED:\s*(\{[\s\S]*?\})\s*$/m);
  if (!m) return { clean: text, delta: null };
  try {
    return { clean: text.replace(m[0], "").trim(), delta: JSON.parse(m[1]) };
  } catch {
    return { clean: text.replace(m[0], "").trim(), delta: null };
  }
}

function mergeSettled(cur, delta) {
  if (!delta) return cur;
  const fixed = [...cur.fixed];
  for (const it of delta.fixed || []) {
    const i = fixed.findIndex((x) => x.k === it.k);
    if (i >= 0) fixed[i] = it; else fixed.push(it);
  }
  const fixedKeys = new Set(fixed.map((x) => x.k));
  const open = (delta.open || []).filter((x) => !fixedKeys.has(x.k));
  return { fixed, open };
}

/**
 * 解析 skill 的结构化结论。
 * 优先读 VERDICT: {...} 那一行；解析不到才退回关键词匹配（不可靠，仅兜底）。
 * 返回 { state:'pass'|'fail'|'waiting', summary, clean }
 */
function extractVerdict(text) {
  const m = text.match(/^VERDICT:\s*(\{[\s\S]*?\})\s*$/m);
  if (m) {
    try {
      const v = JSON.parse(m[1]);
      const map = { pass: "pass", fail: "fail", blocked: "waiting" };
      const state = map[v.state];
      if (state) {
        return {
          state,
          summary: String(v.summary || "").slice(0, 300),
          clean: text.replace(m[0], "").trim(),
          structured: true,
        };
      }
    } catch { /* 落到兜底 */ }
  }
  // 兜底：关键词匹配。模型没按协议输出时才走这里，会误判，仅作最后防线。
  const state = /超出范围|需要确认|无法继续|停下等/.test(text)
    ? "waiting"
    : /未通过|不通过|失败|测试挂/.test(text)
      ? "fail"
      : "pass";
  return { state, summary: text.slice(0, 160), clean: text, structured: false };
}

const FAILURE_REASONS = new Set(["unclear_requirement", "implementation", "environment"]);

const routes = {
  "GET /api/projects": async () => listProjects(),

  "POST /api/projects": async ({ body }) => {
    const project = newProject({
      name: body.name?.trim() || "未命名项目",
      repoPath: body.repoPath?.trim(),
      worktreesDir: body.worktreesDir?.trim(),
      baseBranch: body.baseBranch?.trim() || "",
    });
    if (!project.repoPath || !project.worktreesDir) {
      return { error: "repoPath 和 worktreesDir 必填" };
    }
    return saveProject(project);
  },

  "GET /api/projects/:id": async ({ q }) => {
    const project = await getProject(q.id);
    if (!project) return { error: "not found" };
    return project;
  },

  "GET /api/reqs": async () => listReqs(),

  "POST /api/reqs": async ({ body }) => {
    const project = await getProject(body.projectId);
    if (!project) return { error: "项目不存在" };
    const req = newReq(body.title?.trim() || "未命名需求", project.id);
    await ensureWorktree(project, req.id);
    return saveReq(req);
  },

  "GET /api/req": async ({ q }) => {
    const req = await getReq(q.id);
    if (!req) return { error: "not found" };
    const project = await getProject(req.projectId);
    return {
      ...req,
      changed: project ? await changedFiles(project, req.id) : [],
      tree: project ? treePath(project, req.id) : null,
      running: isRunning(req.id),
    };
  },

  /* 移交：生成规格与工单写入 worktree，切到实现阶段 */
  "POST /api/handoff": async ({ q }) => {
    const req = await getReq(q.id);
    if (!req) return { error: "not found" };
    const project = await requireProject(req);

    const summary = req.settled.fixed.map((x) => `- ${x.k}：${x.v}`).join("\n");
    const out = await runTurn({
      reqId: req.id,
      worktreesDir: project.worktreesDir,
      sessionKey: "analysis",
      phase: "spec", // 需要写 spec.feature / tickets.md，故比分析阶段多 write/edit
      prompt: `${SPEC_INSTRUCTIONS}\n\n已确定的需求条目：\n${summary}`,
      instructions: ANALYST_INSTRUCTIONS,
    });

    // 模型未写文件时兜底，保证 worktree 里一定有规格
    if (!(await readArtifact(project, req.id, "spec.feature"))) {
      await writeArtifact(project, req.id, "spec.feature", `功能：${req.title}\n\n${summary}\n`);
    }
    const ticketsMd = (await readArtifact(project, req.id, "tickets.md")) || `- T-1 实现${req.title}`;
    req.tickets = parseTickets(ticketsMd);
    if (!req.tickets.length) {
      req.tickets = parseTickets(`- T-1 ${req.title}`);
    }
    const cycle = findCycle(req.tickets);
    if (cycle.length) {
      // 依赖成环会让调度永远选不出工单，直接降级为无依赖，并告知用户
      for (const t of req.tickets) t.deps = [];
      req.warning = `工单依赖存在循环（${cycle.join(" → ")}），已忽略全部依赖，请检查 .agent/tickets.md`;
    }

    req.phase = "impl";
    req.handoffNote = out.text.slice(0, 400);
    await commitAll(project, req.id, `分析产物：${req.title}`);
    await saveReq(req);
    startRun(req.id, extractVerdict); // 移交后自动推进
    return req;
  },

  /* 实现阶段对话 */
  "POST /api/impl-message": async ({ q, body }) => {
    const req = await getReq(q.id);
    if (!req) return { error: "not found" };
    const project = await requireProject(req);
    req.implChat.push({ role: "user", text: body.text });
    // 会话已按工单拆分：把人的介入送进"当前正在处理/最近处理"的那个工单会话，
    // 否则代理没有刚才那段工作的上下文，回答会不着边际。
    const cur =
      req.tickets?.find((t) => t.skills.some((s) => s.state === "running")) ||
      req.tickets?.find((t) => t.skills.some((s) => s.state === "fail" || s.state === "waiting")) ||
      req.tickets?.slice().reverse().find((t) => t.skills.some((s) => s.state !== "idle")) ||
      req.tickets?.[0];
    const out = await runTurn({
      reqId: req.id,
      worktreesDir: project.worktreesDir,
      sessionKey: cur ? `impl-${cur.ticket}` : "impl",
      phase: "impl",
      instructions: IMPL_INSTRUCTIONS, skills: SKILLS, prompt: body.text,
    });
    req.implChat.push({ role: "assistant", text: extractVerdict(out.text).clean });
    await saveReq(req);
    return req;
  },

  /* 需求条目直接编辑 */
  "POST /api/settled": async ({ q, body }) => {
    const req = await getReq(q.id);
    if (!req) return { error: "not found" };
    req.settled = body.settled;
    await saveReq(req);
    return req;
  },

  /* 启动自动推进（幂等：已在跑则忽略）*/
  "POST /api/start": async ({ q }) => {
    const req = await getReq(q.id);
    if (!req) return { error: "not found" };
    const started = startRun(req.id, extractVerdict);
    return { ...req, running: true, started };
  },

  /* 暂停自动推进（当前 skill 跑完后停）*/
  "POST /api/stop": async ({ q }) => {
    stopRun(q.id);
    return { stopping: true };
  },

  /* 作废重跑：销毁 worktree 与分支后重建，清空运行记录与实现会话 */
  "POST /api/invalidate": async ({ q, body }) => {
    const req = await getReq(q.id);
    if (!req) return { error: "not found" };
    const project = await requireProject(req);
    await resetWorktree(project, req.id);
    await clearSessions(`${req.id}--impl`); // 会话已按工单拆分，需批量清理
    req.tickets = [];
    req.implChat = [];
    req.everReset = true; // 记为经历过重跑，纳入一次通过率统计时排除
    req.phase = body.backToAnalysis ? "analysis" : "impl";
    // 回分析阶段时保留对话与已定条目，方便补边界后重新移交
    await saveReq(req);
    return req;
  },

  /**
   * 重跑单个 step：不销毁 worktree/分支，只重置该 step（及同工单内其后已 pass 的
   * step，因为它们依赖前序改动）为 idle，并清该工单的会话。
   */
  "POST /api/step-reset": async ({ q, body }) => {
    const req = await getReq(q.id);
    if (!req) return { error: "not found" };
    const t = req.tickets?.find((x) => x.ticket === body.ticket);
    if (!t) return { error: "工单不存在" };
    const idx = t.skills.findIndex((s) => s.name === body.skillName);
    if (idx < 0) return { error: "step 不存在" };

    for (let i = idx; i < t.skills.length; i++) {
      t.skills[i] = { name: t.skills[i].name, state: "idle" };
    }
    t.blockedBy = null;
    req.everReset = true;
    await clearSessions(`${req.id}--impl-${t.ticket}`);
    await saveReq(req);
    return req;
  },

  /**
   * 重跑单个工单：把该工单的 skills 整体重置为初始态，只清该工单会话，
   * 不动其它工单、不动 worktree/分支。
   * 已知限制：该工单此前的 git 改动仍留在分支历史里（工单间共享同一 worktree、
   * 线性 commit），重跑会在其基础上叠加新 commit，而不是真正回滚到工单开始前的状态。
   */
  "POST /api/ticket-reset": async ({ q, body }) => {
    const req = await getReq(q.id);
    if (!req) return { error: "not found" };
    const t = req.tickets?.find((x) => x.ticket === body.ticket);
    if (!t) return { error: "工单不存在" };

    t.skills = SKILLS.map((s) => ({ name: s.name, state: "idle" }));
    t.blockedBy = null;
    req.everReset = true;
    await clearSessions(`${req.id}--impl-${t.ticket}`);
    await saveReq(req);
    return req;
  },

  /* 一次通过率归因：需求非一次通过时人工标注原因 */
  "POST /api/reqs/:id/failure-reason": async ({ q, body }) => {
    const req = await getReq(q.id);
    if (!req) return { error: "not found" };
    if (!FAILURE_REASONS.has(body.reason)) return { error: "非法 reason" };
    req.failureReason = body.reason;
    await saveReq(req);
    return req;
  },
};

/**
 * 流式路由：响应为 NDJSON（每行一个 JSON 事件），最后一行是 {type:"done", req}
 * 事件： {type:"text"|"reasoning", text} | {type:"tool", n, a} | {type:"file", path}
 */
const streamRoutes = {
  /* 分析阶段：一轮对话 */
  "POST /api/message": async ({ q, body, emit }) => {
    const req = await getReq(q.id);
    if (!req) throw new Error("需求不存在");
    const project = await requireProject(req);
    req.dialog.push({ role: "user", text: body.text });

    const out = await runTurn({
      reqId: req.id, worktreesDir: project.worktreesDir, sessionKey: "analysis", phase: "analysis",
      prompt: body.text, instructions: ANALYST_INSTRUCTIONS,
      onEvent: emit,
    });

    const { clean, delta } = extractSettled(out.text);
    req.settled = mergeSettled(req.settled, delta);
    req.dialog.push({ role: "assistant", text: clean });
    await saveReq(req);
    return req;
  },

  /* 实现阶段：跑指定工单的下一个 skill */
  "POST /api/run": async ({ q, body, emit }) => {
    const req = await getReq(q.id);
    if (!req) throw new Error("需求不存在");
    const project = await requireProject(req);
    const t = req.tickets.find((x) => x.ticket === body.ticket) || req.tickets[0];
    if (!t) throw new Error("没有工单");
    const step = t.skills.find((s) => s.state === "idle" || s.state === "running");
    if (!step) return req;

    step.state = "running";
    step.tools = [];
    step.files = [];
    await saveReq(req);
    emit({ type: "step", ticket: t.ticket, skill: step.name, state: "running" });

    const spec = (await readArtifact(project, req.id, "spec.feature")) || "";
    const out = await runTurn({
      reqId: req.id, worktreesDir: project.worktreesDir, sessionKey: `impl-${t.ticket}`, phase: "impl",
      instructions: IMPL_INSTRUCTIONS, skills: SKILLS, onEvent: emit,
      prompt: `使用 ${step.name} skill 处理工单 ${t.ticket}：${t.title}

规格：
${spec}

只做这个工单范围内的事。若必须改动范围外的对外接口，停下说明原因。`,
    });

    const v = extractVerdict(out.text);
    step.tools = out.tools.slice(0, 40);
    step.files = out.files;
    step.state = v.state;
    step.note = v.summary;
    step.verdictSource = v.structured ? "verdict" : "fallback";
    if (v.state !== "pass") step.detail = v.clean.slice(0, 800);
    if (!v.structured) {
      console.warn(`[run] ${t.ticket}/${step.name} 未按协议输出 VERDICT，已退回关键词判定`);
    }

    await commitAll(project, req.id, `${t.ticket} ${step.name}`);
    await saveReq(req);
    return req;
  },
};

/**
 * 订阅某需求的运行事件（NDJSON 长连接）
 * 与流式路由不同：这是 GET、可随时接入、断线可重连，
 * 后台运行不因为客户端断开而中断。
 */
function handleEvents(rq, rs, reqId) {
  rs.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    "connection": "keep-alive",
  });
  const write = (e) => { if (!rs.writableEnded) rs.write(JSON.stringify(e) + "\n"); };

  if (!isRunning(reqId)) {
    write({ type: "run", state: "idle" });
    return rs.end();
  }
  const unsub = subscribe(reqId, (e) => {
    write(e);
    if (e.type === "closed") { unsub(); rs.end(); }
  });
  // 心跳，避免中间层掐断空闲连接
  const hb = setInterval(() => write({ type: "ping" }), 20000);
  rq.on("close", () => { clearInterval(hb); unsub(); });
  rs.on("close", () => { clearInterval(hb); unsub(); });
}

/** 路径带 :id 这种占位符的路由需要单独匹配 */
function matchParamRoute(table, method, pathname) {
  for (const key of Object.keys(table)) {
    const [m, pat] = key.split(" ");
    if (m !== method || !pat.includes(":")) continue;
    const re = new RegExp("^" + pat.replace(/:[^/]+/g, "([^/]+)") + "$");
    const mm = pathname.match(re);
    if (mm) return { handler: table[key], params: mm.slice(1) };
  }
  return null;
}

const server = http.createServer(async (rq, rs) => {
  const url = new URL(rq.url, "http://x");
  const key = `${rq.method} ${url.pathname}`;
  if (key === "GET /api/events") {
    rs.setHeader("Access-Control-Allow-Origin", "*");
    return handleEvents(rq, rs, url.searchParams.get("id"));
  }

  let handler = routes[key];
  const streamHandler = streamRoutes[key];
  let paramId = null;
  if (!handler && !streamHandler) {
    const m = matchParamRoute(routes, rq.method, url.pathname);
    if (m) { handler = m.handler; paramId = m.params[0]; }
  }
  rs.setHeader("Access-Control-Allow-Origin", "*");
  rs.setHeader("Access-Control-Allow-Headers", "content-type");
  if (rq.method === "OPTIONS") return rs.writeHead(204).end();
  if (!handler && !streamHandler) return rs.writeHead(404).end("not found");

  try {
    let body = {};
    if (rq.method === "POST") {
      const chunks = [];
      for await (const c of rq) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw ? JSON.parse(raw) : {};
    }
    const q = Object.fromEntries(url.searchParams);
    if (paramId) q.id = paramId;

    if (streamHandler) {
      rs.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
      const emit = (e) => { if (!rs.writableEnded) rs.write(JSON.stringify(e) + "\n"); };
      try {
        const req = await streamHandler({ body, q, emit });
        emit({ type: "done", req });
      } catch (e) {
        console.error(`[${key}]`, e);
        emit({ type: "error", message: e.message });
      }
      return rs.end();
    }

    const data = await handler({ body, q });
    rs.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    rs.end(JSON.stringify(data));
  } catch (e) {
    console.error(`[${key}]`, e);
    rs.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    rs.end(JSON.stringify({ error: e.message }));
  }
});

migrateLegacyProject()
  .catch((e) => console.error("[migrate]", e))
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`API  http://localhost:${PORT}`);
      console.log(`模型 ${process.env.PI_MODEL} via ${process.env.LITELLM_BASE_URL}`);
      const c = resolveToolConfig();
      console.log(`默认 sandbox 工具 [${c.tools.join(",")}]（来源 ${c.source}；项目 agent.config.json 会覆盖）`);
      console.log(`排查工具链问题：node --env-file=.env doctor.mjs`);
    });
  });
