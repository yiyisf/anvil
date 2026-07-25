/**
 * 存储层（草稿版用文件；生产换 Postgres/MinIO 只需替换这四个函数）
 *   - 需求状态：阶段、对话、已定条目、运行记录
 *   - 会话持久化：resumeState + jsonl（无状态多轮的载体）
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const DATA = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const reqFile = (id) => path.join(DATA, "reqs", `${id}.json`);
const sessFile = (key) => path.join(DATA, "sessions", `${key.replace(/[\\/:]/g, "-")}.json`);

async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}
async function writeJson(p, obj) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(obj, null, 2), "utf8");
}

/* ── 需求 ─────────────────────────────── */
export async function listReqs() {
  try {
    const files = await readdir(path.join(DATA, "reqs"));
    const all = await Promise.all(
      files.filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(DATA, "reqs", f)))
    );
    return all.filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}

export const getReq = (id) => readJson(reqFile(id));

export async function saveReq(req) {
  await writeJson(reqFile(req.id), req);
  return req;
}

export function newReq(title) {
  const id = `REQ-${Date.now().toString(36).slice(-5).toUpperCase()}`;
  return {
    id,
    title,
    phase: "analysis", // analysis | impl | done
    dialog: [],        // 分析阶段对话
    settled: { fixed: [], open: [] },
    implChat: [],      // 实现阶段对话
    tickets: [],       // [{ticket,title,skills:[{name,state,tools,files,note,detail}]}]
    createdAt: new Date().toISOString(),
  };
}

/* ── 会话（无状态多轮）────────────────── */
export const loadSession = (key) => readJson(sessFile(key));
export const saveSession = (key, data) => writeJson(sessFile(key), data);
export const clearSession = (key) => writeJson(sessFile(key), null);

/** 按前缀批量清理会话（会话已按工单拆分，作废重跑要清掉全部 impl-*） */
export async function clearSessions(prefix) {
  const dir = path.join(DATA, "sessions");
  const safe = prefix.replace(/[\\/:]/g, "-");
  try {
    const files = await readdir(dir);
    await Promise.all(
      files.filter((f) => f.startsWith(safe)).map((f) => writeFile(path.join(dir, f), "null", "utf8"))
    );
  } catch { /* 目录不存在 */ }
}
