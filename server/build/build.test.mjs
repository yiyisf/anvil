import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILD_ACTIVITY_DEFINITIONS, createBuildActivities } from "./flow.mjs";
import {
  parseLocalTicket,
  ticketFrontier,
  readDiscoveredLocalTickets,
} from "./ticket-adapter.mjs";
import { decideNextBuildStep } from "./orchestrator.mjs";
import { continuationPrompt } from "./session-lifecycle.mjs";
import { recoveryDecision } from "./recovery-policy.mjs";
import {
  dynamicApprovalGate,
  parseAlignmentDecision,
} from "./decision-protocol.mjs";

test("BUILD flow uses Matt native skill chain", () => {
  assert.deepEqual(
    BUILD_ACTIVITY_DEFINITIONS.map((x) => x.skill),
    ["grill-with-docs", "to-spec", "to-tickets"],
  );
});

test("BUILD starts without fixed approval gates", () => {
  const activities = createBuildActivities("W-1");
  assert.equal(
    activities.every((activity) => activity.gate === null),
    true,
  );
});

test("Alignment protocol selects a route without leaking its marker", () => {
  const parsed = parseAlignmentDecision(
    '需求明确，可以直接开始。\nANVIL_DECISION: {"status":"ready","route":"direct","confidence":0.94,"reason":"局部修改","risk":"low","requiresApproval":false,"question":""}',
  );
  assert.equal(parsed.error, null);
  assert.equal(parsed.clean, "需求明确，可以直接开始。");
  assert.equal(parsed.decision.route, "direct");
  assert.equal(parsed.decision.decisionSummary, "");
  assert.equal(dynamicApprovalGate(parsed.decision), null);
});

test("Alignment protocol keeps concise decision history fields", () => {
  const parsed = parseAlignmentDecision(
    '继续确认。\nANVIL_DECISION: {"status":"needs_input","route":null,"confidence":0.9,"reason":"边界待确认","risk":"low","requiresApproval":false,"question":"是否兼容旧接口？","decisionSummary":"目标用户仅为内部工程师"}',
  );
  assert.equal(parsed.error, null);
  assert.equal(parsed.decision.question, "是否兼容旧接口？");
  assert.equal(parsed.decision.decisionSummary, "目标用户仅为内部工程师");
});

test("high-risk Alignment decisions create a dynamic approval gate", () => {
  const parsed = parseAlignmentDecision(
    '涉及不可逆数据迁移。\nANVIL_DECISION: {"status":"ready","route":"spec","confidence":0.8,"reason":"不可逆迁移","risk":"high","requiresApproval":false,"question":""}',
  );
  const gate = dynamicApprovalGate(parsed.decision);
  assert.equal(gate.status, "waiting");
  assert.match(gate.prompt, /不可逆迁移/);
});

test("missing Alignment decision never defaults to tickets", () => {
  const parsed = parseAlignmentDecision("需求已经清楚。");
  assert.equal(parsed.decision, null);
  assert.match(parsed.error, /缺少 ANVIL_DECISION/);
});

test("orchestrator stops at human gate instead of running ahead", () => {
  const activities = createBuildActivities("W-1");
  activities[0].status = "waiting_user";
  assert.equal(
    decideNextBuildStep({ work: { id: "W-1", buildRoute: null }, activities }).kind,
    "gate",
  );
});

test("orchestrator automatically advances non-gated specification", () => {
  const activities = createBuildActivities("W-1");
  activities[0].status = "completed";
  assert.deepEqual(
    decideNextBuildStep({
      work: { id: "W-1", buildRoute: "tickets" },
      activities,
    }).activity.type,
    "specification",
  );
});

test("orchestrator selects frontier ticket after approved planning", () => {
  const activities = createBuildActivities("W-1");
  activities.forEach((x) => {
    x.status = "completed";
  });
  const frontier = {
    counts: { total: 2, completed: 0, running: 0 },
    frontier: [{ id: "01", title: "Base" }],
  };
  const next = decideNextBuildStep({
    work: { id: "W-1" },
    activities,
    frontier,
  });
  assert.equal(next.kind, "ticket");
  assert.equal(next.ticket.id, "01");
});

test("orchestrator completes BUILD after all tickets complete", () => {
  const activities = createBuildActivities("W-1");
  activities.forEach((x) => {
    x.status = "completed";
  });
  const frontier = {
    counts: { total: 2, completed: 2, running: 0 },
    frontier: [],
  };
  assert.equal(
    decideNextBuildStep({ work: { id: "W-1" }, activities, frontier }).kind,
    "complete",
  );
});

test("fresh session continuation carries handoff and original task", () => {
  const prompt = continuationPrompt(
    { text: "Ticket 02 is active. Spec is .scratch/member/spec.md." },
    "Resolve the failing validation.",
  );
  assert.match(prompt, /Ticket 02 is active/);
  assert.match(prompt, /Resolve the failing validation/);
  assert.match(prompt, /durable worktree artifacts/i);
});

test("context exhaustion chooses bounded fresh-session recovery", () => {
  const interruption = { type: "context_exhausted", signature: "context:1" };
  const decision = recoveryDecision(interruption, []);
  assert.equal(decision.action, "recover");
  assert.equal(decision.strategy, "fresh_session");
});

test("parses local Matt ticket and blockers", () => {
  const ticket = parseLocalTicket(
    `# 02: Member upgrade\n\n**What to build:** upgrade\n\n**Blocked by:** 01: Base member\n\n**Status:** ready-for-agent\n\n- [ ] upgrade works\n`,
  );
  assert.equal(ticket.id, "02");
  assert.deepEqual(ticket.dependencies, ["01"]);
});

test("frontier only contains unblocked tickets", () => {
  const tickets = [
    { id: "01", dependencies: [] },
    { id: "02", dependencies: ["01"] },
  ];
  assert.deepEqual(
    ticketFrontier(tickets).map((x) => x.id),
    ["01"],
  );
  assert.deepEqual(
    ticketFrontier(tickets, new Set(["01"])).map((x) => x.id),
    ["02"],
  );
});

test("discovers Matt .scratch feature issue files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const issues = path.join(root, ".scratch", "member-login", "issues");
  await fs.mkdir(issues, { recursive: true });
  await fs.writeFile(
    path.join(issues, "01-base.md"),
    `# 01: Base member\n\n**Blocked by:** none\n\n- [ ] base works\n`,
  );
  await fs.writeFile(
    path.join(issues, "02-upgrade.md"),
    `# 02: Upgrade\n\n**Blocked by:** 01: Base member\n\n- [ ] upgrade works\n`,
  );
  const found = await readDiscoveredLocalTickets(root);
  assert.equal(found.featureSlug, "member-login");
  assert.deepEqual(
    found.tickets.map((x) => x.id),
    ["01", "02"],
  );
  assert.deepEqual(
    ticketFrontier(found.tickets).map((x) => x.id),
    ["01"],
  );
});
