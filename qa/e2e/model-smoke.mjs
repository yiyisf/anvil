import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

for (const name of ["LITELLM_BASE_URL", "PI_MODEL"]) {
  if (!process.env[name]) throw new Error(`真实模型 E2E 缺少环境变量: ${name}`);
}

const projectRoot = path.resolve(import.meta.dirname, "../..");
const route = process.env.MODEL_E2E_ROUTE || "direct";
if (!["direct", "tickets"].includes(route))
  throw new Error(`不支持的 MODEL_E2E_ROUTE: ${route}`);
const port = 18878;
const baseUrl = `http://127.0.0.1:${port}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-model-e2e-"));
const repository = path.join(root, "repository");
const worktreesDir = path.join(root, "worktrees");
const dataDirectory = path.join(root, "data");
let server;

function git(args) {
  execFileSync("git", args, { cwd: repository, stdio: "ignore" });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/projects`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("模型 E2E API 启动超时");
}

async function json(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function stream(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const events = text.trim().split("\n").filter(Boolean).map(JSON.parse);
  const error = events.find((event) => event.type === "error");
  if (error) throw new Error(error.message);
  return events.findLast((event) => event.type === "done")?.req;
}

try {
  await fs.mkdir(repository, { recursive: true });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "qa@example.test"]);
  git(["config", "user.name", "Anvil Model QA"]);
  await fs.writeFile(
    path.join(repository, "README.md"),
    "# Before\n\nThis repository is a model E2E fixture.\n",
  );
  git(["add", "README.md"]);
  git(["commit", "-m", "baseline"]);

  server = spawn(process.execPath, ["server/index.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDirectory,
    },
    stdio: "inherit",
  });
  await waitForServer();

  const project = await json("/api/projects", {
    method: "POST",
    body: {
      name: "Model E2E",
      repoPath: repository,
      worktreesDir,
      baseBranch: "main",
    },
  });
  const created = await json("/api/v5/works", {
    method: "POST",
    body: {
      projectId: project.id,
      title:
        route === "direct"
          ? "Change only the first heading in README.md from '# Before' to '# After'. This is a tiny direct task with no open questions."
          : "Update README.md in two dependency-ordered steps: first change '# Before' to '# After', then append a 'Status: verified' section that depends on the heading change. There are no open questions.",
    },
  });
  const workId = created.work.id;
  const alignmentResult = await stream("/api/v5/build/advance", { workId });
  assert.equal(alignmentResult.reason, "gate");
  const detail = await json(`/api/v5/works/${workId}`);
  const alignment = detail.activities.find(
    (activity) => activity.type === "alignment",
  );
  await json(`/api/v5/activities/${alignment.id}/gate`, {
    method: "POST",
    body: { workId, decision: "approve", route },
  });
  if (route === "tickets") {
    const planningResult = await stream("/api/v5/build/advance", { workId });
    assert.equal(planningResult.reason, "gate");
    const planned = await json(`/api/v5/works/${workId}`);
    const planning = planned.activities.find(
      (activity) => activity.type === "planning",
    );
    await json(`/api/v5/activities/${planning.id}/gate`, {
      method: "POST",
      body: { workId, decision: "approve" },
    });
  }
  const implementationResult = await stream("/api/v5/build/advance", {
    workId,
  });
  assert.equal(implementationResult.reason, "completed");
  const completed = await json(`/api/v5/works/${workId}`);
  assert.equal(completed.work.status, "completed");
  const [workspace] = await fs.readdir(worktreesDir);
  assert.match(
    await fs.readFile(path.join(worktreesDir, workspace, "README.md"), "utf8"),
    /^# After/m,
  );
  if (route === "tickets") {
    assert.match(
      await fs.readFile(
        path.join(worktreesDir, workspace, "README.md"),
        "utf8",
      ),
      /Status: verified/,
    );
  }
  console.log(`真实模型 ${route} E2E 通过: ${workId}`);
} finally {
  if (server?.exitCode == null) server.kill("SIGTERM");
  await fs.rm(root, { recursive: true, force: true });
}
