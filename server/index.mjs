/**
 * API server. Legacy endpoints remain during BUILD migration.
 */
import http from "node:http";
import { runTurn } from "./harness.mjs";
import { listReqs, getReq, saveReq, newReq, clearSessions, listProjects, getProject, saveProject, newProject } from "./store.mjs";
import { ensureWorktree, resetWorktree, changedFiles, treePath } from "./worktree.mjs";
import { IMPL_INSTRUCTIONS, SKILLS } from "./skills.mjs";
import { startRun, stopRun, isRunning } from "./runner.mjs";
import { createBuildWork, getBuildWork, listWorks } from "./v5-service.mjs";
import { runActivity } from "./activity-runner-v5.mjs";
import { getWork, getActivity } from "./store-v5.mjs";
import { getTicketFrontier } from "./ticket-frontier-v5.mjs";
import { ensureImplementationActivities, runFrontierTicket } from "./implementation-v5.mjs";
import { advanceBuild, decideHumanGate } from "./build-orchestrator-v5.mjs";

const PORT = Number(process.env.PORT || 8787);
async function requireProject(req) { const project = await getProject(req.projectId); if (!project) throw new Error(`需求 ${req.id} 找不到所属项目 ${req.projectId}`); return project; }
async function requireWorkProject(work) { const project = await getProject(work.projectId); if (!project) throw new Error(`Work ${work.id} 找不到所属项目 ${work.projectId}`); return project; }
async function migrateLegacyProject() { const projects = await listProjects(); if (projects.length) return; const { REPO_PATH, WORKTREES_DIR, BASE_BRANCH } = process.env; if (!REPO_PATH || !WORKTREES_DIR) return; const project = newProject({ name: "默认项目", repoPath: REPO_PATH, worktreesDir: WORKTREES_DIR, baseBranch: BASE_BRANCH || "" }); await saveProject(project); const reqs = await listReqs(); for (const r of reqs) if (!r.projectId) { r.projectId = project.id; await saveReq(r); } }
function extractVerdict(text) { const state = /超出范围|需要确认|无法继续|停下等/.test(text) ? "waiting" : /未通过|不通过|失败|测试挂/.test(text) ? "fail" : "pass"; return { state, summary: text.slice(0, 160), clean: text }; }
const FAILURE_REASONS = new Set(["unclear_requirement", "implementation", "environment"]);
const routes = {
  "GET /api/projects": async () => listProjects(),
  "POST /api/projects": async ({ body }) => { const project = newProject({ name: body.name?.trim() || "未命名项目", repoPath: body.repoPath?.trim(), worktreesDir: body.worktreesDir?.trim(), baseBranch: body.baseBranch?.trim() || "" }); if (!project.repoPath || !project.worktreesDir) return { error: "repoPath 和 worktreesDir 必填" }; return saveProject(project); },
  "GET /api/projects/:id": async ({ q }) => (await getProject(q.id)) || { error: "not found" },
  "GET /api/v5/works": async ({ q }) => listWorks(q.projectId || null),
  "POST /api/v5/works": async ({ body }) => { const project = await getProject(body.projectId); if (!project) return { error: "项目不存在" }; const created = await createBuildWork({ projectId: project.id, title: body.title?.trim() || "未命名工作" }); await ensureWorktree(project, created.work.id); return created; },
  "GET /api/v5/works/:id": async ({ q }) => (await getBuildWork(q.id)) || { error: "not found" },
  "GET /api/v5/activities/:id": async ({ q }) => (await getActivity(q.id)) || { error: "not found" },
  "GET /api/v5/works/:id/tickets": async ({ q }) => { const work = await getWork(q.id); if (!work) return { error: "not found" }; return getTicketFrontier({ work, project: await requireWorkProject(work), featureSlug: q.feature || null }); },
  "POST /api/v5/works/:id/implementation/prepare": async ({ q }) => { const work = await getWork(q.id); if (!work) return { error: "not found" }; return ensureImplementationActivities({ work, project: await requireWorkProject(work) }); },
  "POST /api/v5/activities/:id/gate": async ({ q, body }) => decideHumanGate({ workId: body.workId, activityId: q.id, decision: body.decision, route: body.route || null }),
  "GET /api/reqs": async () => listReqs(),
  "POST /api/reqs": async ({ body }) => { const project = await getProject(body.projectId); if (!project) return { error: "项目不存在" }; const req = newReq(body.title?.trim() || "未命名需求", project.id); await ensureWorktree(project, req.id); return saveReq(req); },
  "GET /api/req": async ({ q }) => { const req = await getReq(q.id); if (!req) return { error: "not found" }; const project = await getProject(req.projectId); return { ...req, changed: project ? await changedFiles(project, req.id) : [], tree: project ? treePath(project, req.id) : null, running: isRunning(req.id) }; },
  "POST /api/impl-message": async ({ q, body }) => { const req = await getReq(q.id); if (!req) return { error: "not found" }; const project = await requireProject(req); req.implChat.push({ role: "user", text: body.text }); const out = await runTurn({ reqId: req.id, worktreesDir: project.worktreesDir, sessionKey: "impl", phase: "impl", instructions: IMPL_INSTRUCTIONS, skills: SKILLS, prompt: body.text }); req.implChat.push({ role: "assistant", text: extractVerdict(out.text).clean }); await saveReq(req); return req; },
  "POST /api/start": async ({ q }) => { const req = await getReq(q.id); if (!req) return { error: "not found" }; return { ...req, running: true, started: startRun(req.id, extractVerdict) }; },
  "POST /api/stop": async ({ q }) => { stopRun(q.id); return { stopping: true }; },
  "POST /api/invalidate": async ({ q, body }) => { const req = await getReq(q.id); if (!req) return { error: "not found" }; const project = await requireProject(req); await resetWorktree(project, req.id); await clearSessions(`${req.id}--impl`); req.tickets = []; req.implChat = []; req.everReset = true; req.phase = body.backToAnalysis ? "analysis" : "impl"; return saveReq(req); },
  "POST /api/reqs/:id/failure-reason": async ({ q, body }) => { const req = await getReq(q.id); if (!req) return { error: "not found" }; if (!FAILURE_REASONS.has(body.reason)) return { error: "非法 reason" }; req.failureReason = body.reason; return saveReq(req); },
};
const streamRoutes = {
  "POST /api/v5/build/advance": async ({ q, body, emit }) => { const work = await getWork(body.workId || q.workId); if (!work) throw new Error("Work 不存在"); return advanceBuild({ workId: work.id, project: await requireWorkProject(work), onEvent: emit }); },
  "POST /api/v5/activities/run": async ({ q, body, emit }) => { const work = await getWork(body.workId || q.workId); if (!work) throw new Error("Work 不存在"); return runActivity({ workId: work.id, activityId: body.activityId || q.activityId, project: await requireWorkProject(work), prompt: body.prompt || "", onEvent: emit }); },
  "POST /api/v5/activities/:id/reply": async ({ q, body, emit }) => { const activity = await getActivity(q.id); if (!activity || activity.workId !== body.workId) throw new Error("Activity 不存在"); if (activity.type !== "alignment") throw new Error("只有需求澄清 Activity 支持对话回复"); const work = await getWork(body.workId); activity.status = "idle"; if (activity.gate) activity.gate.status = "pending"; return runActivity({ workId: work.id, activityId: activity.id, project: await requireWorkProject(work), prompt: body.text || "", onEvent: emit }); },
  "POST /api/v5/implementation/run": async ({ q, body, emit }) => { const work = await getWork(body.workId || q.workId); if (!work) throw new Error("Work 不存在"); return runFrontierTicket({ workId: work.id, ticketId: body.ticketId || null, project: await requireWorkProject(work), onEvent: emit }); },
};
function matchRoute(method, pathname, table) { const direct = table[`${method} ${pathname}`]; if (direct) return { handler: direct, params: {} }; for (const [key, handler] of Object.entries(table)) { const [m, pattern] = key.split(" "); if (m !== method || !pattern.includes(":")) continue; const names = []; const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, (x) => { names.push(x.slice(1)); return "([^/]+)"; })}$`); const hit = pathname.match(regex); if (hit) return { handler, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])])) }; } return null; }
function parseBody(req) { return new Promise((resolve, reject) => { let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 1_000_000) reject(new Error("body too large")); }); req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("invalid json")); } }); }); }
function sendJson(res, status, data) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); }
function sendNdjson(res, event) { res.write(`${JSON.stringify(event)}\n`); }
await migrateLegacyProject();
const server = http.createServer(async (req, res) => { const url = new URL(req.url, `http://${req.headers.host}`); const pathname = url.pathname; const q = Object.fromEntries(url.searchParams.entries()); try { const streamMatch = matchRoute(req.method, pathname, streamRoutes); if (streamMatch) { const body = req.method === "POST" ? await parseBody(req) : {}; res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" }); const emit = (e) => sendNdjson(res, e); try { const data = await streamMatch.handler({ q: { ...q, ...streamMatch.params }, body, emit }); sendNdjson(res, { type: "done", req: data }); } catch (e) { sendNdjson(res, { type: "error", message: e.message }); } return res.end(); } const match = matchRoute(req.method, pathname, routes); if (!match) return sendJson(res, 404, { error: "not found" }); const body = req.method === "POST" ? await parseBody(req) : {}; return sendJson(res, 200, await match.handler({ q: { ...q, ...match.params }, body })); } catch (e) { console.error(e); return sendJson(res, 500, { error: e.message }); } });
server.listen(PORT, () => console.log(`API http://localhost:${PORT}`));
