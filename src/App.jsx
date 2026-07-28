import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ChevronRight, ChevronDown, Check, Terminal, FileText, CornerDownLeft,
  Loader2, AlertCircle, ArrowRight, RotateCcw, Pencil, MessageSquare, Plus, Play,
  FolderGit2, ChevronsUpDown,
} from "lucide-react";

const api = {
  list: () => fetch("/api/reqs").then((r) => r.json()),
  get: (id) => fetch(`/api/req?id=${id}`).then((r) => r.json()),
  create: (title, projectId) => post("/api/reqs", { title, projectId }),
  message: (id, text, onEvent) => streamPost(`/api/message?id=${id}`, { text }, onEvent),
  implMessage: (id, text) => post(`/api/impl-message?id=${id}`, { text }),
  handoff: (id, onEvent) => streamPost(`/api/handoff?id=${id}`, {}, onEvent),
  run: (id, ticket, onEvent) => streamPost(`/api/run?id=${id}`, { ticket }, onEvent),
  settled: (id, settled) => post(`/api/settled?id=${id}`, { settled }),
  invalidate: (id, backToAnalysis) => post(`/api/invalidate?id=${id}`, { backToAnalysis }),
  start: (id) => post(`/api/start?id=${id}`, {}),
  stop: (id) => post(`/api/stop?id=${id}`, {}),
  stepReset: (id, ticket, skillName) => post(`/api/step-reset?id=${id}`, { ticket, skillName }),
  ticketReset: (id, ticket) => post(`/api/ticket-reset?id=${id}`, { ticket }),
  failureReason: (id, reason) => post(`/api/reqs/${id}/failure-reason`, { reason }),
  projects: {
    list: () => fetch("/api/projects").then((r) => r.json()),
    create: (p) => post("/api/projects", p),
  },
};
/** 消费 NDJSON 流：逐行回调事件，返回最终 req */
async function streamPost(url, body, onEvent) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", final = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "done") final = e.req;
      else if (e.type === "error") throw new Error(e.message);
      else onEvent?.(e);
    }
  }
  return final;
}

const post = (u, b) =>
  fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })
    .then((r) => r.json());

/** 流式显示时隐藏协议行（SETTLED / VERDICT），避免出现半截 JSON */
function stripProtocol(t) {
  return String(t || "")
    .replace(/^(SETTLED|VERDICT):[\s\S]*$/m, "")
    .trimEnd();
}

/** 订阅某需求的运行事件；返回取消函数 */
function subscribeRun(id, onEvent, onEnd) {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(`/api/events?id=${id}`, { signal: ctrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            if (e.type === "ping") continue;
            onEvent(e);
          } catch { /* 忽略坏行 */ }
        }
      }
    } catch { /* 中断或断线 */ }
    onEnd?.();
  })();
  return () => ctrl.abort();
}

/**
 * 当前选中的需求放进地址栏（?id=REQ-XXXXX）
 *
 * 之前只存在 React state 里，F5 之后回到「选择或新建一个需求」，
 * 分析已经做完、只差点「生成规格并移交实现」的时候尤其难受 ——
 * 看起来像按钮消失了、进度丢了。放进 URL 后刷新与分享链接都能回到原处。
 *
 * 用 replaceState 而不是 pushState：切需求不算一次页面跳转，
 * 不该让「后退」变成在需求之间倒着翻。
 */
const idFromUrl = () => new URLSearchParams(window.location.search).get("id");

function writeIdToUrl(id) {
  const u = new URL(window.location.href);
  if (id) u.searchParams.set("id", id);
  else u.searchParams.delete("id");
  if (u.href !== window.location.href) window.history.replaceState(null, "", u);
}

/** 耗时显示：秒以内不值得看，超过一分钟按 m/s 拆开 */
function fmtMs(ms) {
  if (!ms || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * 运行中的秒表。
 * 不用服务端的 startedAt 是因为两边时钟未必一致，跨机器会算出负数或几小时。
 * 这里从"前端看到它开始跑"起算，只用于运行中的即时反馈；
 * 落库统计的仍是服务端测的 step.ms。
 */
function useElapsed(active) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const t0 = Date.now();
    setMs(0);
    const id = setInterval(() => setMs(Date.now() - t0), 1000);
    return () => clearInterval(id);
  }, [active]);
  return ms;
}

/** 一次通过：全部完成、没重跑过、每步第一次尝试就 pass */
function isOnePass(r) {
  if (r.phase !== "done" || r.everReset) return false;
  const skills = (r.tickets || []).flatMap((t) => t.skills);
  return skills.length > 0 && skills.every((s) => s.state === "pass" && (s.attempt || 1) === 1);
}

/** 本周（周一至今）需求的一次通过统计 */
function weeklyPassStats(reqs) {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const weekReqs = reqs.filter((r) => new Date(r.createdAt) >= monday);
  return { total: weekReqs.length, onePass: weekReqs.filter(isOnePass).length };
}

export default function App() {
  const [reqs, setReqs] = useState([]);
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [activeId, setActiveId] = useState(idFromUrl);
  const [req, setReq] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [live, setLive] = useState(null); // 本轮流式内容 {text, tools, files}
  const [retryNote, setRetryNote] = useState(null);
  /**
   * 乐观回显：刚发出、服务端还没回执的那条用户消息 {reqId, text}
   *
   * 服务端确实在开跑前就把这条消息 push 进了 dialog，但整个 req 要等本轮跑完
   * 才随 done 事件回来（流中途只有 text/tool/file 增量）。所以不本地回显的话，
   * 用户发完消息会看着自己那句话消失，直到代理答完才突然冒出来。
   * 由 act() 统一清除：成功时服务端返回的 dialog 已包含它，失败时它没被持久化。
   */
  const [pending, setPending] = useState(null);
  // 带 reqId 是因为发送期间可以切换需求，不能把回显串到别的需求上
  const pendingFor = (id) => (pending?.reqId === id ? pending.text : null);
  const send = (id, text, call) => { setPending({ reqId: id, text }); act(call); };

  const onEvent = useCallback((e) => {
    setLive((cur) => {
      const s0 = cur || { text: "", tools: [], files: [] };
      if (e.type === "text") return { ...s0, text: s0.text + e.text };
      if (e.type === "tool") return { ...s0, tools: [...s0.tools, { n: e.n, a: e.a }] };
      if (e.type === "file")
        return s0.files.includes(e.path) ? s0 : { ...s0, files: [...s0.files, e.path] };
      if (e.type === "stage") return { ...s0, stages: [...(s0.stages || []), e.text] };
      if (e.type === "step") return { text: "", tools: [], files: [], step: e.skill };
      return s0;
    });
  }, []);

  const refreshList = useCallback(async () => setReqs(await api.list()), []);
  useEffect(() => { refreshList(); }, [refreshList]);
  useEffect(() => {
    api.projects.list().then((ps) => {
      setProjects(ps);
      if (ps.length && !activeProjectId) setActiveProjectId(ps[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    writeIdToUrl(activeId);
    if (!activeId) return setReq(null);
    api.get(activeId).then((r) => {
      // URL 里的 id 可能已经不存在（需求被删、换了机器）。不挡掉的话
      // setReq({error}) 会让下面按 req.settled 取值时整页白屏。
      if (!r || r.error) return setActiveId(null);
      setReq(r);
      // 需求未必属于当前选中的项目（从 URL 恢复时尤其如此），跟过去，
      // 否则侧栏按项目过滤会把它藏起来，看着像没选中
      if (r.projectId) setActiveProjectId(r.projectId);
    });
  }, [activeId]);

  // 运行中订阅事件流：实时刷新 live 与需求状态
  useEffect(() => {
    if (!req?.running) return;
    const off = subscribeRun(
      req.id,
      (e) => {
        if (e.type === "run" || e.type === "closed") {
          api.get(req.id).then(setReq);
          setLive(null);
          if (e.type === "run" && e.state === "error") setErr(e.message);
        } else if (e.type === "ticket") {
          setLive(null);
        } else if (e.type === "step") {
          setLive({ text: "", tools: [], files: [], step: e.skill, attempt: e.attempt });
          api.get(req.id).then(setReq);
        } else if (e.type === "retry") {
          setRetryNote(`${e.ticket} ${e.skill} 未通过，正在重试一次：${e.reason || ""}`);
        } else {
          onEvent(e);
        }
      },
      () => api.get(req.id).then(setReq)
    );
    return off;
  }, [req?.running, req?.id, onEvent]);

  async function act(fn) {
    setBusy(true); setErr(null); setLive(null);
    try {
      const next = await fn();
      if (next?.error) setErr(next.error);
      else { setReq(next); refreshList(); }
    } catch (e) { setErr(e.message); }
    // 与 setReq 同一批更新里清除，回显不会闪一下
    setBusy(false); setLive(null); setPending(null);
  }

  const visibleReqs = showAllProjects
    ? reqs
    : reqs.filter((r) => !activeProjectId || r.projectId === activeProjectId);

  return (
    <div className="flex h-screen w-full bg-white text-sm text-neutral-900 antialiased">
      <Sidebar
        reqs={visibleReqs} allReqs={reqs} activeId={activeId} onPick={setActiveId}
        projects={projects} activeProjectId={activeProjectId} onProjectChange={setActiveProjectId}
        showAllProjects={showAllProjects} onToggleShowAll={() => setShowAllProjects((v) => !v)}
        onCreateProject={async (p) => {
          const created = await api.projects.create(p);
          if (!created?.error) {
            const ps = await api.projects.list();
            setProjects(ps);
            setActiveProjectId(created.id);
          }
          return created;
        }}
        onCreate={async (title) => {
          if (!activeProjectId) return;
          const r = await api.create(title, activeProjectId);
          await refreshList(); setActiveId(r.id);
        }}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {!req ? (
          <div className="flex flex-1 items-center justify-center text-neutral-500">
            选择或新建一个需求
          </div>
        ) : (
          <>
            <PhaseHeader req={req} busy={busy} onInvalidate={(back) => act(() => api.invalidate(req.id, back))} />
            {err && (
              <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700">{err}</div>
            )}
            {req.phase === "analysis" ? (
              <Analysis
                req={req} busy={busy} live={live} pending={pendingFor(req.id)}
                onSend={(t) => send(req.id, t, () => api.message(req.id, t, onEvent))}
                onEdit={(s) => act(() => api.settled(req.id, s))}
                onHandoff={() => act(() => api.handoff(req.id, onEvent))}
              />
            ) : (
              <Implementation
                req={req} busy={busy} live={live} retryNote={retryNote} pending={pendingFor(req.id)}
                onStart={() => act(async () => { const r = await api.start(req.id); setRetryNote(null); return r; })}
                onStop={() => api.stop(req.id).then(() => api.get(req.id).then(setReq))}
                onRun={(ticket) => act(() => api.run(req.id, ticket, onEvent))}
                onSend={(t) => send(req.id, t, () => api.implMessage(req.id, t))}
                onInvalidate={(back) => act(() => api.invalidate(req.id, back))}
                onStepReset={(ticket, skillName) => act(() => api.stepReset(req.id, ticket, skillName))}
                onTicketReset={(ticket) => act(() => api.ticketReset(req.id, ticket))}
                onFailureReason={(reason) => act(() => api.failureReason(req.id, reason))}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

/* ── 左栏 ─────────────────────────────────────── */
function Sidebar({
  reqs, allReqs, activeId, onPick,
  projects, activeProjectId, onProjectChange, showAllProjects, onToggleShowAll, onCreateProject,
  onCreate,
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const stats = weeklyPassStats(showAllProjects ? allReqs : reqs);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200">
      <div className="relative flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 px-4">
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-neutral-50"
        >
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <span className="truncate font-medium">{activeProject?.name || "选择项目"}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-neutral-400" />
        </button>
        <button onClick={() => setAdding(true)} className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900" title="新建需求">
          <Plus className="h-4 w-4" />
        </button>

        {pickerOpen && (
          <div className="absolute left-0 top-12 z-10 w-72 rounded-md border border-neutral-200 bg-white p-1.5 shadow-lg">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => { onProjectChange(p.id); setPickerOpen(false); }}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
                  p.id === activeProjectId ? "bg-neutral-100" : "hover:bg-neutral-50"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.id === activeProjectId && <Check className="h-3 w-3 shrink-0 text-emerald-600" />}
              </button>
            ))}
            {projects.length === 0 && <p className="px-2 py-1.5 text-xs text-neutral-500">还没有项目</p>}
            <div className="my-1 border-t border-neutral-200" />
            <label className="flex items-center gap-2 px-2 py-1.5 text-xs text-neutral-600">
              <input type="checkbox" checked={showAllProjects} onChange={onToggleShowAll} />
              显示全部项目的需求
            </label>
            <button
              onClick={() => { setCreatingProject(true); setPickerOpen(false); }}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-neutral-600 hover:bg-neutral-50"
            >
              <Plus className="h-3 w-3" /> 新建项目
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-b border-neutral-200 px-4 py-2 text-xs text-neutral-500">
        本周 {stats.total} 个需求，{stats.onePass} 个一次通过
      </div>

      {creatingProject && (
        <NewProjectForm onCancel={() => setCreatingProject(false)} onCreate={async (p) => {
          const created = await onCreateProject(p);
          if (!created?.error) setCreatingProject(false);
          return created;
        }} />
      )}

      {adding && (
        <div className="shrink-0 border-b border-neutral-200 p-3">
          <input
            autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && title.trim()) { onCreate(title.trim()); setTitle(""); setAdding(false); }
              if (e.key === "Escape") setAdding(false);
            }}
            onBlur={() => setAdding(false)}
            placeholder="需求标题，回车创建"
            className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 outline-none placeholder:text-neutral-400"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3">
        {reqs.length === 0 && <p className="px-1 text-xs text-neutral-500">还没有需求。</p>}
        <div className="space-y-0.5">
          {reqs.map((r) => (
            <button
              key={r.id} onClick={() => onPick(r.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left ${
                activeId === r.id ? "bg-neutral-100" : "hover:bg-neutral-50"
              }`}
            >
              <span className="flex-1 truncate">{r.title}</span>
              {showAllProjects && r.projectId !== activeProjectId && (
                <span className="shrink-0 truncate text-xs text-neutral-400">
                  {projects.find((p) => p.id === r.projectId)?.name || ""}
                </span>
              )}
              <PhaseTag phase={r.phase} />
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

function NewProjectForm({ onCreate, onCancel }) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [worktreesDir, setWorktreesDir] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [error, setError] = useState(null);

  async function submit() {
    setError(null);
    const created = await onCreate({ name: name.trim(), repoPath: repoPath.trim(), worktreesDir: worktreesDir.trim(), baseBranch: baseBranch.trim() });
    if (created?.error) setError(created.error);
  }

  return (
    <div className="shrink-0 space-y-1.5 border-b border-neutral-200 p-3">
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="项目名称"
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs outline-none placeholder:text-neutral-400" />
      <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="仓库路径 repoPath"
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs outline-none placeholder:text-neutral-400" />
      <input value={worktreesDir} onChange={(e) => setWorktreesDir(e.target.value)} placeholder="worktree 目录 worktreesDir"
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs outline-none placeholder:text-neutral-400" />
      <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="基线分支（可留空）"
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs outline-none placeholder:text-neutral-400" />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-1.5 pt-0.5">
        <button onClick={submit} disabled={!name.trim() || !repoPath.trim() || !worktreesDir.trim()}
          className="flex-1 rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-30">
          创建
        </button>
        <button onClick={onCancel} className="rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50">
          取消
        </button>
      </div>
    </div>
  );
}

function PhaseTag({ phase }) {
  const map = {
    analysis: ["分析", "bg-neutral-100 text-neutral-600"],
    impl: ["实现", "bg-blue-50 text-blue-700"],
    done: ["完成", "bg-neutral-50 text-neutral-400"],
  };
  const [label, cls] = map[phase] || map.analysis;
  return <span className={`rounded px-1.5 py-0.5 text-xs ${cls}`}>{label}</span>;
}

function PhaseHeader({ req, busy, onInvalidate }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-200 px-5">
      <span className="font-medium">{req.title}</span>
      <span className="font-mono text-xs text-neutral-400">{req.id}</span>
      <div className="ml-4 flex items-center gap-2 text-xs">
        <span className={req.phase === "analysis" ? "font-medium" : "text-neutral-400"}>需求分析</span>
        <ArrowRight className="h-3 w-3 text-neutral-300" />
        <span className={req.phase !== "analysis" ? "font-medium" : "text-neutral-400"}>实现</span>
      </div>
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />}
      {req.phase !== "analysis" && (
        <button
          onClick={() => onInvalidate(false)}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
          title="销毁工作副本并重建，产物全部作废"
        >
          <RotateCcw className="h-3 w-3" />
          作废重跑
        </button>
      )}
    </header>
  );
}

/* ── 分析阶段 ─────────────────────────────────── */
function Analysis({ req, busy, live, pending, onSend, onEdit, onHandoff }) {
  const [input, setInput] = useState("");
  // 只在"这一轮 busy 是移交引起的"时才把按钮换成进度，普通对话的 busy 不算
  const [handingOff, setHandingOff] = useState(false);
  useEffect(() => { if (!busy) setHandingOff(false); }, [busy]);
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [req.dialog, pending, busy, live?.text]);
  const ready = req.settled.open.length === 0 && req.settled.fixed.length > 0;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={ref} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-6 py-6">
            {req.dialog.length === 0 && !pending && (
              <p className="text-neutral-500">描述你要做的功能，代理会逐条问清边界。</p>
            )}
            {req.dialog.map((m, i) => <Msg key={i} m={m} />)}
            {pending && <Msg m={{ role: "user", text: pending }} />}
            {live?.text && (
              <div className="py-2.5">
                <p className="whitespace-pre-wrap leading-relaxed text-neutral-800">
                  {stripProtocol(live.text)}
                  <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-neutral-400 align-text-bottom" />
                </p>
              </div>
            )}
            {busy && !live?.text && (
              <div className="flex items-center gap-2 py-3 text-xs text-neutral-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在处理
              </div>
            )}
          </div>
        </div>
        <Composer
          value={input} onChange={setInput} disabled={busy}
          onSend={() => { if (input.trim()) { onSend(input.trim()); setInput(""); } }}
          placeholder="回答问题，或补充约束"
        />
      </div>

      <aside className="flex w-80 shrink-0 flex-col border-l border-neutral-200">
        <div className="flex h-11 shrink-0 items-center border-b border-neutral-200 px-4 text-xs font-medium text-neutral-500">
          需求条目
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <SettledList settled={req.settled} onEdit={onEdit} />
        </div>
        <div className="shrink-0 border-t border-neutral-200 p-4">
          <button
            onClick={() => { setHandingOff(true); onHandoff(); }} disabled={!ready || busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white disabled:bg-neutral-100 disabled:text-neutral-400"
          >
            {handingOff && busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {handingOff && busy ? "正在生成规格" : "生成规格并移交实现"}
          </button>
          {handingOff && busy && <HandoffProgress live={live} />}
          {!handingOff && !ready && (
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">
              {req.settled.fixed.length === 0
                ? "还没有确定的条目。"
                : `还有 ${req.settled.open.length} 项没定。定完再移交，避免代理拿着模糊需求开工。`}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

/**
 * 移交过程的可视化
 *
 * 生成规格要等模型写完 spec.feature 与 tickets.md，十几秒到几分钟不等。
 * 这里把三种进展都摆出来：服务端报的处理步骤、代理正在动的文件、模型的说明文字。
 * 有东西在动，才不会被当成卡死。
 */
function HandoffProgress({ live }) {
  const stages = live?.stages || [];
  const files = live?.files || [];
  const tail = stripProtocol(live?.text || "").slice(-160);
  return (
    <div className="mt-3 space-y-2 text-xs">
      {stages.map((s, i) => (
        <div key={i} className="flex gap-1.5 text-neutral-600">
          {i === stages.length - 1 ? (
            <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-neutral-400" />
          ) : (
            <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
          )}
          <span className="leading-relaxed">{s}</span>
        </div>
      ))}
      {files.length > 0 && (
        <div className="space-y-0.5">
          {files.map((f) => (
            <div key={f} className="flex gap-1.5 font-mono text-neutral-500">
              <FileText className="mt-0.5 h-3 w-3 shrink-0 text-neutral-400" />
              <span className="truncate">{f}</span>
            </div>
          ))}
        </div>
      )}
      {tail && <p className="whitespace-pre-wrap leading-relaxed text-neutral-400">{tail}</p>}
    </div>
  );
}

function SettledList({ settled, onEdit }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState("");

  function commit() {
    if (!editing) return;
    const next = { fixed: [...settled.fixed], open: [...settled.open] };
    if (editing.type === "fixed") {
      if (draft.trim()) next.fixed[editing.i] = { ...next.fixed[editing.i], v: draft.trim() };
    } else if (draft.trim()) {
      const it = next.open[editing.i];
      next.open.splice(editing.i, 1);
      next.fixed.push({ k: it.k, v: draft.trim() });
    }
    onEdit(next); setEditing(null);
  }

  if (!settled.fixed.length && !settled.open.length)
    return <p className="text-xs text-neutral-500">还没有确定的条目。</p>;

  return (
    <>
      <div className="space-y-2.5">
        {settled.fixed.map((it, i) => (
          <div key={it.k + i} className="group flex gap-2.5">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-neutral-500">{it.k}</div>
              {editing?.type === "fixed" && editing.i === i ? (
                <input
                  autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(null); }}
                  className="mt-0.5 w-full rounded border border-neutral-300 px-1.5 py-0.5 outline-none"
                />
              ) : (
                <button
                  onClick={() => { setEditing({ type: "fixed", i }); setDraft(it.v); }}
                  className="flex w-full items-start gap-1.5 text-left text-neutral-800"
                >
                  <span className="min-w-0 flex-1">{it.v}</span>
                  <Pencil className="mt-1 h-3 w-3 shrink-0 text-neutral-300 opacity-0 group-hover:opacity-100" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {settled.open.length > 0 && (
        <div className="mt-5 space-y-2.5 border-t border-neutral-200 pt-4">
          {settled.open.map((it, i) => (
            <div key={it.k + i} className="flex gap-2.5">
              <span className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border border-dashed border-amber-400" />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-neutral-500">{it.k}</div>
                {editing?.type === "open" && editing.i === i ? (
                  <input
                    autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(null); }}
                    placeholder="填写后这项就算定了"
                    className="mt-0.5 w-full rounded border border-neutral-300 px-1.5 py-0.5 outline-none placeholder:text-neutral-400"
                  />
                ) : (
                  <button
                    onClick={() => { setEditing({ type: "open", i }); setDraft(""); }}
                    className="text-left text-neutral-500 hover:text-neutral-900"
                  >
                    {it.v}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Msg({ m }) {
  if (m.role === "user")
    return (
      <div className="flex justify-end py-2.5">
        <div className="max-w-md whitespace-pre-wrap rounded-lg bg-neutral-100 px-3.5 py-2.5 leading-relaxed">{m.text}</div>
      </div>
    );
  return (
    <div className="py-2.5">
      <p className="whitespace-pre-wrap leading-relaxed text-neutral-800">{m.text}</p>
    </div>
  );
}

function ImplUserMsg({ text }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-md whitespace-pre-wrap rounded-lg bg-neutral-100 px-3 py-2 text-xs leading-relaxed">{text}</div>
    </div>
  );
}

function Composer({ value, onChange, onSend, placeholder, disabled }) {
  return (
    <div className="shrink-0 border-t border-neutral-200 px-6 py-4">
      <div className="mx-auto max-w-2xl">
        <div className="rounded-lg border border-neutral-200 focus-within:border-neutral-400">
          <textarea
            rows={2} value={value} onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
            placeholder={placeholder}
            className="w-full resize-none bg-transparent px-3.5 py-3 outline-none placeholder:text-neutral-400"
          />
          <div className="flex items-center border-t border-neutral-200 px-3 py-2">
            <button
              onClick={onSend} disabled={!value.trim() || disabled}
              className="ml-auto flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-30"
            >
              发送 <CornerDownLeft className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 实现阶段 ─────────────────────────────────── */
function Implementation({
  req, busy, live, retryNote, pending, onStart, onStop, onRun, onSend, onInvalidate,
  onStepReset, onTicketReset, onFailureReason,
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [input, setInput] = useState("");
  const blocked = (req.tickets || []).flatMap((t) => t.skills).find((s) => s.state === "fail" || s.state === "waiting");
  const allDone = req.phase === "done" || (req.tickets?.length > 0 && req.tickets.every((t) => t.skills.every((s) => s.state === "pass")));
  const needsAttribution = allDone && !isOnePass(req) && !req.failureReason;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-neutral-200 px-6 py-2.5">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            {req.running ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                <span className="text-xs text-neutral-600">
                  自动推进中{live?.step ? ` · ${live.step}${live.attempt > 1 ? "（重试）" : ""}` : ""}
                </span>
                <button onClick={onStop} className="ml-auto rounded-md border border-neutral-200 px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50">
                  暂停
                </button>
              </>
            ) : (
              <>
                <span className="text-xs text-neutral-500">
                  {(req.tickets || []).every((t) => t.skills.every((s) => s.state === "pass"))
                    ? "全部工单已完成"
                    : "已停下，等你处理后可继续"}
                </span>
                <button onClick={onStart} disabled={busy} className="ml-auto rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-30">
                  继续推进
                </button>
              </>
            )}
          </div>
          {req.warning && (
            <div className="mx-auto mt-2 max-w-2xl text-xs text-amber-700">{req.warning}</div>
          )}
          {retryNote && (
            <div className="mx-auto mt-2 max-w-2xl truncate text-xs text-neutral-500">{retryNote}</div>
          )}
          {needsAttribution && (
            <div className="mx-auto mt-2 max-w-2xl">
              <FailureAttribution onPick={onFailureReason} />
            </div>
          )}
          {req.failureReason && (
            <div className="mx-auto mt-2 max-w-2xl text-xs text-neutral-500">
              归因：{FAILURE_REASON_LABEL[req.failureReason] || req.failureReason}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-6 py-6">
            {(req.tickets || []).map((t) => (
              <Ticket
                key={t.ticket} t={t} busy={busy} live={live}
                onRun={() => onRun(t.ticket)}
                onStepReset={(skillName) => onStepReset(t.ticket, skillName)}
                onTicketReset={() => onTicketReset(t.ticket)}
              />
            ))}
            {!req.tickets?.length && <p className="text-neutral-500">还没有工单。</p>}
          </div>
        </div>

        <div className="shrink-0 border-t border-neutral-200">
          {chatOpen && (req.implChat?.length > 0 || pending) && (
            <div className="max-h-48 overflow-y-auto border-b border-neutral-200 px-6 py-3">
              <div className="mx-auto max-w-2xl space-y-2.5">
                {req.implChat.map((m, i) =>
                  m.role === "user" ? (
                    <ImplUserMsg key={i} text={m.text} />
                  ) : (
                    <p key={i} className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-700">{m.text}</p>
                  )
                )}
                {pending && <ImplUserMsg text={pending} />}
              </div>
            </div>
          )}
          <div className="px-6 py-3">
            <div className="mx-auto flex max-w-2xl items-center gap-2">
              <button
                onClick={() => setChatOpen(!chatOpen)}
                className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900"
              >
                <MessageSquare className="h-3.5 w-3.5" /> 对话
                {req.implChat?.length > 0 && <span className="text-neutral-400">{req.implChat.length}</span>}
              </button>
              <input
                value={input} onChange={(e) => setInput(e.target.value)}
                onFocus={() => setChatOpen(true)} disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && input.trim()) { onSend(input.trim()); setInput(""); setChatOpen(true); }
                }}
                placeholder="对这次运行说点什么"
                className="flex-1 rounded-md border border-neutral-200 px-3 py-2 text-xs outline-none focus:border-neutral-400 placeholder:text-neutral-400"
              />
            </div>
          </div>
        </div>
      </div>

      <aside className="flex w-80 shrink-0 flex-col border-l border-neutral-200">
        <div className="flex h-11 shrink-0 items-center border-b border-neutral-200 px-4 text-xs font-medium text-neutral-500">
          {blocked ? "需要你处理" : "工作副本"}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {blocked ? (
            <Intervene s={blocked} onInvalidate={onInvalidate} />
          ) : (
            <WorktreeInfo req={req} />
          )}
        </div>
      </aside>
    </div>
  );
}

const FAILURE_REASON_LABEL = {
  unclear_requirement: "需求没定清",
  implementation: "实现问题",
  environment: "环境问题",
};

function FailureAttribution({ onPick }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 text-xs">
      <span className="text-neutral-500">未一次通过，归因：</span>
      {Object.entries(FAILURE_REASON_LABEL).map(([k, label]) => (
        <button
          key={k} onClick={() => onPick(k)}
          className="rounded border border-neutral-200 px-2 py-0.5 text-neutral-600 hover:bg-neutral-50"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Ticket({ t, busy, live, onRun, onStepReset, onTicketReset }) {
  const allPass = t.skills.every((s) => s.state === "pass");
  const anyStarted = t.skills.some((s) => s.state !== "idle");
  const [open, setOpen] = useState(!allPass);
  const next = t.skills.find((s) => s.state === "idle");
  const totalMs = t.skills.reduce((n, s) => n + (s.ms || 0), 0); // 工单累计耗时
  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center gap-2">
        <button onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="h-3 w-3 shrink-0 text-neutral-400" /> : <ChevronRight className="h-3 w-3 shrink-0 text-neutral-400" />}
          <span className="font-mono text-xs text-neutral-400">{t.ticket}</span>
          <span className="font-medium">{t.title}</span>
          {t.deps?.length > 0 && (
            <span className="shrink-0 font-mono text-xs text-neutral-400">依赖 {t.deps.join(" ")}</span>
          )}
          {t.blockedBy && (
            <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">
              等待 {t.blockedBy}
            </span>
          )}
          {!open && allPass && (
            <span className="ml-auto flex items-center gap-1 text-xs text-neutral-500">
              <Check className="h-3.5 w-3.5 text-emerald-600" /> {t.skills.length} 步全过
            </span>
          )}
          {totalMs > 0 && (
            <span className={`shrink-0 font-mono text-xs text-neutral-400${!open && allPass ? "" : " ml-auto"}`}>
              {fmtMs(totalMs)}
            </span>
          )}
        </button>
        {next && !t.blockedBy && (
          <button
            onClick={onRun} disabled={busy}
            className="flex shrink-0 items-center gap-1 rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-30"
          >
            <Play className="h-3 w-3" /> 跑 {next.name}
          </button>
        )}
        {anyStarted && (
          <button
            onClick={onTicketReset} disabled={busy}
            title="只重置这个工单的状态与会话，不影响其它工单；此前的代码改动仍会留在分支历史里"
            className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-50 disabled:opacity-30"
          >
            <RotateCcw className="h-3 w-3" /> 重跑此工单
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-1.5 pl-5">
          {t.skills.map((s) => (
            <SkillRun
              key={s.name} s={s} live={s.state === "running" ? live : null} busy={busy}
              onReset={s.state === "pass" || s.state === "fail" || s.state === "waiting" ? () => onStepReset(s.name) : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillRun({ s, live, busy, onReset }) {
  const [open, setOpen] = useState(s.state === "fail");
  const running = s.state === "running" && live;
  const tools = running && live.tools?.length ? live.tools : s.tools;
  const files = running && live.files?.length ? live.files : s.files;
  const expandable = tools?.length || s.detail || files?.length;
  // 运行中走秒表，跑完显示服务端测到的实际耗时（含重试累计）
  const elapsed = useElapsed(s.state === "running");
  const duration = s.state === "running" ? fmtMs((s.ms || 0) + elapsed) : fmtMs(s.ms);
  // 运行中自动展开，让进度可见
  useEffect(() => { if (running) setOpen(true); }, [running]);
  return (
    <div className="rounded-lg border border-neutral-200">
      <button onClick={() => expandable && setOpen(!open)} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left">
        {expandable ? (
          open ? <ChevronDown className="h-3 w-3 shrink-0 text-neutral-400" /> : <ChevronRight className="h-3 w-3 shrink-0 text-neutral-400" />
        ) : <span className="w-3 shrink-0" />}
        <span className="font-mono text-xs">{s.name}</span>
        <SkillState state={s.state} />
        {s.verdictSource === "fallback" && (
          <span
            className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500"
            title="模型未按协议输出 VERDICT，状态是关键词猜的，未必准"
          >
            推测
          </span>
        )}
        {s.attempt > 1 && s.state !== "idle" && (
          <span className="shrink-0 text-xs text-neutral-400">第 {s.attempt} 次</span>
        )}
        {running && tools?.length > 0 && (
          <span className="ml-auto shrink-0 text-xs text-neutral-400">{tools.length} 次调用</span>
        )}
        {!running && s.note && (
          <span className="ml-auto truncate pl-2 text-xs text-neutral-500">{s.note}</span>
        )}
        {duration && (
          <span
            className={`shrink-0 font-mono text-xs text-neutral-400${running || s.note ? " pl-2" : " ml-auto"}`}
            title={s.attempt > 1 ? "含重试的累计耗时" : "本步耗时"}
          >
            {duration}
          </span>
        )}
        {onReset && (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); if (!busy) onReset(); }}
            title="只重跑这一步（及同工单内其后已完成的步骤）"
            className={`ml-2 shrink-0 rounded border border-neutral-200 p-1 text-neutral-400 hover:bg-neutral-50 hover:text-neutral-700 ${busy ? "pointer-events-none opacity-30" : ""}`}
          >
            <RotateCcw className="h-3 w-3" />
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-neutral-200 px-3 py-2.5">
          {s.detail && <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-600">{s.detail}</p>}
          {running && live.text && (
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-600">
              {stripProtocol(live.text).slice(-400)}
            </p>
          )}
          {tools?.map((t, i) => (
            <div key={i} className="flex items-center gap-2 font-mono text-xs text-neutral-500">
              <Terminal className="h-3 w-3 shrink-0 text-neutral-300" />
              <span className="text-neutral-700">{t.n}</span>
              <span className="truncate">{t.a}</span>
            </div>
          ))}
          {files?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {files.map((f) => (
                <span key={f} className="flex items-center gap-1.5 rounded border border-neutral-200 px-1.5 py-0.5 font-mono text-xs text-neutral-600">
                  <FileText className="h-3 w-3 text-neutral-400" /> {f}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SkillState({ state }) {
  if (state === "pass") return <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />;
  if (state === "fail") return <span className="shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">未通过</span>;
  if (state === "waiting") return <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">等你</span>;
  if (state === "running") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />;
  return <span className="shrink-0 text-xs text-neutral-400">待运行</span>;
}

function Intervene({ s, onInvalidate }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <AlertCircle className={`h-4 w-4 ${s.state === "fail" ? "text-red-500" : "text-amber-500"}`} />
        <h3 className="font-medium">{s.state === "fail" ? "未通过" : "等你确认"}</h3>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-neutral-500">
        {s.detail || s.note}
      </p>
      <div className="mt-4 space-y-1.5">
        <button
          onClick={() => onInvalidate(false)}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white"
        >
          <RotateCcw className="h-3.5 w-3.5" /> 作废重跑
        </button>
        <button
          onClick={() => onInvalidate(true)}
          className="w-full rounded-md border border-neutral-200 px-3 py-2 text-xs text-neutral-700 hover:bg-neutral-50"
        >
          回到需求分析补充边界
        </button>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-neutral-500">
        作废重跑会销毁工作副本与分支后重建，产物全部清空。若失败源于需求没定清，回分析阶段补一条更省事。
      </p>
    </div>
  );
}

function WorktreeInfo({ req }) {
  return (
    <div className="space-y-3 text-xs">
      <div>
        <div className="text-neutral-500">分支</div>
        <div className="mt-0.5 font-mono text-neutral-800">agent/{req.id}</div>
      </div>
      {req.tree && (
        <div>
          <div className="text-neutral-500">工作副本</div>
          <div className="mt-0.5 break-all font-mono text-neutral-700">{req.tree}</div>
        </div>
      )}
      <div>
        <div className="text-neutral-500">改动文件 {req.changed?.length || 0}</div>
        <div className="mt-1 space-y-1">
          {(req.changed || []).map((c) => (
            <div key={c.file} className="flex gap-2 font-mono text-neutral-700">
              <span className="text-neutral-400">{c.status}</span>
              <span className="truncate">{c.file}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
