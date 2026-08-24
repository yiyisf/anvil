import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BUILD_PHASES, phaseState, requirementUnderstanding } from "./model.js";
import { createBuildApi } from "../shared/api-client.js";
const STATUS_TEXT = {
  draft: "准备中",
  active: "进行中",
  waiting_user: "等待你",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  idle: "待开始",
  running: "执行中",
  recovering: "正在处理问题",
  ready: "可开始",
  blocked: "等待依赖",
};
const ROUTE_TEXT = {
  direct: "直接开发",
  spec: "先制定方案",
  tickets: "拆分开发任务",
};
function WorkProgress({ data }) {
  return (
    <div className="grid grid-cols-4 gap-2 rounded-xl border border-slate-200 bg-white p-3">
      {BUILD_PHASES.map(([type, label]) => {
        const state = phaseState(type, data);
        return (
          <div key={type} className="flex items-center gap-2 text-xs">
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full border ${state === "done" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : state === "active" ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 text-slate-300"}`}
            >
              {state === "done" ? "✓" : state === "active" ? "●" : "○"}
            </span>
            <span
              className={
                state === "todo"
                  ? "text-slate-400"
                  : "font-medium text-slate-700"
              }
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
function RequirementUnderstanding({ activity }) {
  const u = requirementUnderstanding(activity);
  const Section = ({ title, items, empty }) => (
    <div>
      <div className="mb-2 text-xs font-medium text-slate-500">{title}</div>
      {items.length ? (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div
              key={i}
              className="rounded-lg bg-slate-50 px-3 py-2 text-sm leading-5 text-slate-700"
            >
              {item}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs leading-5 text-slate-400">{empty}</div>
      )}
    </div>
  );
  return (
    <aside className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-4">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
          需求理解
        </div>
        <div className="mt-1 text-sm text-slate-600">
          随着对话自动整理，不需要你维护工程文档。
        </div>
      </div>
      <div className="space-y-5">
        <Section
          title="已明确"
          items={u.confirmed}
          empty="你的回答会逐步沉淀在这里。"
        />
        <Section
          title="仍待确认"
          items={u.open}
          empty={
            activity?.status === "completed"
              ? "当前没有待确认项。"
              : "AI 检查项目后会提出关键问题。"
          }
        />
        <Section
          title="可能影响"
          items={u.impact}
          empty="识别到代码或模块影响后会显示在这里。"
        />
      </div>
    </aside>
  );
}
function ConversationPanel({ activity, busy, live, onReply, onApprove }) {
  const [text, setText] = useState("");
  const conversation = activity.conversation || [];
  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    onReply(value);
  };
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
          理解需求
        </div>
        <h2 className="mt-1 text-base font-semibold text-slate-900">
          和 AI 一起把需求说清楚
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          AI 会结合代码和文档追问关键边界。你可以直接回答，不需要使用工程术语。
        </p>
      </div>
      <div className="max-h-[46vh] space-y-5 overflow-y-auto px-5 py-5">
        {!conversation.length && !busy && (
          <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
            AI 会先检查项目，再向你确认真正影响实现的关键问题。
          </div>
        )}
        {conversation.map((m, i) => (
          <div
            key={`${m.at || i}-${i}`}
            className={m.role === "user" ? "ml-12" : "mr-12"}
          >
            <div className="mb-1 text-xs text-slate-400">
              {m.role === "user" ? "你" : "AI"}
            </div>
            <div
              className={`whitespace-pre-wrap leading-6 ${m.role === "user" ? "rounded-lg bg-slate-100 px-3 py-2" : "text-slate-800"}`}
            >
              {m.text}
            </div>
          </div>
        ))}
        {live && (
          <div className="mr-12">
            <div className="mb-1 text-xs text-slate-400">AI · 正在思考</div>
            <div className="whitespace-pre-wrap leading-6 text-slate-700">
              {live}
            </div>
          </div>
        )}
      </div>
      {activity.status === "waiting_user" && (
        <div className="border-t border-slate-100 p-4">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={3}
            placeholder="直接回答 AI，或补充你认为重要的信息…"
            className="w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-slate-400">
              Enter 发送 · Shift+Enter 换行
            </span>
            <div className="flex gap-2">
              {!!conversation.length && activity.gate?.required && (
                <button
                  disabled={busy}
                  onClick={onApprove}
                  className="rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-600 disabled:opacity-40"
                >
                  确认风险并继续
                </button>
              )}
              <button
                disabled={busy || !text.trim()}
                onClick={send}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs text-white disabled:opacity-30"
              >
                发送回答
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function ActivityRow({ activity }) {
  return (
    <div className="border-b border-slate-100 py-3 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-slate-800">
          {activity.parentActivityId ? "↳ " : ""}
          {activity.label}
        </div>
        <span className="text-xs text-slate-500">
          {STATUS_TEXT[activity.status] || activity.status}
        </span>
      </div>
      <div className="mt-1 font-mono text-xs text-slate-400">
        {activity.technical?.skill
          ? `/${activity.technical.skill}`
          : activity.type}
        {activity.sessionId ? ` · ${activity.sessionId}` : ""}
        {activity.recoveryFor ? ` · recovery ${activity.recoveryFor}` : ""}
      </div>
    </div>
  );
}
function TicketRow({ ticket, engineering }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="mr-2 text-xs text-slate-400">#{ticket.number}</span>
          {ticket.title}
        </div>
        <span className="text-xs text-slate-500">
          {STATUS_TEXT[ticket.status] || ticket.status}
        </span>
      </div>
      {engineering && (
        <div className="mt-2 text-xs text-slate-500">
          {ticket.blockedBy?.length
            ? `依赖：${ticket.blockedBy.join(", ")}`
            : "无未完成依赖"}
          {ticket.path ? (
            <div className="mt-1 truncate font-mono text-slate-400">
              {ticket.path}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
export default function WorkView({ workId, apiBase = "" }) {
  const api = useMemo(() => createBuildApi({ apiBase }), [apiBase]);
  const autoStartedWorkIds = useRef(new Set());
  const [data, setData] = useState(null),
    [tickets, setTickets] = useState(null),
    [engineering, setEngineering] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [live, setLive] = useState(""),
    [stage, setStage] = useState("");
  const refresh = useCallback(async () => {
    if (!workId) return;
    const [work, frontier] = await Promise.all([
      api.getWork(workId),
      api.getTickets(workId),
    ]);
    setData(work);
    setTickets(frontier);
  }, [workId, api]);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);
  const alignment = useMemo(
    () => data?.activities?.find((a) => a.type === "alignment"),
    [data],
  );
  async function run(url, body) {
    setBusy(true);
    setError("");
    setLive("");
    setStage("");
    try {
      await api.stream(url.replace(apiBase, ""), body, (e) => {
        if (e.type === "text") setLive((s) => s + e.text);
        if (e.type === "orchestrator") setStage(e.state);
      });
      await refresh();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
      setLive("");
    }
  }
  const advance = () => run(`${apiBase}/api/v5/build/advance`, { workId });
  const reply = (text) =>
    run(`${apiBase}/api/v5/activities/${alignment.id}/reply`, { workId, text });
  async function decide(activity, decision) {
    setBusy(true);
    setError("");
    try {
      const r = await api.post(`/api/v5/activities/${activity.id}/gate`, {
        workId,
        decision,
      });
      if (r.error) throw new Error(r.error);
      await refresh();
      if (["approve", "retry", "replan"].includes(decision)) await advance();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!data?.work || busy) return;
    const started = data.activities?.some(
      (activity) => activity.status !== "idle",
    );
    if (
      !started &&
      data.work.status === "draft" &&
      !autoStartedWorkIds.current.has(data.work.id)
    ) {
      autoStartedWorkIds.current.add(data.work.id);
      advance();
    }
  }, [data?.work?.id, data?.work?.status, busy]);
  if (!workId) return null;
  if (!data?.work)
    return <div className="p-4 text-sm text-slate-400">加载工作进度…</div>;
  const gate = data.activities?.find(
      (a) => a.status === "waiting_user" && a.gate,
    ),
    alignmentActive = alignment && alignment.status !== "completed",
    recovering =
      data.activities?.some((a) => a.status === "recovering") ||
      data.interruptions?.some((x) => x.status === "recovering"),
    latestInterruption = data.interruptions
      ?.slice()
      .reverse()
      .find((x) => x.status !== "resolved"),
    gateOptions = gate?.gate?.options || [
      { action: "approve", label: "确认并继续" },
      { action: "revise", label: "需要调整" },
    ];
  return (
    <section className="mx-auto max-w-6xl space-y-4 p-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">
            BUILD · {STATUS_TEXT[data.work.status] || data.work.status}
          </div>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            {data.work.title}
          </h1>
          {data.work.buildRoute && (
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              <span className="rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-700">
                {ROUTE_TEXT[data.work.buildRoute] || data.work.buildRoute}
              </span>
              {alignment?.alignmentDecision?.reason && (
                <span>{alignment.alignmentDecision.reason}</span>
              )}
            </div>
          )}
        </div>
        <button
          className="rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-600"
          onClick={() => setEngineering((v) => !v)}
        >
          {engineering ? "收起工程详情" : "工程详情"}
        </button>
      </header>
      <WorkProgress data={data} />
      {recovering && (
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <div className="text-xs font-medium text-blue-700">
            AI 正在自动处理一个执行问题
          </div>
          <div className="mt-1 text-sm text-slate-700">
            无需操作，处理完成后 BUILD 会继续原任务。
          </div>
          {engineering && latestInterruption && (
            <div className="mt-2 font-mono text-xs text-slate-500">
              {latestInterruption.type} ·{" "}
              {latestInterruption.recovery?.strategy}
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="flex items-center justify-between gap-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <span>{error}</span>
          {!["completed", "cancelled"].includes(data.work.status) && (
            <button
              className="rounded border border-red-300 bg-white px-2.5 py-1 text-xs"
              onClick={() => {
                if (data.work.status === "draft")
                  autoStartedWorkIds.current.delete(data.work.id);
                advance();
              }}
            >
              重试推进
            </button>
          )}
        </div>
      )}
      {alignmentActive ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(260px,0.8fr)]">
          <ConversationPanel
            activity={alignment}
            busy={busy}
            live={live}
            onReply={reply}
            onApprove={() => decide(alignment, "approve")}
          />
          <RequirementUnderstanding activity={alignment} />
        </div>
      ) : gate ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <div className="text-xs font-medium text-amber-700">需要你的确认</div>
          <div className="mt-1 font-medium text-slate-900">
            {gate.gate.prompt || gate.label}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {gateOptions.map((o) => (
              <button
                key={o.action}
                disabled={busy}
                onClick={() => decide(gate, o.action)}
                className={
                  o.action === "stop"
                    ? "rounded border border-red-200 bg-white px-3 py-1.5 text-xs text-red-700"
                    : "rounded bg-slate-900 px-3 py-1.5 text-xs text-white"
                }
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : data.work.status === "completed" ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
          <div className="font-semibold text-emerald-900">BUILD 已完成</div>
          <div className="mt-1 text-sm text-emerald-800">
            计划中的开发任务已经全部完成。
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
          {busy
            ? `AI 正在继续处理${stage ? ` · ${stage}` : ""}…`
            : "当前无需你操作。BUILD 会自动推进到下一个需要确认的位置。"}
        </div>
      )}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">开发任务</h2>
          {tickets?.counts && (
            <span className="text-xs text-slate-400">
              {tickets.counts.completed}/{tickets.counts.total} 完成
            </span>
          )}
        </div>
        {!tickets?.tickets?.length ? (
          <div className="text-sm text-slate-400">
            需求和方案确认后，这里会显示开发任务。
          </div>
        ) : (
          <div className="space-y-2">
            {tickets.tickets.map((ticket) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                engineering={engineering}
              />
            ))}
          </div>
        )}
      </div>
      {engineering && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h2 className="mb-1 text-sm font-semibold text-slate-700">
            工程详情
          </h2>
          {live && (
            <pre className="my-3 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-3 text-xs text-slate-200">
              {live}
            </pre>
          )}
          {data.activities?.map((activity) => (
            <ActivityRow key={activity.id} activity={activity} />
          ))}
          {tickets?.issuesDir && (
            <div className="mt-3 truncate font-mono text-xs text-slate-400">
              source: {tickets.issuesDir}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
