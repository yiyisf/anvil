import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function setup(t, title = "Adaptive BUILD") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-build-e2e-"));
  process.env.DATA_DIR = path.join(root, "data");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const [
    { createBuildWork },
    store,
    orchestrator,
    frontierModule,
    flow,
    worktreeModule,
    activityRunnerModule,
  ] = await Promise.all([
    import("./service.mjs"),
    import("../persistence/build-repository.mjs"),
    import("./orchestrator.mjs"),
    import("./ticket-frontier.mjs"),
    import("./flow.mjs"),
    import("../platform/workspace-manager.mjs"),
    import("./activity-runner.mjs"),
  ]);
  const project = {
    id: `P-${Date.now()}-${Math.random()}`,
    repoPath: root,
    worktreesDir: path.join(root, "worktrees"),
    baseBranch: "main",
  };
  const { work } = await createBuildWork({ projectId: project.id, title });
  const worktree = worktreeModule.treePath(project, work.id);
  await fs.mkdir(worktree, { recursive: true });
  return {
    root,
    worktree,
    work,
    project,
    store,
    orchestrator,
    getTicketFrontier: frontierModule.getTicketFrontier,
    createImplementationActivity: flow.createImplementationActivity,
    createActivityRunner: activityRunnerModule.createActivityRunner,
  };
}

async function approveAlignment(ctx, route) {
  let activities = await ctx.store.listActivities(ctx.work.id);
  const alignment = activities.find((a) => a.type === "alignment");
  alignment.status = "waiting_user";
  alignment.routeRecommendation = { route, reason: `test ${route}` };
  await ctx.store.saveActivity(alignment);
  await ctx.orchestrator.decideHumanGate({
    workId: ctx.work.id,
    activityId: alignment.id,
    decision: "approve",
  });
  return ctx.store.listActivities(ctx.work.id);
}

test("new BUILD remains draft until its client starts alignment", async (t) => {
  const context = await setup(t, "Draft BUILD");
  const stored = await context.store.getWork(context.work.id);
  assert.equal(stored.status, "draft");
  assert.equal(
    (await context.store.listActivities(context.work.id)).every(
      (activity) => activity.status === "idle",
    ),
    true,
  );
});

test("Fake Agent drives alignment through the production Activity interface", async (t) => {
  const context = await setup(t, "Fake Agent alignment");
  const alignment = (await context.store.listActivities(context.work.id)).find(
    (activity) => activity.type === "alignment",
  );
  let calls = 0;
  const runner = context.createActivityRunner({
    executeTurn: async () => {
      calls += 1;
      return {
        text: '需求清楚。\nANVIL_ROUTE: {"route":"direct","reason":"test"}',
        tools: [],
        files: [],
      };
    },
    loadSkillBundle: async () => [],
  });

  await runner.runActivity({
    workId: context.work.id,
    activityId: alignment.id,
    project: context.project,
  });

  const storedWork = await context.store.getWork(context.work.id);
  const storedAlignment = await context.store.getActivity(alignment.id);
  assert.equal(calls, 1);
  assert.equal(storedWork.status, "waiting_user");
  assert.equal(storedAlignment.status, "waiting_user");
  assert.equal(storedAlignment.routeRecommendation.route, "direct");
  assert.equal(storedAlignment.conversation.at(-1).text, "需求清楚。");
});

test("concurrent advances share one Alignment execution", async (t) => {
  const context = await setup(t, "Idempotent advance");
  let calls = 0;
  let invocation = "";
  const runner = context.createActivityRunner({
    executeTurn: async ({ prompt }) => {
      calls += 1;
      invocation = prompt;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { text: "需要确认范围。", tools: [], files: [] };
    },
    loadSkillBundle: async () => [],
  });
  const options = {
    workId: context.work.id,
    project: context.project,
    activityRunner: runner.runActivity,
  };

  const first = context.orchestrator.advanceBuild(options);
  const second = context.orchestrator.advanceBuild(options);
  assert.equal(first, second);
  const result = await first;

  assert.equal(calls, 1);
  assert.match(invocation, /Idempotent advance/);
  assert.equal(result.reason, "gate");
  assert.equal(
    (await context.store.getWork(context.work.id)).status,
    "waiting_user",
  );
});

test("Fake Agent completes the direct BUILD route in one Activity Session", async (t) => {
  const context = await setup(t, "Direct route");
  let turns = 0;
  const runner = context.createActivityRunner({
    executeTurn: async () => {
      turns += 1;
      return {
        text:
          turns === 1
            ? '已明确。\nANVIL_ROUTE: {"route":"direct","reason":"small"}'
            : "实现完成。",
        tools: [],
        files: [],
      };
    },
    loadSkillBundle: async () => [],
  });
  await context.orchestrator.advanceBuild({
    workId: context.work.id,
    project: context.project,
    activityRunner: runner.runActivity,
  });
  const alignment = (await context.store.listActivities(context.work.id)).find(
    (activity) => activity.type === "alignment",
  );
  const sessionId = alignment.sessionId;
  await context.orchestrator.decideHumanGate({
    workId: context.work.id,
    activityId: alignment.id,
    decision: "approve",
  });
  await context.orchestrator.advanceBuild({
    workId: context.work.id,
    project: context.project,
    activityRunner: runner.runActivity,
    continueSession: runner.continueActivitySession,
  });

  const completed = await context.store.getWork(context.work.id);
  const storedAlignment = await context.store.getActivity(alignment.id);
  assert.equal(completed.status, "completed");
  assert.equal(turns, 2);
  assert.equal(storedAlignment.sessionId, sessionId);
});

test("Fake Agent completes the specification BUILD route without Tickets", async (t) => {
  const context = await setup(t, "Specification route");
  let turns = 0;
  const runner = context.createActivityRunner({
    executeTurn: async () => {
      turns += 1;
      return {
        text:
          turns === 1
            ? '已明确。\nANVIL_ROUTE: {"route":"spec","reason":"durable design"}'
            : turns === 2
              ? "规格完成。"
              : "按规格实现完成。",
        tools: [],
        files: [],
      };
    },
    loadSkillBundle: async () => [],
  });
  await context.orchestrator.advanceBuild({
    workId: context.work.id,
    project: context.project,
    activityRunner: runner.runActivity,
  });
  const alignment = (await context.store.listActivities(context.work.id)).find(
    (activity) => activity.type === "alignment",
  );
  await context.orchestrator.decideHumanGate({
    workId: context.work.id,
    activityId: alignment.id,
    decision: "approve",
  });
  await context.orchestrator.advanceBuild({
    workId: context.work.id,
    project: context.project,
    activityRunner: runner.runActivity,
    continueSession: runner.continueActivitySession,
  });

  const activities = await context.store.listActivities(context.work.id);
  assert.equal(
    (await context.store.getWork(context.work.id)).status,
    "completed",
  );
  assert.equal(turns, 3);
  assert.equal(
    activities.find((activity) => activity.type === "planning").status,
    "idle",
  );
  assert.equal(
    activities.some((activity) => activity.type === "implementation"),
    false,
  );
});

test("Fake Agent completes dependency-ordered Ticket BUILD route", async (t) => {
  const context = await setup(t, "Ticket route");
  let turns = 0;
  const runner = context.createActivityRunner({
    executeTurn: async ({ prompt }) => {
      turns += 1;
      if (prompt.startsWith("ANVIL_PLANNING_APPROVED:")) {
        const issues = path.join(context.worktree, ".scratch", "qa", "issues");
        await fs.mkdir(issues, { recursive: true });
        await fs.writeFile(
          path.join(issues, "01-base.md"),
          "# 01: Base\\n\\n**Blocked by:** none\\n\\n- [ ] base works\\n".replaceAll(
            "\\n",
            "\n",
          ),
        );
        await fs.writeFile(
          path.join(issues, "02-next.md"),
          "# 02: Next\\n\\n**Blocked by:** 01: Base\\n\\n- [ ] next works\\n".replaceAll(
            "\\n",
            "\n",
          ),
        );
      }
      return {
        text:
          turns === 1
            ? '已明确。\nANVIL_ROUTE: {"route":"tickets","reason":"dependencies"}'
            : "阶段完成。",
        tools: [],
        files: [],
      };
    },
    loadSkillBundle: async () => [],
  });
  await context.orchestrator.advanceBuild({
    workId: context.work.id,
    project: context.project,
    activityRunner: runner.runActivity,
  });
  let activities = await context.store.listActivities(context.work.id);
  const alignment = activities.find(
    (activity) => activity.type === "alignment",
  );
  await context.orchestrator.decideHumanGate({
    workId: context.work.id,
    activityId: alignment.id,
    decision: "approve",
  });
  const planningGate = await context.orchestrator.advanceBuild({
    workId: context.work.id,
    project: context.project,
    activityRunner: runner.runActivity,
  });
  assert.equal(planningGate.reason, "gate");
  assert.equal(
    (
      await context.getTicketFrontier({
        work: await context.store.getWork(context.work.id),
        project: context.project,
      })
    ).counts.total,
    0,
    "the initial planning turn must wait for approval before publishing tickets",
  );
  const planning = (await context.store.listActivities(context.work.id)).find(
    (activity) => activity.type === "planning",
  );
  await context.orchestrator.decideHumanGate({
    workId: context.work.id,
    activityId: planning.id,
    decision: "approve",
  });
  const executedTickets = [];
  await context.orchestrator.advanceBuild({
    workId: context.work.id,
    project: context.project,
    activityRunner: runner.runActivity,
    continueSession: runner.continueActivitySession,
    ticketRunner: async ({ workId, ticketId }) => {
      executedTickets.push(ticketId);
      const implementation = (await context.store.listActivities(workId)).find(
        (activity) => activity.ticketId === ticketId,
      );
      implementation.status = "completed";
      await context.store.saveActivity(implementation);
    },
  });

  assert.equal(
    (await context.store.getWork(context.work.id)).status,
    "completed",
  );
  assert.deepEqual(executedTickets, ["01", "02"]);
  assert.equal(turns, 4);
});

test("adaptive BUILD chooses direct implementation after alignment", async (t) => {
  const ctx = await setup(t, "Tiny copy change");
  const activities = await approveAlignment(ctx, "direct");
  const work = await ctx.store.getWork(ctx.work.id);
  assert.equal(work.buildRoute, "direct");
  const next = ctx.orchestrator.decideNextBuildStep({ work, activities });
  assert.equal(next.kind, "direct_implementation");
  assert.equal(next.activity.type, "alignment");
});

test("adaptive BUILD chooses spec implementation without tickets", async (t) => {
  const ctx = await setup(t, "Single feature with durable design");
  let activities = await approveAlignment(ctx, "spec");
  let work = await ctx.store.getWork(ctx.work.id);
  assert.equal(work.buildRoute, "spec");
  let next = ctx.orchestrator.decideNextBuildStep({ work, activities });
  assert.equal(next.kind, "activity");
  assert.equal(next.activity.type, "specification");
  const specification = activities.find((a) => a.type === "specification");
  specification.status = "completed";
  specification.sessionId = "SESSION-spec-test";
  await ctx.store.saveActivity(specification);
  activities = await ctx.store.listActivities(work.id);
  work = await ctx.store.getWork(work.id);
  next = ctx.orchestrator.decideNextBuildStep({ work, activities });
  assert.equal(next.kind, "spec_implementation");
  assert.equal(next.activity.type, "specification");
  assert.equal(activities.find((a) => a.type === "planning").status, "idle");
});

test("adaptive BUILD keeps ticket frontier for decomposed work", async (t) => {
  const ctx = await setup(t, "Member upgrade");
  let activities = await approveAlignment(ctx, "tickets");
  let work = await ctx.store.getWork(ctx.work.id);
  assert.equal(work.buildRoute, "tickets");
  let next = ctx.orchestrator.decideNextBuildStep({ work, activities });
  assert.equal(next.activity.type, "specification");
  const specification = activities.find((a) => a.type === "specification");
  specification.status = "completed";
  await ctx.store.saveActivity(specification);
  activities = await ctx.store.listActivities(work.id);
  next = ctx.orchestrator.decideNextBuildStep({ work, activities });
  assert.equal(next.activity.type, "planning");
  const issuesDir = path.join(
    ctx.worktree,
    ".scratch",
    "member-upgrade",
    "issues",
  );
  await fs.mkdir(issuesDir, { recursive: true });
  await fs.writeFile(
    path.join(issuesDir, "01-base.md"),
    `# 01: Base member\n\n**Blocked by:** none\n\n- [ ] base works\n`,
  );
  await fs.writeFile(
    path.join(issuesDir, "02-upgrade.md"),
    `# 02: Upgrade member\n\n**Blocked by:** 01: Base member\n\n- [ ] upgrade works\n`,
  );
  const planning = activities.find((a) => a.type === "planning");
  planning.status = "waiting_user";
  await ctx.store.saveActivity(planning);
  await ctx.orchestrator.decideHumanGate({
    workId: work.id,
    activityId: planning.id,
    decision: "approve",
  });
  activities = await ctx.store.listActivities(work.id);
  let frontier = await ctx.getTicketFrontier({
    work: await ctx.store.getWork(work.id),
    project: ctx.project,
  });
  assert.equal(frontier.counts.total, 2);
  assert.deepEqual(
    frontier.frontier.map((ticket) => ticket.id),
    ["01"],
  );
  next = ctx.orchestrator.decideNextBuildStep({
    work: await ctx.store.getWork(work.id),
    activities,
    frontier,
  });
  assert.equal(next.kind, "ticket");
  const first = ctx.createImplementationActivity(
    work.id,
    frontier.tickets.find((ticket) => ticket.id === "01"),
  );
  first.status = "completed";
  await ctx.store.saveActivity(first);
  activities = await ctx.store.listActivities(work.id);
  frontier = await ctx.getTicketFrontier({
    work: await ctx.store.getWork(work.id),
    project: ctx.project,
  });
  assert.deepEqual(
    frontier.frontier.map((ticket) => ticket.id),
    ["02"],
  );
  const second = ctx.createImplementationActivity(
    work.id,
    frontier.tickets.find((ticket) => ticket.id === "02"),
  );
  second.status = "completed";
  await ctx.store.saveActivity(second);
  activities = await ctx.store.listActivities(work.id);
  frontier = await ctx.getTicketFrontier({
    work: await ctx.store.getWork(work.id),
    project: ctx.project,
  });
  next = ctx.orchestrator.decideNextBuildStep({
    work: await ctx.store.getWork(work.id),
    activities,
    frontier,
  });
  assert.equal(next.kind, "complete");
});
