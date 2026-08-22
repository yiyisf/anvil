import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function setup(t, title = "Adaptive BUILD") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-build-e2e-"));
  process.env.DATA_DIR = path.join(root, "data");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const [{ createBuildWork }, store, orchestrator, frontierModule, flow, worktreeModule] = await Promise.all([
    import("./v5-service.mjs"), import("./store-v5.mjs"), import("./build-orchestrator-v5.mjs"), import("./ticket-frontier-v5.mjs"), import("./build-flow.mjs"), import("./worktree.mjs"),
  ]);
  const project = { id: `P-${Date.now()}-${Math.random()}`, repoPath: root, worktreesDir: path.join(root, "worktrees"), baseBranch: "main" };
  const { work } = await createBuildWork({ projectId: project.id, title });
  const worktree = worktreeModule.treePath(project, work.id); await fs.mkdir(worktree, { recursive: true });
  return { root, worktree, work, project, store, orchestrator, getTicketFrontier: frontierModule.getTicketFrontier, createImplementationActivity: flow.createImplementationActivity };
}

async function approveAlignment(ctx, route) {
  let activities = await ctx.store.listActivities(ctx.work.id); const alignment = activities.find((a) => a.type === "alignment");
  alignment.status = "waiting_user"; alignment.routeRecommendation = { route, reason: `test ${route}` }; await ctx.store.saveActivity(alignment);
  await ctx.orchestrator.decideHumanGate({ workId: ctx.work.id, activityId: alignment.id, decision: "approve" });
  return ctx.store.listActivities(ctx.work.id);
}

test("adaptive BUILD chooses direct implementation after alignment", async (t) => {
  const ctx = await setup(t, "Tiny copy change"); const activities = await approveAlignment(ctx, "direct"); const work = await ctx.store.getWork(ctx.work.id);
  assert.equal(work.buildRoute, "direct"); const next = ctx.orchestrator.decideNextBuildStep({ work, activities }); assert.equal(next.kind, "direct_implementation"); assert.equal(next.activity.type, "alignment");
});

test("adaptive BUILD chooses spec implementation without tickets", async (t) => {
  const ctx = await setup(t, "Single feature with durable design"); let activities = await approveAlignment(ctx, "spec"); let work = await ctx.store.getWork(ctx.work.id);
  assert.equal(work.buildRoute, "spec"); let next = ctx.orchestrator.decideNextBuildStep({ work, activities }); assert.equal(next.kind, "activity"); assert.equal(next.activity.type, "specification");
  const specification = activities.find((a) => a.type === "specification"); specification.status = "completed"; specification.sessionId = "SESSION-spec-test"; await ctx.store.saveActivity(specification);
  activities = await ctx.store.listActivities(work.id); work = await ctx.store.getWork(work.id); next = ctx.orchestrator.decideNextBuildStep({ work, activities }); assert.equal(next.kind, "spec_implementation"); assert.equal(next.activity.type, "specification");
  assert.equal(activities.find((a) => a.type === "planning").status, "idle");
});

test("adaptive BUILD keeps ticket frontier for decomposed work", async (t) => {
  const ctx = await setup(t, "Member upgrade"); let activities = await approveAlignment(ctx, "tickets"); let work = await ctx.store.getWork(ctx.work.id);
  assert.equal(work.buildRoute, "tickets"); let next = ctx.orchestrator.decideNextBuildStep({ work, activities }); assert.equal(next.activity.type, "specification");
  const specification = activities.find((a) => a.type === "specification"); specification.status = "completed"; await ctx.store.saveActivity(specification); activities = await ctx.store.listActivities(work.id); next = ctx.orchestrator.decideNextBuildStep({ work, activities }); assert.equal(next.activity.type, "planning");
  const issuesDir = path.join(ctx.worktree, ".scratch", "member-upgrade", "issues"); await fs.mkdir(issuesDir, { recursive: true }); await fs.writeFile(path.join(issuesDir, "01-base.md"), `# 01: Base member\n\n**Blocked by:** none\n\n- [ ] base works\n`); await fs.writeFile(path.join(issuesDir, "02-upgrade.md"), `# 02: Upgrade member\n\n**Blocked by:** 01: Base member\n\n- [ ] upgrade works\n`);
  const planning = activities.find((a) => a.type === "planning"); planning.status = "waiting_user"; await ctx.store.saveActivity(planning); await ctx.orchestrator.decideHumanGate({ workId: work.id, activityId: planning.id, decision: "approve" }); activities = await ctx.store.listActivities(work.id);
  let frontier = await ctx.getTicketFrontier({ work: await ctx.store.getWork(work.id), project: ctx.project }); assert.equal(frontier.counts.total, 2); assert.deepEqual(frontier.frontier.map((ticket) => ticket.id), ["01"]); next = ctx.orchestrator.decideNextBuildStep({ work: await ctx.store.getWork(work.id), activities, frontier }); assert.equal(next.kind, "ticket");
  const first = ctx.createImplementationActivity(work.id, frontier.tickets.find((ticket) => ticket.id === "01")); first.status = "completed"; await ctx.store.saveActivity(first); activities = await ctx.store.listActivities(work.id); frontier = await ctx.getTicketFrontier({ work: await ctx.store.getWork(work.id), project: ctx.project }); assert.deepEqual(frontier.frontier.map((ticket) => ticket.id), ["02"]);
  const second = ctx.createImplementationActivity(work.id, frontier.tickets.find((ticket) => ticket.id === "02")); second.status = "completed"; await ctx.store.saveActivity(second); activities = await ctx.store.listActivities(work.id); frontier = await ctx.getTicketFrontier({ work: await ctx.store.getWork(work.id), project: ctx.project }); next = ctx.orchestrator.decideNextBuildStep({ work: await ctx.store.getWork(work.id), activities, frontier }); assert.equal(next.kind, "complete");
});
