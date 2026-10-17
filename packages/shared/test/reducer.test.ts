import { describe, expect, it } from 'vitest';
import { hasBlocksLink } from '../src/index.js';
import type { Op, Workflow } from '../src/index.js';
import { apply, freshState, loadSnapshot } from './helpers.js';

const codes = (r: { rejected: { code: string }[] }): string[] => r.rejected.map((x) => x.code);

describe('applyBatch basics', () => {
  it('does not mutate the input state', () => {
    const s = freshState();
    const before = structuredClone(s);
    apply(s, [{ type: 'ticket.update', id: 'PROJ-100', fields: { summary: 'Changed' } }]);
    expect(s).toEqual(before);
  });

  it('bumps the version once per batch and records field meta', () => {
    const { state, result } = apply(freshState(), [
      { type: 'ticket.update', id: 'PROJ-100', fields: { summary: 'A' } },
      { type: 'ticket.transition', id: 'PROJ-100', status: 'Done' },
    ]);
    expect(result.version).toBe(1);
    expect(state.version).toBe(1);
    expect(state.meta['PROJ-100.summary']).toEqual({ version: 1, author: 'Sam' });
    expect(state.meta['PROJ-100.status']).toEqual({ version: 1, author: 'Sam' });
  });

  it('leaves the version alone when nothing applies', () => {
    const s = freshState();
    const { state, result } = apply(s, [{ type: 'ticket.update', id: 'PROJ-999', fields: { summary: 'x' } }], { atomic: false });
    expect(result.version).toBe(0);
    expect(state).toBe(s);
  });

  it('rejects everything while frozen', () => {
    const s = { ...freshState(), frozen: { by: 'Shaun', at: '2026-10-17T10:32:00Z' } };
    const { result } = apply(s, [{ type: 'ticket.update', id: 'PROJ-100', fields: { summary: 'x' } }]);
    expect(codes(result)).toEqual(['FROZEN']);
  });

  it('atomic batches are all or nothing', () => {
    const s = freshState();
    const { state, result } = apply(s, [
      { type: 'ticket.update', id: 'PROJ-100', fields: { summary: 'ok' } },
      { type: 'ticket.update', id: 'PROJ-999', fields: { summary: 'missing' } },
    ]);
    expect(state).toBe(s);
    expect(result.applied).toEqual([]);
    expect(codes(result)).toEqual(['BATCH_REJECTED', 'NOT_FOUND']);
  });

  it('non-atomic batches apply what they can', () => {
    const { state, result } = apply(freshState(), [
      { type: 'ticket.update', id: 'PROJ-100', fields: { summary: 'ok' } },
      { type: 'ticket.update', id: 'PROJ-999', fields: { summary: 'missing' } },
    ], { atomic: false });
    expect(state.tickets['PROJ-100']!.summary).toBe('ok');
    expect(result.applied.map((a) => a.index)).toEqual([0]);
    expect(codes(result)).toEqual(['NOT_FOUND']);
  });

  it('later ops in a batch can use ids created earlier in it', () => {
    const { state, result } = apply(freshState(), [
      { type: 'epic.create', fields: { summary: 'Reporting' } },
      { type: 'ticket.create', epicId: 'NEW-1', fields: { summary: 'Export CSV' } },
      { type: 'link.add', from: 'NEW-2', to: 'PROJ-100', linkType: 'blocks' },
    ]);
    expect(result.applied.map((a) => a.createdId)).toEqual(['NEW-1', 'NEW-2', undefined]);
    expect(state.epics['NEW-1']!.ticketOrder).toEqual(['NEW-2']);
    expect(hasBlocksLink(state, 'NEW-2', 'PROJ-100')).toBe(true);
  });
});

describe('conflicts and locks', () => {
  it('skips agent ops on fields a human changed since baseVersion (STALE_FIELD)', () => {
    const human = apply(freshState(), [{ type: 'ticket.update', id: 'PROJ-127', fields: { summary: 'Human edit' } }], {
      author: { name: 'James', kind: 'human' },
    });
    const agent = apply(human.state, [
      { type: 'ticket.update', id: 'PROJ-127', fields: { summary: 'Agent edit' } },
      { type: 'ticket.update', id: 'PROJ-127', fields: { labels: ['agent'] } },
    ], { author: { name: 'Claude Code', kind: 'agent' }, baseVersion: 0 });
    expect(agent.result.skipped.map((x) => [x.index, x.code])).toEqual([[0, 'STALE_FIELD']]);
    expect(agent.result.skipped[0]!.message).toContain('James at v1');
    expect(agent.state.tickets['PROJ-127']!.summary).toBe('Human edit');
    expect(agent.state.tickets['PROJ-127']!.labels).toEqual(['agent']); // a skip doesn't fail an atomic batch
  });

  it("doesn't flag your own earlier edits as stale", () => {
    const first = apply(freshState(), [{ type: 'ticket.update', id: 'PROJ-127', fields: { summary: 'One' } }]);
    const second = apply(first.state, [{ type: 'ticket.update', id: 'PROJ-127', fields: { summary: 'Two' } }], { baseVersion: 0 });
    expect(second.result.skipped).toEqual([]);
    expect(second.state.tickets['PROJ-127']!.summary).toBe('Two');
  });

  it('rejects ops on ids locked by someone else', () => {
    const { result } = apply(freshState(), [{ type: 'ticket.move', id: 'PROJ-121', epicId: 'PROJ-42' }], {
      ctx: { locks: new Map([['PROJ-121', 'Priya']]) },
    });
    expect(codes(result)).toEqual(['LOCKED']);
    expect(result.rejected[0]!.message).toContain('Priya');
  });
});

describe('epic ops', () => {
  it('creates with defaults and appends to epicOrder', () => {
    const { state } = apply(freshState(), [{ type: 'epic.create', fields: { summary: 'Search' } }]);
    expect(state.epics['NEW-1']).toEqual({ id: 'NEW-1', summary: 'Search', status: 'To Do', startDate: null, dueDate: null, ticketOrder: [] });
    expect(state.epicOrder.at(-1)).toBe('NEW-1');
  });

  it('honours a given tempId, refusing duplicates and non-temp ids', () => {
    expect(apply(freshState(), [{ type: 'epic.create', tempId: 'NEW-9', fields: { summary: 'x' } }]).state.epics['NEW-9']).toBeDefined();
    expect(codes(apply(freshState(), [{ type: 'epic.create', tempId: 'PROJ-1', fields: { summary: 'x' } }]).result)).toEqual(['INVALID']);
    const once = apply(freshState(), [{ type: 'epic.create', tempId: 'NEW-9', fields: { summary: 'x' } }]).state;
    expect(codes(apply(once, [{ type: 'epic.create', tempId: 'NEW-9', fields: { summary: 'y' } }]).result)).toEqual(['DUPLICATE_ID']);
  });

  it('updates fields; an empty string clears optional text', () => {
    const { state } = apply(freshState(), [{ type: 'epic.update', id: 'PROJ-41', fields: { summary: 'Migration', description: '', color: 'teal' } }]);
    expect(state.epics['PROJ-41']!.summary).toBe('Migration');
    expect(state.epics['PROJ-41']).not.toHaveProperty('description');
    expect(state.epics['PROJ-41']!.color).toBe('teal');
  });

  it('sets dates and rejects start after due', () => {
    const ok = apply(freshState(), [{ type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-11-01', dueDate: '2027-03-31' }]);
    expect(ok.state.epics['PROJ-41']).toMatchObject({ startDate: '2026-11-01', dueDate: '2027-03-31' });
    const bad = apply(freshState(), [{ type: 'epic.setDates', id: 'PROJ-41', startDate: '2027-04-01', dueDate: '2027-03-31' }]);
    expect(codes(bad.result)).toEqual(['INVALID_DATES']);
  });

  it('transitions only to known statuses', () => {
    expect(apply(freshState(), [{ type: 'epic.transition', id: 'PROJ-41', status: 'Done' }]).state.epics['PROJ-41']!.status).toBe('Done');
    expect(codes(apply(freshState(), [{ type: 'epic.transition', id: 'PROJ-41', status: 'Shipped' }]).result)).toEqual(['INVALID_STATUS']);
  });

  it('reorders, clamping the index', () => {
    const { state } = apply(freshState(), [{ type: 'epic.reorder', id: 'PROJ-40', index: 99 }]);
    expect(state.epicOrder.at(-1)).toBe('PROJ-40');
  });

  it('discards only empty NEW epics', () => {
    const created = apply(freshState(), [
      { type: 'epic.create', fields: { summary: 'A' } },
      { type: 'ticket.create', epicId: 'NEW-1', fields: { summary: 't' } },
    ]).state;
    expect(codes(apply(created, [{ type: 'epic.discardNew', id: 'NEW-1' }]).result)).toEqual(['NOT_EMPTY']);
    expect(codes(apply(created, [{ type: 'epic.discardNew', id: 'PROJ-40' }]).result)).toEqual(['NOT_NEW']);
    const gone = apply(created, [{ type: 'ticket.discardNew', id: 'NEW-2' }, { type: 'epic.discardNew', id: 'NEW-1' }]).state;
    expect(gone.epics['NEW-1']).toBeUndefined();
    expect(gone.epicOrder).not.toContain('NEW-1');
  });
});

describe('ticket ops', () => {
  it('creates with workflow defaults', () => {
    const { state } = apply(freshState(), [{ type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'Dry run' } }]);
    expect(state.tickets['NEW-1']).toMatchObject({ epicId: 'PROJ-41', issueType: 'Task', status: 'To Do', assignee: null, labels: [], storyPoints: null, links: [] });
    expect(state.epics['PROJ-41']!.ticketOrder.at(-1)).toBe('NEW-1');
  });

  it('rejects unknown types, the epic type, and missing epics', () => {
    expect(codes(apply(freshState(), [{ type: 'ticket.create', epicId: null, fields: { summary: 'x', issueType: 'Spike' } }]).result)).toEqual(['INVALID']);
    expect(codes(apply(freshState(), [{ type: 'ticket.create', epicId: null, fields: { summary: 'x', issueType: 'Epic' } }]).result)).toEqual(['INVALID']);
    expect(codes(apply(freshState(), [{ type: 'ticket.create', epicId: 'PROJ-99', fields: { summary: 'x' } }]).result)).toEqual(['NOT_FOUND']);
  });

  it('accepts any type and status when the workflow is unknown', () => {
    const snapshot = loadSnapshot();
    const workflow: Workflow = { epicIssueType: 'Epic', statuses: {}, transitions: null, assignableUsers: [] };
    const { result } = apply(freshState(), [{ type: 'ticket.create', epicId: null, fields: { summary: 'x', issueType: 'Spike', status: 'Triage' } }], {
      snapshot: { ...snapshot, workflow },
    });
    expect(result.applied).toHaveLength(1);
  });

  it('updates fields including assignee, labels and Trellis-owned story points', () => {
    const person = { accountId: 'acc-0003', displayName: 'Casey Moor' };
    const { state } = apply(freshState(), [{ type: 'ticket.update', id: 'PROJ-121', fields: { assignee: person, labels: ['x'], storyPoints: 8, issueType: 'Bug' } }]);
    expect(state.tickets['PROJ-121']).toMatchObject({ assignee: person, labels: ['x'], storyPoints: 8, issueType: 'Bug' });
  });

  it('moves between epics at an index, and out of any epic', () => {
    const moved = apply(freshState(), [{ type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-44', index: 1 }]).state;
    expect(moved.tickets['PROJ-126']!.epicId).toBe('PROJ-44');
    expect(moved.epics['PROJ-44']!.ticketOrder[1]).toBe('PROJ-126');
    expect(moved.epics['PROJ-41']!.ticketOrder).not.toContain('PROJ-126');
    const out = apply(moved, [{ type: 'ticket.move', id: 'PROJ-126', epicId: null }]).state;
    expect(out.tickets['PROJ-126']!.epicId).toBeNull();
    expect(out.epics['PROJ-44']!.ticketOrder).not.toContain('PROJ-126');
  });

  it('reorders within the same epic', () => {
    const { state } = apply(freshState(), [{ type: 'ticket.move', id: 'PROJ-128', epicId: 'PROJ-41', index: 0 }]);
    expect(state.epics['PROJ-41']!.ticketOrder[0]).toBe('PROJ-128');
    expect(state.epics['PROJ-41']!.ticketOrder).toHaveLength(9);
  });

  it('enforces transitions when the workflow lists them', () => {
    const snapshot = loadSnapshot();
    const workflow: Workflow = { ...snapshot.workflow, transitions: { Story: { 'To Do': ['In Progress'] } } };
    const s = freshState();
    const story = Object.values(s.tickets).find((t) => t.issueType === 'Story' && t.status === 'To Do')!;
    const bad = apply(s, [{ type: 'ticket.transition', id: story.id, status: 'Done' }], { snapshot: { ...snapshot, workflow } });
    expect(codes(bad.result)).toEqual(['INVALID_TRANSITION']);
    const ok = apply(s, [{ type: 'ticket.transition', id: story.id, status: 'In Progress' }], { snapshot: { ...snapshot, workflow } });
    expect(ok.result.applied).toHaveLength(1);
  });

  it('discards only NEW tickets, removing their links on both sides', () => {
    const s = apply(freshState(), [
      { type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'n' } },
      { type: 'link.add', from: 'PROJ-120', to: 'NEW-1', linkType: 'blocks' },
    ]).state;
    expect(codes(apply(s, [{ type: 'ticket.discardNew', id: 'PROJ-120' }]).result)).toEqual(['NOT_NEW']);
    const gone = apply(s, [{ type: 'ticket.discardNew', id: 'NEW-1' }]).state;
    expect(gone.tickets['NEW-1']).toBeUndefined();
    expect(gone.epics['PROJ-41']!.ticketOrder).not.toContain('NEW-1');
    expect(gone.tickets['PROJ-120']!.links.some((l) => l.target === 'NEW-1')).toBe(false);
  });
});

describe('link ops', () => {
  it('adds a Blocks link, refusing self links and duplicates', () => {
    const { state } = apply(freshState(), [{ type: 'link.add', from: 'PROJ-126', to: 'PROJ-127', linkType: 'blocks' }]);
    expect(state.tickets['PROJ-126']!.links).toContainEqual({ type: 'Blocks', direction: 'outward', target: 'PROJ-127' });
    expect(codes(apply(freshState(), [{ type: 'link.add', from: 'PROJ-126', to: 'PROJ-126', linkType: 'blocks' }]).result)).toEqual(['SELF_LINK']);
    // PROJ-121 blocks PROJ-122 already (stored on both sides in the fixture).
    expect(codes(apply(freshState(), [{ type: 'link.add', from: 'PROJ-121', to: 'PROJ-122', linkType: 'blocks' }]).result)).toEqual(['DUPLICATE_LINK']);
  });

  it('removes a link from both sides', () => {
    const { state } = apply(freshState(), [{ type: 'link.remove', from: 'PROJ-121', to: 'PROJ-122', linkType: 'blocks' }]);
    expect(hasBlocksLink(state, 'PROJ-121', 'PROJ-122')).toBe(false);
    expect(state.tickets['PROJ-122']!.links.some((l) => l.target === 'PROJ-121' && l.type === 'Blocks')).toBe(false);
    expect(codes(apply(freshState(), [{ type: 'link.remove', from: 'PROJ-122', to: 'PROJ-121', linkType: 'blocks' }]).result)).toEqual(['NOT_FOUND']);
  });

  it('never touches other link types', () => {
    const { state } = apply(freshState(), [{ type: 'link.remove', from: 'PROJ-121', to: 'PROJ-122', linkType: 'blocks' }]);
    expect(state.tickets['PROJ-124']!.links).toEqual(freshState().tickets['PROJ-124']!.links);
  });
});

describe('timeline', () => {
  it('sets the timeline', () => {
    const timeline = { scale: 'quarters', start: '2026-10-01', end: '2027-12-31' } as const;
    const op: Op = { type: 'timeline.set', timeline };
    expect(apply(freshState(), [op]).state.timeline).toEqual(timeline);
  });
});
