import { describe, expect, it } from 'vitest';
import { compareIds, defaultTicketType, defaultTimeline, fromSnapshot, initialStatus, nextTempId } from '../src/index.js';
import { freshState, loadSnapshot, TODAY } from './helpers.js';

describe('fromSnapshot', () => {
  it('copies items without sharing references with the snapshot', () => {
    const snap = loadSnapshot();
    const s = fromSnapshot(snap, { today: TODAY });
    s.tickets['PROJ-100']!.summary = 'changed';
    expect(snap.tickets['PROJ-100']!.summary).not.toBe('changed');
    expect(s.version).toBe(0);
    expect(s.frozen).toBeNull();
  });

  it('orders epics by due date, undated last', () => {
    const s = freshState();
    expect(s.epicOrder).toEqual(['PROJ-40', 'PROJ-44', 'PROJ-41', 'PROJ-42', 'PROJ-43']);
  });

  it('repairs ticketOrder to list exactly the epic tickets', () => {
    const snap = loadSnapshot();
    snap.epics['PROJ-40']!.ticketOrder = ['PROJ-999', 'PROJ-102'];
    const order = fromSnapshot(snap, { today: TODAY }).epics['PROJ-40']!.ticketOrder;
    expect(order[0]).toBe('PROJ-102');
    expect(order).not.toContain('PROJ-999');
    expect(order).toHaveLength(7);
  });

  it('detaches tickets whose epic is missing', () => {
    const snap = loadSnapshot();
    snap.tickets['PROJ-45']!.epicId = 'PROJ-1';
    expect(fromSnapshot(snap, { today: TODAY }).tickets['PROJ-45']!.epicId).toBeNull();
  });
});

describe('helpers', () => {
  it('builds a month-based default timeline', () => {
    expect(defaultTimeline('2026-10-17')).toEqual({ scale: 'months', start: '2026-10-01', end: '2027-05-31' });
  });

  it('allocates the next temp id', () => {
    const s = freshState();
    expect(nextTempId(s)).toBe('NEW-1');
    s.tickets['NEW-4'] = { ...s.tickets['PROJ-100']!, id: 'NEW-4' };
    expect(nextTempId(s)).toBe('NEW-5');
  });

  it('compares ids numerically', () => {
    expect(['PROJ-10', 'PROJ-9', 'NEW-2'].sort(compareIds)).toEqual(['NEW-2', 'PROJ-9', 'PROJ-10']);
  });

  it('picks initial status and default type from the workflow', () => {
    const wf = loadSnapshot().workflow;
    expect(initialStatus(wf, 'Story')).toBe('To Do');
    expect(initialStatus(undefined, 'Story')).toBe('To Do');
    expect(defaultTicketType(wf)).toBe('Task');
  });
});
