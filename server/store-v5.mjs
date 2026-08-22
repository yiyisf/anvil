import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve(".data");
const dirs = {
  works: path.join(DATA_DIR, "works"),
  activities: path.join(DATA_DIR, "activities"),
  runs: path.join(DATA_DIR, "runs"),
  agentSessions: path.join(DATA_DIR, "agent-sessions"),
  interruptions: path.join(DATA_DIR, "interruptions"),
};

async function ensure(dir) { await fs.mkdir(dir, { recursive: true }); }
function file(dir, id) { return path.join(dir, `${id}.json`); }

async function save(kind, value) {
  const dir = dirs[kind]; await ensure(dir); value.updatedAt = new Date().toISOString();
  await fs.writeFile(file(dir, value.id), JSON.stringify(value, null, 2)); return value;
}
async function get(kind, id) { try { return JSON.parse(await fs.readFile(file(dirs[kind], id), "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function list(kind, predicate = () => true) { const dir = dirs[kind]; await ensure(dir); const names = await fs.readdir(dir); const values = []; for (const name of names.filter((x) => x.endsWith(".json"))) { const value = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")); if (predicate(value)) values.push(value); } return values; }

export const saveWork = (value) => save("works", value);
export const getWork = (id) => get("works", id);
export const listWorks = (projectId = null) => list("works", (w) => !projectId || w.projectId === projectId);
export const saveActivity = (value) => save("activities", value);
export const getActivity = (id) => get("activities", id);
export const listActivities = (workId) => list("activities", (a) => a.workId === workId);
export const saveSkillRun = (value) => save("runs", value);
export const getSkillRun = (id) => get("runs", id);
export const listSkillRuns = (activityId) => list("runs", (r) => r.activityId === activityId);
export const saveAgentSession = (value) => save("agentSessions", value);
export const getAgentSession = (id) => get("agentSessions", id);
export const listAgentSessions = (workId) => list("agentSessions", (s) => s.workId === workId);
export const saveInterruption = (value) => save("interruptions", value);
export const getInterruption = (id) => get("interruptions", id);
export const listInterruptions = (workId, activityId = null) => list("interruptions", (x) => x.workId === workId && (!activityId || x.activityId === activityId));
