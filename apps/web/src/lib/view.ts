// Small helpers shared by components.
import type { RoadmapState, Snapshot, Ticket } from '@trellis/shared';

/** Status category key (`new` / `indeterminate` / `done`) for styling, from the snapshot workflow. */
export function statusCategory(snapshot: Snapshot | null, issueType: string, status: string): string {
  const found = snapshot?.workflow.statuses[issueType]?.find((s) => s.name === status);
  if (found) return found.category;
  return /done|closed|resolved|won.?t/i.test(status) ? 'done' : /progress|review|doing/i.test(status) ? 'indeterminate' : 'new';
}

/** Does a ticket match the toolbar filter (key, summary, assignee, labels, status)? */
export function matches(t: Ticket, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return [t.id, t.summary, t.assignee?.displayName ?? '', t.status, ...t.labels].some((s) => s.toLowerCase().includes(q));
}

/** Fill colour index for an epic: rotates through the 5 epic fills in epic order. */
export function epicFill(state: RoadmapState, epicId: string): number {
  const i = state.epicOrder.indexOf(epicId);
  return (i < 0 ? 0 : i) % 5;
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
