// Seeds an EMPTY sandbox project with a few labelled issues so discovery has something to read.
// Writes to Jira. Approved by the facilitator for the sandbox only; requires --confirm-project.
// Usage: tsx src/discovery/seed-sandbox.ts --confirm-project <KEY>
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { loadJiraEnv, workspacePath } from '../env.js';
import { acli } from './acli.js';

const run = promisify(execFile);
const env = loadJiraEnv();
const key = env.JIRA_PROJECT_KEY;
const LABEL = 'trellis-seed';

const confirmIdx = process.argv.indexOf('--confirm-project');
if (process.argv[confirmIdx + 1] !== key || confirmIdx < 0) {
  console.error('Refusing to write: pass --confirm-project <JIRA_PROJECT_KEY>.');
  process.exit(1);
}

const { stdout: countOut } = await acli(['jira', 'workitem', 'search', '--jql', `project = ${key}`, '--count']);
if (!/:\s*0\s*$/.test(countOut.trim())) {
  console.error('Refusing to seed: the project is not empty.');
  process.exit(1);
}

const seedDir = `${workspacePath()}/discovery/seed`;
await mkdir(seedDir, { recursive: true });
const log: { step: string; args: string[]; ok: boolean; out: string }[] = [];

/** Only these write subcommands are allowed here. */
const WRITE_ALLOWED = [['jira', 'workitem', 'create'], ['jira', 'workitem', 'link', 'create'], ['jira', 'workitem', 'transition']];

async function write(step: string, args: string[]): Promise<string> {
  if (!WRITE_ALLOWED.some((p) => p.every((part, i) => args[i] === part))) throw new Error(`not allowed: ${args.join(' ')}`);
  try {
    const { stdout, stderr } = await run('acli', args, { maxBuffer: 16 * 1024 * 1024 });
    log.push({ step, args, ok: true, out: stdout + stderr });
    return stdout + stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message;
    log.push({ step, args, ok: false, out });
    return `ERROR: ${out}`;
  } finally {
    await writeFile(`${seedDir}/seed-log.json`, JSON.stringify(log, null, 2));
  }
}

// Don't trust one output shape: prefer a structured `key`, else the first project key in the
// text that isn't one we passed in (the output also mentions the parent epic's key).
function keyFrom(out: string, exclude: readonly string[] = []): string {
  try {
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const nested = parsed['issue'] as Record<string, unknown> | undefined;
    const k = parsed['key'] ?? nested?.['key'];
    if (typeof k === 'string') return k;
  } catch {
    // not JSON; fall through to text matching
  }
  const found = [...out.matchAll(new RegExp(`\\b${key}-\\d+\\b`, 'g'))].map((m) => m[0]);
  const k = found.find((f) => !exclude.includes(f));
  if (!k) throw new Error(`No new issue key in acli output:\n${out.slice(0, 500)}`);
  return k;
}

async function create(step: string, type: string, summary: string, extra: string[] = []): Promise<string> {
  return keyFrom(await write(step, ['jira', 'workitem', 'create', '--project', key, '--type', type,
    '--summary', summary, '--label', LABEL, '--json', ...extra]), extra);
}

// 1. Epics. The first one tests whether create --from-json accepts the system due date via additionalAttributes.
const epicJson = `${seedDir}/epic-a.json`;
await writeFile(epicJson, JSON.stringify({
  projectKey: key, type: 'Epic', summary: 'Seed epic A: data migration', labels: [LABEL],
  additionalAttributes: { duedate: '2027-01-31' },
}, null, 2));
const epicAOut = await write('epic A (from-json, duedate)', ['jira', 'workitem', 'create', '--from-json', epicJson, '--json']);
const epicA = epicAOut.startsWith('ERROR') ? await create('epic A (fallback)', 'Epic', 'Seed epic A: data migration') : keyFrom(epicAOut);
const epicB = await create('epic B', 'Epic', 'Seed epic B: billing');

// 2. Child tickets under the epics (tests --parent for epic children).
const s1 = await create('story 1', 'Story', 'Seed story: map legacy schema', ['--parent', epicA]);
const s2 = await create('story 2', 'Story', 'Seed story: backfill job', ['--parent', epicA]);
const t1 = await create('task 1', 'Task', 'Seed task: cutover runbook', ['--parent', epicA]);
const s3 = await create('story 3', 'Story', 'Seed story: checkout flow', ['--parent', epicB]);
const b1 = await create('bug 1', 'Bug', 'Seed bug: webhook retries', ['--parent', epicB]);
const t2 = await create('task 2 (no epic)', 'Task', 'Seed task: unparented chore');

// 3. A blocks link: s2 blocks s3.
await write('link s2 blocks s3', ['jira', 'workitem', 'link', 'create', '--out', s2, '--in', s3, '--type', 'Blocks', '--yes']);

// 4. Transitions, so we see more than one status.
await write('s1 -> In Progress', ['jira', 'workitem', 'transition', '--key', s1, '--status', 'In Progress', '--yes', '--json']);
await write('t1 -> Done', ['jira', 'workitem', 'transition', '--key', t1, '--status', 'Done', '--yes', '--json']);

const created = { epicA, epicB, s1, s2, t1, s3, b1, t2 };
await writeFile(`${seedDir}/created.json`, JSON.stringify(created, null, 2));
for (const l of log) console.log(`${l.ok ? 'ok  ' : 'FAIL'} ${l.step}${l.ok ? '' : `: ${l.out.trim().split('\n')[0]}`}`);
console.log(`Created ${Object.keys(created).length} issues labelled ${LABEL}.`);
