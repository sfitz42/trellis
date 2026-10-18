// Pure batch reducer (docs/PLAN.md §4). `applyBatch` never mutates its input: it works on a clone,
// and each op handler validates fully before touching the working copy, so a rejected op leaves
// no trace.
import type {
  AppliedOp, Batch, BatchResult, Epic, ErrorCode, IssueId, Op, OpError, OpOf, RoadmapState, Ticket, Workflow,
} from './schemas.js';
import { BLOCKS, isTempId } from './schemas.js';
import { defaultTicketType, initialStatus, nextTempId, statusesFor } from './state.js';

export interface ApplyContext {
  batchId: string;
  /** From `snapshot.workflow`; when absent, statuses and types aren't checked. */
  workflow?: Workflow;
  /** Issue ids claimed by someone other than this batch's author → who holds the claim. */
  locks?: ReadonlyMap<IssueId, string>;
}

class OpFailure extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}
const fail = (code: ErrorCode, message: string): never => {
  throw new OpFailure(code, message);
};

interface Done {
  createdId?: IssueId;
  inverse: Op[];
}

// --- lookups

function epic(s: RoadmapState, id: IssueId): Epic {
  return s.epics[id] ?? fail('NOT_FOUND', `epic ${id} not found`);
}
function ticket(s: RoadmapState, id: IssueId): Ticket {
  return s.tickets[id] ?? fail('NOT_FOUND', `ticket ${id} not found`);
}
function epicType(ctx: ApplyContext): string {
  return ctx.workflow?.epicIssueType ?? 'Epic';
}

function checkStatus(ctx: ApplyContext, issueType: string, from: string | null, to: string): void {
  const known = statusesFor(ctx.workflow, issueType);
  if (known && !known.includes(to)) fail('INVALID_STATUS', `"${to}" is not a status of ${issueType} (known: ${known.join(', ')})`);
  const allowed = from !== null && from !== to ? ctx.workflow?.transitions?.[issueType]?.[from] : undefined;
  if (allowed && !allowed.includes(to)) fail('INVALID_TRANSITION', `${issueType} can't move from "${from}" to "${to}"`);
}

function checkIssueType(ctx: ApplyContext, issueType: string): void {
  if (issueType === epicType(ctx)) fail('INVALID', `tickets can't have the epic type "${issueType}"`);
  const known = ctx.workflow ? Object.keys(ctx.workflow.statuses) : [];
  if (known.length > 0 && !known.includes(issueType)) fail('INVALID', `unknown issue type "${issueType}" (known: ${known.join(', ')})`);
}

function checkDates(start: string | null, due: string | null): void {
  if (start && due && start > due) fail('INVALID_DATES', `start date ${start} is after due date ${due}`);
}

function newId(s: RoadmapState, tempId: IssueId | undefined): IssueId {
  if (tempId === undefined) return nextTempId(s);
  if (!isTempId(tempId)) fail('INVALID', `tempId must look like NEW-<n>, got ${tempId}`);
  if (s.epics[tempId] || s.tickets[tempId]) fail('DUPLICATE_ID', `${tempId} already exists`);
  return tempId;
}

function clampIndex(index: number | undefined, length: number): number {
  return index === undefined ? length : Math.min(index, length);
}

function moveInArray(arr: IssueId[], id: IssueId, index: number): number {
  const from = arr.indexOf(id);
  arr.splice(from, 1);
  arr.splice(Math.min(index, arr.length), 0, id);
  return from;
}

/** Does a Blocks link from → to exist, stored on either side? */
export function hasBlocksLink(s: RoadmapState, from: IssueId, to: IssueId): boolean {
  return (
    (s.tickets[from]?.links.some((l) => l.type === BLOCKS && l.direction === 'outward' && l.target === to) ?? false) ||
    (s.tickets[to]?.links.some((l) => l.type === BLOCKS && l.direction === 'inward' && l.target === from) ?? false)
  );
}

function setOptional<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
  if (value === undefined || value === '') delete obj[key];
  else obj[key] = value;
}

// --- op metadata

/** `${id}.${field}` keys an op changes. `${id}.*` means the whole item (create / discard). */
export function touchedKeys(op: Op, createdId?: IssueId): string[] {
  switch (op.type) {
    case 'epic.create':
    case 'ticket.create':
      return createdId ? [`${createdId}.*`] : [];
    case 'epic.discardNew':
    case 'ticket.discardNew':
      return [`${op.id}.*`];
    case 'epic.update':
    case 'ticket.update':
      return Object.keys(op.fields).map((f) => `${op.id}.${f}`);
    case 'epic.setDates':
      return [`${op.id}.startDate`, `${op.id}.dueDate`];
    case 'epic.defer':
      return [`${op.id}.deferred`, `${op.id}.startDate`, `${op.id}.dueDate`];
    case 'ticket.defer':
      return [`${op.id}.deferred`];
    case 'epic.transition':
    case 'ticket.transition':
      return [`${op.id}.status`];
    case 'epic.reorder':
      return [`${op.id}.order`];
    case 'ticket.move':
      return [`${op.id}.epicId`, `${op.id}.order`];
    case 'link.add':
    case 'link.remove':
      return [`${op.from}.links`, `${op.to}.links`];
    case 'timeline.set':
      return ['timeline'];
  }
}

function idsOf(op: Op): IssueId[] {
  if ('id' in op) return [op.id];
  if ('from' in op) return [op.from, op.to];
  return [];
}

// --- handlers: validate everything, then mutate `s`

type Handler<T extends Op['type']> = (s: RoadmapState, op: OpOf<T>, ctx: ApplyContext) => Done;

const handlers: { [T in Op['type']]: Handler<T> } = {
  'epic.create'(s, op, ctx) {
    const id = newId(s, op.tempId);
    const f = op.fields;
    const status = f.status ?? initialStatus(ctx.workflow, epicType(ctx));
    checkStatus(ctx, epicType(ctx), null, status);
    checkDates(f.startDate ?? null, f.dueDate ?? null);
    const e: Epic = { id, summary: f.summary, status, startDate: f.startDate ?? null, dueDate: f.dueDate ?? null, ticketOrder: [], deferred: false };
    setOptional(e, 'description', f.description);
    setOptional(e, 'color', f.color);
    s.epics[id] = e;
    s.epicOrder.push(id);
    return { createdId: id, inverse: [{ type: 'epic.discardNew', id }] };
  },

  'epic.update'(s, op) {
    const e = epic(s, op.id);
    const prev: OpOf<'epic.update'>['fields'] = {};
    for (const k of Object.keys(op.fields) as (keyof typeof op.fields)[]) prev[k] = e[k] === undefined ? '' : e[k];
    if (op.fields.summary !== undefined) e.summary = op.fields.summary;
    if ('description' in op.fields) setOptional(e, 'description', op.fields.description);
    if ('color' in op.fields) setOptional(e, 'color', op.fields.color);
    return { inverse: [{ type: 'epic.update', id: op.id, fields: prev }] };
  },

  'epic.setDates'(s, op) {
    const e = epic(s, op.id);
    if (e.deferred) fail('DEFERRED', `${op.id} is in Deliver later; undefer it first (one batch can do both)`);
    checkDates(op.startDate, op.dueDate);
    const inverse: Op = { type: 'epic.setDates', id: op.id, startDate: e.startDate, dueDate: e.dueDate };
    e.startDate = op.startDate;
    e.dueDate = op.dueDate;
    return { inverse: [inverse] };
  },

  'epic.transition'(s, op, ctx) {
    const e = epic(s, op.id);
    checkStatus(ctx, epicType(ctx), e.status, op.status);
    const inverse: Op = { type: 'epic.transition', id: op.id, status: e.status };
    e.status = op.status;
    return { inverse: [inverse] };
  },

  'epic.reorder'(s, op) {
    epic(s, op.id);
    const from = moveInArray(s.epicOrder, op.id, op.index);
    return { inverse: [{ type: 'epic.reorder', id: op.id, index: from }] };
  },

  'epic.discardNew'(s, op) {
    const e = epic(s, op.id);
    if (!isTempId(op.id)) fail('NOT_NEW', `${op.id} is in Jira; only NEW-* items can be discarded`);
    if (e.ticketOrder.length > 0 || Object.values(s.tickets).some((t) => t.epicId === op.id)) {
      fail('NOT_EMPTY', `${op.id} still has tickets; move or discard them first`);
    }
    const index = s.epicOrder.indexOf(op.id);
    s.epicOrder.splice(index, 1);
    delete s.epics[op.id];
    const fields: OpOf<'epic.create'>['fields'] = { summary: e.summary, status: e.status, startDate: e.startDate, dueDate: e.dueDate };
    setOptional(fields, 'description', e.description);
    setOptional(fields, 'color', e.color);
    const inverse: Op[] = [{ type: 'epic.create', tempId: op.id, fields }, { type: 'epic.reorder', id: op.id, index }];
    if (e.deferred) inverse.push({ type: 'epic.defer', id: op.id, deferred: true });
    return { inverse };
  },

  'epic.defer'(s, op) {
    const e = epic(s, op.id);
    if (e.deferred === op.deferred) return { inverse: [] };
    const inverse: Op[] = [{ type: 'epic.defer', id: op.id, deferred: e.deferred }];
    // Deferring clears the dates; undoing it undefers first, then restores them.
    if (op.deferred && (e.startDate !== null || e.dueDate !== null)) {
      inverse.push({ type: 'epic.setDates', id: op.id, startDate: e.startDate, dueDate: e.dueDate });
      e.startDate = null;
      e.dueDate = null;
    }
    e.deferred = op.deferred;
    return { inverse };
  },

  'ticket.create'(s, op, ctx) {
    if (op.epicId !== null) epic(s, op.epicId);
    const f = op.fields;
    const issueType = f.issueType ?? defaultTicketType(ctx.workflow);
    checkIssueType(ctx, issueType);
    const status = f.status ?? initialStatus(ctx.workflow, issueType);
    checkStatus(ctx, issueType, null, status);
    const id = newId(s, op.tempId);
    const t: Ticket = {
      id, epicId: op.epicId, issueType, summary: f.summary, status,
      assignee: f.assignee ?? null, labels: f.labels ?? [], storyPoints: f.storyPoints ?? null, links: [], deferred: false,
    };
    setOptional(t, 'description', f.description);
    s.tickets[id] = t;
    if (op.epicId !== null) s.epics[op.epicId]?.ticketOrder.push(id);
    return { createdId: id, inverse: [{ type: 'ticket.discardNew', id }] };
  },

  'ticket.update'(s, op, ctx) {
    const t = ticket(s, op.id);
    if (op.fields.issueType !== undefined) checkIssueType(ctx, op.fields.issueType);
    const prev: Record<string, unknown> = {};
    // A missing optional text field is restored by '' (which clears it); null stays null.
    for (const k of Object.keys(op.fields) as (keyof typeof op.fields)[]) prev[k] = t[k] === undefined ? '' : t[k];
    const f = op.fields;
    if (f.summary !== undefined) t.summary = f.summary;
    if ('description' in f) setOptional(t, 'description', f.description);
    if (f.assignee !== undefined) t.assignee = f.assignee;
    if (f.labels !== undefined) t.labels = [...f.labels];
    if (f.storyPoints !== undefined) t.storyPoints = f.storyPoints;
    if (f.issueType !== undefined) t.issueType = f.issueType;
    return { inverse: [{ type: 'ticket.update', id: op.id, fields: prev }] };
  },

  'ticket.move'(s, op) {
    const t = ticket(s, op.id);
    const target = op.epicId === null ? null : epic(s, op.epicId);
    const prevEpicId = t.epicId;
    const source = prevEpicId === null ? null : (s.epics[prevEpicId] ?? null);
    const prevIndex = source ? source.ticketOrder.indexOf(op.id) : undefined;
    if (source) source.ticketOrder.splice(source.ticketOrder.indexOf(op.id), 1);
    if (target) target.ticketOrder.splice(clampIndex(op.index, target.ticketOrder.length), 0, op.id);
    t.epicId = op.epicId;
    const inverse: OpOf<'ticket.move'> = { type: 'ticket.move', id: op.id, epicId: prevEpicId };
    if (prevIndex !== undefined && prevIndex >= 0) inverse.index = prevIndex;
    return { inverse: [inverse] };
  },

  'ticket.transition'(s, op, ctx) {
    const t = ticket(s, op.id);
    checkStatus(ctx, t.issueType, t.status, op.status);
    const inverse: Op = { type: 'ticket.transition', id: op.id, status: t.status };
    t.status = op.status;
    return { inverse: [inverse] };
  },

  'ticket.discardNew'(s, op) {
    const t = ticket(s, op.id);
    if (!isTempId(op.id)) fail('NOT_NEW', `${op.id} is in Jira; transition it to a closed status instead`);
    const inverse: Op[] = [];
    const fields: OpOf<'ticket.create'>['fields'] = {
      summary: t.summary, issueType: t.issueType, status: t.status,
      assignee: t.assignee, labels: [...t.labels], storyPoints: t.storyPoints,
    };
    setOptional(fields, 'description', t.description);
    inverse.push({ type: 'ticket.create', tempId: op.id, epicId: t.epicId, fields });
    if (t.epicId !== null) {
      const order = s.epics[t.epicId]?.ticketOrder ?? [];
      inverse.push({ type: 'ticket.move', id: op.id, epicId: t.epicId, index: order.indexOf(op.id) });
      order.splice(order.indexOf(op.id), 1);
    }
    // Drop every Blocks link touching this ticket, on either side, and restore them on undo.
    for (const other of Object.values(s.tickets)) {
      if (other.id === op.id) continue;
      for (const l of other.links.filter((l) => l.target === op.id && l.type === BLOCKS)) {
        const [from, to] = l.direction === 'outward' ? [other.id, op.id] : [op.id, other.id];
        inverse.push({ type: 'link.add', from, to, linkType: 'blocks' });
      }
      other.links = other.links.filter((l) => l.target !== op.id);
    }
    for (const l of t.links.filter((l) => l.type === BLOCKS)) {
      const [from, to] = l.direction === 'outward' ? [op.id, l.target] : [l.target, op.id];
      inverse.push({ type: 'link.add', from, to, linkType: 'blocks' });
    }
    if (t.deferred) inverse.push({ type: 'ticket.defer', id: op.id, deferred: true });
    delete s.tickets[op.id];
    return { inverse };
  },

  'ticket.defer'(s, op) {
    const t = ticket(s, op.id);
    if (t.deferred === op.deferred) return { inverse: [] };
    const inverse: Op = { type: 'ticket.defer', id: op.id, deferred: t.deferred };
    t.deferred = op.deferred;
    return { inverse: [inverse] };
  },

  'link.add'(s, op) {
    const from = ticket(s, op.from);
    ticket(s, op.to);
    if (op.from === op.to) fail('SELF_LINK', `${op.from} can't block itself`);
    if (hasBlocksLink(s, op.from, op.to)) fail('DUPLICATE_LINK', `${op.from} already blocks ${op.to}`);
    from.links.push({ type: BLOCKS, direction: 'outward', target: op.to });
    return { inverse: [{ type: 'link.remove', from: op.from, to: op.to, linkType: 'blocks' }] };
  },

  'link.remove'(s, op) {
    const from = ticket(s, op.from);
    const to = ticket(s, op.to);
    if (!hasBlocksLink(s, op.from, op.to)) fail('NOT_FOUND', `${op.from} doesn't block ${op.to}`);
    const isIt = (dir: 'outward' | 'inward', target: IssueId) => (l: Ticket['links'][number]) =>
      l.type === BLOCKS && l.direction === dir && l.target === target;
    from.links = from.links.filter((l) => !isIt('outward', op.to)(l));
    to.links = to.links.filter((l) => !isIt('inward', op.from)(l));
    return { inverse: [{ type: 'link.add', from: op.from, to: op.to, linkType: 'blocks' }] };
  },

  'timeline.set'(s, op) {
    const ids = op.timeline.milestones.map((m) => m.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup !== undefined) fail('INVALID', `milestone id ${dup} is used twice`);
    const inverse: Op = { type: 'timeline.set', timeline: s.timeline };
    s.timeline = structuredClone(op.timeline);
    s.timeline.milestones.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    return { inverse: [inverse] };
  },
};

function runOp(s: RoadmapState, op: Op, ctx: ApplyContext): Done {
  // The mapped type guarantees handlers[op.type] accepts this op; TS can't correlate the union here.
  return (handlers[op.type] as Handler<Op['type']>)(s, op, ctx);
}

/**
 * Apply a batch (§4 steps 1–7, minus I/O). Returns the new state and the result to send back.
 * `atomic` (default true): any rejection rejects the whole batch. Skipped ops (STALE_FIELD)
 * don't count as rejections.
 */
export function applyBatch(state: RoadmapState, batch: Batch, ctx: ApplyContext): { state: RoadmapState; result: BatchResult } {
  const atomic = batch.atomic ?? true;
  const rejected: OpError[] = [];
  const skipped: OpError[] = [];
  const applied: AppliedOp[] = [];

  if (state.frozen) {
    const msg = `session frozen by ${state.frozen.by} at ${state.frozen.at}`;
    return {
      state,
      result: { batchId: ctx.batchId, version: state.version, applied, skipped, rejected: batch.ops.map((op, index) => ({ index, op, code: 'FROZEN', message: msg })) },
    };
  }

  const s = structuredClone(state);
  batch.ops.forEach((op, index) => {
    const lockedBy = idsOf(op).map((id) => [id, ctx.locks?.get(id)] as const).find(([, holder]) => holder !== undefined);
    if (lockedBy) {
      rejected.push({ index, op, code: 'LOCKED', message: `${lockedBy[0]} is being edited by ${lockedBy[1]}` });
      return;
    }
    if (batch.baseVersion !== undefined) {
      for (const key of touchedKeys(op)) {
        const m = s.meta[key];
        if (m && m.version > batch.baseVersion && m.author !== batch.author.name) {
          skipped.push({ index, op, code: 'STALE_FIELD', message: `${key.replace('.', ' ')} edited by ${m.author} at v${m.version}` });
          return;
        }
      }
    }
    try {
      const done = runOp(s, op, ctx);
      const entry: AppliedOp = { index, op, touched: touchedKeys(op, done.createdId), inverse: done.inverse };
      if (done.createdId) entry.createdId = done.createdId;
      applied.push(entry);
    } catch (err) {
      if (!(err instanceof OpFailure)) throw err;
      rejected.push({ index, op, code: err.code, message: err.message });
    }
  });

  if (atomic && rejected.length > 0) {
    const failed = new Set(rejected.map((r) => r.index));
    const others = applied.filter((a) => !failed.has(a.index)).map((a) => ({
      index: a.index, op: a.op, code: 'BATCH_REJECTED' as const, message: 'not applied: another op in this atomic batch was rejected',
    }));
    return {
      state,
      result: { batchId: ctx.batchId, version: state.version, applied: [], skipped, rejected: [...rejected, ...others].sort((a, b) => a.index - b.index) },
    };
  }

  if (applied.length === 0) return { state, result: { batchId: ctx.batchId, version: state.version, applied, rejected, skipped } };

  s.version = state.version + 1;
  for (const a of applied) {
    for (const key of a.touched) if (!key.endsWith('.*')) s.meta[key] = { version: s.version, author: batch.author.name };
  }
  return { state: s, result: { batchId: ctx.batchId, version: s.version, applied, rejected, skipped } };
}
