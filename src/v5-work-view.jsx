import React, { useCallback, useEffect, useState } from "react";

const STATUS_TEXT = {
  draft: "准备中", active: "进行中", waiting_user: "等待确认", completed: "已完成",
  failed: "失败", idle: "待开始", running: "执行中", ready: "可开始", blocked: "等待依赖",
};

async function streamPost(url, body, onEvent) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "", final = null;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); const lines = buf.split("\n"); buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue; const e = JSON.parse(line);
      if (e.type === "done") final = e.req; else if (e.type === "error") throw new Error(e.message); else onEvent?.(e);
    }
  }
  return final;
}

function ActivityRow({ activity, engineering, busy, onRun }) {
  const runnable = ["idle", "waiting_user", "failed"].includes(activity.status) && activity.type !== "implementation";
  return <div className="border-b border-slate-100 py-3 last:border-0">
    <div className="flex items-center justify-between gap-3">
      <div className="font-medium text-slate-800">{activity.label}</div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">{STATUS_TEXT[activity.status] || activity.status}</span>
        {runnable && <button disabled={busy} onClick={() => onRun(activity)} className="rounded border border-slate-200 px-2 py-1 text-xs disabled:opacity-40">{activity.status === "waiting_user" ? "继续" : "开始"}</button>}
      </div>
    </div>
    {engineering && <div className="mt-1 font-mono text-xs text-slate-400">{activity.technical?.skill ? `/${activity.technical.skill}` : activity.type}{activity.sessionId ? ` · ${activity.sessionId}` : ""}</div>}
  </div>;
}

function TicketRow({ ticket, engineering, busy, onRun }) {
  return <div className="rounded-lg border border-slate-200 p-3">
    <div className="flex items-start justify-between gap-3">
      <div><span className="mr-2 text-xs text-slate-400">#{ticket.number}</span>{ticket.title}</div>
      <div className="flex items-center gap-2"><span className="text-xs text-slate-500">{STATUS_TEXT[ticket.status] || ticket.status}</span>{ticket.status === "ready" && <button disabled={busy} onClick={() => onRun(ticket)} className="rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-40">开发</button>}</div>
    </div>
    {engineering && <div className="mt-2 text-xs text-slate-500">{ticket.blockedBy?.length ? `依赖：${ticket.blockedBy.join(", ")}` : "无未完成依赖"}{ticket.path ? <div className="mt-1 truncate font-mono text-slate-400">{ticket.path}</div> : null}</div>}
  </div>;
}

export default function V5WorkView({ workId, apiBase = "" }) {
  const [data, setData] = useState(null); const [tickets, setTickets] = useState(null); const [engineering, setEngineering] = useState(false);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [live, setLive] = useState("");
  const refresh = useCallback(async () => {
    if (!workId) return;
    const [work, frontier] = await Promise.all([fetch(`${apiBase}/api/v5/works/${workId}`).then((r) => r.json()), fetch(`${apiBase}/api/v5/works/${workId}/tickets`).then((r) => r.json())]);
    setData(work); setTickets(frontier);
  }, [workId, apiBase]);
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, [refresh]);

  async function runActivity(activity) {
    setBusy(true); setError(""); setLive("");
    try { await streamPost(`${apiBase}/api/v5/activities/run`, { workId, activityId: activity.id }, (e) => { if (e.type === "text") setLive((s) => s + e.text); }); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function runTicket(ticket) {
    setBusy(true); setError(""); setLive("");
    try { await streamPost(`${apiBase}/api/v5/implementation/run`, { workId, ticketId: ticket.id }, (e) => { if (e.type === "text") setLive((s) => s + e.text); }); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (!workId) return null;
  if (!data?.work) return <div className="p-4 text-sm text-slate-400">加载工作进度…</div>;
  return <section className="mx-auto max-w-4xl space-y-4 p-4">
    <header className="flex items-start justify-between gap-4"><div><div className="text-xs uppercase tracking-wide text-slate-400">BUILD · {STATUS_TEXT[data.work.status] || data.work.status}</div><h1 className="mt-1 text-xl font-semibold text-slate-900">{data.work.title}</h1></div><button className="rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-600" onClick={() => setEngineering((v) => !v)}>{engineering ? "简洁视图" : "工程详情"}</button></header>
    {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    {busy && <div className="rounded border border-blue-100 bg-blue-50 p-3 text-xs text-blue-700">Agent 正在执行…</div>}
    {live && engineering && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-3 text-xs text-slate-200">{live}</pre>}
    <div className="rounded-xl border border-slate-200 bg-white p-4"><h2 className="mb-1 text-sm font-semibold text-slate-700">当前流程</h2>{data.activities?.map((activity) => <ActivityRow key={activity.id} activity={activity} engineering={engineering} busy={busy} onRun={runActivity} />)}</div>
    <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-700">开发任务</h2>{tickets?.counts && <span className="text-xs text-slate-400">{tickets.counts.completed}/{tickets.counts.total} 完成</span>}</div>{!tickets?.tickets?.length ? <div className="text-sm text-slate-400">方案确认并拆分任务后，这里会显示开发进度。</div> : <div className="space-y-2">{tickets.tickets.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} engineering={engineering} busy={busy} onRun={runTicket} />)}</div>}{engineering && tickets?.issuesDir && <div className="mt-3 truncate font-mono text-xs text-slate-400">source: {tickets.issuesDir}</div>}</div>
  </section>;
}
