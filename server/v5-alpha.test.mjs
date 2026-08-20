import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILD_ACTIVITY_DEFINITIONS } from "./build-flow.mjs";
import { parseLocalTicket, ticketFrontier, readDiscoveredLocalTickets } from "./ticket-adapter.mjs";
import { projectLegacyReqToWork } from "./v4-compat.mjs";

test("BUILD flow uses Matt native skill chain", () => {
  assert.deepEqual(BUILD_ACTIVITY_DEFINITIONS.map((x) => x.skill), ["grill-with-docs", "to-spec", "to-tickets"]);
});

test("parses local Matt ticket and blockers", () => {
  const ticket = parseLocalTicket(`# 02: Member upgrade\n\n**What to build:** upgrade\n\n**Blocked by:** 01: Base member\n\n**Status:** ready-for-agent\n\n- [ ] upgrade works\n`);
  assert.equal(ticket.id, "02");
  assert.deepEqual(ticket.dependencies, ["01"]);
});

test("frontier only contains unblocked tickets", () => {
  const tickets = [{ id: "01", dependencies: [] }, { id: "02", dependencies: ["01"] }];
  assert.deepEqual(ticketFrontier(tickets).map((x) => x.id), ["01"]);
  assert.deepEqual(ticketFrontier(tickets, new Set(["01"])).map((x) => x.id), ["02"]);
});

test("discovers Matt .scratch feature issue files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-v5-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const issues = path.join(root, ".scratch", "member-login", "issues");
  await fs.mkdir(issues, { recursive: true });
  await fs.writeFile(path.join(issues, "01-base.md"), `# 01: Base member\n\n**Blocked by:** none\n\n- [ ] base works\n`);
  await fs.writeFile(path.join(issues, "02-upgrade.md"), `# 02: Upgrade\n\n**Blocked by:** 01: Base member\n\n- [ ] upgrade works\n`);
  const found = await readDiscoveredLocalTickets(root);
  assert.equal(found.featureSlug, "member-login");
  assert.deepEqual(found.tickets.map((x) => x.id), ["01", "02"]);
  assert.deepEqual(ticketFrontier(found.tickets).map((x) => x.id), ["01"]);
});

test("legacy req can be projected without destructive migration", () => {
  const work = projectLegacyReqToWork({ id: "REQ-1", projectId: "P-1", title: "Login", phase: "analysis" });
  assert.equal(work.mode, "build");
  assert.equal(work.compatibility, true);
});
