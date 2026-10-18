// pull → edit → freeze → dry run → apply → pull, against an in-memory Jira. The same loop runs for
// real against the sandbox at the end of Phase 5.
import { describe, expect, it } from 'vitest';
import { applyBatch, computeChangeset, fromSnapshot, rebaseOnSnapshot } from '@trellis/shared';
import type { Batch, OplogEntry, RoadmapState, Snapshot } from '@trellis/shared';
import { adfToMarkdown } from '../src/adf.js';
import { commentBody, executePlan, formatPlan } from '../src/apply.js';
import type { LogEntry } from '../src/apply.js';
import { buildPlan } from '../src/plan.js';
import { buildSnapshot } from '../src/pull.js';
import { FakeJira, fixture } from './fake.js';

const opts = { site: 'example.atlassian.net', projectKey: 'PROJ', now: () => new Date('2026-10-17T10:00:00Z') };

async function session(jira: FakeJira): Promise<{ snap: Snapshot; state: RoadmapState; log: OplogEntry[]; apply: (b: Batch) => void }> {
  const snap = await buildSnapshot(jira, opts);
  let state = fromSnapshot(snap, { today: '2026-10-17' });
  const log: OplogEntry[] = [];
  return {
    snap,
    get state() { return state; },
    log,
    apply: (batch: Batch) => {
      const id = `b${log.length + 1}`;
      const out = applyBatch(state, batch, { batchId: id, workflow: snap.workflow });
      expect(out.result.rejected).toEqual([]);
      state = out.state;
      log.push({ batch: { ...batch, id }, result: out.result, at: 'x' });
    },
  };
}

const agentBatch: Batch = {
  author: { name: 'Claude Code', kind: 'agent' },
  reason: 'Split PROJ-140 into three tickets and push Notifications back a month',
  askedBy: 'Shaun',
  ops: [
    { type: 'epic.create', tempId: 'NEW-1', fields: { summary: 'Reporting', dueDate: '2027-06-30', startDate: '2027-04-01' } },
    { type: 'ticket.create', tempId: 'NEW-2', epicId: 'NEW-1', fields: { summary: 'CSV export', issueType: 'Story', description: 'Export **all** rows' } },
    { type: 'ticket.create', tempId: 'NEW-3', epicId: 'PROJ-42', fields: { summary: 'Provider sandbox account', issueType: 'Task', labels: ['payments'], assignee: { accountId: 'acc-0003', displayName: 'Casey Moor' } } },
    { type: 'link.add', from: 'NEW-3', to: 'PROJ-141', linkType: 'blocks' },
    { type: 'link.remove', from: 'PROJ-140', to: 'PROJ-141', linkType: 'blocks' },
    { type: 'ticket.transition', id: 'PROJ-140', status: 'Done' },
    { type: 'epic.setDates', id: 'PROJ-43', startDate: null, dueDate: '2027-06-30' },
    { type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-44' },
    { type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'Backfill job (resumable)', labels: ['backend', 'migration'], description: 'Run in batches:\n\n- checkpoint\n- resume' } },
  ],
};

describe('pull', () => {
  it('rebuilds the fixture from Jira-shaped issues', async () => {
    const snap = await buildSnapshot(FakeJira.fromSnapshot(fixture()), opts);
    const fx = fixture();
    expect(snap.project).toEqual({ site: 'example.atlassian.net', key: 'PROJ', name: 'Platform Rebuild' });
    expect(snap.epics).toEqual(fx.epics);
    expect(snap.tickets).toEqual(fx.tickets);
    expect(snap.workflow.epicIssueType).toBe('Epic');
    expect(snap.workflow.statuses['Story']?.map((s) => s.name)).toEqual(['To Do', 'In Progress', 'Done']);
    expect(snap.workflow.statuses['Feature']).toBeDefined();
    expect(snap.workflow.assignableUsers.map((p) => p.displayName)).toEqual(fx.workflow.assignableUsers.map((p) => p.displayName));
  });

  it('reads the deliver-later label as deferred and leaves it out of labels', async () => {
    const jira = FakeJira.fromSnapshot(fixture());
    jira.issues.get('PROJ-43')!.fields['labels'] = ['deliver-later'];
    jira.issues.get('PROJ-128')!.fields['labels'] = ['frontend', 'deliver-later'];
    const snap = await buildSnapshot(jira, opts);
    expect(snap.epics['PROJ-43']).toMatchObject({ deferred: true, dueDate: '2027-05-31' }); // Jira's due date, as it is
    expect(snap.tickets['PROJ-128']).toMatchObject({ deferred: true, labels: ['frontend'] });
    expect(snap.tickets['PROJ-127']?.deferred).toBe(false);
  });

  it('identifies epics by hierarchy level, skips sub-tasks, and detaches non-epic parents', async () => {
    const jira = FakeJira.fromSnapshot(fixture());
    jira.issues.set('PROJ-900', jira.raw('PROJ-900', 'Subtask', 'Sub-task', 'To Do', { parent: { key: 'PROJ-121' } }));
    jira.issues.set('PROJ-901', jira.raw('PROJ-901', 'Task', 'Child of a task', 'To Do', { parent: { key: 'PROJ-121' } }));
    const snap = await buildSnapshot(jira, opts);
    expect(snap.tickets['PROJ-900']).toBeUndefined();
    expect(snap.tickets['PROJ-901']?.epicId).toBeNull();
  });
});

describe('plan (dry run)', () => {
  it('turns the changeset into steps, with comment-only notes and one comment per issue', async () => {
    const jira = FakeJira.fromSnapshot(fixture());
    const s = await session(jira);
    s.apply(agentBatch);
    const cs = computeChangeset(s.snap, s.state, s.log);
    const plan = await buildPlan(cs, s.snap, jira, { projectKey: 'PROJ' });
    const text = formatPlan(plan);
    expect(text).toContain('create epic "Reporting" due 2027-06-30');
    expect(text).toContain('epic PROJ-41 → PROJ-44 (as a comment');
    expect(text).toContain('dates — … 2027-05-31 → — … 2027-06-30 (as a comment)');
    expect(plan.steps.filter((x) => x.kind === 'comment').map((x) => x.target).sort()).toEqual(['NEW-1', 'NEW-2', 'NEW-3', 'PROJ-121', 'PROJ-126', 'PROJ-140', 'PROJ-43'].sort());
    expect(plan.steps.find((x) => x.id.endsWith(':start'))?.summary).toBe('planned start 2027-04-01 (as a comment)');
    expect(jira.calls).toEqual([]); // dry run: reads only
  });

  it('reports drift, keeps Jira values by default, and honours decisions', async () => {
    const jira = FakeJira.fromSnapshot(fixture());
    const s = await session(jira);
    s.apply(agentBatch);
    const cs = computeChangeset(s.snap, s.state, s.log);
    // Someone renames PROJ-121 in Jira after the snapshot.
    await jira.updateFields('PROJ-121', { summary: 'Renamed in Jira' });
    const plan = await buildPlan(cs, s.snap, jira, { projectKey: 'PROJ' });
    const step = plan.steps.find((x) => x.kind === 'field.update' && x.target === 'PROJ-121' && x.summary.startsWith('summary'));
    expect(step).toMatchObject({ run: false, decision: 'keep', drift: { field: 'summary', jira: 'Renamed in Jira', trellis: 'Backfill job (resumable)' } });
    expect(formatPlan(plan)).toContain('1 drift conflict(s)');

    const over = await buildPlan(cs, s.snap, jira, { projectKey: 'PROJ', decisions: { [step?.id ?? '']: 'overwrite' } });
    expect(over.steps.find((x) => x.id === step?.id)).toMatchObject({ run: true, decision: 'overwrite' });
    expect((await buildPlan(cs, s.snap, jira, { projectKey: 'PROJ', onDrift: 'overwrite' })).steps.find((x) => x.id === step?.id)?.run).toBe(true);
  });

  it('defer: a label step plus a note for the issue comment; skipped when Jira already has it', async () => {
    const jira = FakeJira.fromSnapshot(fixture());
    const s = await session(jira);
    s.apply({ author: { name: 'Sam', kind: 'human' }, ops: [{ type: 'epic.defer', id: 'PROJ-43', deferred: true }, { type: 'ticket.defer', id: 'PROJ-128', deferred: true }] });
    const cs = computeChangeset(s.snap, s.state, s.log);
    expect(cs.ops.map((o) => o.kind)).toEqual(['defer', 'defer']); // no separate dates change for PROJ-43
    const plan = await buildPlan(cs, s.snap, jira, { projectKey: 'PROJ' });
    expect(plan.steps.map((x) => [x.kind, x.target, x.action.do, x.run])).toEqual([
      ['defer', 'PROJ-43', 'update', true], ['defer', 'PROJ-43', 'note', true],
      ['defer', 'PROJ-128', 'update', true], ['defer', 'PROJ-128', 'note', true],
      ['comment', 'PROJ-43', 'comment', true], ['comment', 'PROJ-128', 'comment', true],
    ]);
    expect(plan.steps[0]?.action).toEqual({ do: 'update', fields: { labelsToAdd: ['deliver-later'] } });
    expect(formatPlan(plan)).toContain('move to Deliver later (add label deliver-later)');

    // Someone already added the label to PROJ-128 in Jira: nothing to do there.
    await jira.updateFields('PROJ-128', { labelsToAdd: ['deliver-later'] });
    const again = await buildPlan(cs, s.snap, jira, { projectKey: 'PROJ' });
    expect(again.steps.filter((x) => x.target === 'PROJ-128').map((x) => [x.action.do, x.run, x.skipReason])).toEqual([
      ['update', false, 'already in Jira'], ['note', false, 'already in Jira'],
    ]);
  });

  it('skips changes that are already in Jira', async () => {
    const jira = FakeJira.fromSnapshot(fixture());
    const s = await session(jira);
    s.apply({ author: { name: 'Sam', kind: 'human' }, ops: [{ type: 'ticket.transition', id: 'PROJ-140', status: 'Done' }, { type: 'link.remove', from: 'PROJ-140', to: 'PROJ-141', linkType: 'blocks' }] });
    await jira.transition('PROJ-140', 'Done');
    const linkId = s.snap.tickets['PROJ-140']?.links[0]?.jiraLinkId ?? '';
    await jira.removeLink(linkId);
    const plan = await buildPlan(computeChangeset(s.snap, s.state, s.log), s.snap, jira, { projectKey: 'PROJ' });
    expect(plan.steps.map((x) => [x.kind, x.run, x.skipReason])).toEqual([
      ['transition', false, 'already in Jira'],
      ['link.remove', false, 'already removed in Jira'],
    ]);
  });
});

describe('apply + re-pull', () => {
  it('runs the full loop: the changeset is empty after re-pulling', async () => {
    const jira = FakeJira.fromSnapshot(fixture());
    const s = await session(jira);
    s.apply(agentBatch);
    const cs = computeChangeset(s.snap, s.state, s.log);
    const plan = await buildPlan(cs, s.snap, jira, { projectKey: 'PROJ' });
    let saved: LogEntry[] = [];
    const result = await executePlan(plan, jira, [], { save: (l) => { saved = [...l]; return Promise.resolve(); }, frozenBy: 'Shaun', now: () => new Date('2026-10-17T11:00:00Z') });
    expect(result.failed).toBeNull();

    // Creates resolved NEW ids: the story landed under the newly created epic.
    const epicKey = saved.find((e) => e.target === 'NEW-1' && e.createdKey)?.createdKey ?? '';
    const storyKey = saved.find((e) => e.target === 'NEW-2' && e.createdKey)?.createdKey ?? '';
    expect((jira.issues.get(storyKey)?.fields['parent'] as { key: string }).key).toBe(epicKey);
    expect(jira.issues.get(epicKey)?.fields['duedate']).toBe('2027-06-30');
    expect(adfToMarkdown(jira.issues.get('PROJ-121')?.fields['description'])).toBe('Run in batches:\n\n- checkpoint\n- resume');
    expect(jira.issues.get('PROJ-121')?.fields['labels']).toEqual(['backend', 'migration']); // was ['frontend']

    // Comments: notes for comment-only changes plus the captured request.
    const c43 = adfToMarkdown(jira.comments.find((c) => c.key === 'PROJ-43')?.body);
    expect(c43).toContain('Planned dates: none → 30 Jun 2027 (was none → 31 May 2027)');
    expect(c43).toContain('"Split PROJ-140 into three tickets and push Notifications back a month" (asked by Shaun)');
    expect(c43).toContain('frozen by Shaun');
    expect(adfToMarkdown(jira.comments.find((c) => c.key === 'PROJ-126')?.body)).toContain('Moved to epic PROJ-44 (Admin console) on the roadmap, from PROJ-41');
    expect(adfToMarkdown(jira.comments.find((c) => c.key === epicKey)?.body)).toContain('Planned start: 1 Apr 2027.');
    expect(saved.filter((e) => e.status === 'commented').map((e) => e.acknowledge).sort()).toEqual(['NEW-1.dates', 'PROJ-126.epicId', 'PROJ-43.dates']);

    // Re-pull and rebase as the server does: temp ids renamed, comment-only changes acknowledged.
    const next = await buildSnapshot(jira, opts);
    const tempIds = Object.fromEntries(saved.filter((e) => e.createdKey).map((e) => [e.target, e.createdKey ?? '']));
    const told = saved.filter((e) => e.status === 'commented' && e.acknowledge).map((e) => e.acknowledge ?? '');
    const { state } = rebaseOnSnapshot(s.state, s.snap, next, tempIds, told);
    expect(computeChangeset(next, state).ops).toEqual([]);
    expect(state.epics[epicKey]?.startDate).toBe('2027-04-01'); // Trellis-owned value kept
    expect(state.tickets['PROJ-126']?.epicId).toBe('PROJ-44'); // roadmap keeps the move
  });

  it('runs the loop for deferral: labels and notes land, and deferral survives the re-pull', async () => {
    const jira = FakeJira.fromSnapshot(fixture());
    jira.issues.get('PROJ-44')!.fields['labels'] = ['deliver-later']; // deferred in Jira before the session
    const s = await session(jira);
    expect(s.state.epics['PROJ-44']).toMatchObject({ deferred: true, dueDate: null });
    s.apply({
      author: { name: 'Claude Code', kind: 'agent' }, reason: "Notifications won't make 9 Nov, put it in deliver later", askedBy: 'Shaun',
      ops: [
        { type: 'epic.defer', id: 'PROJ-43', deferred: true },
        { type: 'ticket.defer', id: 'PROJ-128', deferred: true },
        { type: 'ticket.create', tempId: 'NEW-1', epicId: 'PROJ-41', fields: { summary: 'Later polish' } },
        { type: 'ticket.defer', id: 'NEW-1', deferred: true },
      ],
    });
    s.apply({ author: { name: 'Shaun', kind: 'human' }, ops: [
      { type: 'epic.defer', id: 'PROJ-44', deferred: false },
      { type: 'epic.setDates', id: 'PROJ-44', startDate: '2026-10-19', dueDate: '2026-11-08' },
    ] });
    const plan = await buildPlan(computeChangeset(s.snap, s.state, s.log), s.snap, jira, { projectKey: 'PROJ' });
    let saved: LogEntry[] = [];
    const result = await executePlan(plan, jira, [], { save: (l) => { saved = [...l]; return Promise.resolve(); }, now: () => new Date('2026-10-17T11:00:00Z') });
    expect(result.failed).toBeNull();

    const newKey = saved.find((e) => e.target === 'NEW-1' && e.createdKey)?.createdKey ?? '';
    expect(jira.issues.get('PROJ-43')?.fields['labels']).toEqual(['deliver-later']);
    expect(jira.issues.get('PROJ-43')?.fields['duedate']).toBe('2027-05-31'); // acli can't clear it
    expect(jira.issues.get('PROJ-128')?.fields['labels']).toEqual(['frontend', 'deliver-later']);
    expect(jira.issues.get(newKey)?.fields['labels']).toEqual(['deliver-later']);
    expect(jira.issues.get('PROJ-44')?.fields['labels']).toEqual([]);

    // One comment per issue: the note, then the captured request.
    const comment = (key: string): string => adfToMarkdown(jira.comments.filter((c) => c.key === key).map((c) => c.body)[0]);
    expect(jira.comments.filter((c) => c.key === 'PROJ-43')).toHaveLength(1);
    expect(comment('PROJ-43')).toContain("Moved to Deliver later on the roadmap: not planned for the current milestone (label deliver-later). Its planned dates are cleared in Trellis; Jira's due date field is unchanged.");
    expect(comment('PROJ-43')).toContain(`"Notifications won't make 9 Nov, put it in deliver later" (asked by Shaun)`);
    expect(comment('PROJ-128')).toContain('Moved to Deliver later on the roadmap: not planned for the current milestone (label deliver-later).');
    expect(comment('PROJ-128')).not.toContain('planned dates');
    expect(comment('PROJ-44')).toContain('Scheduled again on the roadmap (out of Deliver later; label deliver-later removed).');
    expect(comment('PROJ-44')).toContain('Planned dates: 19 Oct 2026 → 8 Nov 2026');

    // Re-pull: empty changeset, deferral preserved.
    const next = await buildSnapshot(jira, opts);
    const tempIds = Object.fromEntries(saved.filter((e) => e.createdKey).map((e) => [e.target, e.createdKey ?? '']));
    const told = saved.filter((e) => e.status === 'commented' && e.acknowledge).map((e) => e.acknowledge ?? '');
    const { state } = rebaseOnSnapshot(s.state, s.snap, next, tempIds, told);
    expect(computeChangeset(next, state).ops).toEqual([]);
    expect(state.epics['PROJ-43']).toMatchObject({ deferred: true, dueDate: null });
    expect(state.tickets['PROJ-128']).toMatchObject({ deferred: true, labels: ['frontend'] });
    expect(state.tickets[newKey]?.deferred).toBe(true);
    expect(state.epics['PROJ-44']).toMatchObject({ deferred: false, dueDate: '2026-11-08' });
  });

  it('stops on failure and resumes without repeating completed steps', async () => {
    const jira = FakeJira.fromSnapshot(fixture());
    const s = await session(jira);
    s.apply(agentBatch);
    const plan = await buildPlan(computeChangeset(s.snap, s.state, s.log), s.snap, jira, { projectKey: 'PROJ' });
    jira.failOnce = (call) => call.startsWith('transition PROJ-140');
    let saved: LogEntry[] = [];
    const save = (l: LogEntry[]): Promise<void> => { saved = [...l]; return Promise.resolve(); };
    const first = await executePlan(plan, jira, [], { save });
    expect(first.failed).toMatchObject({ target: 'PROJ-140', status: 'failed', message: 'simulated failure: transition PROJ-140 Done' });
    const createsBefore = jira.calls.filter((c) => c.startsWith('create')).length;

    const second = await executePlan(plan, jira, saved, { save });
    expect(second.failed).toBeNull();
    expect(second.resumed).toBeGreaterThan(0);
    expect(jira.calls.filter((c) => c.startsWith('create')).length).toBe(createsBefore); // no duplicate creates
    expect(jira.issues.get('PROJ-140')?.fields['status']).toMatchObject({ name: 'Done' });
  });

  it('formats comment bodies', () => {
    const md = adfToMarkdown(commentBody(['Planned start: 1 Apr 2027.'], [{ batchId: 'b1', reason: 'make it so', askedBy: 'Shaun' }], 'Shaun', '2026-10-17'));
    expect(md).toBe('**Changed in the Trellis roadmap session** (2026-10-17, frozen by Shaun)\n\n- Planned start: 1 Apr 2027.\n\nRequests:\n\n- "make it so" (asked by Shaun)');
  });
});
