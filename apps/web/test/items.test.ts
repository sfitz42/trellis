import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyBatch, computeChangeset, fromSnapshot, Snapshot } from '@trellis/shared';
import type { Op, OplogEntry, RoadmapState } from '@trellis/shared';
import {
  backwardsWarnings, changesByItem, dependenciesOf, describeChange, describeOp, idsOfOp, initials, revertOps, scheduleEpicOps,
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

describe('deliver later', () => {
  it('reverting a deferred epic undefers it and restores the dates Jira knows', () => {
    const s = apply(fresh(), [{ type: 'epic.defer', id: 'PROJ-43', deferred: true }]);
    const ops = revertOps('PROJ-43', snapshot, s);
    expect(ops).toEqual([
      { type: 'epic.defer', id: 'PROJ-43', deferred: false },
      { type: 'epic.setDates', id: 'PROJ-43', startDate: null, dueDate: '2027-05-31' },
    ]);
    expect(computeChangeset(snapshot, apply(s, ops)).ops).toEqual([]);
  });

  it('reverting a deferred ticket schedules it again', () => {
    const s = apply(fresh(), [{ type: 'ticket.defer', id: 'PROJ-128', deferred: true }]);
    expect(revertOps('PROJ-128', snapshot, s)).toEqual([{ type: 'ticket.defer', id: 'PROJ-128', deferred: false }]);
  });

  it('schedules a deferred epic: its earlier dates back, or from where it is dropped', () => {
    const dated = apply(fresh(), [{ type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-10-19', dueDate: '2026-11-08' }]);
    const out = applyBatch(dated, { author: { name: 'Sam', kind: 'human' }, ops: [{ type: 'epic.defer', id: 'PROJ-41', deferred: true }] }, { batchId: 'b9', workflow: snapshot.workflow });
    const oplog: OplogEntry[] = [{ batch: { id: 'b9', author: { name: 'Sam', kind: 'human' }, ops: [] }, result: out.result, at: '' }];
    const undefer = { type: 'epic.defer', id: 'PROJ-41', deferred: false };
    // Schedule (no drop point): the dates it had before it was deferred.
    expect(scheduleEpicOps(out.state, 'PROJ-41', 'milestones', { today: '2026-10-18', oplog })).toEqual([
      undefer, { type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-10-19', dueDate: '2026-11-08' },
    ]);
    // Dropped on w/c 2 Nov: same three-week length from there.
    expect(scheduleEpicOps(out.state, 'PROJ-41', 'milestones', { at: '2026-11-04', today: '2026-10-18', oplog })).toEqual([
      undefer, { type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-11-02', dueDate: '2026-11-22' },
    ]);
    // Nothing in the log: Jira only knows a due date, so one unit from today.
    expect(scheduleEpicOps(out.state, 'PROJ-41', 'milestones', { today: '2026-10-18' })).toEqual([
      undefer, { type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-10-12', dueDate: '2026-10-18' },
    ]);
    expect(describeOp({ type: 'epic.defer', id: 'PROJ-41', deferred: true }, out.state)).toBe('moved Data migration to Deliver later');
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

  it('marks a new ticket and its epic as touched (agent highlight)', () => {
    expect(idsOfOp({ type: 'ticket.create', epicId: 'PROJ-42', fields: { summary: 'x' } }, 'NEW-1')).toEqual(['PROJ-42', 'NEW-1']);
    expect(idsOfOp({ type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-41' })).toEqual(['PROJ-126', 'PROJ-41']);
  });

  it('makes initials, with AI for agents', () => {
    expect(initials('Shaun Fitzsimons')).toBe('SF');
    expect(initials('Priya')).toBe('PR');
    expect(initials('Claude Code')).toBe('AI');
  });
});
