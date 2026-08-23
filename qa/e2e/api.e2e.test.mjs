import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const port = 19000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let root;
let repository;
let worktrees;
let dataDirectory;
let server;
let project;
let work;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function waitForServer(child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null)
      throw new Error(`API server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/projects`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("API server did not become ready within 20 seconds");
}

async function startServer() {
  const logs = [];
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  child.qaLogs = logs;
  await waitForServer(child);
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

async function request(pathname, { method = "GET", body, headers } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers:
      body === undefined
        ? headers
        : { "content-type": "application/json", ...headers },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, headers: response.headers, text, json };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-professional-e2e-"));
  repository = path.join(root, "fixture-repository");
  worktrees = path.join(root, "worktrees");
  dataDirectory = path.join(root, "data");
  await fs.mkdir(repository, { recursive: true });
  git(["init", "-b", "main"], repository);
  git(["config", "user.email", "qa@example.test"], repository);
  git(["config", "user.name", "Anvil QA"], repository);
  await fs.writeFile(path.join(repository, "README.md"), "# QA fixture\n");
  git(["add", "README.md"], repository);
  git(["commit", "-m", "fixture baseline"], repository);
  server = await startServer();
});

after(async () => {
  await stopServer(server);
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test("QA-API-001 unknown routes return a JSON 404", async () => {
  const response = await request("/api/does-not-exist");
  assert.equal(response.status, 404);
  assert.deepEqual(response.json, { error: "not found" });
});

test("QA-API-002 malformed JSON is rejected without terminating the server", async () => {
  const malformed = await request("/api/projects", {
    method: "POST",
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.json, { error: "invalid json" });
  assert.equal((await request("/api/projects")).status, 200);
});

test("QA-API-003 project validation, creation, lookup and listing", async () => {
  const invalid = await request("/api/projects", {
    method: "POST",
    body: { name: "Incomplete" },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, "repoPath 和 worktreesDir 必填");
  const created = await request("/api/projects", {
    method: "POST",
    body: {
      name: "E2E Project",
      repoPath: repository,
      worktreesDir: worktrees,
      baseBranch: "main",
    },
  });
  assert.equal(created.status, 200);
  assert.match(created.json.id, /^PRJ-/);
  project = created.json;
  const fetched = await request(
    `/api/projects/${encodeURIComponent(project.id)}`,
  );
  assert.equal(fetched.json.name, "E2E Project");
  const listed = await request("/api/projects");
  assert.ok(listed.json.some((candidate) => candidate.id === project.id));
  const missing = await request("/api/projects/PRJ-MISSING");
  assert.equal(missing.status, 404);
});

test("QA-API-004 BUILD creation provisions isolated worktree and initial domain records", async () => {
  const created = await request("/api/v5/works", {
    method: "POST",
    body: { title: "QA BUILD", projectId: project.id },
  });
  assert.equal(created.status, 200);
  work = created.json.work;
  assert.match(work.id, /^WORK-/);
  assert.equal(work.title, "QA BUILD");
  assert.equal(created.json.activities.length, 3);
  assert.deepEqual(
    created.json.activities.map((activity) => activity.type),
    ["alignment", "specification", "planning"],
  );
  const entries = await fs.readdir(worktrees);
  assert.equal(entries.length, 1);
  assert.ok(
    entries[0].length <= 10,
    `workspace key is unexpectedly long: ${entries[0]}`,
  );
  assert.equal(
    git(
      ["branch", "--show-current"],
      path.join(worktrees, entries[0]),
    ).startsWith("agent/"),
    true,
  );
});

test("QA-API-005 BUILD detail, project filtering and empty ticket frontier", async () => {
  const detail = await request(`/api/v5/works/${encodeURIComponent(work.id)}`);
  assert.equal(detail.json.work.id, work.id);
  assert.equal(detail.json.activities.length, 3);
  const filtered = await request(
    `/api/v5/works?projectId=${encodeURIComponent(project.id)}`,
  );
  assert.deepEqual(
    filtered.json.map((item) => item.id),
    [work.id],
  );
  const excluded = await request("/api/v5/works?projectId=PRJ-OTHER");
  assert.deepEqual(excluded.json, []);
  const frontier = await request(
    `/api/v5/works/${encodeURIComponent(work.id)}/tickets`,
  );
  assert.equal(frontier.json.counts.total, 0);
  assert.deepEqual(frontier.json.frontier, []);
});

test("QA-API-006 missing BUILD stream target returns a framed NDJSON error", async () => {
  const response = await request("/api/v5/build/advance", {
    method: "POST",
    body: { workId: "WORK-MISSING" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
  const events = response.text.trim().split("\n").map(JSON.parse);
  assert.equal(events[0].type, "error");
  assert.match(events[0].message, /Work 不存在/);
});

test("QA-API-007 Legacy Requirement lifecycle is no longer exposed", async () => {
  for (const [method, pathname] of [
    ["GET", "/api/reqs"],
    ["POST", "/api/reqs"],
    ["GET", "/api/req?id=REQ-REMOVED"],
  ]) {
    const response = await request(pathname, {
      method,
      body: method === "POST" ? {} : undefined,
    });
    assert.equal(response.status, 404);
  }
});

test("QA-API-008 invalid Gate state returns an HTTP conflict", async () => {
  const detail = await request(`/api/v5/works/${work.id}`);
  const alignment = detail.json.activities.find(
    (activity) => activity.type === "alignment",
  );
  const response = await request(`/api/v5/activities/${alignment.id}/gate`, {
    method: "POST",
    body: { workId: work.id, decision: "approve" },
  });
  assert.equal(response.status, 409);
  assert.match(response.json.error, /等待确认状态/);
});

test("QA-API-009 project and BUILD state survive an API process restart", async () => {
  await stopServer(server);
  server = await startServer();
  const persistedProject = await request(`/api/projects/${project.id}`);
  const persistedWork = await request(`/api/v5/works/${work.id}`);
  assert.equal(persistedProject.json.name, "E2E Project");
  assert.equal(persistedWork.json.work.title, "QA BUILD");
  assert.equal(persistedWork.json.activities.length, 3);
});

test("QA-API-010 a newly created BUILD is draft until a client starts alignment", async () => {
  const detail = await request(`/api/v5/works/${work.id}`);
  const alignment = detail.json.activities.find(
    (activity) => activity.type === "alignment",
  );
  assert.equal(detail.json.work.status, "draft");
  assert.equal(alignment.status, "idle");
});

for (const [id, method, pathname] of [
  ["QA-LEGACY-011", "POST", "/api/message?id=REQ-MISSING"],
  ["QA-LEGACY-012", "POST", "/api/handoff?id=REQ-MISSING"],
  ["QA-LEGACY-013", "POST", "/api/run?id=REQ-MISSING"],
  ["QA-LEGACY-014", "POST", "/api/settled?id=REQ-MISSING"],
  ["QA-LEGACY-015", "GET", "/api/events?id=REQ-MISSING"],
]) {
  test(`${id} removed Legacy endpoint stays unavailable: ${method} ${pathname.split("?")[0]}`, async () => {
    const response = await request(pathname, {
      method,
      body: method === "POST" ? {} : undefined,
    });
    assert.equal(response.status, 404, "Legacy endpoints must remain removed");
  });
}
