// Raw Jira issues → Trellis epics and tickets, using only fields every project has
// (docs/jira-mapping.md, "Core fields"). Unknown or missing fields degrade to empty values.
import type { Epic, Link, Person, StatusInfo, Ticket } from '@trellis/shared';
import { adfToMarkdown } from './adf.js';
import type { ProjectInfo, RawIssue } from './adapter.js';

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export interface Hierarchy {
  /** hierarchy level by issue type name */
  level: Map<string, number>;
  epicType: string;
}

export function hierarchyOf(project: ProjectInfo): Hierarchy {
  const level = new Map(project.issueTypes.map((t) => [t.name, t.hierarchyLevel]));
  const epic = project.issueTypes.find((t) => t.hierarchyLevel === 1);
  return { level, epicType: epic?.name ?? 'Epic' };
}

export function typeName(raw: RawIssue): string {
  return str(obj(raw.fields['issuetype'])?.['name']) ?? 'Task';
}

export function levelOf(raw: RawIssue, h: Hierarchy): number {
  const it = obj(raw.fields['issuetype']);
  const fromIssue = it?.['hierarchyLevel'];
  if (typeof fromIssue === 'number') return fromIssue;
  if (it?.['subtask'] === true) return -1;
  return h.level.get(typeName(raw)) ?? 0;
}

export function statusOf(raw: RawIssue): StatusInfo {
  const s = obj(raw.fields['status']);
  return { name: str(s?.['name']) ?? 'Unknown', category: str(obj(s?.['statusCategory'])?.['key']) ?? 'new' };
}

export function personOf(v: unknown): Person | null {
  const p = obj(v);
  const id = str(p?.['accountId']);
  return id ? { accountId: id, displayName: str(p?.['displayName']) ?? id } : null;
}

export function parentKey(raw: RawIssue): string | null {
  return str(obj(raw.fields['parent'])?.['key']) ?? null;
}

export function linksOf(raw: RawIssue): Link[] {
  const list = Array.isArray(raw.fields['issuelinks']) ? (raw.fields['issuelinks'] as unknown[]) : [];
  return list.flatMap((l) => {
    const o = obj(l);
    const type = str(obj(o?.['type'])?.['name']);
    const outward = str(obj(o?.['outwardIssue'])?.['key']);
    const inward = str(obj(o?.['inwardIssue'])?.['key']);
    if (!type || (!outward && !inward)) return [];
    const link: Link = { type, direction: outward ? 'outward' : 'inward', target: (outward ?? inward) as string };
    const id = o?.['id'];
    if (typeof id === 'string' || typeof id === 'number') link.jiraLinkId = String(id);
    return [link];
  });
}

/**
 * The Jira label for Deliver later (docs/plans/milestones.md, M0 decision 4). Trellis reads it as
 * `deferred` and never shows it among an issue's labels.
 */
export const LATER_LABEL = 'deliver-later';

/** All of the issue's labels, the Deliver later one included. */
export function allLabelsOf(raw: RawIssue): string[] {
  const l = raw.fields['labels'];
  return Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string') : [];
}

/** The issue's labels as Trellis shows them: without the Deliver later label. */
export function labelsOf(raw: RawIssue): string[] {
  return allLabelsOf(raw).filter((l) => l !== LATER_LABEL);
}

export function deferredOf(raw: RawIssue): boolean {
  return allLabelsOf(raw).includes(LATER_LABEL);
}

export function descriptionOf(raw: RawIssue): string {
  return adfToMarkdown(raw.fields['description']);
}

export function dueDateOf(raw: RawIssue): string | null {
  const d = str(raw.fields['duedate']);
  return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

export function toEpic(raw: RawIssue): Epic {
  const e: Epic = {
    id: raw.key,
    summary: str(raw.fields['summary']) || raw.key,
    status: statusOf(raw).name,
    startDate: null, // Trellis-owned
    dueDate: dueDateOf(raw),
    ticketOrder: [],
    deferred: deferredOf(raw),
  };
  const d = descriptionOf(raw);
  if (d) e.description = d;
  return e;
}

export function toTicket(raw: RawIssue, epicKeys: ReadonlySet<string>): Ticket {
  const parent = parentKey(raw);
  const t: Ticket = {
    id: raw.key,
    epicId: parent && epicKeys.has(parent) ? parent : null,
    issueType: typeName(raw),
    summary: str(raw.fields['summary']) || raw.key,
    status: statusOf(raw).name,
    assignee: personOf(raw.fields['assignee']),
    labels: labelsOf(raw),
    storyPoints: null, // Trellis-owned
    links: linksOf(raw),
    deferred: deferredOf(raw),
  };
  const d = descriptionOf(raw);
  if (d) t.description = d;
  return t;
}
