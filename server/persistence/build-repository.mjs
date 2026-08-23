import path from "node:path";
import { createJsonDirectoryRepository } from "./json-directory-repository.mjs";

const dataDirectory = process.env.DATA_DIR || path.resolve(".data");
const collections = Object.fromEntries(
  Object.entries({
    works: "works",
    activities: "activities",
    runs: "runs",
    agentSessions: "agent-sessions",
    interruptions: "interruptions",
  }).map(([name, directory]) => [
    name,
    createJsonDirectoryRepository(path.join(dataDirectory, directory)),
  ]),
);

const save = (kind, value) => collections[kind].save(value);
const get = (kind, id) => collections[kind].get(id);
const list = (kind, predicate) => collections[kind].list(predicate);

export const saveWork = (value) => save("works", value);
export const getWork = (id) => get("works", id);
export const listWorks = (projectId = null) =>
  list("works", (work) => !projectId || work.projectId === projectId);
export const saveActivity = (value) => save("activities", value);
export const getActivity = (id) => get("activities", id);
export const listActivities = (workId) =>
  list("activities", (activity) => activity.workId === workId);
export const saveSkillRun = (value) => save("runs", value);
export const getSkillRun = (id) => get("runs", id);
export const listSkillRuns = (activityId) =>
  list("runs", (run) => run.activityId === activityId);
export const saveAgentSession = (value) => save("agentSessions", value);
export const getAgentSession = (id) => get("agentSessions", id);
export const listAgentSessions = (workId) =>
  list("agentSessions", (session) => session.workId === workId);
export const saveInterruption = (value) => save("interruptions", value);
export const getInterruption = (id) => get("interruptions", id);
export const listInterruptions = (workId, activityId = null) =>
  list(
    "interruptions",
    (item) =>
      item.workId === workId && (!activityId || item.activityId === activityId),
  );
