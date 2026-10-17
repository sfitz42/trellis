// Changeset = diff(snapshot, roadmap), ordered so dependencies resolve (docs/PLAN.md §6).
// A diff, not an op replay: edits that cancel out produce nothing. Trellis-owned fields
// (start date, story points, colour, ordering, timeline) never appear.
import { hashString } from './hash.js';
import type { Epic, IssueId, OplogEntry, Person, RoadmapState, Snapshot, Ticket } from './schemas.js';
import { isTempId } from './schemas.js';
import { compareIds, initialStatus } from './state.js';

export interface Reason {
  batchId: string;
  reason: string;
  askedBy?: string;
}

interface Base {
  target: IssueId;
  /** Everyone who changed this item during the session (for the "By" column). */
  by: string[];
  /** Captured agent requests that touched this item (for optional Jira comments). */
  reasons: Reason[];
}

export type ChangeOp = Base &
  (
    | { kind: 'epic.create'; after: { summary: string; description?: string; status: string; dueDate: string | null } }
    | { kind: 'ticket.create'; after: { summary: string; issueType: string; epicId: IssueId | null; description?: string; status: string; assignee: Person | null; labels: string[] } }
    | { kind: 'ticket.move'; before: IssueId | null; after: IssueId | null }
    | { kind: 'field.update'; field: 'summary' | 'description' | 'assignee' | 'labels' | 'issueType'; before: unknown; after: unknown }
    | { kind: 'transition'; before: string | null; after: string }
    | { kind: 'epic.dueDate'; before: string | null; after: string | null }
    | { kind: 'link.add'; linkType: string; to: IssueId }
    | { kind: 'link.remove'; linkType: string; to: IssueId; jiraLinkId?: string }
  );

export type ChangeKind = ChangeOp['kind'];

/** A ChangeOp before provenance is attached (distributive Omit over the union). */
type ChangeDraft = ChangeOp extends infer T ? (T extends unknown ? Omit<T, 'by' | 'reasons'> : never) : never;

export interface Changeset {
  /** Stable hash of the base and ops: apply resumes by (id, op index). */
  id: string;
  base: { pulledAt: string; version: number; project: string };
  ops: (ChangeOp & { index: number })[];
}

const ORDER: ChangeKind[] = ['epic.create', 'ticket.create', 'ticket.move', 'field.update', 'transition', 'epic.dueDate', 'link.add', 'link.remove'];

const text = (s: string | undefined): string => s ?? '';
const sameLabels = (a: string[], b: string[]): boolean => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const sameAssignee = (a: Person | null, b: Person | null): boolean => (a?.accountId ?? null) === (b?.accountId ?? null);

/** Every link as a canonical (source, type, target) triple, whichever side stores it. */
function linkTriples(tickets: Record<IssueId, Ticket>): Map<string, { from: IssueId; type: string; to: IssueId; jiraLinkId?: string }> {
  const out = new Map<string, { from: IssueId; type: string; to: IssueId; jiraLinkId?: string }>();
  for (const t of Object.values(tickets)) {
    for (const l of t.links) {
      const [from, to] = l.direction === 'outward' ? [t.id, l.target] : [l.target, t.id];
      const key = `${from}|${l.type}|${to}`;
      const prev = out.get(key);
      const entry: { from: IssueId; type: string; to: IssueId; jiraLinkId?: string } = { from, type: l.type, to };
      const id = l.jiraLinkId ?? prev?.jiraLinkId;
      if (id !== undefined) entry.jiraLinkId = id;
      out.set(key, entry);
    }
  }
  return out;
}

function provenance(oplog: readonly OplogEntry[]): Map<IssueId, { by: Set<string>; reasons: Reason[] }> {
  const out = new Map<IssueId, { by: Set<string>; reasons: Reason[] }>();
  for (const entry of oplog) {
    const ids = new Set<IssueId>();
    for (const a of entry.result.applied) {
      for (const key of a.touched) {
        const id = key.slice(0, key.indexOf('.'));
        if (id && id !== 'timeline') ids.add(id);
      }
      if (a.createdId) ids.add(a.createdId);
    }
    for (const id of ids) {
      const p = out.get(id) ?? { by: new Set<string>(), reasons: [] };
      p.by.add(entry.batch.author.name);
      if (entry.batch.author.kind === 'agent' && entry.batch.reason) {
        const r: Reason = { batchId: entry.batch.id, reason: entry.batch.reason };
        if (entry.batch.askedBy !== undefined) r.askedBy = entry.batch.askedBy;
        p.reasons.push(r);
      }
      out.set(id, p);
    }
  }
  return out;
}

export function computeChangeset(snapshot: Snapshot, state: RoadmapState, oplog: readonly OplogEntry[] = []): Changeset {
  const prov = provenance(oplog);
  const ops: ChangeOp[] = [];
  const push = (op: ChangeDraft): void => {
    const p = prov.get(op.target);
    ops.push({ ...op, by: p ? [...p.by].sort() : [], reasons: p?.reasons ?? [] });
  };
  const epicType = snapshot.workflow.epicIssueType;

  // Epics
  for (const e of sortById(Object.values(state.epics))) {
    const before: Epic | undefined = snapshot.epics[e.id];
    if (!before) {
      if (!isTempId(e.id)) continue; // not in this snapshot and not ours: nothing we can do
      const after: { summary: string; description?: string; status: string; dueDate: string | null } = { summary: e.summary, status: e.status, dueDate: e.dueDate };
      if (e.description) after.description = e.description;
      push({ kind: 'epic.create', target: e.id, after });
      if (e.status !== initialStatus(snapshot.workflow, epicType)) push({ kind: 'transition', target: e.id, before: null, after: e.status });
      continue;
    }
    if (e.summary !== before.summary) push({ kind: 'field.update', target: e.id, field: 'summary', before: before.summary, after: e.summary });
    if (text(e.description) !== text(before.description)) push({ kind: 'field.update', target: e.id, field: 'description', before: text(before.description), after: text(e.description) });
    if (e.status !== before.status) push({ kind: 'transition', target: e.id, before: before.status, after: e.status });
    if (e.dueDate !== before.dueDate) push({ kind: 'epic.dueDate', target: e.id, before: before.dueDate, after: e.dueDate });
  }

  // Tickets
  for (const t of sortById(Object.values(state.tickets))) {
    const before: Ticket | undefined = snapshot.tickets[t.id];
    if (!before) {
      if (!isTempId(t.id)) continue;
      const after: Extract<ChangeOp, { kind: 'ticket.create' }>['after'] = {
        summary: t.summary, issueType: t.issueType, epicId: t.epicId, status: t.status, assignee: t.assignee, labels: [...t.labels],
      };
      if (t.description) after.description = t.description;
      push({ kind: 'ticket.create', target: t.id, after });
      if (t.status !== initialStatus(snapshot.workflow, t.issueType)) push({ kind: 'transition', target: t.id, before: null, after: t.status });
      continue;
    }
    if (t.epicId !== before.epicId) push({ kind: 'ticket.move', target: t.id, before: before.epicId, after: t.epicId });
    if (t.summary !== before.summary) push({ kind: 'field.update', target: t.id, field: 'summary', before: before.summary, after: t.summary });
    if (text(t.description) !== text(before.description)) push({ kind: 'field.update', target: t.id, field: 'description', before: text(before.description), after: text(t.description) });
    if (!sameAssignee(t.assignee, before.assignee)) push({ kind: 'field.update', target: t.id, field: 'assignee', before: before.assignee, after: t.assignee });
    if (!sameLabels(t.labels, before.labels)) push({ kind: 'field.update', target: t.id, field: 'labels', before: [...before.labels].sort(), after: [...t.labels].sort() });
    if (t.issueType !== before.issueType) push({ kind: 'field.update', target: t.id, field: 'issueType', before: before.issueType, after: t.issueType });
    if (t.status !== before.status) push({ kind: 'transition', target: t.id, before: before.status, after: t.status });
  }

  // Links
  const was = linkTriples(snapshot.tickets);
  const now = linkTriples(state.tickets);
  for (const [key, l] of [...now].sort(([a], [b]) => a.localeCompare(b))) {
    if (!was.has(key)) push({ kind: 'link.add', target: l.from, linkType: l.type, to: l.to });
  }
  for (const [key, l] of [...was].sort(([a], [b]) => a.localeCompare(b))) {
    // Only remove links between items still in the roadmap (others are outside our view).
    if (now.has(key) || !state.tickets[l.from] || !state.tickets[l.to]) continue;
    const op: Extract<ChangeDraft, { kind: 'link.remove' }> = { kind: 'link.remove', target: l.from, linkType: l.type, to: l.to };
    if (l.jiraLinkId !== undefined) op.jiraLinkId = l.jiraLinkId;
    push(op);
  }

  // Stable sort keeps the per-kind order (epics before tickets, ids ascending).
  const ordered = ops
    .map((op, i) => ({ op, i }))
    .sort((a, b) => ORDER.indexOf(a.op.kind) - ORDER.indexOf(b.op.kind) || a.i - b.i)
    .map(({ op }, index) => ({ ...op, index }));

  const base = { pulledAt: snapshot.pulledAt, version: state.version, project: snapshot.project.key };
  return { id: hashString(JSON.stringify({ base, ops: ordered.map(({ by: _by, reasons: _r, ...rest }) => rest) })), base, ops: ordered };
}

function sortById<T extends { id: IssueId }>(items: T[]): T[] {
  return [...items].sort((a, b) => compareIds(a.id, b.id));
}
