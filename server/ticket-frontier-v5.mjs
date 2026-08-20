import { readDiscoveredLocalTickets, deriveTicketStates } from "./ticket-adapter.mjs";
import { listActivities } from "./store-v5.mjs";
import { treePath } from "./worktree.mjs";

function ticketExecutionState(activities) {
  const completed = new Set();
  const running = new Set();
  for (const activity of activities) {
    if (activity.type !== "implementation" || !activity.ticketId) continue;
    if (activity.status === "completed") completed.add(activity.ticketId);
    if (activity.status === "running") running.add(activity.ticketId);
  }
  return { completed, running };
}

export async function getTicketFrontier({ work, project, featureSlug = null }) {
  const worktreePath = treePath(project, work.id);
  const source = await readDiscoveredLocalTickets(worktreePath, { featureSlug });
  const activities = await listActivities(work.id);
  const { completed, running } = ticketExecutionState(activities);
  const tickets = deriveTicketStates(source.tickets, completed, running);
  return {
    workId: work.id,
    featureSlug: source.featureSlug,
    issuesDir: source.issuesDir,
    tickets,
    frontier: tickets.filter((ticket) => ticket.status === "ready"),
    counts: {
      total: tickets.length,
      ready: tickets.filter((x) => x.status === "ready").length,
      running: tickets.filter((x) => x.status === "running").length,
      blocked: tickets.filter((x) => x.status === "blocked").length,
      completed: tickets.filter((x) => x.status === "completed").length,
    },
  };
}
