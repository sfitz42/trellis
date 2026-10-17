// Writes packages/shared/fixtures/snapshot.sample.json: a sanitised snapshot in the docs/PLAN.md §3
// shape. Everything is invented and deterministic; only the *structure* mirrors what Phase 0 found
// (epics by hierarchy level, `parent` for children, Blocks links, To Do / In Progress / Done).
import { mkdir, writeFile } from 'node:fs/promises';
import { repoRoot } from '../env.js';

const KEY = 'PROJ';

const people = [
  { accountId: 'acc-0001', displayName: 'Avery Stone' },
  { accountId: 'acc-0002', displayName: 'Blake Rivers' },
  { accountId: 'acc-0003', displayName: 'Casey Moor' },
  { accountId: 'acc-0004', displayName: 'Devon Hale' },
  { accountId: 'acc-0005', displayName: 'Emery Vale' },
];

const statusCategory = { 'To Do': 'new', 'In Progress': 'indeterminate', Done: 'done' } as const;
type Status = keyof typeof statusCategory;

const epicDefs: { summary: string; due: string | null; status: Status; tickets: string[] }[] = [
  { summary: 'Identity & SSO', due: '2026-11-30', status: 'In Progress', tickets: [
    'Add SAML login option', 'Session timeout settings', 'Map roles from identity provider',
    'Login audit trail', 'Fix redirect loop after logout', 'SSO admin setup guide', 'Remember last tenant'] },
  { summary: 'Data migration', due: '2027-02-28', status: 'To Do', tickets: [
    'Map legacy customer schema', 'Backfill job with resumable checkpoints', 'Cutover runbook and rollback plan',
    'Reconcile record counts', 'Dry-run against staging copy', 'Archive retired tables', 'Duplicate rows after import',
    'Migration progress dashboard', 'Sign-off checklist'] },
  { summary: 'Billing v2', due: '2027-04-30', status: 'To Do', tickets: [
    'Provider sandbox account and keys', 'Checkout payment intent flow', 'Webhook handling and retries',
    'Invoice PDF template', 'Proration rules', 'Refund flow', 'Rounding error on annual plans', 'Tax rate lookup'] },
  { summary: 'Notifications service', due: null, status: 'To Do', tickets: [
    'Notification preferences page', 'Email digest job', 'Push provider integration', 'Template versioning',
    'Unsubscribe link broken in some clients', 'Rate limiting per user'] },
  { summary: 'Admin console', due: '2026-12-31', status: 'In Progress', tickets: [
    'User search and filters', 'Bulk deactivate users', 'Feature flag toggles', 'Admin activity log'] },
];

const types = ['Story', 'Story', 'Task', 'Story', 'Bug', 'Task', 'Story', 'Feature'];
const statuses: Status[] = ['Done', 'In Progress', 'To Do', 'To Do', 'To Do', 'In Progress', 'To Do'];
const labelSets = [[], ['backend'], ['frontend'], [], ['backend', 'security'], ['docs'], []];

let n = 39;
const epics: Record<string, unknown> = {};
const tickets: Record<string, Record<string, unknown>> = {};
const epicOrder: string[] = [];

epicDefs.forEach((e, ei) => {
  const epicId = `${KEY}-${++n}`;
  epicOrder.push(epicId);
  const ticketOrder: string[] = [];
  e.tickets.forEach((summary, ti) => {
    const id = `${KEY}-${100 + ei * 20 + ti}`;
    ticketOrder.push(id);
    const issueType = summary.match(/broken|error|loop|Duplicate/) ? 'Bug' : (types[(ei + ti) % types.length] ?? 'Story');
    const status = e.status === 'To Do' && ti > 1 ? 'To Do' : (statuses[(ei * 3 + ti) % statuses.length] ?? 'To Do');
    tickets[id] = {
      id,
      epicId,
      issueType,
      summary,
      description: ti % 3 === 0 ? `Sample description for "${summary}".` : undefined,
      status,
      assignee: ti % 4 === 3 ? null : people[(ei + ti) % people.length],
      labels: labelSets[(ei + ti) % labelSets.length],
      storyPoints: null, // Trellis-owned (not read from Jira); see docs/jira-mapping.md
      links: [],
    };
  });
  epics[epicId] = {
    id: epicId,
    summary: e.summary,
    description: `Sample epic: ${e.summary}.`,
    status: e.status,
    startDate: null, // Trellis-owned (not read from Jira)
    dueDate: e.due,
    ticketOrder,
  };
});

// A few tickets with no epic, like the real project has.
for (const summary of ['Upgrade CI runners', 'Tidy README']) {
  const id = `${KEY}-${++n}`;
  tickets[id] = { id, epicId: null, issueType: 'Task', summary, status: 'To Do', assignee: null, labels: [], storyPoints: null, links: [] };
}

// Blocks links, including one across epics and one pointing backwards in time. Stored on both
// issues, as Jira returns them (outward on the blocker, inward on the blocked), with a link id.
let linkId = 10100;
const link = (from: string, to: string): void => {
  const jiraLinkId = String(linkId++);
  (tickets[from]?.['links'] as unknown[]).push({ type: 'Blocks', direction: 'outward', target: to, jiraLinkId });
  (tickets[to]?.['links'] as unknown[]).push({ type: 'Blocks', direction: 'inward', target: from, jiraLinkId });
};
link(`${KEY}-121`, `${KEY}-122`); // backfill blocks cutover
link(`${KEY}-120`, `${KEY}-121`);
link(`${KEY}-140`, `${KEY}-141`); // sandbox keys block checkout
link(`${KEY}-141`, `${KEY}-142`);
link(`${KEY}-100`, `${KEY}-182`); // SSO blocks admin feature flags (cross-epic)
link(`${KEY}-161`, `${KEY}-103`); // notifications blocks an earlier epic's ticket (backwards in time)
// A non-Blocks link: kept and shown, never edited in v1.
(tickets[`${KEY}-124`]?.['links'] as unknown[]).push({ type: 'Relates', direction: 'outward', target: `${KEY}-126`, jiraLinkId: String(linkId++) });
(tickets[`${KEY}-126`]?.['links'] as unknown[]).push({ type: 'Relates', direction: 'inward', target: `${KEY}-124`, jiraLinkId: String(linkId - 1) });

const snapshot = {
  pulledAt: '2026-10-01T09:42:00.000Z',
  project: { site: 'example.atlassian.net', key: KEY, name: 'Platform Rebuild' },
  epics,
  tickets,
  workflow: {
    // acli cannot list transitions; statuses are those seen per type, transitions assumed open.
    statuses: Object.fromEntries(['Epic', 'Story', 'Task', 'Bug', 'Feature'].map((t) => [
      t, (Object.keys(statusCategory) as Status[]).map((name) => ({ name, category: statusCategory[name] })),
    ])),
    transitions: null,
    assignableUsers: people,
  },
};

const out = `${repoRoot}packages/shared/fixtures/snapshot.sample.json`;
await mkdir(`${repoRoot}packages/shared/fixtures`, { recursive: true });
await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${Object.keys(epics).length} epics, ${Object.keys(tickets).length} tickets.`);
