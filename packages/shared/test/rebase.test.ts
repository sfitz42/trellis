import { describe, expect, it } from 'vitest';
import { computeChangeset, hasBlocksLink, rebaseOnSnapshot } from '../src/index.js';
import type { Snapshot } from '../src/index.js';
import { apply, freshState, loadSnapshot } from './helpers.js';

/** A "re-pulled" snapshot: the fixture with Jira-side edits applied. */
function jiraChanged(edit: (s: Snapshot) => void): Snapshot {
  const s = loadSnapshot();
  s.pulledAt = '2026-10-17T11:00:00.000Z';
  edit(s);
  return s;
}

describe('rebaseOnSnapshot', () => {
  it('takes Jira values for fields nobody changed in Trellis', () => {
    const next = jiraChanged((s) => { s.tickets['PROJ-121']!.summary = 'Renamed in Jira'; });
    const { state, keptEdits } = rebaseOnSnapshot(freshState(), loadSnapshot(), next);
    expect(state.tickets['PROJ-121']!.summary).toBe('Renamed in Jira');
    expect(keptEdits).toEqual([]);
    expect(computeChangeset(next, state).ops).toEqual([]);
  });

  it('keeps Trellis edits over Jira changes, and reports them', () => {
    const edited = apply(freshState(), [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'Trellis edit' } }]).state;
    const next = jiraChanged((s) => { s.tickets['PROJ-121']!.summary = 'Jira edit'; });
    const { state, keptEdits } = rebaseOnSnapshot(edited, loadSnapshot(), next);
    expect(state.tickets['PROJ-121']!.summary).toBe('Trellis edit');
    expect(keptEdits).toEqual(['PROJ-121.summary']);
  });

  it('deferral merges like a core field; the changeset empties once Jira has it', () => {
    const edited = apply(freshState(), [
      { type: 'epic.defer', id: 'PROJ-43', deferred: true },
      { type: 'ticket.defer', id: 'PROJ-128', deferred: true },
    ]).state;
    // After apply, Jira carries the label on both (its due date field is unchanged).
    const next = jiraChanged((s) => {
      s.epics['PROJ-43']!.deferred = true;
      s.tickets['PROJ-128']!.deferred = true;
    });
    const { state, keptEdits } = rebaseOnSnapshot(edited, loadSnapshot(), next);
    expect(state.epics['PROJ-43']).toMatchObject({ deferred: true, dueDate: null });
    expect(state.tickets['PROJ-128']!.deferred).toBe(true);
    expect(keptEdits).toEqual([]);
    expect(computeChangeset(next, state).ops).toEqual([]);
  });

  it('an epic deferred in Jira loses its roadmap dates', () => {
    const next = jiraChanged((s) => { s.epics['PROJ-44']!.deferred = true; });
    const { state } = rebaseOnSnapshot(freshState(), loadSnapshot(), next);
    expect(state.epics['PROJ-44']).toMatchObject({ deferred: true, startDate: null, dueDate: null });
    expect(computeChangeset(next, state).ops).toEqual([]);
  });

  it('always keeps Trellis-owned fields and ordering', () => {
    const edited = apply(freshState(), [
      { type: 'epic.setDates', id: 'PROJ-41', startDate: '2026-11-01', dueDate: '2027-02-28' },
      { type: 'ticket.update', id: 'PROJ-121', fields: { storyPoints: 5 } },
      { type: 'epic.reorder', id: 'PROJ-43', index: 0 },
    ]).state;
    const { state } = rebaseOnSnapshot(edited, loadSnapshot(), jiraChanged(() => undefined));
    expect(state.epics['PROJ-41']!.startDate).toBe('2026-11-01');
    expect(state.tickets['PROJ-121']!.storyPoints).toBe(5);
    expect(state.epicOrder[0]).toBe('PROJ-43');
  });

  it('adds issues that appeared in Jira and drops ones that left', () => {
    const next = jiraChanged((s) => {
      s.tickets['PROJ-300'] = { ...s.tickets['PROJ-45']!, id: 'PROJ-300', summary: 'Created in Jira', epicId: 'PROJ-41', links: [] };
      delete s.tickets['PROJ-46'];
    });
    const { state, added, dropped } = rebaseOnSnapshot(freshState(), loadSnapshot(), next);
    expect(added).toEqual(['PROJ-300']);
    expect(dropped).toEqual(['PROJ-46']);
    expect(state.epics['PROJ-41']!.ticketOrder.at(-1)).toBe('PROJ-300');
    expect(state.tickets['PROJ-46']).toBeUndefined();
  });

  it('renames NEW-* items that apply created, everywhere they are referenced', () => {
    const edited = apply(freshState(), [
      { type: 'epic.create', tempId: 'NEW-1', fields: { summary: 'Reporting' } },
      { type: 'ticket.create', tempId: 'NEW-2', epicId: 'NEW-1', fields: { summary: 'Export CSV' } },
      { type: 'link.add', from: 'NEW-2', to: 'PROJ-121', linkType: 'blocks' },
      { type: 'epic.setDates', id: 'NEW-1', startDate: '2026-12-01', dueDate: null },
    ]).state;
    // Jira after apply: the new epic and ticket exist with real keys, linked as asked.
    const next = jiraChanged((s) => {
      s.epics['PROJ-50'] = { id: 'PROJ-50', summary: 'Reporting', status: 'To Do', startDate: null, dueDate: null, ticketOrder: [], deferred: false };
      s.tickets['PROJ-301'] = {
        id: 'PROJ-301', epicId: 'PROJ-50', issueType: 'Task', summary: 'Export CSV', status: 'To Do', assignee: null, labels: [], storyPoints: null,
        links: [{ type: 'Blocks', direction: 'outward', target: 'PROJ-121', jiraLinkId: '20001' }], deferred: false,
      };
    });
    const { state, renamed } = rebaseOnSnapshot(edited, loadSnapshot(), next, { 'NEW-1': 'PROJ-50', 'NEW-2': 'PROJ-301', 'NEW-9': 'PROJ-999' });
    expect(renamed).toEqual({ 'NEW-1': 'PROJ-50', 'NEW-2': 'PROJ-301' });
    expect(state.epics['NEW-1']).toBeUndefined();
    expect(state.epics['PROJ-50']!.startDate).toBe('2026-12-01'); // Trellis-owned value carried over
    expect(state.epics['PROJ-50']!.ticketOrder).toEqual(['PROJ-301']);
    expect(state.epicOrder).toContain('PROJ-50');
    expect(hasBlocksLink(state, 'PROJ-301', 'PROJ-121')).toBe(true);
    expect(computeChangeset(next, state).ops).toEqual([]);
  });

  it('keeps NEW-* items that are not in Jira yet', () => {
    const edited = apply(freshState(), [{ type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'Pending' } }]).state;
    const { state } = rebaseOnSnapshot(edited, loadSnapshot(), jiraChanged(() => undefined));
    expect(state.tickets['NEW-1']!.summary).toBe('Pending');
    expect(state.epics['PROJ-41']!.ticketOrder).toContain('NEW-1');
  });

  it('merges links three ways', () => {
    // We removed 121→122 and added 126→127; Jira meanwhile added 140→143.
    const edited = apply(freshState(), [
      { type: 'link.remove', from: 'PROJ-121', to: 'PROJ-122', linkType: 'blocks' },
      { type: 'link.add', from: 'PROJ-126', to: 'PROJ-127', linkType: 'blocks' },
    ]).state;
    const next = jiraChanged((s) => {
      s.tickets['PROJ-140']!.links.push({ type: 'Blocks', direction: 'outward', target: 'PROJ-143', jiraLinkId: '20002' });
    });
    const { state } = rebaseOnSnapshot(edited, loadSnapshot(), next);
    expect(hasBlocksLink(state, 'PROJ-121', 'PROJ-122')).toBe(false);
    expect(hasBlocksLink(state, 'PROJ-126', 'PROJ-127')).toBe(true);
    expect(hasBlocksLink(state, 'PROJ-140', 'PROJ-143')).toBe(true);
    expect(state.tickets['PROJ-124']!.links.some((l) => l.type === 'Relates')).toBe(true);
  });

  it('due dates: Jira wins only if Trellis has not changed them since Jira was told', () => {
    const next = jiraChanged((s) => {
      s.epics['PROJ-41']!.dueDate = '2027-01-31'; // changed in Jira, untouched in Trellis
      s.epics['PROJ-42']!.dueDate = '2027-03-31'; // changed in Jira, but Trellis moved it too
    });
    const edited = apply(freshState(), [{ type: 'epic.setDates', id: 'PROJ-42', startDate: null, dueDate: '2027-06-30' }]).state;
    const { state, keptEdits } = rebaseOnSnapshot(edited, loadSnapshot(), next);
    expect(state.epics['PROJ-41']!.dueDate).toBe('2027-01-31');
    expect(state.acknowledged['PROJ-41.dates']).toEqual({ startDate: null, dueDate: '2027-01-31' });
    expect(state.epics['PROJ-42']!.dueDate).toBe('2027-06-30');
    expect(keptEdits).toContain('PROJ-42.dueDate');
  });

  it('marks comment-only changes as told after apply, so the changeset empties', () => {
    const edited = apply(freshState(), [
      { type: 'epic.setDates', id: 'PROJ-43', startDate: '2027-03-01', dueDate: '2027-06-30' },
      { type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-44' },
    ]).state;
    const next = jiraChanged(() => undefined);
    const { state } = rebaseOnSnapshot(edited, loadSnapshot(), next, {}, ['PROJ-43.dates', 'PROJ-126.epicId']);
    expect(state.epics['PROJ-43']).toMatchObject({ startDate: '2027-03-01', dueDate: '2027-06-30' });
    expect(state.tickets['PROJ-126']!.epicId).toBe('PROJ-44');
    expect(computeChangeset(next, state).ops).toEqual([]);
  });

  it('bumps the version and keeps meta for surviving items', () => {
    const edited = apply(freshState(), [{ type: 'ticket.update', id: 'PROJ-46', fields: { summary: 'x' } }, { type: 'ticket.update', id: 'PROJ-45', fields: { summary: 'y' } }]).state;
    const { state } = rebaseOnSnapshot(edited, loadSnapshot(), jiraChanged((s) => { delete s.tickets['PROJ-46']; }));
    expect(state.version).toBe(edited.version + 1);
    expect(state.meta['PROJ-45.summary']).toBeDefined();
    expect(state.meta['PROJ-46.summary']).toBeUndefined();
  });
});
