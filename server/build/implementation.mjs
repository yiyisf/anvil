import { createImplementationActivity } from "./flow.mjs";
import { getTicketFrontier } from "./ticket-frontier.mjs";
import {
  listActivities,
  saveActivity,
  getWork,
} from "../persistence/build-repository.mjs";
import { runActivity } from "./activity-runner.mjs";

export async function ensureImplementationActivities({ work, project }) {
  const frontier = await getTicketFrontier({ work, project });
  const activities = await listActivities(work.id);
  const byTicket = new Map(
    activities
      .filter((a) => a.type === "implementation" && a.ticketId)
      .map((a) => [a.ticketId, a]),
  );
  const created = [];
  for (const ticket of frontier.tickets) {
    if (byTicket.has(ticket.id)) continue;
    const activity = createImplementationActivity(work.id, ticket);
    await saveActivity(activity);
    byTicket.set(ticket.id, activity);
    created.push(activity);
  }
  return { frontier, created, activities: [...activities, ...created] };
}

export async function runFrontierTicket({
  workId,
  ticketId = null,
  project,
  onEvent,
}) {
  const work = await getWork(workId);
  if (!work) throw new Error(`Work 不存在: ${workId}`);
  const prepared = await ensureImplementationActivities({ work, project });
  const ticket = ticketId
    ? prepared.frontier.frontier.find((t) => t.id === ticketId)
    : prepared.frontier.frontier[0];
  if (!ticket)
    throw new Error(
      ticketId
        ? `Ticket ${ticketId} 当前不在 frontier`
        : "当前没有可执行的 Ticket",
    );
  const activity = prepared.activities.find(
    (a) => a.type === "implementation" && a.ticketId === ticket.id,
  );
  const prompt = `Implement only ticket #${ticket.number}: ${ticket.title}.\n\nTicket source: ${ticket.path}\n\nRead the ticket file before coding and treat its scope, blockers, and acceptance criteria as authoritative. Do not implement other tickets.`;
  return runActivity({
    workId,
    activityId: activity.id,
    project,
    prompt,
    onEvent,
  });
}
