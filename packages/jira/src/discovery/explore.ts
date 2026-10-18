// Read-only exploration of JIRA_PROJECT_KEY. Raw output goes to workspace/discovery/ (gitignored);
// only counts, ids and type/status names are printed.
import { mkdir, writeFile } from 'node:fs/promises';
import { loadJiraEnv, workspacePath } from '../env.js';
import { acli, acliJson } from './acli.js';

interface RawIssue {
  key: string;
  fields: Record<string, unknown>;
}

const env = loadJiraEnv();
const key = env.JIRA_PROJECT_KEY;
const rawDir = `${workspacePath()}/discovery/raw`;
await mkdir(rawDir, { recursive: true });

async function save(name: string, data: unknown): Promise<void> {
  await writeFile(`${rawDir}/${name}.json`, JSON.stringify(data, null, 2));
}

async function count(jql: string): Promise<number> {
  const { stdout } = await acli(['jira', 'workitem', 'search', '--jql', jql, '--count']);
  const n = /(\d+)\s*$/.exec(stdout.trim());
  if (!n?.[1]) throw new Error(`Could not parse count from: ${stdout}`);
  return Number(n[1]);
}

async function search(jql: string, fields: string): Promise<RawIssue[]> {
  const res = await acliJson<RawIssue[] | { issues: RawIssue[] }>([
    'jira', 'workitem', 'search', '--jql', jql, '--fields', fields, '--paginate',
  ]).catch((err: unknown) => {
    // acli prints a non-JSON message for empty results on some versions.
    if (err instanceof Error && /no work items|0 work items/i.test(err.message)) return [];
    throw err;
  });
  return Array.isArray(res) ? res : res.issues;
}

// --- project & issue types
const project = await acliJson<{
  style: string;
  simplified: boolean;
  issueTypes: { id: string; name: string; hierarchyLevel: number; subtask: boolean }[];
}>(['jira', 'project', 'view', '--key', key]);
await save('project', project);

// --- volume
const total = await count(`project = ${key}`);
const epicCount = await count(`project = ${key} AND issuetype = Epic`);
const openCount = await count(`project = ${key} AND issuetype != Epic AND statusCategory != Done`);

// --- link types
const linkTypes = await acliJson<{ issueLinkTypes: { name: string }[] }>(['jira', 'workitem', 'link', 'type']);
await save('link-types', linkTypes);

// --- epics and children
// `search --fields` rejects fields outside a fixed set (e.g. duedate), so view each epic in full.
const epicKeys = total > 0 ? await search(`project = ${key} AND issuetype = Epic`, 'key,summary,status') : [];
const epics: RawIssue[] = [];
for (const e of epicKeys) epics.push(await acliJson<RawIssue>(['jira', 'workitem', 'view', e.key, '--fields', '*all']));
await save('epics', epics);
const childCounts: Record<string, number> = {};
for (const e of epics) childCounts[e.key] = await count(`parent = ${e.key}`);
const epicDates = epics.map((e) => ({
  status: (e.fields['status'] as { name: string } | undefined)?.name,
  duedate: e.fields['duedate'] ?? null,
  // Non-null date-shaped custom fields: candidates for "Start date".
  dateCustomFields: Object.entries(e.fields)
    .filter(([f, v]) => f.startsWith('customfield_') && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
    .map(([f]) => f),
}));

// --- all issues: statuses per type, and custom fields present on one sample per type
// `search --fields` also rejects `parent`, so view every issue in full (N+1; fine for discovery).
const issueKeys = total > 0 ? await search(`project = ${key}`, 'key,issuetype,status') : [];
const issues: RawIssue[] = [];
for (const i of issueKeys) issues.push(await acliJson<RawIssue>(['jira', 'workitem', 'view', i.key, '--fields', '*all']));
await save('issues', issues);
const parentShapes = issues
  .filter((i) => i.fields['parent'])
  .map((i) => Object.keys(i.fields['parent'] as object).sort().join(','));
const linkShapes = issues.flatMap((i) => ((i.fields['issuelinks'] as object[] | undefined) ?? []).map((l) => Object.keys(l).sort().join(',')));
const statusesByType: Record<string, Set<string>> = {};
const samplePerType: Record<string, string> = {};
for (const i of issues) {
  const type = (i.fields['issuetype'] as { name: string } | undefined)?.name ?? '?';
  const status = (i.fields['status'] as { name: string } | undefined)?.name ?? '?';
  (statusesByType[type] ??= new Set()).add(status);
  samplePerType[type] ??= i.key;
}
const customFieldsByType: Record<string, string[]> = {};
for (const [type, sampleKey] of Object.entries(samplePerType)) {
  const full = await acliJson<RawIssue>(['jira', 'workitem', 'view', sampleKey, '--fields', '*all']);
  await save(`sample-${type}`, full);
  customFieldsByType[type] = Object.keys(full.fields).filter((f) => f.startsWith('customfield_')).sort();
}

const summary = {
  projectStyle: project.style,
  teamManaged: project.simplified,
  issueTypes: project.issueTypes.map((t) => ({ id: t.id, name: t.name, level: t.hierarchyLevel })),
  volume: { total, epics: epicCount, openTickets: openCount },
  linkTypes: linkTypes.issueLinkTypes.map((t) => t.name),
  epicChildCounts: Object.values(childCounts),
  epicDates,
  parentShapes: [...new Set(parentShapes)],
  issuesWithParent: parentShapes.length,
  linkShapes: [...new Set(linkShapes)],
  statusesByType: Object.fromEntries(Object.entries(statusesByType).map(([t, s]) => [t, [...s].sort()])),
  customFieldsByType,
};
await save('summary', summary);
console.log(JSON.stringify(summary, null, 2));
