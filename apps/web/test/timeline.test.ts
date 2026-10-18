import { describe, expect, it } from 'vitest';
import type { TimelineConfig } from '@trellis/shared';
import {
  barGeometry, columnIndex, columns, dragDates, endPosition, fmtDay, position, scheduleAt, shift, timelineFrom, unitEnd, unitStart,
} from '../src/lib/timeline.js';

const DEFAULTS = { milestones: [], showLater: true, laterLabel: 'Deliver later' };
const tl = (t: Pick<TimelineConfig, 'scale' | 'start' | 'end'> & Partial<TimelineConfig>): TimelineConfig => ({ ...DEFAULTS, ...t });
const months = tl({ scale: 'months', start: '2026-10-01', end: '2027-05-31' });

describe('units', () => {
  it('finds unit boundaries', () => {
    expect(unitStart('2026-10-17', 'months')).toBe('2026-10-01');
    expect(unitEnd('2027-02-10', 'months')).toBe('2027-02-28');
    expect(unitStart('2026-11-20', 'quarters')).toBe('2026-10-01');
    expect(unitEnd('2026-11-20', 'quarters')).toBe('2026-12-31');
    expect(unitStart('2026-10-17', 'weeks')).toBe('2026-10-12'); // Monday
    expect(unitEnd('2026-10-17', 'weeks')).toBe('2026-10-18');
  });

  it('shifts by units, clamping month ends', () => {
    expect(shift('2027-01-31', 1, 'months')).toBe('2027-02-28');
    expect(shift('2026-10-01', -1, 'quarters')).toBe('2026-07-01');
    expect(shift('2026-10-12', 2, 'weeks')).toBe('2026-10-26');
  });
});

describe('columns', () => {
  it('builds month columns with labels', () => {
    const cols = columns(months);
    expect(cols).toHaveLength(8);
    expect(cols[0]).toEqual({ start: '2026-10-01', end: '2026-10-31', label: 'Oct', sublabel: '2026' });
    expect(cols[3]?.label).toBe('Jan');
  });

  it('builds quarter, week and custom columns', () => {
    expect(columns(tl({ scale: 'quarters', start: '2026-10-01', end: '2027-09-30' })).map((c) => c.label)).toEqual(['Q4', 'Q1', 'Q2', 'Q3']);
    expect(columns(tl({ scale: 'weeks', start: '2026-10-14', end: '2026-10-31' }))[0]?.start).toBe('2026-10-12');
    const custom = columns(tl({ scale: 'custom', start: '2026-10-01', end: '2027-03-31', customRanges: [{ label: 'PI 1', start: '2026-10-01', end: '2026-12-31' }] }));
    expect(custom.map((c) => c.label)).toEqual(['PI 1']);
  });

  it('milestones scale: weeks up to the last milestone, or to `end` when there are none', () => {
    // Design screen 1: w/c 19 Oct, 26 Oct, 2 Nov; the 9 Nov line closes the grid.
    const t = tl({ scale: 'milestones', start: '2026-10-19', end: '2026-12-13', milestones: [{ id: 'm1', label: 'Delivery', date: '2026-11-09' }] });
    expect(columns(t).map((c) => c.start)).toEqual(['2026-10-19', '2026-10-26', '2026-11-02']);
    expect(columns(t).map((c) => `${c.label} / ${c.sublabel}`)).toEqual(['w/c 19 Oct / week 1', 'w/c 26 Oct / week 2', 'w/c 2 Nov / week 3']);
    expect(columns({ ...t, milestones: [] })).toHaveLength(8);
    // The 9 Nov line closes the grid: the start of the milestone day.
    expect(position('2026-11-09', columns(t))).toBe(3);
  });
});

describe('positions', () => {
  const cols = columns(months);
  it('maps dates to column units', () => {
    expect(position('2026-10-01', cols)).toBe(0);
    expect(position('2026-11-01', cols)).toBe(1);
    expect(endPosition('2026-11-30', cols)).toBe(2);
    expect(position('2026-10-16', cols)).toBeCloseTo(0.4839, 3);
    expect(columnIndex('2027-01-15', cols)).toBe(3);
  });

  it('extends past either edge', () => {
    expect(position('2026-09-01', cols)).toBeLessThan(0);
    expect(endPosition('2027-06-30', cols)).toBeCloseTo(9, 1);
  });

  it('draws bars, using one unit when there is no start date', () => {
    expect(barGeometry({ startDate: '2026-11-01', dueDate: '2027-03-31' }, cols, 'months')).toEqual({ left: 1, width: 5, hasStart: true, hasDue: true });
    expect(barGeometry({ startDate: null, dueDate: '2027-02-28' }, cols, 'months')).toEqual({ left: 4, width: 1, hasStart: false, hasDue: true });
    expect(barGeometry({ startDate: null, dueDate: null }, cols, 'months')).toBeNull();
  });
});

describe('dragDates', () => {
  const span = { startDate: '2026-11-01', dueDate: '2027-02-28' };
  it('moves both ends by whole units', () => {
    expect(dragDates(span, 'move', 1, 'months')).toEqual({ startDate: '2026-12-01', dueDate: '2027-03-31' });
    expect(dragDates(span, 'move', -1, 'months')).toEqual({ startDate: '2026-10-01', dueDate: '2027-01-31' });
  });

  it('resizes one end without crossing the other', () => {
    expect(dragDates(span, 'end', 1, 'months')).toEqual({ startDate: '2026-11-01', dueDate: '2027-03-31' });
    expect(dragDates(span, 'end', -9, 'months')).toEqual({ startDate: '2026-11-01', dueDate: '2026-11-30' });
    expect(dragDates(span, 'start', 9, 'months')).toEqual({ startDate: '2027-02-01', dueDate: '2027-02-28' });
  });

  it('gives a start date to an epic that only had a due date', () => {
    expect(dragDates({ startDate: null, dueDate: '2027-02-28' }, 'start', -2, 'months')).toEqual({ startDate: '2026-12-01', dueDate: '2027-02-28' });
  });
});

describe('scheduleAt', () => {
  it('starts at the drop unit and keeps the previous length, else one unit', () => {
    expect(scheduleAt('2026-11-04', { startDate: '2026-10-05', dueDate: '2026-10-25' }, 'milestones')).toEqual({ startDate: '2026-11-02', dueDate: '2026-11-22' });
    expect(scheduleAt('2026-11-04', undefined, 'weeks')).toEqual({ startDate: '2026-11-02', dueDate: '2026-11-08' });
    expect(scheduleAt('2026-11-04', { startDate: null, dueDate: '2027-01-31' }, 'months')).toEqual({ startDate: '2026-11-01', dueDate: '2026-11-30' });
    expect(fmtDay('2026-11-09')).toBe('9 Nov');
  });
});

describe('timelineFrom', () => {
  it('starts at the unit and spans N units', () => {
    expect(timelineFrom('2026-10-17', 'months', 8)).toEqual(tl({ scale: 'months', start: '2026-10-01', end: '2027-05-31' }));
    expect(timelineFrom('2026-10-17', 'quarters', 4)).toEqual(tl({ scale: 'quarters', start: '2026-10-01', end: '2027-09-30' }));
  });

  it('keeps milestones and tray settings when the scale changes', () => {
    const prev = tl({ scale: 'milestones', start: '2026-10-19', end: '2026-12-13', milestones: [{ id: 'm1', label: 'Delivery', date: '2026-11-09' }], showLater: false });
    expect(timelineFrom('2026-10-17', 'months', 8, prev)).toMatchObject({ milestones: prev.milestones, showLater: false });
  });
});
