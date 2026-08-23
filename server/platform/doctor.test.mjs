import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureWorktree, treePath } from "./workspace-manager.mjs";

const projectRoot = path.resolve(import.meta.dirname, "../..");

test("doctor reaches configuration validation after platform modules load", () => {
  const env = { ...process.env };
  delete env.WORKTREES_DIR;
  const result = spawnSync(process.execPath, ["doctor.mjs"], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /未设置 WORKTREES_DIR/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
});

test("doctor resolves a BUILD Work ID to its compact workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-doctor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const worktreesDir = path.join(root, "worktrees");
  await fs.mkdir(repository, { recursive: true });
  const git = (args) =>
    execFileSync("git", args, { cwd: repository, stdio: "ignore" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "qa@example.test"]);
  git(["config", "user.name", "Anvil QA"]);
  await fs.writeFile(path.join(repository, "README.md"), "# fixture\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "baseline"]);
  const workId = "WORK-12345678-1234-1234-1234-123456789abc";
  const project = {
    id: "PRJ-DOCTOR",
    repoPath: repository,
    worktreesDir,
    baseBranch: "main",
  };
  await ensureWorktree(project, workId);

  const result = spawnSync(process.execPath, ["doctor.mjs", workId], {
    cwd: projectRoot,
    env: {
      ...process.env,
      WORKTREES_DIR: worktreesDir,
      REPO_PATH: repository,
      SANDBOX_TOOLS: "node",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    new RegExp(
      treePath(project, workId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
  assert.match(result.stdout, /【结论提示】/);
});
