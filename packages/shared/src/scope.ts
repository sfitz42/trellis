// Scope against milestones (docs/plans/milestones.md): what makes a delivery date, what is in
// Deliver later, and warnings. Tickets have no dates, so they go by their epic's dates.
import type { Epic, IssueId, Milestone, RoadmapState, Ticket } from './schemas.js';
import { BLOCKS } from './schemas.js';
import { compareIds } from './state.js';

/** A ticket is later when it or its epic is deferred. */
export function ticketIsLater(state: RoadmapState, t: Ticket): boolean {
  return t.deferred || (t.epicId !== null && state.epics[t.epicId]?.deferred === true);
}

export interface ScopeBucket {
  epics: IssueId[];
  tickets: IssueId[];
}

export interface ScopeSummary {
  /** The milestone counted against; null when the timeline has none. */
  milestone: Milestone | null;
  /** Scheduled epics due on or before the milestone, and their tickets that aren't later. */
  by: ScopeBucket;
  /** Deferred epics, and tickets deferred themselves or through their epic. */
  later: ScopeBucket;
  /** Neither: epics with no dates or due after the milestone, tickets without an epic. */
  other: ScopeBucket;
}

/** First milestone by date, or the one with this id. Throws for an unknown id. */
export function findMilestone(state: RoadmapState, id?: string): Milestone | null {
  const list = state.timeline.milestones;
  if (id === undefined) return list[0] ?? null;
  const m = list.find((x) => x.id === id);
  if (!m) throw new Error(`no milestone ${id} (known: ${list.map((x) => x.id).join(', ') || 'none'})`);
  return m;
}

export function scopeSummary(state: RoadmapState, milestoneId?: string): ScopeSummary {
  const milestone = findMilestone(state, milestoneId);
  const out: ScopeSummary = { milestone, by: { epics: [], tickets: [] }, later: { epics: [], tickets: [] }, other: { epics: [], tickets: [] } };
  const makesIt = (e: Epic): boolean => milestone !== null && e.dueDate !== null && e.dueDate <= milestone.date;

  for (const e of Object.values(state.epics)) {
    out[e.deferred ? 'later' : makesIt(e) ? 'by' : 'other'].epics.push(e.id);
  }
  const byEpics = new Set(out.by.epics);
  for (const t of Object.values(state.tickets)) {
    const bucket = ticketIsLater(state, t) ? 'later' : t.epicId !== null && byEpics.has(t.epicId) ? 'by' : 'other';
    out[bucket].tickets.push(t.id);
  }
  for (const b of [out.by, out.later, out.other]) {
    b.epics.sort(compareIds);
    b.tickets.sort(compareIds);
  }
  return out;
}

export type ScopeWarning =
  | { kind: 'pastMilestone'; id: IssueId; milestone: Milestone; message: string }
  | { kind: 'blockedByLater'; id: IssueId; blocker: IssueId; message: string }
  | { kind: 'noSlack'; id: IssueId; blocker: IssueId; milestone: Milestone; message: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayMonth(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''}`;
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The milestone a scheduled epic works towards: the first one on or after its start (today when it
 * has none), else the last one. Null for deferred or undated epics, or no milestones.
 */
export function targetMilestone(state: RoadmapState, e: Epic, today: string): Milestone | null {
  const list = state.timeline.milestones;
  if (e.deferred || e.dueDate === null || list.length === 0) return null;
  const from = e.startDate ?? today;
  return list.find((m) => m.date >= from) ?? list[list.length - 1] ?? null;
}

/** Every Blocks link as [blocker, blocked], whichever side stores it, sorted. */
function blocksPairs(state: RoadmapState): [IssueId, IssueId][] {
  const seen = new Map<string, [IssueId, IssueId]>();
  for (const t of Object.values(state.tickets)) {
    for (const l of t.links) {
      if (l.type !== BLOCKS) continue;
      const pair: [IssueId, IssueId] = l.direction === 'outward' ? [t.id, l.target] : [l.target, t.id];
      seen.set(pair.join('|'), pair);
    }
  }
  return [...seen.values()].sort((a, b) => compareIds(a[0], b[0]) || compareIds(a[1], b[1]));
}

/** Warnings about milestones and deferral. `id` is the item the warning is shown on. */
export function scopeWarnings(state: RoadmapState, today: string): ScopeWarning[] {
  const out: ScopeWarning[] = [];
  for (const id of state.epicOrder) {
    const e = state.epics[id];
    if (!e) continue;
    const m = targetMilestone(state, e, today);
    if (m && e.dueDate !== null && e.dueDate > m.date) {
      out.push({ kind: 'pastMilestone', id, milestone: m, message: `${e.summary} is due ${dayMonth(e.dueDate)}, after ${m.label} (${dayMonth(m.date)}). Move it earlier or put it in Deliver later.` });
    }
  }
  for (const [blocker, blocked] of blocksPairs(state)) {
    const a = state.tickets[blocker];
    const b = state.tickets[blocked];
    if (!a || !b || ticketIsLater(state, b)) continue;
    if (ticketIsLater(state, a)) {
      out.push({ kind: 'blockedByLater', id: blocked, blocker, message: `${blocked} is in scope but blocked by ${blocker}, which is in Deliver later.` });
      continue;
    }
    const ea = a.epicId !== null ? state.epics[a.epicId] : undefined;
    const eb = b.epicId !== null ? state.epics[b.epicId] : undefined;
    const m = eb ? targetMilestone(state, eb, today) : null;
    if (m && ea?.dueDate && ea.dueDate <= m.date && ea.dueDate >= addDays(m.date, -6)) {
      out.push({ kind: 'noSlack', id: blocked, blocker, milestone: m, message: `${blocker} (blocks ${blocked}) is only due ${dayMonth(ea.dueDate)}: no slack before ${m.label} (${dayMonth(m.date)}).` });
    }
  }
  return out;
}
