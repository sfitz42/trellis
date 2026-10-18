// Per-item views over the model: what differs from Jira, how to revert it, dependencies, and
// plain-language descriptions of ops for the activity feed and agent panel.
import { acknowledgedDates, BLOCKS, computeChangeset, isTempId } from '@trellis/shared';
import type { ChangeOp, Changeset, Epic, IssueId, Op, OplogEntry, RoadmapState, Snapshot, Ticket } from '@trellis/shared';
import { fmtMonth } from './timeline.js';

// --- differs from Jira

export function changesetFor(snapshot: Snapshot | null, state: RoadmapState, oplog: readonly OplogEntry[]): Changeset | null {
  return snapshot ? computeChangeset(snapshot, state, oplog) : null;
}

/** Changeset ops grouped by every item they touch (link ops count for both ends). */
export function changesByItem(cs: Changeset | null): Map<IssueId, ChangeOp[]> {
  const out = new Map<IssueId, ChangeOp[]>();
  const add = (id: IssueId, op: ChangeOp): void => { out.set(id, [...(out.get(id) ?? []), op]); };
  for (const op of cs?.ops ?? []) {
    add(op.target, op);
    if (op.kind === 'link.add' || op.kind === 'link.remove') add(op.to, op);
    if (op.kind === 'ticket.move') {
      if (op.before) add(op.before, op);
      if (op.after) add(op.after, op);
    }
  }
  return out;
}

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (typeof v === 'object' && 'displayName' in v) return (v as { displayName: string }).displayName;
  return typeof v === 'string' ? v : JSON.stringify(v);
};

/** One line per change, as in the "Differs from Jira" box: `status: To do → In progress`. */
export function describeChange(op: ChangeOp, forId?: IssueId): string {
  switch (op.kind) {
    case 'epic.create': return 'new epic (not in Jira yet)';
    case 'ticket.create': return 'new ticket (not in Jira yet)';
    case 'ticket.move': return forId && forId !== op.target ? `${op.target} ${op.after === forId ? 'moved in' : 'moved out'}` : `epic: ${show(op.before)} → ${show(op.after)}`;
    case 'field.update': return `${op.field}: ${show(op.before)} → ${show(op.after)}`;
    case 'transition': return `status: ${show(op.before)} → ${op.after}`;
    case 'defer': return op.after ? 'moved to Deliver later' : 'scheduled again (out of Deliver later)';
    case 'epic.dates': return `dates: ${show(op.before.startDate)} – ${show(op.before.dueDate)} → ${show(op.after.startDate)} – ${show(op.after.dueDate)} (comment in Jira)`;
    case 'link.add': return forId === op.to ? `links: + blocked by ${op.target}` : `links: + ${op.linkType.toLowerCase()} ${op.to}`;
    case 'link.remove': return forId === op.to ? `links: − blocked by ${op.target}` : `links: − ${op.linkType.toLowerCase()} ${op.to}`;
  }
}

/** Ops that put an existing item back to its Jira values (Trellis-owned fields untouched). */
export function revertOps(id: IssueId, snapshot: Snapshot, state: RoadmapState): Op[] {
  const ops: Op[] = [];
  const eSnap = snapshot.epics[id];
  const eNow = state.epics[id];
  if (eSnap && eNow) {
    const fields: { summary?: string; description?: string } = {};
    if (eNow.summary !== eSnap.summary) fields.summary = eSnap.summary;
    if ((eNow.description ?? '') !== (eSnap.description ?? '')) fields.description = eSnap.description ?? '';
    if (Object.keys(fields).length) ops.push({ type: 'epic.update', id, fields });
    if (eNow.status !== eSnap.status) ops.push({ type: 'epic.transition', id, status: eSnap.status });
    // Dates are Trellis-owned: "Jira's values" are the dates Jira was last told.
    const told = acknowledgedDates(state, id) ?? { startDate: eSnap.startDate, dueDate: eSnap.dueDate };
    if (eNow.startDate !== told.startDate || eNow.dueDate !== told.dueDate) ops.push({ type: 'epic.setDates', id, startDate: told.startDate, dueDate: told.dueDate });
    return ops;
  }
  const tSnap = snapshot.tickets[id];
  const tNow = state.tickets[id];
  if (!tSnap || !tNow) return ops;
  const fields: Extract<Op, { type: 'ticket.update' }>['fields'] = {};
  if (tNow.summary !== tSnap.summary) fields.summary = tSnap.summary;
  if ((tNow.description ?? '') !== (tSnap.description ?? '')) fields.description = tSnap.description ?? '';
  if ((tNow.assignee?.accountId ?? null) !== (tSnap.assignee?.accountId ?? null)) fields.assignee = tSnap.assignee;
  if ([...tNow.labels].sort().join('\n') !== [...tSnap.labels].sort().join('\n')) fields.labels = [...tSnap.labels];
  if (tNow.issueType !== tSnap.issueType) fields.issueType = tSnap.issueType;
  if (Object.keys(fields).length) ops.push({ type: 'ticket.update', id, fields });
  if (tNow.epicId !== tSnap.epicId && (tSnap.epicId === null || state.epics[tSnap.epicId])) ops.push({ type: 'ticket.move', id, epicId: tSnap.epicId });
  if (tNow.status !== tSnap.status) ops.push({ type: 'ticket.transition', id, status: tSnap.status });
  // Blocks links touching this ticket: restore Jira's set.
  const was = blocksPairs(Object.values(snapshot.tickets)).filter(([a, b]) => a === id || b === id);
  const now = blocksPairs(Object.values(state.tickets)).filter(([a, b]) => a === id || b === id);
  const key = ([a, b]: [IssueId, IssueId]): string => `${a}>${b}`;
  for (const p of was) if (!now.some((q) => key(q) === key(p)) && state.tickets[p[0]] && state.tickets[p[1]]) ops.push({ type: 'link.add', from: p[0], to: p[1], linkType: 'blocks' });
  for (const p of now) if (!was.some((q) => key(q) === key(p))) ops.push({ type: 'link.remove', from: p[0], to: p[1], linkType: 'blocks' });
  return ops;
}

// --- dependencies

/** Every Blocks link as [blocker, blocked], whichever side stores it. */
export function blocksPairs(tickets: Iterable<Ticket>): [IssueId, IssueId][] {
  const seen = new Set<string>();
  const out: [IssueId, IssueId][] = [];
  for (const t of tickets) {
    for (const l of t.links) {
      if (l.type !== BLOCKS) continue;
      const pair: [IssueId, IssueId] = l.direction === 'outward' ? [t.id, l.target] : [l.target, t.id];
      const k = pair.join('>');
      if (!seen.has(k)) {
        seen.add(k);
        out.push(pair);
      }
    }
  }
  return out;
}

export interface Dependencies {
  blockedBy: IssueId[];
  blocks: IssueId[];
  /** Other link types, shown read-only. */
  other: { type: string; direction: 'outward' | 'inward'; target: IssueId }[];
}

export function dependenciesOf(state: RoadmapState, id: IssueId): Dependencies {
  const pairs = blocksPairs(Object.values(state.tickets));
  const t = state.tickets[id];
  return {
    blockedBy: pairs.filter(([, b]) => b === id).map(([a]) => a),
    blocks: pairs.filter(([a]) => a === id).map(([, b]) => b),
    other: (t?.links ?? []).filter((l) => l.type !== BLOCKS).map((l) => ({ type: l.type, direction: l.direction, target: l.target })),
  };
}

export interface BackwardsWarning {
  blocker: IssueId;
  blocked: IssueId;
  message: string;
}

/**
 * A dependency "runs backwards" when the blocked ticket's epic starts before the blocker's epic is
 * due: on the timeline the arrow points back in time. Needs both dates; otherwise no warning.
 */
export function backwardsWarnings(state: RoadmapState, id?: IssueId): BackwardsWarning[] {
  const out: BackwardsWarning[] = [];
  for (const [a, b] of blocksPairs(Object.values(state.tickets))) {
    if (id !== undefined && a !== id && b !== id) continue;
    const ea = epicOf(state, a);
    const eb = epicOf(state, b);
    if (!ea || !eb || ea.id === eb.id || !ea.dueDate || !eb.startDate) continue;
    if (eb.startDate <= ea.dueDate) {
      out.push({
        blocker: a,
        blocked: b,
        message: `${b} starts in ${fmtMonth(eb.startDate)} but ${a}'s epic now runs to ${fmtMonth(ea.dueDate)}. The dependency crosses backwards on the timeline.`,
      });
    }
  }
  return out;
}

export function epicOf(state: RoadmapState, ticketId: IssueId): Epic | undefined {
  const t = state.tickets[ticketId];
  return t?.epicId ? state.epics[t.epicId] : undefined;
}

// --- plain-language ops

function name(state: RoadmapState, id: IssueId): string {
  return state.epics[id]?.summary ?? state.tickets[id]?.summary ?? id;
}

/** "moved PROJ-126 to Data migration" — the verb phrase after the author's name. */
export function describeOp(op: Op, state: RoadmapState, createdId?: IssueId): string {
  switch (op.type) {
    case 'epic.create': return `created epic ${createdId ?? op.tempId ?? ''} ${op.fields.summary}`.replace(/\s+/g, ' ');
    case 'epic.update': return `edited ${Object.keys(op.fields).join(', ')} of ${op.id}`;
    case 'epic.setDates': return `set ${name(state, op.id)} to ${op.startDate ? fmtMonth(op.startDate) : '…'} – ${op.dueDate ? fmtMonth(op.dueDate) : '…'}`;
    case 'epic.transition': return `moved ${op.id} to ${op.status}`;
    case 'epic.reorder': return `reordered ${name(state, op.id)}`;
    case 'epic.discardNew': return `discarded new epic ${op.id}`;
    case 'epic.defer': return op.deferred ? `moved ${name(state, op.id)} to Deliver later` : `scheduled ${name(state, op.id)} again`;
    case 'ticket.create': return `added ${createdId ?? op.tempId ?? 'a ticket'} under ${op.epicId ?? 'no epic'}`;
    case 'ticket.update': return `edited ${Object.keys(op.fields).join(', ')} of ${op.id}`;
    case 'ticket.move': return `moved ${op.id} to ${op.epicId ? name(state, op.epicId) : 'no epic'}`;
    case 'ticket.transition': return `marked ${op.id} ${op.status}`;
    case 'ticket.discardNew': return `discarded ${op.id}`;
    case 'ticket.defer': return op.deferred ? `moved ${op.id} to Deliver later` : `scheduled ${op.id} again`;
    case 'link.add': return `linked ${op.from} blocks ${op.to}`;
    case 'link.remove': return `removed ${op.from} blocks ${op.to}`;
    case 'timeline.set': return `changed the timeline to ${op.timeline.scale}`;
  }
}

/** Ids an op refers to (for highlighting what an agent batch touched). */
export function idsOfOp(op: Op, createdId?: IssueId): IssueId[] {
  const ids: IssueId[] = [];
  if ('id' in op) ids.push(op.id);
  if ('from' in op) ids.push(op.from, op.to);
  if (op.type === 'ticket.move' && op.epicId) ids.push(op.epicId);
  // Adding a ticket changes its epic too (the design marks the epic's bar as agent-touched).
  if (op.type === 'ticket.create' && op.epicId) ids.push(op.epicId);
  if (createdId) ids.push(createdId);
  return ids;
}

export const isNew = (id: IssueId): boolean => isTempId(id);

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (/^(claude|copilot)/i.test(name)) return 'AI';
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : (parts[0]?.[1] ?? ''))).toUpperCase();
}
