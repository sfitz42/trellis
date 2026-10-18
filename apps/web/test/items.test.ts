import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyBatch, computeChangeset, fromSnapshot, Snapshot } from '@trellis/shared';
import type { Op, RoadmapState } from '@trellis/shared';
import {
  backwardsWarnings, changesByItem, dependenciesOf, describeChange, describeOp, initials, revertOps,
} from '../src/lib/items.js';

const snapshot = Snapshot.parse(JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/snapshot.sample.json', import.meta.url), 'utf8')));
const fresh = (): RoadmapState => fromSnapshot(snapshot, { today: '2026-10-17' });
const apply = (s: RoadmapState, ops: Op[]): RoadmapState => applyBatch(s, { author: { name: 'Sam', kind: 'human' }, ops }, { batchId: 't', workflow: snapshot.workflow }).state;

describe('differs from Jira', () => {
  it('groups changes per item and describes them', () => {
    const s = apply(fresh(), [
      { type: 'ticket.transition', id: 'PROJ-121', status: 'Done' },
      { type: 'link.add', from: 'PROJ-121', to: 'PROJ-141', linkType: 'blocks' },
    ]);
    const by = changesByItem(computeChangeset(snapshot, s));
    const lines = (by.get('PROJ-121') ?? []).map((op) => describeChange(op, 'PROJ-121'));
    expect(lines).toEqual([`status: ${snapshot.tickets['PROJ-121']!.status} → Done`, 'links: + blocks PROJ-141']);
    expect((by.get('PROJ-141') ?? []).map((op) => describeChange(op, 'PROJ-141'))).toEqual(['links: + blocked by PROJ-121']);
  });

  it('reverts an item to its Jira values, leaving Trellis-owned fields', () => {
    const edited = apply(fresh(), [
      { type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'X', labels: ['z'], storyPoints: 8 } },
      { type: 'ticket.move', id: 'PROJ-121', epicId: 'PROJ-44' },
      { type: 'ticket.transition', id: 'PROJ-121', status: 'Done' },
      { type: 'link.remove', from: 'PROJ-121', to: 'PROJ-122', linkType: 'blocks' },
      { type: 'link.add', from: 'PROJ-121', to: 'PROJ-141', linkType: 'blocks' },
    ]);
    const reverted = apply(edited, revertOps('PROJ-121', snapshot, edited));
    expect(computeChangeset(snapshot, reverted).ops).toEqual([]);
    expect(reverted.tickets['PROJ-121']?.storyPoints).toBe(8);
  });

  it('reverts epics to the dates Jira was last told', () => {
    const edited = apply(fresh(), [
      { type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-11-01', dueDate: '2027-03-31' },
      { type: 'epic.update', id: 'PROJ-41', fields: { summary: 'Y' } },
    ]);
    const reverted = apply(edited, revertOps('PROJ-41', snapshot, edited));
    expect(computeChangeset(snapshot, reverted).ops).toEqual([]);
    expect(reverted.epics['PROJ-41']).toMatchObject({ startDate: null, dueDate: '2027-02-28' });
  });
});

describe('dependencies', () => {
  it('lists blockers, blocked and other links', () => {
    expect(dependenciesOf(fresh(), 'PROJ-121')).toEqual({ blockedBy: ['PROJ-120'], blocks: ['PROJ-122'], other: [] });
    expect(dependenciesOf(fresh(), 'PROJ-124').other).toEqual([{ type: 'Relates', direction: 'outward', target: 'PROJ-126' }]);
  });

  it('warns when a dependency runs backwards in time', () => {
    // PROJ-121 (Data migration, due Feb 2027) blocks PROJ-141 (Billing v2); start Billing in January.
    const s = apply(fresh(), [
      { type: 'link.add', from: 'PROJ-121', to: 'PROJ-141', linkType: 'blocks' },
      { type: 'epic.setDates', id: 'PROJ-42', startDate: '2027-01-01', dueDate: '2027-04-30' },
      { type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-11-01', dueDate: '2027-03-31' },
    ]);
    const w = backwardsWarnings(s, 'PROJ-121');
    expect(w.map((x) => [x.blocker, x.blocked])).toContainEqual(['PROJ-121', 'PROJ-141']);
    expect(w.find((x) => x.blocked === 'PROJ-141')?.message).toBe("PROJ-141 starts in Jan but PROJ-121's epic now runs to Mar. The dependency crosses backwards on the timeline.");
    // No start date on the blocked epic → no warning.
    expect(backwardsWarnings(fresh(), 'PROJ-161')).toEqual([]);
  });
});

describe('describeOp', () => {
  it('reads like the activity feed', () => {
    const s = fresh();
    expect(describeOp({ type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-41' }, s)).toBe('moved PROJ-126 to Data migration');
    expect(describeOp({ type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'x' } }, s, 'NEW-1')).toBe('added NEW-1 under PROJ-41');
    expect(describeOp({ type: 'epic.setDates', id: 'PROJ-41', startDate: null, dueDate: '2027-03-31' }, s)).toBe('set Data migration to … – Mar');
  });

  it('makes initials, with AI for agents', () => {
    expect(initials('Shaun Fitzsimons')).toBe('SF');
    expect(initials('Priya')).toBe('PR');
    expect(initials('Claude Code')).toBe('AI');
  });
});
