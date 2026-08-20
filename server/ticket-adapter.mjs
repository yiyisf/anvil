import fs from "node:fs/promises";
import path from "node:path";

function parseBlockedBy(value) {
  const text = String(value || "").trim();
  if (!text || /^none\b/i.test(text)) return [];
  const ids = [...text.matchAll(/(?:^|[^\d])(\d{1,3})(?=[^\d]|$)/g)]
    .map((match) => match[1].padStart(2, "0"));
  return [...new Set(ids)];
}

export function parseLocalTicket(content, filePath = "") {
  const titleMatch = content.match(/^#\s+(\d+)\s*:\s*(.+)$/m);
  if (!titleMatch) throw new Error(`无法解析 ticket 标题: ${filePath}`);
  const number = titleMatch[1].padStart(2, "0");
  const blockedMatch = content.match(/^\*\*Blocked by:\*\*\s*(.+)$/mi);
  const statusMatch = content.match(/^\*\*Status:\*\*\s*(.+)$/mi);
  const criteria = [...content.matchAll(/^- \[([ xX])\]\s+(.+)$/gm)].map((m) => ({
    done: m[1].toLowerCase() === "x",
    text: m[2].trim(),
  }));
  return {
    id: number,
    number,
    title: titleMatch[2].trim(),
    path: filePath,
    dependencies: parseBlockedBy(blockedMatch?.[1]),
    sourceStatus: statusMatch?.[1]?.trim() || "ready-for-agent",
    acceptanceCriteria: criteria,
  };
}

export async function readLocalTickets(issuesDir) {
  const entries = await fs.readdir(issuesDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  const tickets = [];
  for (const name of files) {
    const file = path.join(issuesDir, name);
    tickets.push(parseLocalTicket(await fs.readFile(file, "utf8"), file));
  }
  return tickets;
}

export function deriveTicketStates(tickets, completedIds = new Set(), runningIds = new Set()) {
  return tickets.map((ticket) => {
    const completed = completedIds.has(ticket.id);
    const running = runningIds.has(ticket.id);
    const blockers = ticket.dependencies.filter((id) => !completedIds.has(id));
    return {
      ...ticket,
      status: completed ? "completed" : running ? "running" : blockers.length ? "blocked" : "ready",
      blockedBy: blockers,
    };
  });
}

export function ticketFrontier(tickets, completedIds = new Set(), runningIds = new Set()) {
  return deriveTicketStates(tickets, completedIds, runningIds)
    .filter((ticket) => ticket.status === "ready");
}
