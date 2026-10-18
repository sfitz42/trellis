// `pnpm session:new | session:list | session:restore`: start a fresh roadmap, keeping the old one.
// A session is the server's workspace files; archives live in workspace/archive/<name>/ (gitignored,
// like the rest of workspace/: they hold real Jira data). The server builds a clean roadmap from
// snapshot.json whenever state.json is missing, so it needs no changes for any of this.
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readJson } from './files.js';

/** Files that make up a session (snapshot.json is copied, the rest moved). */
export const SESSION_FILES = ['state.json', 'roadmap.json', 'oplog.jsonl', 'changeset.json', 'apply-plan.json', 'apply-log.json', 'drift-decisions.json', '.lock'] as const;

export interface ArchiveMeta {
  name: string;
  label: string | null;
  archivedAt: string;
  project: string | null;
  version: number | null;
  batches: number;
  /** True when apply wrote to Jira in this session (some step done or commented). */
  applied: boolean;
  frozen: boolean;
  snapshotPulledAt: string | null;
}

export interface SessionOptions {
  /** The workspace folder. */
  dir: string;
  now?: () => Date;
  /** Is a Trellis server using this workspace? Moving files under it would be undone by its next save. */
  serverUp?: () => Promise<string | null>;
  force?: boolean;
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
}

/** What the current session in `dir` looks like, or null when there is none. */
export async function describeSession(dir: string): Promise<Omit<ArchiveMeta, 'name' | 'label' | 'archivedAt'> | null> {
  const state = (await readJson(join(dir, 'state.json')).catch(() => null)) as { state?: { project?: { key?: string }; version?: number } } | null;
  const hasAny = (await Promise.all(SESSION_FILES.map((f) => exists(join(dir, f))))).some(Boolean);
  if (!state && !hasAny) return null;
  const oplog = await readFile(join(dir, 'oplog.jsonl'), 'utf8').catch(() => '');
  const log = (await readJson(join(dir, 'apply-log.json')).catch(() => null)) as { status?: string }[] | null;
  const snap = (await readJson(join(dir, 'snapshot.json')).catch(() => null)) as { pulledAt?: string; project?: { key?: string } } | null;
  return {
    project: state?.state?.project?.key ?? snap?.project?.key ?? null,
    version: state?.state?.version ?? null,
    batches: oplog.split('\n').filter((l) => l.trim()).length,
    applied: Array.isArray(log) && log.some((e) => e.status === 'done' || e.status === 'commented'),
    frozen: await exists(join(dir, '.lock')),
    snapshotPulledAt: snap?.pulledAt ?? null,
  };
}

async function guard(opts: SessionOptions, action: string): Promise<void> {
  if (opts.force) return;
  const up = await (opts.serverUp ?? (() => serverUsing(opts.dir)))();
  if (up) throw new Error(`a Trellis server is running (${up}). Stop it first (Ctrl-C, or \`pnpm docker:down\`), then ${action}. Use --force to skip this check.`);
  if (await exists(join(opts.dir, '.lock'))) {
    throw new Error(`the session is frozen (workspace/.lock). Finish the apply or unfreeze first, then ${action}. Use --force to archive it as it is.`);
  }
}

/** Move the current session into archive/<name>/ (snapshot.json copied). Returns its metadata, or null if there was nothing. */
export async function archiveSession(opts: SessionOptions & { label?: string | null }): Promise<ArchiveMeta | null> {
  const now = (opts.now ?? (() => new Date()))();
  const current = await describeSession(opts.dir);
  if (!current) return null;
  const label = opts.label ? slug(opts.label) : null;
  let name = `${stamp(now)}${label ? `-${label}` : ''}`;
  const root = join(opts.dir, 'archive');
  for (let n = 2; await exists(join(root, name)); n++) name = `${stamp(now)}${label ? `-${label}` : ''}-${n}`;
  const target = join(root, name);
  await mkdir(target, { recursive: true });

  const files = await readdir(opts.dir);
  for (const f of files) {
    const isSession = (SESSION_FILES as readonly string[]).includes(f) || /^oplog\.jsonl\..+\.old$/.test(f);
    if (isSession) await rename(join(opts.dir, f), join(target, f));
  }
  if (await exists(join(opts.dir, 'snapshot.json'))) await copyFile(join(opts.dir, 'snapshot.json'), join(target, 'snapshot.json'));
  const meta: ArchiveMeta = { name, label, archivedAt: now.toISOString(), ...current };
  await writeFile(join(target, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

export async function newSession(opts: SessionOptions & { label?: string | null }): Promise<ArchiveMeta | null> {
  await guard(opts, 'start a new session');
  return archiveSession(opts);
}

export async function listSessions(dir: string): Promise<ArchiveMeta[]> {
  const root = join(dir, 'archive');
  const names = await readdir(root).catch(() => [] as string[]);
  const metas = await Promise.all(names.map(async (n) => (await readJson(join(root, n, 'meta.json')).catch(() => null)) as ArchiveMeta | null));
  return metas.filter((m): m is ArchiveMeta => m !== null).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

/** Put an archived session back (copied: the archive stays). The current session is archived first. */
export async function restoreSession(opts: SessionOptions & { name: string }): Promise<{ restored: ArchiveMeta; saved: ArchiveMeta | null }> {
  const source = join(opts.dir, 'archive', opts.name);
  const restored = (await readJson(join(source, 'meta.json')).catch(() => null)) as ArchiveMeta | null;
  if (!restored) throw new Error(`no archived session named "${opts.name}" (see \`pnpm session:list\`)`);
  await guard(opts, 'restore');
  const saved = await archiveSession({ ...opts, label: `before-restore-${opts.name}`.slice(0, 40) });
  for (const f of await readdir(source)) {
    if (f === 'meta.json') continue;
    await copyFile(join(source, f), join(opts.dir, f));
  }
  return { restored, saved };
}

/** A server using this workspace leaves workspace/.server.json while it runs; probe its port. */
async function serverUsing(dir: string): Promise<string | null> {
  const marker = (await readJson(join(dir, '.server.json')).catch(() => null)) as { port?: number } | null;
  if (!marker?.port) return null;
  const url = `http://localhost:${marker.port}`;
  try {
    const res = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(800) });
    return res.ok ? url : null;
  } catch {
    return null; // stale marker from a crash: nothing answers there
  }
}

// --- script

function line(m: Omit<ArchiveMeta, 'name' | 'label' | 'archivedAt'>): string {
  return `${m.project ?? '?'} · v${m.version ?? '?'} · ${m.batches} batch(es) · ${m.applied ? 'applied to Jira' : 'not applied'}${m.frozen ? ' · was frozen' : ''}`;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { label: { type: 'string' }, force: { type: 'boolean' }, pull: { type: 'boolean' } } });
  const { loadJiraEnv, workspacePath } = await import('./env.js');
  const dir = workspacePath();
  const force = values.force === true;

  if (cmd === 'new') {
    const meta = await newSession({ dir, force, label: values.label ?? null });
    console.log(meta ? `Archived the previous session to ${join(dir, 'archive', meta.name)}/ (${line(meta)}).` : 'No session to archive.');
    if (values.pull) {
      const env = loadJiraEnv();
      const { AcliAdapter } = await import('./adapter.js');
      const { buildSnapshot } = await import('./pull.js');
      const { writeJsonAtomic } = await import('./files.js');
      const snapshot = await buildSnapshot(new AcliAdapter(env.JIRA_PROJECT_KEY), { site: env.JIRA_SITE, projectKey: env.JIRA_PROJECT_KEY });
      await writeJsonAtomic(join(dir, 'snapshot.json'), snapshot);
      console.log(`Pulled ${env.JIRA_PROJECT_KEY}: ${Object.keys(snapshot.epics).length} epics, ${Object.keys(snapshot.tickets).length} tickets.`);
    }
    const hasSnapshot = await exists(join(dir, 'snapshot.json'));
    console.log(hasSnapshot
      ? 'Start Trellis (`pnpm dev` or `pnpm docker:up`): it builds a fresh roadmap from workspace/snapshot.json.'
      : 'No snapshot yet: run `pnpm jira:pull` (or `pnpm seed` for sample data), then start Trellis.');
    return 0;
  }
  if (cmd === 'list') {
    const current = await describeSession(dir);
    console.log(`Current: ${current ? line(current) : 'none (the next start builds a fresh roadmap)'}`);
    const all = await listSessions(dir);
    if (all.length === 0) console.log('No archived sessions.');
    for (const m of all) console.log(`  ${m.name.padEnd(36)} ${m.archivedAt.slice(0, 16).replace('T', ' ')}  ${line(m)}`);
    return 0;
  }
  if (cmd === 'restore') {
    const name = positionals[0];
    if (!name) throw new Error('usage: pnpm session:restore <name>   (names from `pnpm session:list`)');
    const { restored, saved } = await restoreSession({ dir, force, name });
    if (saved) console.log(`Archived the current session to ${join(dir, 'archive', saved.name)}/.`);
    console.log(`Restored ${restored.name} (${line(restored)}). Start Trellis to continue it.`);
    return 0;
  }
  console.error('usage: pnpm session:new [--label NAME] [--pull] [--force] | pnpm session:list | pnpm session:restore <name> [--force]');
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exit(code); }, (err: unknown) => {
    console.error(`session: ${(err as Error).message}`);
    process.exit(1);
  });
}

