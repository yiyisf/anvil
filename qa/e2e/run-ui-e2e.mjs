import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const apiPort = 8787;
const uiPort = 15173;
const processes = [];
let root;

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function start(command, args, options) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  processes.push(child);
  return child;
}

async function stopAll() {
  for (const child of processes) {
    if (child.exitCode == null) child.kill("SIGTERM");
  }
  await Promise.all(
    processes.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode != null) return resolve();
          child.once("exit", resolve);
          setTimeout(resolve, 2_000);
        }),
    ),
  );
  if (root) await fs.rm(root, { recursive: true, force: true });
}

async function waitFor(url, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`服务未在 ${timeout}ms 内就绪: ${url}`);
}

try {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-ui-e2e-"));
  const repository = path.join(root, "repository");
  const worktrees = path.join(root, "worktrees");
  const dataDirectory = path.join(root, "data");
  await fs.mkdir(repository, { recursive: true });
  git(["init", "-b", "main"], repository);
  git(["config", "user.email", "qa@example.test"], repository);
  git(["config", "user.name", "Anvil QA"], repository);
  await fs.writeFile(path.join(repository, "README.md"), "# Browser fixture\n");
  git(["add", "README.md"], repository);
  git(["commit", "-m", "fixture baseline"], repository);

  start(process.execPath, ["server/index.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(apiPort),
      DATA_DIR: dataDirectory,
    },
  });
  start(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(uiPort),
    ],
    { cwd: projectRoot, env: process.env },
  );
  await Promise.all([
    waitFor(`http://127.0.0.1:${apiPort}/api/projects`),
    waitFor(`http://127.0.0.1:${uiPort}`),
  ]);

  const test = start(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "qa/e2e/playwright.config.mjs",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        QA_REPO_PATH: repository,
        QA_WORKTREES_DIR: worktrees,
        QA_UI_URL: `http://127.0.0.1:${uiPort}`,
      },
    },
  );
  const exitCode = await new Promise((resolve) => test.once("exit", resolve));
  if (exitCode !== 0) process.exitCode = exitCode || 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopAll();
}
