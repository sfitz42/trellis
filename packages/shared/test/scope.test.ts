import { describe, expect, it } from 'vitest';
import { scopeSummary, scopeWarnings, targetMilestone } from '../src/index.js';
import type { Op, RoadmapState } from '../src/index.js';
import { apply, freshState, timeline, TODAY } from './helpers.js';

const delivery = { id: 'm1', label: 'Delivery', date: '2026-11-09' };

/** Design screen 1: three epics make 9 Nov, Notifications and Admin console are deferred, one ticket too. */
function designState(extra: Op[] = []): RoadmapState {
  return apply(freshState(), [
    { type: 'timeline.set', timeline: timeline({ scale: 'milestones', start: '2026-10-19', end: '2026-11-08', milestones: [delivery] }) },
    { type: 'epic.setDates', id: 'PROJ-40', startDate: '2026-10-19', dueDate: '2026-11-01' },
    { type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-10-26', dueDate: '2026-11-08' },
    { type: 'epic.setDates', id: 'PROJ-42', startDate: '2026-10-19', dueDate: '2026-11-08' },
    { type: 'epic.defer', id: 'PROJ-43', deferred: true },
    { type: 'epic.defer', id: 'PROJ-44', deferred: true },
    { type: 'ticket.defer', id: 'PROJ-128', deferred: true },
    ...extra,
  ]).state;
}

describe('scopeSummary', () => {
  it('counts what makes the milestone and what is later', () => {
    const s = scopeSummary(designState());
    expect(s.milestone).toEqual(delivery);
    expect(s.by.epics).toEqual(['PROJ-40', 'PROJ-41', 'PROJ-42']);
    expect(s.by.tickets).toHaveLength(23); // 7 + 8 (one of 9 deferred) + 8
    expect(s.later.epics).toEqual(['PROJ-43', 'PROJ-44']);
    expect(s.later.tickets).toHaveLength(11); // 6 + 4 through their epics, plus PROJ-128
    expect(s.later.tickets).toContain('PROJ-128');
    expect(s.other).toEqual({ epics: [], tickets: ['PROJ-45', 'PROJ-46'] });
  });

  it('a ticket deferred inside a deferred epic is counted once', () => {
    const s = scopeSummary(designState([{ type: 'ticket.defer', id: 'PROJ-160', deferred: true }]));
    expect(s.later.tickets.filter((id) => id === 'PROJ-160')).toHaveLength(1);
  });

  it('epics due after the milestone, or undated, are neither in nor later', () => {
    const s = scopeSummary(designState([{ type: 'epic.setDates', id: 'PROJ-42', startDate: null, dueDate: '2026-11-10' }]));
    expect(s.other.epics).toEqual(['PROJ-42']);
    expect(s.by.tickets).toHaveLength(15);
  });

  it('with no milestones nothing is "by"; unknown ids throw', () => {
    const s = scopeSummary(freshState());
    expect(s.milestone).toBeNull();
    expect(s.by.epics).toEqual([]);
    expect(() => scopeSummary(designState(), 'm9')).toThrow(/no milestone m9/);
  });
});

describe('scopeWarnings', () => {
  it('flags an epic due after the milestone it works towards', () => {
    const s = designState([{ type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-10-26', dueDate: '2026-11-15' }]);
    expect(targetMilestone(s, s.epics['PROJ-41']!, TODAY)).toEqual(delivery);
    const w = scopeWarnings(s, TODAY).filter((x) => x.kind === 'pastMilestone');
    expect(w.map((x) => x.id)).toEqual(['PROJ-41']);
    expect(w[0]!.message).toMatch(/due 15 Nov, after Delivery \(9 Nov\)/);
  });

  it('flags an in-scope ticket blocked by a deferred one', () => {
    // PROJ-120 blocks PROJ-121 (both Data migration); PROJ-161 (Notifications, deferred) blocks PROJ-103.
    const s = designState([{ type: 'ticket.defer', id: 'PROJ-120', deferred: true }]);
    expect(scopeWarnings(s, TODAY).filter((x) => x.kind === 'blockedByLater')).toEqual([
      expect.objectContaining({ id: 'PROJ-121', blocker: 'PROJ-120' }),
      expect.objectContaining({ id: 'PROJ-103', blocker: 'PROJ-161' }),
    ]);
  });

  it('flags a dependency whose blocker lands in the last week before the milestone', () => {
    // PROJ-140 blocks PROJ-141 (Billing v2, due 8 Nov: one day before Delivery).
    const kinds = scopeWarnings(designState(), TODAY).filter((x) => x.kind === 'noSlack').map((x) => `${x.blocker}>${x.id}`);
    expect(kinds).toContain('PROJ-140>PROJ-141');
    const early = designState([{ type: 'epic.setDates', id: 'PROJ-42', startDate: '2026-10-19', dueDate: '2026-10-30' }]);
    expect(scopeWarnings(early, TODAY).filter((x) => x.kind === 'noSlack' && x.blocker === 'PROJ-140')).toEqual([]);
  });

  it('says nothing about deferred work', () => {
    const s = designState();
    expect(scopeWarnings(s, TODAY).some((w) => w.id === 'PROJ-43' || w.id === 'PROJ-160')).toBe(false);
  });
});
