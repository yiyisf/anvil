import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  workspaceKey,
  workspaceBinding,
  treePath,
} from "./workspace-manager.mjs";

test("BUILD UUID maps to a compact stable workspace key", () => {
  const id = "WORK-12345678-1234-5678-9abc-def012345678";
  assert.equal(workspaceKey(id), "12345678");
  assert.equal(workspaceKey(id), workspaceKey(id));
  assert.ok(workspaceKey(id).length <= 10);
});

test("arbitrary ids get short deterministic workspace keys", () => {
  const key = workspaceKey(
    "arbitrary-long-id-that-should-not-be-a-directory-name",
  );
  assert.equal(key.length, 10);
  assert.equal(
    key,
    workspaceKey("arbitrary-long-id-that-should-not-be-a-directory-name"),
  );
});

test("tree path no longer embeds the full work UUID", () => {
  const project = { worktreesDir: "C:/anvil/worktrees" };
  const id = "WORK-12345678-1234-5678-9abc-def012345678";
  const p = treePath(project, id);
  assert.ok(p.endsWith("12345678"));
  assert.ok(!p.includes(id));
});


test("agent workspace binding points to the same compact Git worktree", () => {
  const worktreesDir = "C:/anvil/worktrees";
  const id = "WORK-12345678-1234-5678-9abc-def012345678";
  const binding = workspaceBinding(worktreesDir, id);
  assert.deepEqual(binding, {
    workDir: "12345678",
    projectDir: path.join(worktreesDir, "12345678"),
  });
  assert.equal(
    binding.projectDir,
    treePath({ worktreesDir }, id),
  );
  assert.notEqual(binding.workDir, id);
});
