/**
 * 工单调度器
 *
 * 执行单位是「工单的 skill 链」：
 *   - 工单之间按依赖拓扑排序，先串行（共享同一 worktree，并发会互相踩文件）
 *   - 工单内部 implement → code-review → e2e 依次跑
 *   - skill 失败自动重试一次，重试时把上次失败原因作为上下文带进去
 *   - 工单 fail / blocked 时，下游依赖它的工单标成 waiting_dep，不再推进
 */
import { runTurn as defaultRunTurn } from "./harness.mjs";
import { getReq, saveReq, getProject } from "./store.mjs";
import { readArtifact, commitAll } from "./worktree.mjs";
import { IMPL_INSTRUCTIONS, SKILLS } from "./skills.mjs";

/** 解析 tickets.md：`- T-2 标题 [依赖 T-1, T-3]` */
export function parseTickets(md) {
  const out = [];
  for (const line of String(md || "").split("\n")) {
    const m = line.match(/^\s*-\s*(T-\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    let title = m[2];
    const deps = [];
    const dm = title.match(/[[［]\s*依赖[:：]?\s*([^\]］]+)[\]］]\s*$/);
    if (dm) {
      title = title.slice(0, dm.index).trim();
      for (const d of dm[1].split(/[,，、\s]+/)) {
        const id = d.trim().toUpperCase();
        if (/^T-\d+$/.test(id)) deps.push(id);
      }
    }
    out.push({
      ticket: m[1], title, deps,
      skills: SKILLS.map((s) => ({ name: s.name, state: "idle" })),
    });
  }
  return out;
}

/** 检测循环依赖，返回参与环的工单号（无环返回 []） */
export function findCycle(tickets) {
  const byId = new Map(tickets.map((t) => [t.ticket, t]));
  const state = new Map(); // 0未访问 1在栈 2完成
  const cycle = [];
  const visit = (id, path) => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) { cycle.push(...path.slice(path.indexOf(id)), id); return true; }
    state.set(id, 1);
    for (const d of byId.get(id)?.deps || []) {
      if (byId.has(d) && visit(d, [...path, id])) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const t of tickets) if (visit(t.ticket, [])) break;
  return cycle;
}

const isDone = (t) => t.skills.every((s) => s.state === "pass");
const isStuck = (t) => t.skills.some((s) => s.state === "fail" || s.state === "waiting");

/** 依赖是否全部完成 */
function depsReady(t, byId) {
  return (t.deps || []).every((d) => {
    const dep = byId.get(d);
    return !dep || isDone(dep);
  });
}

/** 依赖里有没有卡住的（卡住则本工单永远等不到） */
function depsBlocked(t, byId) {
  return (t.deps || []).some((d) => {
    const dep = byId.get(d);
    return dep && (isStuck(dep) || dep.blockedBy);
  });
}

/** 挑下一个可跑的工单 */
export function nextTicket(tickets) {
  const byId = new Map(tickets.map((t) => [t.ticket, t]));
  for (const t of tickets) {
    if (isDone(t) || isStuck(t)) continue;
    if (depsBlocked(t, byId)) continue;
    if (!depsReady(t, byId)) continue;
    return t;
  }
  return null;
}

/** 标记因依赖卡住而无法推进的工单 */
function markBlockedByDep(tickets) {
  const byId = new Map(tickets.map((t) => [t.ticket, t]));
  for (const t of tickets) {
    if (isDone(t) || isStuck(t)) { t.blockedBy = null; continue; }
    const bad = (t.deps || []).find((d) => {
      const dep = byId.get(d);
      return dep && (isStuck(dep) || dep.blockedBy);
    });
    t.blockedBy = bad || null;
  }
}

/* ── 运行态（内存中；重启后由 store 里的 skill 状态恢复视图）── */
const running = new Map(); // reqId → { subscribers:Set, stop:boolean, log:[] }

export const isRunning = (reqId) => running.has(reqId);

export function subscribe(reqId, fn) {
  const r = running.get(reqId);
  if (!r) return () => {};
  r.subscribers.add(fn);
  for (const e of r.log.slice(-200)) fn(e); // 补发近期事件，支持中途接入
  return () => r.subscribers.delete(fn);
}

export function stopRun(reqId) {
  const r = running.get(reqId);
  if (r) r.stop = true;
}

function broadcast(reqId, e) {
  const r = running.get(reqId);
  if (!r) return;
  r.log.push(e);
  if (r.log.length > 500) r.log.splice(0, r.log.length - 500);
  for (const fn of r.subscribers) { try { fn(e); } catch {} }
}

/** 跑一个 skill（含失败重试一次） */
async function runSkill({ req, project, ticket, step, extractVerdict, runTurn }) {
  const spec = (await readArtifact(project, req.id, "spec.feature")) || "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    step.state = "running";
    step.attempt = attempt;
    step.tools = [];
    step.files = [];
    // 计时：重试算作同一步的继续，累加而不是清零，否则"这步花了多久"会被少算
    step.startedAt = Date.now();
    if (attempt === 1) step.ms = 0;
    await saveReq(req);
    broadcast(req.id, { type: "step", ticket: ticket.ticket, skill: step.name, state: "running", attempt });

    const retryNote =
      attempt === 2 && step.lastFailure
        ? `\n\n上一次尝试没有通过，原因：${step.lastFailure}\n请针对这个原因修正，不要重复同样的做法。`
        : "";

    const out = await runTurn({
      reqId: req.id,
      worktreesDir: project.worktreesDir,
      // 每个工单独立会话：共用一个会话会让上下文随工单数线性累积，
      // 触发压缩后实施质量不可控。一个工单只承载自己那三步。
      sessionKey: `impl-${ticket.ticket}`,
      phase: "impl",
      instructions: IMPL_INSTRUCTIONS,
      skills: SKILLS,
      onEvent: (e) => broadcast(req.id, e),
      prompt: `使用 ${step.name} skill 处理工单 ${ticket.ticket}：${ticket.title}

规格：
${spec}

只做这个工单范围内的事。若必须改动范围外的对外接口，停下说明原因。${retryNote}`,
    });

    const v = extractVerdict(out.text);
    step.ms = (step.ms || 0) + (Date.now() - step.startedAt);
    step.startedAt = null;
    step.tools = out.tools.slice(0, 40);
    step.files = out.files;
    step.note = v.summary;
    step.verdictSource = v.structured ? "verdict" : "fallback";

    await commitAll(project, req.id, `${ticket.ticket} ${step.name}${attempt > 1 ? " (重试)" : ""}`);

    if (v.state === "pass") {
      step.state = "pass";
      step.detail = null;
      await saveReq(req);
      broadcast(req.id, { type: "step", ticket: ticket.ticket, skill: step.name, state: "pass" });
      return "pass";
    }

    // blocked 需要人来定，不重试
    if (v.state === "waiting") {
      step.state = "waiting";
      step.detail = v.clean.slice(0, 800);
      await saveReq(req);
      broadcast(req.id, { type: "step", ticket: ticket.ticket, skill: step.name, state: "waiting" });
      return "waiting";
    }

    // fail：第一次记录原因后重试，第二次仍失败则停
    step.lastFailure = v.summary || v.clean.slice(0, 200);
    if (attempt === 1) {
      broadcast(req.id, { type: "retry", ticket: ticket.ticket, skill: step.name, reason: step.lastFailure });
      continue;
    }
    step.state = "fail";
    step.detail = v.clean.slice(0, 800);
    await saveReq(req);
    broadcast(req.id, { type: "step", ticket: ticket.ticket, skill: step.name, state: "fail" });
    return "fail";
  }
}

/**
 * 启动一个需求的自动推进（后台运行，不占用 HTTP 请求）
 * 已在跑则忽略。
 */
export function startRun(reqId, extractVerdict, { runTurn = defaultRunTurn } = {}) {
  if (running.has(reqId)) return false;
  running.set(reqId, { subscribers: new Set(), stop: false, log: [] });

  (async () => {
    try {
      for (;;) {
        const req = await getReq(reqId);
        if (!req) break;
        const project = await getProject(req.projectId);
        if (!project) throw new Error(`需求 ${reqId} 找不到所属项目 ${req.projectId}`);
        if (running.get(reqId)?.stop) {
          broadcast(reqId, { type: "run", state: "stopped" });
          break;
        }

        markBlockedByDep(req.tickets);
        await saveReq(req);

        const t = nextTicket(req.tickets);
        if (!t) {
          const allDone = req.tickets.length > 0 && req.tickets.every(isDone);
          if (allDone) req.phase = "done";
          await saveReq(req);
          broadcast(reqId, { type: "run", state: allDone ? "done" : "halted", req });
          break;
        }

        broadcast(reqId, { type: "ticket", ticket: t.ticket, state: "running" });

        let halted = false;
        for (const step of t.skills) {
          if (step.state === "pass") continue;
          if (running.get(reqId)?.stop) { halted = true; break; }
          const r = await runSkill({ req, project, ticket: t, step, extractVerdict, runTurn });
          if (r !== "pass") { halted = true; break; }
        }

        if (halted) {
          const fresh = await getReq(reqId);
          markBlockedByDep(fresh.tickets);
          await saveReq(fresh);
          broadcast(reqId, { type: "run", state: "halted", req: fresh });
          break;
        }
      }
    } catch (e) {
      console.error(`[run ${reqId}]`, e);
      broadcast(reqId, { type: "run", state: "error", message: e.message });
    } finally {
      const r = running.get(reqId);
      running.delete(reqId);
      if (r) for (const fn of r.subscribers) { try { fn({ type: "closed" }); } catch {} }
    }
  })();

  return true;
}
