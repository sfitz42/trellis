// Rebase the roadmap onto a newer Jira snapshot (docs/PLAN.md §6 re-pull, §11 reload).
// Core fields merge three ways: if the roadmap still has the old snapshot's value, take Jira's new
// value; if someone changed it in Trellis, keep the edit. Trellis-owned fields (start date, story
// points, colour, ordering, timeline) are always kept. NEW-* items that apply created in Jira are
// renamed to their real keys.
import type { Epic, IssueId, Link, RoadmapState, Snapshot, Ticket } from './schemas.js';
import { isTempId } from './schemas.js';
import { acknowledgedDates, compareIds, datesKey } from './state.js';

export interface RebaseResult {
  state: RoadmapState;
  /** NEW-* id → real key, for items found in the new snapshot. */
  renamed: Record<IssueId, IssueId>;
  /** Items that appeared in Jira since the old snapshot. */
  added: IssueId[];
  /** Items that left the snapshot (no longer in the project or JQL scope). */
  dropped: IssueId[];
  /** Fields where a Trellis edit was kept over Jira's value (`${id}.${field}`). */
  keptEdits: string[];
}

// Epic dates are Trellis-owned: merged against `acknowledged` (what Jira was told), not the snapshot.
// `deferred` is a core field: Jira holds it as the `deliver-later` label.
const EPIC_CORE = ['summary', 'description', 'status', 'deferred'] as const;
const TICKET_CORE = ['epicId', 'issueType', 'summary', 'description', 'status', 'assignee', 'labels', 'deferred'] as const;

function norm(field: string, v: unknown): string {
  if (field === 'description') return JSON.stringify(v ?? '');
  if (field === 'labels') return JSON.stringify([...((v as string[] | undefined) ?? [])].sort());
  if (field === 'assignee') return JSON.stringify((v as { accountId: string } | null)?.accountId ?? null);
  return JSON.stringify(v ?? null);
}

type Triple = { from: IssueId; type: string; to: IssueId; jiraLinkId?: string };

function triples(tickets: Iterable<Ticket>): Map<string, Triple> {
  const out = new Map<string, Triple>();
  for (const t of tickets) {
    for (const l of t.links) {
      const [from, to] = l.direction === 'outward' ? [t.id, l.target] : [l.target, t.id];
      const key = `${from}|${l.type}|${to}`;
      const entry: Triple = { from, type: l.type, to };
      const id = l.jiraLinkId ?? out.get(key)?.jiraLinkId;
      if (id !== undefined) entry.jiraLinkId = id;
      out.set(key, entry);
    }
  }
  return out;
}

function renameId(id: IssueId, map: Record<IssueId, IssueId>): IssueId {
  return map[id] ?? id;
}

export function rebaseOnSnapshot(
  current: RoadmapState,
  oldSnapshot: Snapshot | null,
  newSnapshot: Snapshot,
  tempIdMap: Record<IssueId, IssueId> = {},
  /** `acknowledged` keys (e.g. `PROJ-43.dates`, `PROJ-126.epicId`) that apply told Jira about. */
  told: readonly string[] = [],
): RebaseResult {
  // 1. Rename NEW-* items that now exist in Jira.
  const renamed: Record<IssueId, IssueId> = {};
  for (const [temp, key] of Object.entries(tempIdMap)) {
    if ((current.epics[temp] || current.tickets[temp]) && (newSnapshot.epics[key] || newSnapshot.tickets[key])) renamed[temp] = key;
  }
  const s = renameAll(structuredClone(current), renamed);
  const renamedKeys = new Set(Object.values(renamed));
  const acknowledged: Record<string, unknown> = { ...s.acknowledged };
  // Apply posted these: from now on Jira "knows" the current Trellis value.
  for (const key of told) {
    const k = key.replace(/^([^.]+)/, (id) => renamed[id] ?? id);
    const [id = '', field] = k.split('.');
    if (field === 'dates' && s.epics[id]) acknowledged[k] = { startDate: s.epics[id].startDate, dueDate: s.epics[id].dueDate };
    if (field === 'epicId' && s.tickets[id]) acknowledged[k] = s.tickets[id].epicId;
  }

  // The base for the merge: the old snapshot, plus renamed items as we have them (so Jira's
  // values win for those: apply wrote our values, Jira's are what actually landed).
  const baseEpics: Record<IssueId, Epic> = { ...(oldSnapshot?.epics ?? {}) };
  const baseTickets: Record<IssueId, Ticket> = { ...(oldSnapshot?.tickets ?? {}) };
  for (const key of renamedKeys) {
    if (s.epics[key]) baseEpics[key] = s.epics[key];
    if (s.tickets[key]) baseTickets[key] = s.tickets[key];
  }

  const added: IssueId[] = [];
  const dropped: IssueId[] = [];
  const keptEdits: string[] = [];
  const epics: Record<IssueId, Epic> = {};
  const tickets: Record<IssueId, Ticket> = {};

  // 2. Epics and tickets present in Jira now.
  for (const theirs of Object.values(newSnapshot.epics)) {
    const ours = s.epics[theirs.id];
    if (!ours) {
      epics[theirs.id] = structuredClone(theirs);
      acknowledged[datesKey(theirs.id)] = { startDate: theirs.startDate, dueDate: theirs.dueDate };
      added.push(theirs.id);
      continue;
    }
    const base = baseEpics[theirs.id] ?? ours;
    const merged: Epic = { ...ours };
    for (const f of EPIC_CORE) {
      if (norm(f, ours[f]) === norm(f, base[f])) assign(merged, f, theirs[f]);
      else if (norm(f, ours[f]) !== norm(f, theirs[f])) keptEdits.push(`${ours.id}.${f}`);
    }
    // Due date (Trellis-owned): take Jira's value only when Jira itself changed it since the last
    // snapshot AND Trellis hasn't changed it since Jira was last told. Otherwise keep ours.
    const toldDates = acknowledgedDates({ ...s, acknowledged }, theirs.id) ?? { startDate: ours.startDate, dueDate: base.dueDate };
    if (renamedKeys.has(theirs.id)) {
      acknowledged[datesKey(theirs.id)] = { startDate: ours.startDate, dueDate: theirs.dueDate };
      merged.dueDate = theirs.dueDate;
    } else if (theirs.dueDate !== base.dueDate) {
      if (ours.dueDate === toldDates.dueDate) {
        merged.dueDate = theirs.dueDate;
        acknowledged[datesKey(theirs.id)] = { startDate: toldDates.startDate, dueDate: theirs.dueDate };
      } else if (ours.dueDate !== theirs.dueDate) {
        keptEdits.push(`${ours.id}.dueDate`);
      }
    }
    // Deferred in Jira (label added there): a deferred epic has no dates in Trellis.
    if (merged.deferred && !ours.deferred) {
      merged.startDate = null;
      merged.dueDate = null;
    }
    epics[theirs.id] = merged;
  }
  for (const theirs of Object.values(newSnapshot.tickets)) {
    const ours = s.tickets[theirs.id];
    if (!ours) {
      tickets[theirs.id] = structuredClone(theirs);
      added.push(theirs.id);
      continue;
    }
    const base = baseTickets[theirs.id] ?? ours;
    const merged: Ticket = { ...ours };
    for (const f of TICKET_CORE) {
      if (norm(f, ours[f]) === norm(f, base[f])) assign(merged, f, structuredClone(theirs[f]));
      else if (norm(f, ours[f]) !== norm(f, theirs[f])) keptEdits.push(`${ours.id}.${f}`);
    }
    tickets[theirs.id] = merged;
  }

  // 3. Items not in the new snapshot: keep NEW-* ones, drop the rest.
  for (const e of Object.values(s.epics)) {
    if (epics[e.id]) continue;
    if (isTempId(e.id)) epics[e.id] = e;
    else dropped.push(e.id);
  }
  for (const t of Object.values(s.tickets)) {
    if (tickets[t.id]) continue;
    if (isTempId(t.id)) tickets[t.id] = t;
    else dropped.push(t.id);
  }
  for (const t of Object.values(tickets)) if (t.epicId !== null && !epics[t.epicId]) t.epicId = null;

  // 4. Links, three ways on (from, type, to): Jira's now + ours added − ours removed.
  const base = triples(Object.values(baseTickets));
  for (const [k, v] of triples([...renamedKeys].flatMap((id) => (s.tickets[id] ? [s.tickets[id]] : [])))) base.set(k, v);
  const ours = triples(Object.values(s.tickets));
  const result = triples(Object.values(newSnapshot.tickets));
  for (const [k, v] of ours) if (!base.has(k) && !result.has(k)) result.set(k, v);
  for (const k of base.keys()) if (!ours.has(k)) result.delete(k);
  for (const t of Object.values(tickets)) t.links = [];
  for (const l of [...result.values()].sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to))) {
    const link = (direction: Link['direction'], target: IssueId): Link => {
      const out: Link = { type: l.type, direction, target };
      if (l.jiraLinkId !== undefined) out.jiraLinkId = l.jiraLinkId;
      return out;
    };
    if (tickets[l.from]) tickets[l.from]?.links.push(link('outward', l.to));
    else tickets[l.to]?.links.push(link('inward', l.from));
  }

  // 5. Ordering: keep ours, drop gone ids, append newcomers.
  const epicOrder = s.epicOrder.filter((id) => epics[id]);
  for (const id of Object.keys(epics).sort(compareIds)) if (!epicOrder.includes(id)) epicOrder.push(id);
  for (const e of Object.values(epics)) {
    const mine = Object.values(tickets).filter((t) => t.epicId === e.id).map((t) => t.id);
    const kept = e.ticketOrder.filter((id) => mine.includes(id));
    e.ticketOrder = [...kept, ...mine.filter((id) => !kept.includes(id)).sort(compareIds)];
  }

  const gone = new Set(dropped);
  const alive = ([k]: [string, unknown]): boolean => !gone.has(k.slice(0, k.indexOf('.')));
  const meta = Object.fromEntries(Object.entries(s.meta).filter(alive));

  return {
    state: {
      ...s,
      project: { key: newSnapshot.project.key, name: newSnapshot.project.name },
      epics,
      tickets,
      epicOrder,
      meta,
      acknowledged: Object.fromEntries(Object.entries(acknowledged).filter(alive)),
      version: current.version + 1,
    },
    renamed,
    added: added.sort(compareIds),
    dropped: dropped.sort(compareIds),
    keptEdits,
  };
}

function assign<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete obj[key];
  else obj[key] = value;
}

function renameAll(s: RoadmapState, map: Record<IssueId, IssueId>): RoadmapState {
  if (Object.keys(map).length === 0) return s;
  const r = (id: IssueId): IssueId => renameId(id, map);
  const epics: Record<IssueId, Epic> = {};
  for (const e of Object.values(s.epics)) epics[r(e.id)] = { ...e, id: r(e.id), ticketOrder: e.ticketOrder.map(r) };
  const tickets: Record<IssueId, Ticket> = {};
  for (const t of Object.values(s.tickets)) {
    tickets[r(t.id)] = { ...t, id: r(t.id), epicId: t.epicId === null ? null : r(t.epicId), links: t.links.map((l) => ({ ...l, target: r(l.target) })) };
  }
  const renameKey = <V,>([k, v]: [string, V]): [string, V] => {
    const dot = k.indexOf('.');
    return dot > 0 ? [`${r(k.slice(0, dot))}${k.slice(dot)}`, v] : [k, v];
  };
  const meta = Object.fromEntries(Object.entries(s.meta).map(renameKey));
  const acknowledged = Object.fromEntries(Object.entries(s.acknowledged).map(renameKey));
  return { ...s, epics, tickets, epicOrder: s.epicOrder.map(r), meta, acknowledged };
}
