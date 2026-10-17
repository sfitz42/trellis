import { describe, expect, it } from 'vitest';
import { computeChangeset } from '../src/index.js';
import type { OplogEntry, RoadmapState } from '../src/index.js';
import { apply, freshState, loadSnapshot } from './helpers.js';

const kinds = (s: RoadmapState, log: OplogEntry[] = []) => computeChangeset(loadSnapshot(), s, log).ops.map((o) => o.kind);

describe('computeChangeset', () => {
  it('is empty for an untouched roadmap', () => {
    expect(computeChangeset(loadSnapshot(), freshState()).ops).toEqual([]);
  });

  it('treats links stored on both sides, or one, as the same link', () => {
    const s = freshState();
    // Drop the inward copies; the outward copies alone describe the same links.
    for (const t of Object.values(s.tickets)) t.links = t.links.filter((l) => l.direction === 'outward');
    expect(computeChangeset(loadSnapshot(), s).ops).toEqual([]);
  });

  it('ignores Trellis-owned fields', () => {
    const { state } = apply(freshState(), [
      { type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-11-01', dueDate: '2027-02-28' }, // due unchanged
      { type: 'ticket.update', id: 'PROJ-121', fields: { storyPoints: 8 } },
      { type: 'epic.update', id: 'PROJ-41', fields: { color: 'teal' } },
      { type: 'epic.reorder', id: 'PROJ-43', index: 0 },
      { type: 'ticket.move', id: 'PROJ-128', epicId: 'PROJ-41', index: 0 },
      { type: 'timeline.set', timeline: { scale: 'weeks', start: '2026-10-01', end: '2026-12-31' } },
    ]);
    expect(kinds(state)).toEqual([]);
  });

  it('cancels out edits that return to the Jira value', () => {
    const a = apply(freshState(), [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'Temp' } }]).state;
    const b = apply(a, [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: loadSnapshot().tickets['PROJ-121']!.summary } }]).state;
    expect(kinds(b)).toEqual([]);
  });

  it('orders ops so dependencies resolve', () => {
    const { state } = apply(freshState(), [
      { type: 'link.remove', from: 'PROJ-121', to: 'PROJ-122', linkType: 'blocks' },
      { type: 'link.add', from: 'PROJ-126', to: 'PROJ-127', linkType: 'blocks' },
      { type: 'epic.setDates', id: 'PROJ-41', startDate: null, dueDate: '2027-03-31' },
      { type: 'ticket.transition', id: 'PROJ-121', status: 'Done' },
      { type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'Renamed' } },
      { type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-44' },
      { type: 'ticket.create', epicId: 'NEW-1', fields: { summary: 'Child of new epic' } },
      { type: 'epic.create', tempId: 'NEW-1', fields: { summary: 'New epic' } },
    ], { atomic: false });
    // The ticket.create above ran before its epic existed and was rejected; create it again.
    const s2 = apply(state, [{ type: 'ticket.create', epicId: 'NEW-1', fields: { summary: 'Child of new epic' } }]).state;
    expect(kinds(s2)).toEqual(['epic.create', 'ticket.create', 'ticket.move', 'field.update', 'transition', 'epic.dueDate', 'link.add', 'link.remove']);
    const cs = computeChangeset(loadSnapshot(), s2);
    expect(cs.ops.map((o) => o.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(cs.ops.find((o) => o.kind === 'ticket.create')).toMatchObject({ target: 'NEW-2', after: { epicId: 'NEW-1', issueType: 'Task' } });
  });

  it('records before/after values and the Jira link id on removals', () => {
    const { state } = apply(freshState(), [
      { type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-44' },
      { type: 'link.remove', from: 'PROJ-121', to: 'PROJ-122', linkType: 'blocks' },
      { type: 'epic.setDates', id: 'PROJ-41', startDate: null, dueDate: '2027-03-31' },
    ]);
    const ops = computeChangeset(loadSnapshot(), state).ops;
    expect(ops.find((o) => o.kind === 'ticket.move')).toMatchObject({ before: 'PROJ-41', after: 'PROJ-44' });
    expect(ops.find((o) => o.kind === 'epic.dueDate')).toMatchObject({ before: '2027-02-28', after: '2027-03-31' });
    expect(ops.find((o) => o.kind === 'link.remove')).toMatchObject({ target: 'PROJ-121', to: 'PROJ-122', linkType: 'Blocks', jiraLinkId: expect.any(String) });
  });

  it('adds a transition after creating a new item in a non-initial status', () => {
    const { state } = apply(freshState(), [{ type: 'ticket.create', epicId: null, fields: { summary: 'Started', status: 'In Progress' } }]);
    expect(kinds(state)).toEqual(['ticket.create', 'transition']);
  });

  it('emits nothing for NEW items discarded during the session', () => {
    const a = apply(freshState(), [{ type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'Oops' } }]).state;
    expect(kinds(apply(a, [{ type: 'ticket.discardNew', id: 'NEW-1' }]).state)).toEqual([]);
  });

  it('carries who changed an item and captured agent requests', () => {
    const human = apply(freshState(), [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'Human' } }], { author: { name: 'James', kind: 'human' } });
    const agent = apply(human.state, [{ type: 'ticket.transition', id: 'PROJ-121', status: 'Done' }], {
      author: { name: 'Claude Code', kind: 'agent' }, reason: 'close the backfill ticket', askedBy: 'Shaun',
    });
    const ops = computeChangeset(loadSnapshot(), agent.state, [human.entry, agent.entry]).ops;
    expect(ops[0]!.by).toEqual(['Claude Code', 'James']);
    expect(ops[0]!.reasons).toEqual([{ batchId: agent.entry.batch.id, reason: 'close the backfill ticket', askedBy: 'Shaun' }]);
  });

  it('has a stable id that changes when the ops change', () => {
    const s = apply(freshState(), [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'X' } }]).state;
    const a = computeChangeset(loadSnapshot(), s);
    expect(computeChangeset(loadSnapshot(), s).id).toBe(a.id);
    const t = apply(s, [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'Y' } }]).state;
    expect(computeChangeset(loadSnapshot(), { ...t, version: s.version }).id).not.toBe(a.id);
  });
});
