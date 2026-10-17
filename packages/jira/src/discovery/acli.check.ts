// Quick guard check (no test runner until Phase 1): run with `tsx`.
import assert from 'node:assert/strict';
import { assertReadOnly, WriteBlockedError } from './acli.js';

const blocked = [
  ['jira', 'workitem', 'create', '--project', 'X'],
  ['jira', 'workitem', 'edit', '--key', 'X-1'],
  ['jira', 'workitem', 'transition', '--key', 'X-1'],
  ['jira', 'workitem', 'link', 'create'],
  ['jira', 'workitem', 'comment', 'create'],
  ['jira', 'workitem', 'delete'],
  ['jira', 'auth', 'logout'],
];
for (const args of blocked) assert.throws(() => { assertReadOnly(args); }, WriteBlockedError, args.join(' '));

const allowed = [
  ['jira', 'auth', 'status'],
  ['jira', 'workitem', 'search', '--jql', 'project = X'],
  ['jira', 'workitem', 'create', '--help'],
];
for (const args of allowed) assert.doesNotThrow(() => { assertReadOnly(args); }, args.join(' '));

console.log(`acli guard ok: ${blocked.length} blocked, ${allowed.length} allowed`);
