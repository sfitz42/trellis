// `pnpm jira:pull` (PLAN.md §6 step 4): read the project through acli and write
// workspace/snapshot.json. Read-only against Jira.
import { pathToFileURL } from 'node:url';
import { compareIds, Snapshot } from '@trellis/shared';
import type { Epic, Person, StatusInfo, Ticket } from '@trellis/shared';
import { AcliAdapter } from './adapter.js';
import type { JiraAdapter, RawIssue } from './adapter.js';
import { loadJiraEnv, workspacePath } from './env.js';
import { writeJsonAtomic } from './files.js';
import { hierarchyOf, levelOf, personOf, statusOf, toEpic, toTicket, typeName } from './normalize.js';

/** Map with limited concurrency (pull makes one `view` call per issue). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const CATEGORY_ORDER = ['new', 'indeterminate', 'done'];

export interface PullOptions {
  site: string;
  projectKey: string;
  now?: () => Date;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function buildSnapshot(jira: JiraAdapter, opts: PullOptions): Promise<Snapshot> {
  const project = await jira.project(opts.projectKey);
  const h = hierarchyOf(project);
  const keys = (await jira.searchKeys(`project = ${opts.projectKey} ORDER BY key ASC`)).sort(compareIds);
  let done = 0;
  const raws = await mapLimit(keys, opts.concurrency ?? 6, async (k): Promise<RawIssue> => {
    const r = await jira.getIssue(k);
    opts.onProgress?.(++done, keys.length);
    return r;
  });

  const epicRaws = raws.filter((r) => levelOf(r, h) === 1);
  // Sub-tasks (level -1) and anything above epics are out of scope for v1.
  const ticketRaws = raws.filter((r) => levelOf(r, h) === 0);
  const epicKeys = new Set(epicRaws.map((r) => r.key));

  const epics: Record<string, Epic> = {};
  for (const r of epicRaws) epics[r.key] = toEpic(r);
  const tickets: Record<string, Ticket> = {};
  for (const r of ticketRaws) {
    const t = toTicket(r, epicKeys);
    tickets[t.id] = t;
    if (t.epicId) epics[t.epicId]?.ticketOrder.push(t.id);
  }
  for (const e of Object.values(epics)) e.ticketOrder.sort(compareIds);

  // acli can't list workflows. Offer every status seen anywhere in the project for every type
  // (team-managed projects usually share one workflow); if Jira refuses a transition, apply
  // reports it as a failed step. Ordered by category, then name.
  const seen: StatusInfo[] = [];
  for (const r of [...epicRaws, ...ticketRaws]) {
    const st = statusOf(r);
    if (!seen.some((x) => x.name === st.name)) seen.push(st);
  }
  seen.sort((a, b) => (CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)) || a.name.localeCompare(b.name));
  const statuses: Record<string, StatusInfo[]> = {};
  for (const t of project.issueTypes) if (t.hierarchyLevel === 0 || t.hierarchyLevel === 1) statuses[t.name] = [...seen];
  for (const r of [...epicRaws, ...ticketRaws]) statuses[typeName(r)] ??= [...seen];

  const people = new Map<string, Person>();
  for (const r of ticketRaws) {
    const p = personOf(r.fields['assignee']);
    if (p) people.set(p.accountId, p);
  }

  return Snapshot.parse({
    pulledAt: (opts.now ?? (() => new Date()))().toISOString(),
    project: { site: opts.site, key: project.key, name: project.name },
    epics,
    tickets,
    workflow: {
      epicIssueType: h.epicType,
      statuses,
      transitions: null,
      assignableUsers: [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    },
  });
}

async function main(): Promise<void> {
  const env = loadJiraEnv();
  const jira = new AcliAdapter(env.JIRA_PROJECT_KEY);
  process.stderr.write(`Pulling ${env.JIRA_PROJECT_KEY} from ${env.JIRA_SITE}…\n`);
  const snapshot = await buildSnapshot(jira, {
    site: env.JIRA_SITE,
    projectKey: env.JIRA_PROJECT_KEY,
    onProgress: (d, n) => { if (d === n || d % 25 === 0) process.stderr.write(`  ${d}/${n} issues\n`); },
  });
  const path = `${workspacePath()}/snapshot.json`;
  await writeJsonAtomic(path, snapshot);
  console.log(`Wrote ${path}: ${Object.keys(snapshot.epics).length} epics, ${Object.keys(snapshot.tickets).length} tickets (pulled ${snapshot.pulledAt}).`);
  console.log('A running Trellis server picks this up automatically (reloads if frozen, otherwise offers a reload).');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(`jira:pull failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
