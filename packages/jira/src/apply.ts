// `pnpm jira:apply` (PLAN.md §6 step 3): dry run by default; `--yes` executes the plan through
// acli, appending each result to workspace/apply-log.json immediately so a rerun resumes and never
// repeats a completed step (idempotent by changeset id + step id). Never deletes issues.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Snapshot, isTempId } from '@trellis/shared';
import type { Changeset, IssueId, Reason } from '@trellis/shared';
import { markdownToAdf } from './adf.js';
import type { AdfDoc } from './adf.js';
import { AcliAdapter } from './adapter.js';
import type { CreateInput, JiraAdapter } from './adapter.js';
import { loadJiraEnv, workspacePath } from './env.js';
import { readJson, writeJsonAtomic } from './files.js';
import { buildPlan } from './plan.js';
import type { ApplyPlan, DriftDecision, Note, PlanStep } from './plan.js';

export interface LogEntry {
  changesetId: string;
  step: string;
  index: number | null;
  kind: string;
  target: IssueId;
  /** The Jira key the step acted on (resolved from NEW-* where needed). */
  key?: IssueId;
  status: 'done' | 'skipped' | 'failed' | 'commented';
  createdKey?: IssueId;
  /** For comment-only changes: the `acknowledged` key Trellis marks as told on re-pull. */
  acknowledge?: string;
  message?: string;
  at: string;
}

const FINISHED = new Set<LogEntry['status']>(['done', 'skipped', 'commented']);

function fmtDate(d: string | null): string {
  if (!d) return 'none';
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function noteText(n: Note, key: (id: IssueId) => IssueId): string {
  switch (n.kind) {
    case 'dates': return `Planned dates: ${fmtDate(n.after.startDate)} → ${fmtDate(n.after.dueDate)} (was ${fmtDate(n.before.startDate)} → ${fmtDate(n.before.dueDate)}). Trellis owns roadmap dates; Jira's due date field is unchanged.`;
    case 'start': return `Planned start: ${fmtDate(n.startDate)}.`;
    case 'move': return `Moved to epic ${n.to ? key(n.to) : 'none'}${n.toName ? ` (${n.toName})` : ''} on the roadmap, from ${n.from ? key(n.from) : 'no epic'}. Please move it in Jira: the CLI can't change the parent.`;
  }
}

export function commentBody(notes: string[], reasons: Reason[], frozenBy: string | undefined, date: string): AdfDoc {
  const lines = [`**Changed in the Trellis roadmap session** (${date}${frozenBy ? `, frozen by ${frozenBy}` : ''})`, ''];
  for (const n of notes) lines.push(`- ${n}`);
  if (reasons.length) {
    if (notes.length) lines.push('');
    lines.push('Requests:');
    for (const r of reasons) lines.push(`- "${r.reason}"${r.askedBy ? ` (asked by ${r.askedBy})` : ''}`);
  }
  return markdownToAdf(lines.join('\n'));
}

export interface ExecuteOptions {
  /** Called with the full log after every step (persist it atomically). */
  save: (log: LogEntry[]) => Promise<void>;
  onStep?: (entry: LogEntry, step: PlanStep) => void;
  now?: () => Date;
  frozenBy?: string;
}

export interface ExecuteResult {
  log: LogEntry[];
  failed: LogEntry | null;
  ran: number;
  resumed: number;
}

export async function executePlan(plan: ApplyPlan, jira: JiraAdapter, previous: LogEntry[], opts: ExecuteOptions): Promise<ExecuteResult> {
  const now = opts.now ?? (() => new Date());
  const log = [...previous];
  const mine = (e: LogEntry): boolean => e.changesetId === plan.changesetId;
  const finished = new Set(log.filter((e) => mine(e) && FINISHED.has(e.status)).map((e) => e.step));
  const keys = new Map<IssueId, IssueId>();
  for (const e of log) if (e.createdKey) keys.set(e.target, e.createdKey);
  const resolve = (id: IssueId): IssueId => {
    if (!isTempId(id)) return id;
    const k = keys.get(id);
    if (!k) throw new Error(`${id} hasn't been created in Jira (its create step failed or was skipped)`);
    return k;
  };
  const record = async (step: PlanStep, entry: Omit<LogEntry, 'changesetId' | 'step' | 'index' | 'kind' | 'target' | 'at'>): Promise<LogEntry> => {
    const e: LogEntry = { changesetId: plan.changesetId, step: step.id, index: step.index, kind: step.kind, target: step.target, at: now().toISOString(), ...entry };
    log.push(e);
    await opts.save(log);
    opts.onStep?.(e, step);
    return e;
  };

  let ran = 0;
  let resumed = 0;
  for (const step of plan.steps) {
    if (finished.has(step.id)) {
      resumed++;
      continue;
    }
    if (!step.run) {
      await record(step, { status: 'skipped', message: step.skipReason ?? 'skipped' });
      continue;
    }
    if (step.action.do === 'note') continue; // posted (and logged) with the issue's comment
    try {
      const key = step.action.do === 'create' ? undefined : resolve(step.target);
      const a = step.action;
      switch (a.do) {
        case 'create': {
          const input: CreateInput = { ...a.input };
          if (input.parentKey) input.parentKey = resolve(input.parentKey);
          const { key: created } = await jira.createIssue(input);
          keys.set(step.target, created);
          await record(step, { status: 'done', key: created, createdKey: created });
          break;
        }
        case 'update':
          await jira.updateFields(key as string, a.fields);
          await record(step, { status: 'done', key: key as string });
          break;
        case 'transition':
          await jira.transition(key as string, a.status);
          await record(step, { status: 'done', key: key as string });
          break;
        case 'link.add':
          await jira.addLink(resolve(a.from), resolve(a.to), a.type);
          await record(step, { status: 'done', key: key as string });
          break;
        case 'link.remove':
          await jira.removeLink(a.linkId);
          await record(step, { status: 'done', key: key as string });
          break;
        case 'comment': {
          const notes = plan.steps.filter((s) => s.target === step.target && s.action.do === 'note' && s.run && !finished.has(s.id));
          const texts = notes.map((s) => noteText((s.action as Extract<PlanStep['action'], { do: 'note' }>).note, (id) => (isTempId(id) ? (keys.get(id) ?? id) : id)));
          await jira.addComment(key as string, commentBody(texts, a.reasons, opts.frozenBy, now().toISOString().slice(0, 10)));
          for (const n of notes) {
            await record(n, { status: 'commented', key: key as string, acknowledge: (n.action as Extract<PlanStep['action'], { do: 'note' }>).acknowledge });
          }
          await record(step, { status: 'done', key: key as string });
          break;
        }
      }
      ran++;
    } catch (err) {
      const failed = await record(step, { status: 'failed', message: (err as Error).message });
      return { log, failed, ran, resumed };
    }
  }
  return { log, failed: null, ran, resumed };
}

// --- script

export function formatPlan(plan: ApplyPlan): string {
  const lines = [`Apply plan · changeset ${plan.changesetId} · ${plan.steps.length} steps · project ${plan.project}`];
  for (const s of plan.steps) {
    const mark = s.drift ? (s.run ? '! overwrite' : '~ drift   ') : !s.run ? '= skip    ' : s.action.do === 'note' ? '✎ comment ' : s.kind === 'comment' ? '✎ post    ' : '✓ will    ';
    let line = `  ${mark} ${(s.index ?? '').toString().padStart(3)} ${s.kind.padEnd(13)} ${s.target.padEnd(9)} ${s.summary}`;
    if (s.drift) line += `\n               Jira now: ${JSON.stringify(s.drift.jira)} · snapshot: ${JSON.stringify(s.drift.snapshot)} · Trellis: ${JSON.stringify(s.drift.trellis)} → ${s.run ? 'overwrite' : 'keep Jira value'}`;
    else if (!s.run && s.skipReason) line += ` (${s.skipReason})`;
    lines.push(line);
  }
  const drift = plan.steps.filter((s) => s.drift);
  if (drift.length) lines.push('', `${drift.length} drift conflict(s): decide in the Trellis Freeze screen, or pass --on-drift overwrite.`);
  return lines.join('\n');
}

const USAGE = `Usage: pnpm jira:apply [--dry-run] [--yes --confirm-project KEY] [--on-drift skip|overwrite]
  --dry-run              (default) fetch current Jira values, show the plan and drift, write apply-plan.json
  --yes                  execute the plan; resumes from apply-log.json if a previous run stopped
  --confirm-project KEY  required with --yes; must match JIRA_PROJECT_KEY
  --on-drift MODE        for drift without a decision from the Freeze screen (default: skip)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      'confirm-project': { type: 'string' },
      'on-drift': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const env = loadJiraEnv();
  const dir = workspacePath();
  const onDrift = values['on-drift'] ?? 'skip';
  if (onDrift !== 'skip' && onDrift !== 'overwrite') throw new Error(`--on-drift must be skip or overwrite\n${USAGE}`);
  if (values.yes && values['dry-run']) throw new Error('choose --dry-run or --yes, not both');

  // Guards: frozen session, matching project and site, explicit confirmation for writes.
  const lock = (await readJson(join(dir, '.lock'))) as { by?: string } | null;
  if (!lock) throw new Error('the Trellis session is not frozen. Freeze it first (Freeze for apply, or `pnpm -s trellis freeze`).');
  const snapshot = Snapshot.parse(await readJson(join(dir, 'snapshot.json')));
  if (snapshot.project.key !== env.JIRA_PROJECT_KEY) throw new Error(`snapshot.json is from project ${snapshot.project.key}, but JIRA_PROJECT_KEY is ${env.JIRA_PROJECT_KEY}. Refusing to apply.`);
  if (snapshot.project.site && snapshot.project.site !== env.JIRA_SITE) throw new Error(`snapshot.json is from ${snapshot.project.site}, but JIRA_SITE is ${env.JIRA_SITE}. Refusing to apply.`);
  const cs = (await readJson(join(dir, 'changeset.json'))) as Changeset | null;
  if (!cs) throw new Error('workspace/changeset.json not found (it is written on freeze)');
  if (cs.base.project !== env.JIRA_PROJECT_KEY) throw new Error(`changeset is for ${cs.base.project}, not ${env.JIRA_PROJECT_KEY}`);
  if (values.yes && values['confirm-project'] !== env.JIRA_PROJECT_KEY) {
    throw new Error(`--yes writes to Jira project ${env.JIRA_PROJECT_KEY}: add --confirm-project ${env.JIRA_PROJECT_KEY} to confirm.`);
  }

  const jira = new AcliAdapter(env.JIRA_PROJECT_KEY);
  const decisions = ((await readJson(join(dir, 'drift-decisions.json'))) as { changesetId?: string; decisions?: Record<string, DriftDecision> } | null) ?? {};
  const plan = await buildPlan(cs, snapshot, jira, {
    projectKey: env.JIRA_PROJECT_KEY,
    decisions: decisions.changesetId === cs.id ? (decisions.decisions ?? {}) : {},
    onDrift,
  });
  await writeJsonAtomic(join(dir, 'apply-plan.json'), plan);
  console.log(formatPlan(plan));

  if (!values.yes) {
    console.log(`\nDry run: nothing was written to Jira. Plan saved to workspace/apply-plan.json.\nTo apply: pnpm jira:apply --yes --confirm-project ${env.JIRA_PROJECT_KEY}`);
    return 0;
  }

  const logPath = join(dir, 'apply-log.json');
  const previous = (((await readJson(logPath)) as LogEntry[] | null) ?? []).filter((e) => typeof e === 'object');
  console.log('\nApplying…');
  const result = await executePlan(plan, jira, previous, {
    save: (log) => writeJsonAtomic(logPath, log),
    onStep: (e) => { console.log(`  ${e.status.padEnd(9)} ${e.step.padEnd(14)} ${e.key ?? e.target}${e.createdKey ? ` → ${e.createdKey}` : ''}${e.message ? `  ${e.message}` : ''}`); },
    ...(lock.by ? { frozenBy: lock.by } : {}),
  });
  if (result.resumed) console.log(`(resumed: ${result.resumed} step(s) were already done)`);
  if (result.failed) {
    console.error(`\nStopped at step ${result.failed.step} (${result.failed.target}): ${result.failed.message ?? ''}\nFix the cause and rerun the same command: completed steps are skipped.`);
    return 1;
  }
  console.log(`\nApplied. Next: pnpm jira:pull so Trellis re-pulls and the changeset empties.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exit(code); }, (err: unknown) => {
    console.error(`jira:apply: ${(err as Error).message}`);
    process.exit(1);
  });
}

