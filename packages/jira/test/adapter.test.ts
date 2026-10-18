// The acli adapter, with a recording runner and hand-written acli output (shaped like the
// sandbox's, all values invented). Checks the exact commands each JiraAdapter method runs.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { markdownToAdf } from '../src/adf.js';
import { AcliAdapter, keysIn } from '../src/adapter.js';
import type { Runner } from '../src/adapter.js';

interface Call { args: string[]; json?: unknown }

function recorder(responses: Record<string, string> = {}): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = (args) => {
    const call: Call = { args };
    const file = args[args.indexOf('--from-json') + 1];
    if (args.includes('--from-json') && file) call.json = JSON.parse(readFileSync(file, 'utf8')) as unknown; // read before the adapter deletes it
    calls.push(call);
    const key = Object.keys(responses).find((k) => args.join(' ').includes(k));
    return Promise.resolve({ stdout: key ? (responses[key] ?? '') : '{}', stderr: '' });
  };
  return { run, calls };
}

const viewOutput = JSON.stringify({
  expand: 'renderedFields,names', id: '10007', key: 'PROJ-121', self: 'https://example.atlassian.net/rest/api/3/issue/10007',
  fields: {
    summary: 'Backfill job', issuetype: { id: '10040', name: 'Task', hierarchyLevel: 0, subtask: false },
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, customfield_10015: null,
    parent: { id: '10002', key: 'PROJ-41', self: 'x', fields: { summary: 'Data migration' } },
    issuelinks: [{ id: '10100', self: 'x', type: { name: 'Blocks' }, outwardIssue: { key: 'PROJ-122' } }],
  },
});

describe('AcliAdapter', () => {
  it('reads project, search and issues', async () => {
    const { run, calls } = recorder({
      'project view': JSON.stringify({ key: 'PROJ', name: 'Platform Rebuild', style: 'next-gen', issueTypes: [{ id: '1', name: 'Epic', hierarchyLevel: 1 }, { id: '2', name: 'Task', hierarchyLevel: 0 }] }),
      'workitem search': JSON.stringify([{ key: 'PROJ-1', fields: {} }, { key: 'PROJ-2', fields: { parent: { key: 'PROJ-1' } } }]),
      'workitem view': viewOutput,
    });
    const a = new AcliAdapter('PROJ', run);
    expect((await a.project('PROJ')).issueTypes).toEqual([{ id: '1', name: 'Epic', hierarchyLevel: 1 }, { id: '2', name: 'Task', hierarchyLevel: 0 }]);
    expect(await a.searchKeys('project = PROJ')).toEqual(['PROJ-1', 'PROJ-2']);
    expect((await a.getIssue('PROJ-121')).fields['summary']).toBe('Backfill job');
    expect(calls.map((c) => c.args)).toEqual([
      ['jira', 'project', 'view', '--key', 'PROJ', '--json'],
      ['jira', 'workitem', 'search', '--jql', 'project = PROJ', '--paginate', '--json'],
      ['jira', 'workitem', 'view', 'PROJ-121', '--fields', '*all', '--json'],
    ]);
  });

  it('finds keys in any search output shape', () => {
    expect(keysIn({ issues: [{ key: 'PROJ-3' }, { key: 'OTHER-1' }] }, 'PROJ')).toEqual(['PROJ-3']);
    expect(keysIn([{ key: 'PROJ-4', fields: { parent: { key: 'PROJ-1' } } }], 'PROJ')).toEqual(['PROJ-4']);
  });

  it('creates epics from JSON (so the due date can be set) and tickets with --parent', async () => {
    const { run, calls } = recorder({ 'workitem create': JSON.stringify({ key: 'PROJ-501', fields: { parent: { key: 'PROJ-42' } } }) });
    const a = new AcliAdapter('PROJ', run);
    expect(await a.createIssue({ projectKey: 'PROJ', type: 'Epic', summary: 'Reporting', dueDate: '2027-06-30', description: markdownToAdf('Hi') })).toEqual({ key: 'PROJ-501' });
    expect(calls[0]?.json).toEqual({ projectKey: 'PROJ', type: 'Epic', summary: 'Reporting', description: markdownToAdf('Hi'), additionalAttributes: { duedate: '2027-06-30' } });
    await a.createIssue({ projectKey: 'PROJ', type: 'Task', summary: 'Sandbox', parentKey: 'PROJ-42', labels: ['a', 'b'], assigneeId: 'acc-1' });
    expect(calls[1]?.args).toEqual(['jira', 'workitem', 'create', '--project', 'PROJ', '--type', 'Task', '--summary', 'Sandbox', '--parent', 'PROJ-42', '--label', 'a,b', '--assignee', 'acc-1', '--json']);
  });

  it('updates fields through edit JSON, and unassigns with a flag', async () => {
    const { run, calls } = recorder();
    const a = new AcliAdapter('PROJ', run);
    await a.updateFields('PROJ-121', { summary: 'S', labelsToAdd: ['x'], labelsToRemove: ['y'], assigneeId: null });
    expect(calls[0]?.json).toEqual({ issues: ['PROJ-121'], summary: 'S', labelsToAdd: ['x'], labelsToRemove: ['y'] });
    expect(calls[1]?.args).toEqual(['jira', 'workitem', 'edit', '--key', 'PROJ-121', '--remove-assignee', '--yes', '--json']);
  });

  it('transitions, links, unlinks and comments', async () => {
    const { run, calls } = recorder();
    const a = new AcliAdapter('PROJ', run);
    await a.transition('PROJ-121', 'Done');
    await a.addLink('PROJ-121', 'PROJ-141', 'Blocks');
    await a.removeLink('10100');
    await a.addComment('PROJ-121', markdownToAdf('note'));
    expect(calls.map((c) => c.args.slice(0, 9))).toEqual([
      ['jira', 'workitem', 'transition', '--key', 'PROJ-121', '--status', 'Done', '--yes', '--json'],
      // "PROJ-121 blocks PROJ-141": acli's --in is the blocker (verified against the sandbox).
      ['jira', 'workitem', 'link', 'create', '--out', 'PROJ-141', '--in', 'PROJ-121', '--type'],
      ['jira', 'workitem', 'link', 'delete', '--id', '10100', '--yes'],
      ['jira', 'workitem', 'comment', 'create', '--key', 'PROJ-121', '--body', JSON.stringify(markdownToAdf('note')), '--json'],
    ]);
  });
});
