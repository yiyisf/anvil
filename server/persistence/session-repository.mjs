import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const dataDirectory = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const sessionFile = (key) =>
  path.join(dataDirectory, "sessions", `${key.replace(/[\\/:]/g, "-")}.json`);

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

export async function loadSession(key) {
  try {
    return JSON.parse(await readFile(sessionFile(key), "utf8"));
  } catch {
    return null;
  }
}

export const saveSession = (key, value) => writeJson(sessionFile(key), value);
export const clearSession = (key) => writeJson(sessionFile(key), null);

export async function clearSessions(prefix) {
  const directory = path.join(dataDirectory, "sessions");
  const safePrefix = prefix.replace(/[\\/:]/g, "-");
  try {
    const files = await readdir(directory);
    await Promise.all(
      files
        .filter((file) => file.startsWith(safePrefix))
        .map((file) => writeFile(path.join(directory, file), "null", "utf8")),
    );
  } catch {
    // The collection has not been created yet.
  }
}
