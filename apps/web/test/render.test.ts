// Server-side renders of every screen against the fixture: catches template/runtime errors and
// checks the key moments from docs/design are present (no browser needed).
import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBatch, computeChangeset, fromSnapshot, Snapshot } from '@trellis/shared';
import type { Batch, OplogEntry, RoadmapState } from '@trellis/shared';
import App from '../src/App.svelte';
import ActivityRail from '../src/components/ActivityRail.svelte';
import AgentBanner from '../src/components/AgentBanner.svelte';
import AgentPanel from '../src/components/AgentPanel.svelte';
import ChangesTable from '../src/components/ChangesTable.svelte';
import EpicFocus from '../src/components/EpicFocus.svelte';
import FreezeScreen from '../src/components/FreezeScreen.svelte';
import TicketPanel from '../src/components/TicketPanel.svelte';
import Timeline from '../src/components/Timeline.svelte';
import TopBar from '../src/components/TopBar.svelte';
import { Live } from '../src/lib/live.svelte.js';
import { ui } from '../src/lib/ui.svelte.js';

/** Rendered HTML without Svelte's hydration comment markers. */
const text = (r: { body: string }): string => r.body.replace(/<!--.*?-->/g, '');

const snapshot = Snapshot.parse(JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/snapshot.sample.json', import.meta.url), 'utf8')));

function session(): { live: Live; apply: (batch: Batch) => OplogEntry } {
  const live = new Live('Shaun');
  let state: RoadmapState = fromSnapshot(snapshot, { today: '2026-10-17' });
  live.state = state;
  live.snapshot = snapshot;
  live.summary = { pulledAt: snapshot.pulledAt, project: snapshot.project, epics: 5, tickets: 36, newerAvailable: false };
  live.presence = [
    { clientId: live.clientId, name: 'Shaun', kind: 'human', via: 'ws', selection: [], dragging: null },
    { clientId: 'p', name: 'Priya', kind: 'human', via: 'ws', selection: ['PROJ-121'], dragging: 'PROJ-120' },
    { clientId: 'http:Claude Code', name: 'Claude Code', kind: 'agent', via: 'http', selection: [], dragging: null },
  ];
  live.claims = [{ id: 'PROJ-120', holder: 'Priya', clientId: 'p', kind: 'drag', expiresAt: '2099-01-01T00:00:00Z' }];
  let n = 0;
  const apply = (batch: Batch): OplogEntry => {
    const id = `b${++n}`;
    const out = applyBatch(state, batch, { batchId: id, workflow: snapshot.workflow });
    state = out.state;
    live.state = state;
    const entry: OplogEntry = { batch: { ...batch, id }, result: out.result, at: new Date().toISOString() };
    live.oplog = [...live.oplog, entry];
    return entry;
  };
  return { live, apply };
}

const agentBatch: Batch = {
  author: { name: 'Claude Code', kind: 'agent' },
  baseVersion: 0,
  reason: 'Push Notifications back a month and add a dry-run ticket',
  askedBy: 'Shaun',
  atomic: false,
  ops: [
    { type: 'epic.setDates', id: 'PROJ-43', startDate: '2027-02-01', dueDate: '2027-05-31' },
    { type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'Dry-run migration against staging copy' } },
    { type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-99' },
  ],
};

beforeEach(() => {
  ui.view = 'timeline';
  ui.ticket = null;
  ui.epic = null;
  ui.expanded = [];
  ui.filter = '';
  ui.agentPanel = false;
});

describe('screen 1 · live roadmap session', () => {
  it('renders the top bar with presence, change count and freeze', () => {
    const { live, apply } = session();
    apply({ author: { name: 'Shaun', kind: 'human' }, ops: [{ type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-44' }] });
    const html = text(render(TopBar, { props: { live } }));
    expect(html).toContain('Platform Rebuild');
    expect(html).toContain('5 epics · 36 tickets');
    expect(html).toContain('Reconnecting'); // no socket in a test
    expect(html).toMatch(/<span class="count[^"]*">1<\/span> Changes vs Jira/);
    expect(html).toContain('Freeze for apply');
    expect(html).toContain('aria-label="Claude Code, agent"');
  });

  it('renders epics on the timeline, with tickets, soft locks, changes and agent marks', () => {
    const { live, apply } = session();
    apply({ author: { name: 'Shaun', kind: 'human' }, ops: [{ type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-11-01', dueDate: '2027-03-31' }] });
    const entry = apply(agentBatch);
    live.agentTouched = new Map(entry.result.applied.flatMap((a) => (a.createdId ? [[a.createdId, Date.now() + 30_000]] : [])));
    ui.expanded = ['PROJ-41'];
    const html = text(render(Timeline, { props: { live } }));
    for (const name of ['Identity &amp; SSO', 'Data migration', 'Billing v2', 'Notifications service', 'Admin console']) expect(html).toContain(name);
    expect(html).toContain('Oct');
    expect(html).toContain('PROJ-121');
    expect(html).toContain('Priya moving');
    expect(html).toContain('Added by agent');
    expect(html).toContain('title="Differs from Jira"');
    expect(html).toContain('→ blocks PROJ-122');
    expect(html).toContain('+ Add ticket');
  });

  it('filters tickets', () => {
    const { live } = session();
    ui.filter = 'cutover';
    const html = text(render(Timeline, { props: { live } }));
    expect(html).toContain('Cutover runbook and rollback plan');
    expect(html).not.toContain('Billing v2');
  });

  it('renders the activity rail', () => {
    const { live, apply } = session();
    apply({ author: { name: 'Shaun', kind: 'human' }, ops: [{ type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-41' }] });
    apply(agentBatch);
    const html = text(render(ActivityRail, { props: { live } }));
    expect(html).toContain('<strong>Priya</strong> is moving PROJ-120');
    expect(html).toContain('Claude Code');
    expect(html).toContain('(asked by Shaun)');
    expect(html).toContain('<strong>You</strong>');
    expect(html).toContain('CLI clients: Claude Code');
  });
});

describe('screen 2 · ticket detail and dependencies', () => {
  it('shows fields, who else is viewing, dependencies and what differs from Jira', () => {
    const { live, apply } = session();
    apply({
      author: { name: 'Shaun', kind: 'human' },
      ops: [
        { type: 'ticket.transition', id: 'PROJ-121', status: 'Done' },
        { type: 'link.add', from: 'PROJ-121', to: 'PROJ-141', linkType: 'blocks' },
        { type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-11-01', dueDate: '2027-03-31' },
        { type: 'epic.setDates', id: 'PROJ-42', startDate: '2027-01-01', dueDate: '2027-04-30' },
      ],
    });
    ui.openTicket('PROJ-121', 'PROJ-41');
    const panel = text(render(TicketPanel, { props: { live } }));
    expect(panel).toContain('Priya is also viewing');
    expect(panel).toContain('Status · changed');
    expect(panel).toContain('is blocked by');
    expect(panel).toContain('blocks · new');
    expect(panel).toContain('Differs from Jira snapshot');
    expect(panel).toContain(`status: ${snapshot.tickets['PROJ-121']!.status} → Done`);
    expect(panel).toContain('Revert to Jira values');

    const focus = text(render(EpicFocus, { props: { live } }));
    expect(focus).toContain('Dependency chain');
    expect(focus).toContain('PROJ-121 · selected');
    expect(focus).toContain('Nov 2026 → Mar 2027');
    expect(focus).toContain('Jira: due Feb');
    expect(focus).toContain('The dependency crosses backwards on the timeline.');
    expect(focus).toContain('Tickets in this epic');
  });

  it('offers discard for NEW tickets', () => {
    const { live, apply } = session();
    apply({ author: { name: 'Shaun', kind: 'human' }, ops: [{ type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'n' } }] });
    ui.openTicket('NEW-1', 'PROJ-41');
    expect(text(render(TicketPanel, { props: { live } }))).toContain('Discard ticket');
  });
});

describe('screen 3 · agent batch', () => {
  it('shows the banner and panel with request, results, rejection and CLI summary', () => {
    const { live, apply } = session();
    // A human edit after v0 so the agent's change to the same field is kept for them.
    apply({ author: { name: 'James', kind: 'human' }, ops: [{ type: 'epic.setDates', id: 'PROJ-43', startDate: '2027-01-01', dueDate: '2027-04-30' }] });
    const entry = apply(agentBatch);
    live.agentBatch = entry;
    const banner = text(render(AgentBanner, { props: { live, batch: entry } }));
    expect(banner).toContain('Claude Code applied batch #2');
    expect(banner).toContain('asked by Shaun');
    expect(banner).toMatch(/1 change applied, 1 rejected, 1 kept for James/);
    expect(banner).toContain('Undo agent batch');

    const panel = text(render(AgentPanel, { props: { live, batch: entry } }));
    expect(panel).toContain('Agent batch #2');
    expect(panel).toContain('Request from Shaun (facilitator)');
    expect(panel).toContain('Push Notifications back a month');
    expect(panel).toContain('added NEW-1 under PROJ-41');
    expect(panel).toContain('Kept the newer edit');
    expect(panel).toContain('Rejected: epic PROJ-99 not found');
    expect(panel).toContain('What the agent ran');
    expect(panel).toContain('trellis batch --base 0 --asked-by Shaun');
  });
});

describe('screen 4 · freeze and apply', () => {
  it('shows the frozen header, progress, changeset and hand-off', () => {
    const { live, apply } = session();
    apply(agentBatch);
    live.state = { ...live.roadmap, frozen: { by: 'Shaun', at: '2026-10-17T10:32:00Z' } };
    const html = text(render(FreezeScreen, { props: { live } }));
    expect(html).toContain('Session frozen for apply');
    expect(html).toContain('Frozen by Shaun');
    expect(html).toContain('3 · Waiting for agent to apply');
    expect(html).toMatch(/Changeset · \d+ operations/);
    expect(html).toContain('Hand off to your agent');
    expect(html).toContain('pnpm jira:apply --dry-run');
    expect(html).toContain('Watching apply-log.json');
    expect(html).toContain('Unfreeze without applying');

    live.applyLog = [{ target: 'NEW-1', kind: 'ticket.create', status: 'done', createdKey: 'PROJ-400' }, { target: 'PROJ-126', status: 'drift', message: 'assignee changed in Jira' }];
    const after = text(render(FreezeScreen, { props: { live } }));
    expect(after).toContain('NEW-1 → PROJ-400');
    expect(after).toContain('1 drift conflict');
    expect(after).toContain('4 · Re-pull snapshot');
  });

  it('lists changeset ops with operation, target, change and author', () => {
    const { live, apply } = session();
    apply(agentBatch);
    const ops = computeChangeset(snapshot, live.roadmap, live.oplog).ops;
    const html = text(render(ChangesTable, { props: { ops } }));
    expect(html).toContain('Create');
    expect(html).toContain('Dry-run migration against staging copy');
    expect(html).toContain('Claude Code');
  });
});

describe('app shell', () => {
  it('asks for a display name first', () => {
    expect(text(render(App))).toContain('Join session');
  });
});
