import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Core-chain E2E for Anvil-owned orchestration.
 * Agent/model execution is intentionally replaced by the state/artifacts it
 * would produce, so this test can run in CI without model credentials while
 * still crossing the real store, human gates, Matt ticket artifacts, frontier
 * derivation, and BUILD state-machine decisions.
 */
test("BUILD core chain reaches completion through both human gates and ticket frontier", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-build-e2e-"));
  const dataDir = path.join(root, "data");
  const worktreesDir = path.join(root, "worktrees");
  process.env.DATA_DIR = dataDir;
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const [{ createBuildWork }, store, orchestrator, { getTicketFrontier }, { createImplementationActivity }] = await Promise.all([
    import("./v5-service.mjs"),
    import("./store-v5.mjs"),
    import("./build-orchestrator-v5.mjs"),
    import("./ticket-frontier-v5.mjs"),
    import("./build-flow.mjs"),
  ]);

  const project = { id: "P-E2E", repoPath: root, worktreesDir, baseBranch: "main" };
  const { work } = await createBuildWork({ projectId: project.id, title: "Member upgrade" });
  const worktree = path.join(worktreesDir, work.id);
  await fs.mkdir(worktree, { recursive: true });

  let activities = await store.listActivities(work.id);
  let next = orchestrator.decideNextBuildStep({ work, activities });
  assert.equal(next.kind, "activity");
  assert.equal(next.activity.type, "alignment");

  // grill-with-docs finishes and asks the product owner to confirm boundaries.
  let alignment = activities.find((a) => a.type === "alignment");
  alignment.status = "waiting_user";
  await store.saveActivity(alignment);
  activities = await store.listActivities(work.id);
  next = orchestrator.decideNextBuildStep({ work: await store.getWork(work.id), activities });
  assert.equal(next.kind, "gate");
  assert.equal(next.activity.type, "alignment");

  await orchestrator.decideHumanGate({ workId: work.id, activityId: alignment.id, decision: "approve" });
  activities = await store.listActivities(work.id);
  next = orchestrator.decideNextBuildStep({ work: await store.getWork(work.id), activities });
  assert.equal(next.kind, "activity");
  assert.equal(next.activity.type, "specification");

  // to-spec is deliberately non-gated and auto-advances once completed.
  const specification = activities.find((a) => a.type === "specification");
  specification.status = "completed";
  await store.saveActivity(specification);
  activities = await store.listActivities(work.id);
  next = orchestrator.decideNextBuildStep({ work: await store.getWork(work.id), activities });
  assert.equal(next.kind, "activity");
  assert.equal(next.activity.type, "planning");

  // to-tickets produces the current Matt local tracker format.
  const issuesDir = path.join(worktree, ".scratch", "member-upgrade", "issues");
  await fs.mkdir(issuesDir, { recursive: true });
  await fs.writeFile(path.join(issuesDir, "01-base.md"), `# 01: Base member\n\n**Blocked by:** none\n\n- [ ] base works\n`);
  await fs.writeFile(path.join(issuesDir, "02-upgrade.md"), `# 02: Upgrade member\n\n**Blocked by:** 01: Base member\n\n- [ ] upgrade works\n`);

  const planning = activities.find((a) => a.type === "planning");
  planning.status = "waiting_user";
  await store.saveActivity(planning);
  activities = await store.listActivities(work.id);
  next = orchestrator.decideNextBuildStep({ work: await store.getWork(work.id), activities });
  assert.equal(next.kind, "gate");
  assert.equal(next.activity.type, "planning");

  await orchestrator.decideHumanGate({ workId: work.id, activityId: planning.id, decision: "approve" });
  activities = await store.listActivities(work.id);

  let frontier = await getTicketFrontier({ work: await store.getWork(work.id), project });
  assert.equal(frontier.counts.total, 2);
  assert.deepEqual(frontier.frontier.map((ticket) => ticket.id), ["01"]);
  next = orchestrator.decideNextBuildStep({ work: await store.getWork(work.id), activities, frontier });
  assert.equal(next.kind, "ticket");
  assert.equal(next.ticket.id, "01");

  // /implement ticket 01 completes; dependency graph must unlock ticket 02.
  const first = createImplementationActivity(work.id, frontier.tickets.find((ticket) => ticket.id === "01"));
  first.status = "completed";
  await store.saveActivity(first);
  activities = await store.listActivities(work.id);
  frontier = await getTicketFrontier({ work: await store.getWork(work.id), project });
  assert.equal(frontier.tickets.find((ticket) => ticket.id === "01").status, "completed");
  assert.deepEqual(frontier.frontier.map((ticket) => ticket.id), ["02"]);
  next = orchestrator.decideNextBuildStep({ work: await store.getWork(work.id), activities, frontier });
  assert.equal(next.kind, "ticket");
  assert.equal(next.ticket.id, "02");

  const second = createImplementationActivity(work.id, frontier.tickets.find((ticket) => ticket.id === "02"));
  second.status = "completed";
  await store.saveActivity(second);
  activities = await store.listActivities(work.id);
  frontier = await getTicketFrontier({ work: await store.getWork(work.id), project });
  assert.equal(frontier.counts.completed, 2);
  assert.equal(frontier.frontier.length, 0);

  next = orchestrator.decideNextBuildStep({ work: await store.getWork(work.id), activities, frontier });
  assert.equal(next.kind, "complete");
});
