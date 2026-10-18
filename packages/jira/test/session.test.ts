import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveSession, describeSession, listSessions, newSession, restoreSession } from '../src/session.js';

let dir: string;
const down = (): Promise<string | null> => Promise.resolve(null);
const at = (iso: string) => () => new Date(iso);

/** A workspace as the server leaves it after a session. */
async function sessionFiles(project: string, version: number, extra: Record<string, string> = {}): Promise<void> {
  await writeFile(join(dir, 'snapshot.json'), JSON.stringify({ pulledAt: '2026-10-01T09:42:00.000Z', project: { key: project } }));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ state: { project: { key: project }, version }, baseSnapshot: null, batchSeq: version }));
  await writeFile(join(dir, 'roadmap.json'), '{}');
  await writeFile(join(dir, 'oplog.jsonl'), '{"a":1}\n{"a":2}\n');
  for (const [f, c] of Object.entries(extra)) await writeFile(join(dir, f), c);
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'trellis-session-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('session:new', () => {
  it('archives every session file, keeps the snapshot, and records what it was', async () => {
    await sessionFiles('PROJ', 12, { 'changeset.json': '{}', 'apply-log.json': '[{"status":"done"}]', 'oplog.jsonl.2026-09-01.old': 'x' });
    const meta = await newSession({ dir, serverUp: down, label: 'Q1 planning!', now: at('2026-10-18T17:30:00Z') });
    expect(meta).toMatchObject({ name: '2026-10-18-1730-q1-planning', project: 'PROJ', version: 12, batches: 2, applied: true, frozen: false });
    expect((await readdir(dir)).sort()).toEqual(['archive', 'snapshot.json']); // clean: the next start is a fresh roadmap
    const archived = (await readdir(join(dir, 'archive', meta?.name ?? ''))).sort();
    expect(archived).toEqual(['apply-log.json', 'changeset.json', 'meta.json', 'oplog.jsonl', 'oplog.jsonl.2026-09-01.old', 'roadmap.json', 'snapshot.json', 'state.json']);
  });

  it('does nothing when there is no session', async () => {
    expect(await newSession({ dir, serverUp: down })).toBeNull();
  });

  it('refuses while a server is running or the session is frozen, unless forced', async () => {
    await sessionFiles('PROJ', 3);
    await expect(newSession({ dir, serverUp: () => Promise.resolve('http://localhost:8080') })).rejects.toThrow(/server is running/);
    await writeFile(join(dir, '.lock'), '{}');
    await expect(newSession({ dir, serverUp: down })).rejects.toThrow(/frozen/);
    const meta = await newSession({ dir, serverUp: down, force: true });
    expect(meta?.frozen).toBe(true);
  });

  it('detects a server using this workspace from its .server.json marker, ignoring stale ones', async () => {
    await sessionFiles('PROJ', 3);
    const srv = createServer((_req, res) => { res.end('{}'); });
    await new Promise<void>((r) => { srv.listen(0, '127.0.0.1', r); });
    const port = (srv.address() as AddressInfo).port;
    await writeFile(join(dir, '.server.json'), JSON.stringify({ port }));
    await expect(newSession({ dir })).rejects.toThrow(new RegExp(`server is running \\(http://localhost:${port}\\)`));
    await new Promise<void>((r) => { srv.close(() => { r(); }); });
    expect(await newSession({ dir })).not.toBeNull(); // nothing answers now: stale marker
  });

  it('never overwrites an archive with the same name', async () => {
    await sessionFiles('PROJ', 1);
    const a = await archiveSession({ dir, label: 'x', now: at('2026-10-18T17:30:00Z') });
    await sessionFiles('PROJ', 2);
    const b = await archiveSession({ dir, label: 'x', now: at('2026-10-18T17:30:00Z') });
    expect([a?.name, b?.name]).toEqual(['2026-10-18-1730-x', '2026-10-18-1730-x-2']);
  });
});

describe('session:list and session:restore', () => {
  it('lists archives newest first and restores one, saving the current session first', async () => {
    await sessionFiles('PROJ', 5);
    await archiveSession({ dir, label: 'old', now: at('2026-10-01T10:00:00Z') });
    await sessionFiles('OTHER', 9);
    await archiveSession({ dir, label: 'newer', now: at('2026-10-10T10:00:00Z') });
    expect((await listSessions(dir)).map((m) => m.name)).toEqual(['2026-10-10-1000-newer', '2026-10-01-1000-old']);

    await sessionFiles('PROJ', 20); // the session in progress now
    const { restored, saved } = await restoreSession({ dir, serverUp: down, name: '2026-10-01-1000-old', now: at('2026-10-18T09:00:00Z') });
    expect(restored.version).toBe(5);
    expect(saved?.version).toBe(20);
    expect((await describeSession(dir))?.version).toBe(5);
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toMatchObject({ state: { version: 5 } });
    // The restored archive is copied, not consumed.
    expect((await listSessions(dir)).map((m) => m.name)).toContain('2026-10-01-1000-old');
  });

  it('explains an unknown archive name', async () => {
    await expect(restoreSession({ dir, serverUp: down, name: 'nope' })).rejects.toThrow(/no archived session named "nope"/);
  });
});
