import type { Epic, IssueId, RoadmapState, Snapshot, Ticket, TimelineConfig, Workflow } from './schemas.js';
import { isTempId } from './schemas.js';

/** Default timeline: the month containing `today` plus the next `months - 1` months. */
export function defaultTimeline(today: string, months = 8): TimelineConfig {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const endMonth = new Date(Date.UTC(y, m - 1 + months, 0)); // last day of the final month
  return { scale: 'months', start, end: endMonth.toISOString().slice(0, 10) };
}

/**
 * Build a fresh roadmap from a snapshot. Repairs `ticketOrder` so it lists exactly the
 * epic's tickets (missing ones appended in id order), and orders epics by due date, then id.
 */
export function fromSnapshot(snapshot: Snapshot, opts: { today: string; timeline?: TimelineConfig }): RoadmapState {
  const epics: Record<IssueId, Epic> = structuredClone(snapshot.epics);
  const tickets: Record<IssueId, Ticket> = structuredClone(snapshot.tickets);

  for (const epic of Object.values(epics)) {
    const mine = Object.values(tickets).filter((t) => t.epicId === epic.id).map((t) => t.id);
    const kept = epic.ticketOrder.filter((id) => mine.includes(id));
    epic.ticketOrder = [...kept, ...mine.filter((id) => !kept.includes(id)).sort(compareIds)];
  }
  // A ticket pointing at an epic we don't have is treated as having no epic.
  for (const t of Object.values(tickets)) if (t.epicId && !epics[t.epicId]) t.epicId = null;

  const epicOrder = Object.values(epics)
    .sort((a, b) => (a.dueDate ?? '9999') .localeCompare(b.dueDate ?? '9999') || compareIds(a.id, b.id))
    .map((e) => e.id);

  return {
    project: { key: snapshot.project.key, name: snapshot.project.name },
    epics,
    tickets,
    epicOrder,
    timeline: opts.timeline ?? defaultTimeline(opts.today),
    meta: {},
    version: 0,
    frozen: null,
  };
}

/** Compare issue ids by prefix, then number (PROJ-9 before PROJ-10). */
export function compareIds(a: string, b: string): number {
  const [pa = '', na = '0'] = a.split(/-(?=\d+$)/);
  const [pb = '', nb = '0'] = b.split(/-(?=\d+$)/);
  return pa.localeCompare(pb) || Number(na) - Number(nb);
}

/** Next unused temp id. Server-side allocation (§3) goes through this. */
export function nextTempId(state: RoadmapState): IssueId {
  let max = 0;
  for (const id of [...Object.keys(state.epics), ...Object.keys(state.tickets)]) {
    if (isTempId(id)) max = Math.max(max, Number(id.slice(4)));
  }
  return `NEW-${max + 1}`;
}

/** Statuses known for an issue type, or `null` if the workflow doesn't say (accept any). */
export function statusesFor(workflow: Workflow | undefined, issueType: string): string[] | null {
  const list = workflow?.statuses[issueType];
  return list && list.length > 0 ? list.map((s) => s.name) : null;
}

/** The status a newly created item starts in: the first `new`-category status, else the first. */
export function initialStatus(workflow: Workflow | undefined, issueType: string): string {
  const list = workflow?.statuses[issueType] ?? [];
  return list.find((s) => s.category === 'new')?.name ?? list[0]?.name ?? 'To Do';
}

/** Default issue type for new tickets: the first non-epic type the workflow knows, else Task. */
export function defaultTicketType(workflow: Workflow | undefined): string {
  const types = Object.keys(workflow?.statuses ?? {}).filter((t) => t !== workflow?.epicIssueType);
  return types.includes('Task') ? 'Task' : (types[0] ?? 'Task');
}
