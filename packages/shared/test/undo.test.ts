import { describe, expect, it } from 'vitest';
import { computeChangeset, planUndo } from '../src/index.js';
import type { Op, RoadmapState } from '../src/index.js';
import { apply, freshState, items, loadSnapshot } from './helpers.js';

/** Apply `ops`, then undo that batch; the roadmap should be back where it started. */
function roundTrip(start: RoadmapState, ops: Op[]): { before: RoadmapState; after: RoadmapState } {
  const done = apply(start, ops);
  expect(done.result.rejected).toEqual([]);
  const plan = planUndo([done.entry], done.entry.batch.id);
  if (!plan.ok) throw new Error(`undo refused: ${plan.reason}`);
  const undone = apply(done.state, plan.ops);
  expect(undone.result.rejected).toEqual([]);
  return { before: start, after: undone.state };
}

const withNew = (): RoadmapState =>
  apply(freshState(), [
    { type: 'epic.create', tempId: 'NEW-1', fields: { summary: 'New epic', description: 'd', color: 'plum', dueDate: '2027-01-31' } },
    { type: 'ticket.create', tempId: 'NEW-2', epicId: 'PROJ-41', fields: { summary: 'New ticket', labels: ['a'] } },
    { type: 'link.add', from: 'NEW-2', to: 'PROJ-121', linkType: 'blocks' },
    { type: 'link.add', from: 'PROJ-120', to: 'NEW-2', linkType: 'blocks' },
  ]).state;

const cases: [string, () => RoadmapState, Op[]][] = [
  ['epic.create', freshState, [{ type: 'epic.create', fields: { summary: 'E' } }]],
  ['epic.update', freshState, [{ type: 'epic.update', id: 'PROJ-41', fields: { summary: 'S', description: '', color: 'teal' } }]],
  ['epic.setDates', freshState, [{ type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-11-01', dueDate: '2027-03-31' }]],
  ['epic.transition', freshState, [{ type: 'epic.transition', id: 'PROJ-41', status: 'Done' }]],
  ['epic.reorder', freshState, [{ type: 'epic.reorder', id: 'PROJ-40', index: 3 }]],
  ['epic.discardNew', withNew, [{ type: 'epic.discardNew', id: 'NEW-1' }]],
  ['ticket.create', freshState, [{ type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'T' } }]],
  ['ticket.update', freshState, [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'S', description: 'x', assignee: null, labels: ['z'], storyPoints: 3 } }]],
  ['ticket.move', freshState, [{ type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-44', index: 0 }]],
  ['ticket.move (no epic)', freshState, [{ type: 'ticket.move', id: 'PROJ-45', epicId: 'PROJ-41' }]],
  ['ticket.transition', freshState, [{ type: 'ticket.transition', id: 'PROJ-121', status: 'Done' }]],
  ['link.add', freshState, [{ type: 'link.add', from: 'PROJ-126', to: 'PROJ-127', linkType: 'blocks' }]],
  ['timeline.set', freshState, [{ type: 'timeline.set', timeline: { scale: 'weeks', start: '2026-10-01', end: '2026-12-31' } }]],
];

describe('undo inverses', () => {
  it.each(cases)('%s round-trips exactly', (_name, start, ops) => {
    const { before, after } = roundTrip(start(), ops);
    expect(items(after)).toEqual(items(before));
  });

  it('ticket.discardNew restores the ticket, its position and its links', () => {
    const { before, after } = roundTrip(withNew(), [{ type: 'ticket.discardNew', id: 'NEW-2' }]);
    expect(items(after)).toEqual(items(before));
  });

  it('link.remove restores the link (as the same link, possibly stored on one side)', () => {
    const { after } = roundTrip(freshState(), [{ type: 'link.remove', from: 'PROJ-121', to: 'PROJ-122', linkType: 'blocks' }]);
    expect(computeChangeset(loadSnapshot(), after).ops).toEqual([]);
  });

  it('undoes a multi-op batch in reverse order', () => {
    const { before, after } = roundTrip(freshState(), [
      { type: 'epic.create', tempId: 'NEW-1', fields: { summary: 'E' } },
      { type: 'ticket.move', id: 'PROJ-126', epicId: 'NEW-1' },
      { type: 'ticket.update', id: 'PROJ-126', fields: { summary: 'Moved' } },
    ]);
    expect(items(after)).toEqual(items(before));
  });
});

describe('planUndo refusals', () => {
  it('refuses when a later batch touched the same field, and says which', () => {
    const one = apply(freshState(), [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'A' } }]);
    const two = apply(one.state, [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'B' } }]);
    const plan = planUndo([one.entry, two.entry], one.entry.batch.id);
    expect(plan).toEqual({ ok: false, reason: 'CONFLICT', conflicts: [{ batchId: two.entry.batch.id, key: 'PROJ-121.summary' }] });
  });

  it('refuses undoing a create once the new item was edited later', () => {
    const one = apply(freshState(), [{ type: 'ticket.create', epicId: null, fields: { summary: 'n' } }]);
    const two = apply(one.state, [{ type: 'ticket.update', id: 'NEW-1', fields: { summary: 'm' } }]);
    expect(planUndo([one.entry, two.entry], one.entry.batch.id)).toMatchObject({ ok: false, reason: 'CONFLICT' });
  });

  it('allows undo when later batches touched other fields', () => {
    const one = apply(freshState(), [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'A' } }]);
    const two = apply(one.state, [{ type: 'ticket.update', id: 'PROJ-121', fields: { labels: ['x'] } }]);
    expect(planUndo([one.entry, two.entry], one.entry.batch.id).ok).toBe(true);
  });

  it('reports unknown or empty batches', () => {
    expect(planUndo([], 'nope')).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    const none = apply(freshState(), [{ type: 'ticket.update', id: 'PROJ-999', fields: { summary: 'x' } }], { atomic: false });
    expect(planUndo([none.entry], none.entry.batch.id)).toMatchObject({ ok: false, reason: 'NOTHING_APPLIED' });
  });
});
