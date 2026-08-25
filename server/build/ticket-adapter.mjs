import fs from "node:fs/promises";
import path from "node:path";

function parseBlockedBy(value) {
  const text = String(value || "").trim();
  if (!text || /^none\b/i.test(text)) return [];
  const ids = [...text.matchAll(/(?:^|[^\d])(\d{1,3})(?=[^\d]|$)/g)].map(
    (match) => match[1].padStart(2, "0"),
  );
  return [...new Set(ids)];
}

export function parseLocalTicket(content, filePath = "") {
  const titleMatch = content.match(/^#\s+(\d+)\s*:\s*(.+)$/m);
  if (!titleMatch) throw new Error(`无法解析 ticket 标题: ${filePath}`);
  const number = titleMatch[1].padStart(2, "0");
  const blockedMatch = content.match(/^\*\*Blocked by:\*\*\s*(.+)$/im);
  const statusMatch = content.match(/^\*\*Status:\*\*\s*(.+)$/im);
  const criteria = [...content.matchAll(/^- \[([ xX])\]\s+(.+)$/gm)].map(
    (m) => ({
      done: m[1].toLowerCase() === "x",
      text: m[2].trim(),
    }),
  );
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

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

/**
 * Matt to-tickets local tracker layout:
 *   .scratch/<feature-slug>/issues/<NN>-<slug>.md
 *
 * A worktree may contain multiple historical feature folders, so pick the
 * most recently modified issue set unless the caller supplies featureSlug.
 */
export async function discoverLocalTicketSet(
  worktreePath,
  { featureSlug = null } = {},
) {
  const scratch = path.join(worktreePath, ".scratch");
  if (featureSlug) {
    const issuesDir = path.join(scratch, featureSlug, "issues");
    const st = await statOrNull(issuesDir);
    if (!st?.isDirectory()) return null;
    return { featureSlug, issuesDir, modifiedAt: st.mtimeMs };
  }

  let features;
  try {
    features = await fs.readdir(scratch, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const feature of features) {
    if (!feature.isDirectory()) continue;
    const issuesDir = path.join(scratch, feature.name, "issues");
    const st = await statOrNull(issuesDir);
    if (!st?.isDirectory()) continue;
    const issueFiles = (await fs.readdir(issuesDir)).filter((name) =>
      name.endsWith(".md"),
    );
    if (!issueFiles.length) continue;
    let newest = st.mtimeMs;
    for (const name of issueFiles) {
      const fst = await statOrNull(path.join(issuesDir, name));
      if (fst) newest = Math.max(newest, fst.mtimeMs);
    }
    candidates.push({
      featureSlug: feature.name,
      issuesDir,
      modifiedAt: newest,
    });
  }

  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return candidates[0] || null;
}

export async function readDiscoveredLocalTickets(worktreePath, options = {}) {
  const set = await discoverLocalTicketSet(worktreePath, options);
  if (!set) return { featureSlug: null, issuesDir: null, tickets: [] };
  return { ...set, tickets: await readLocalTickets(set.issuesDir) };
}

export function deriveTicketStates(
  tickets,
  completedIds = new Set(),
  runningIds = new Set(),
) {
  return tickets.map((ticket) => {
    const completed = completedIds.has(ticket.id);
    const running = runningIds.has(ticket.id);
    const blockers = ticket.dependencies.filter((id) => !completedIds.has(id));
    return {
      ...ticket,
      status: completed
        ? "completed"
        : running
          ? "running"
          : blockers.length
            ? "blocked"
            : "ready",
      blockedBy: blockers,
    };
  });
}

export function ticketFrontier(
  tickets,
  completedIds = new Set(),
  runningIds = new Set(),
) {
  return deriveTicketStates(tickets, completedIds, runningIds).filter(
    (ticket) => ticket.status === "ready",
  );
}
