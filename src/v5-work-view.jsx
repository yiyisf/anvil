import React, { useEffect, useState } from "react";

const STATUS_TEXT = {
  draft: "准备中", active: "进行中", waiting_user: "等待确认", completed: "已完成",
  failed: "失败", idle: "待开始", running: "执行中", ready: "可开始", blocked: "等待依赖",
};

function ActivityRow({ activity, engineering }) {
  return <div className="border-b border-slate-100 py-3 last:border-0">
    <div className="flex items-center justify-between gap-3">
      <div className="font-medium text-slate-800">{activity.label}</div>
      <span className="text-xs text-slate-500">{STATUS_TEXT[activity.status] || activity.status}</span>
    </div>
    {engineering && <div className="mt-1 font-mono text-xs text-slate-400">
      {activity.technical?.skill ? `/${activity.technical.skill}` : activity.type}
      {activity.sessionId ? ` · ${activity.sessionId}` : ""}
    </div>}
  </div>;
}

function TicketRow({ ticket, engineering }) {
  return <div className="rounded-lg border border-slate-200 p-3">
    <div className="flex items-start justify-between gap-3">
      <div><span className="mr-2 text-xs text-slate-400">#{ticket.number}</span>{ticket.title}</div>
      <span className="text-xs text-slate-500">{STATUS_TEXT[ticket.status] || ticket.status}</span>
    </div>
    {engineering && <div className="mt-2 text-xs text-slate-500">
      {ticket.blockedBy?.length ? `依赖：${ticket.blockedBy.join(", ")}` : "无未完成依赖"}
      {ticket.path ? <div className="mt-1 truncate font-mono text-slate-400">{ticket.path}</div> : null}
    </div>}
  </div>;
}

export default function V5WorkView({ workId, apiBase = "" }) {
  const [data, setData] = useState(null);
  const [tickets, setTickets] = useState(null);
  const [engineering, setEngineering] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!workId) return;
    let live = true;
    Promise.all([
      fetch(`${apiBase}/api/v5/works/${workId}`).then((r) => r.json()),
      fetch(`${apiBase}/api/v5/works/${workId}/tickets`).then((r) => r.json()),
    ]).then(([work, frontier]) => {
      if (!live) return;
      setData(work);
      setTickets(frontier);
    }).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [workId, apiBase]);

  if (!workId) return null;
  if (error) return <div className="p-4 text-sm text-red-600">{error}</div>;
  if (!data?.work) return <div className="p-4 text-sm text-slate-400">加载工作进度…</div>;

  return <section className="mx-auto max-w-4xl space-y-4 p-4">
    <header className="flex items-start justify-between gap-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-slate-400">BUILD · {STATUS_TEXT[data.work.status] || data.work.status}</div>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">{data.work.title}</h1>
      </div>
      <button className="rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-600" onClick={() => setEngineering((v) => !v)}>
        {engineering ? "简洁视图" : "工程详情"}
      </button>
    </header>

    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-1 text-sm font-semibold text-slate-700">当前流程</h2>
      {data.activities?.map((activity) => <ActivityRow key={activity.id} activity={activity} engineering={engineering} />)}
    </div>

    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">开发任务</h2>
        {tickets?.counts && <span className="text-xs text-slate-400">{tickets.counts.completed}/{tickets.counts.total} 完成</span>}
      </div>
      {!tickets?.tickets?.length ? <div className="text-sm text-slate-400">方案确认并拆分任务后，这里会显示开发进度。</div> :
        <div className="space-y-2">{tickets.tickets.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} engineering={engineering} />)}</div>}
      {engineering && tickets?.issuesDir && <div className="mt-3 truncate font-mono text-xs text-slate-400">source: {tickets.issuesDir}</div>}
    </div>
  </section>;
}
