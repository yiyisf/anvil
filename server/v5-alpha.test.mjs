import test from "node:test";
import assert from "node:assert/strict";
import { BUILD_ACTIVITY_DEFINITIONS } from "./build-flow.mjs";
import { parseLocalTicket, ticketFrontier } from "./ticket-adapter.mjs";
import { projectLegacyReqToWork } from "./v4-compat.mjs";

test("BUILD flow uses Matt native skill chain", () => {
  assert.deepEqual(
    BUILD_ACTIVITY_DEFINITIONS.map((x) => x.skill),
    ["grill-with-docs", "to-spec", "to-tickets"],
  );
});

test("parses local Matt ticket and blockers", () => {
  const ticket = parseLocalTicket(`# 02: Member upgrade\n\n**What to build:** upgrade\n\n**Blocked by:** 01: Base member\n\n**Status:** ready-for-agent\n\n- [ ] upgrade works\n`);
  assert.equal(ticket.id, "02");
  assert.deepEqual(ticket.dependencies, ["01"]);
});

test("frontier only contains unblocked tickets", () => {
  const tickets = [
    { id: "01", dependencies: [] },
    { id: "02", dependencies: ["01"] },
  ];
  assert.deepEqual(ticketFrontier(tickets).map((x) => x.id), ["01"]);
  assert.deepEqual(ticketFrontier(tickets, new Set(["01"])).map((x) => x.id), ["02"]);
});

test("legacy req can be projected without destructive migration", () => {
  const work = projectLegacyReqToWork({ id: "REQ-1", projectId: "P-1", title: "Login", phase: "analysis" });
  assert.equal(work.mode, "build");
  assert.equal(work.compatibility, true);
});
