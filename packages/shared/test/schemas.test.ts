import { describe, expect, it } from 'vitest';
import { Batch, IsoDate, IssueId, Op, Snapshot, TimelineConfig } from '../src/index.js';
import { loadSnapshot } from './helpers.js';

describe('schemas', () => {
  it('parses the sanitised fixture snapshot', () => {
    const s = loadSnapshot();
    expect(Object.keys(s.epics)).toHaveLength(5);
    expect(Object.keys(s.tickets).length).toBeGreaterThanOrEqual(30);
    expect(s.workflow.epicIssueType).toBe('Epic');
    expect(s.workflow.transitions).toBeNull();
  });

  it('loads files from before milestones and deferral with the defaults', () => {
    const raw = JSON.parse(JSON.stringify(loadSnapshot())) as { epics: Record<string, Record<string, unknown>>; tickets: Record<string, Record<string, unknown>> };
    for (const e of Object.values(raw.epics)) delete e['deferred'];
    for (const t of Object.values(raw.tickets)) delete t['deferred'];
    const s = Snapshot.parse(raw);
    expect(Object.values(s.epics).every((e) => !e.deferred)).toBe(true);
    expect(Object.values(s.tickets).every((t) => !t.deferred)).toBe(true);
    expect(TimelineConfig.parse({ scale: 'months', start: '2026-10-01', end: '2027-05-31' })).toEqual({
      scale: 'months', start: '2026-10-01', end: '2027-05-31', milestones: [], showLater: true, laterLabel: 'Deliver later',
    });
  });

  it('ignores unknown keys in Jira-derived data', () => {
    const raw = { ...loadSnapshot(), somethingJiraAdded: { x: 1 } };
    expect(Snapshot.parse(raw)).not.toHaveProperty('somethingJiraAdded');
  });

  it('rejects unknown keys in ops (catches agent typos)', () => {
    expect(Op.safeParse({ type: 'ticket.update', id: 'PROJ-1', fields: { sumary: 'x' } }).success).toBe(false);
    expect(Op.safeParse({ type: 'ticket.update', id: 'PROJ-1', fields: { summary: 'x' } }).success).toBe(true);
  });

  it('validates ids and dates', () => {
    expect(IssueId.safeParse('PROJ-12').success).toBe(true);
    expect(IssueId.safeParse('NEW-3').success).toBe(true);
    expect(IssueId.safeParse('proj-12').success).toBe(false);
    expect(IsoDate.safeParse('2027-02-28').success).toBe(true);
    expect(IsoDate.safeParse('2027-02-30').success).toBe(false);
    expect(IsoDate.safeParse('2027-2-1').success).toBe(false);
  });

  it('requires at least one op in a batch', () => {
    expect(Batch.safeParse({ author: { name: 'A', kind: 'agent' }, ops: [] }).success).toBe(false);
  });
});
