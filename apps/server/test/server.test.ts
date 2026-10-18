import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BatchResult, Changeset, OplogEntry, RoadmapState, Snapshot, Status } from '@trellis/shared';
import { tempIdsFromApplyLog, toldFromApplyLog } from '../src/session.js';
import { agent, cleanup, Client, readFixture, sleep, start } from './helpers.js';
import type { Running } from './helpers.js';

let running: Running | undefined;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  if (running) await cleanup(running);
  running = undefined;
});

async function server(opts: Parameters<typeof start>[0] = {}): Promise<Running> {
  running = await start(opts);
  return running;
}
async function client(r: Running, name: string): Promise<Client> {
  const c = await Client.connect(r.wsUrl, name);
  clients.push(c);
  return c;
}
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

describe('boot and persistence', () => {
  it('starts from snapshot.json and writes state.json and a stable roadmap.json', async () => {
    const r = await server();
    const { body } = await r.http<Status>('GET', '/api/status');
    expect(body).toMatchObject({ version: 0, frozen: null, pendingChanges: 0, snapshot: { epics: 5, tickets: 36, newerAvailable: false } });
    const mirror = JSON.parse(await readFile(join(r.dir, 'roadmap.json'), 'utf8')) as Record<string, unknown>;
    expect(mirror).not.toHaveProperty('meta');
    expect(Object.keys(mirror)).toEqual([...Object.keys(mirror)].sort());
    const ids = Object.keys(mirror['tickets'] as object);
    expect(ids.indexOf('PROJ-45')).toBeLessThan(ids.indexOf('PROJ-100')); // numeric, not alphabetical
    expect(await exists(join(r.dir, 'state.json'))).toBe(true);
  });

  it('restores state, version and oplog after a restart', async () => {
    const r = await server();
    await r.http('POST', '/api/batch', { author: agent, reason: 'rename', ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'Renamed' } }] });
    await r.stop();
    running = await start({ dir: r.dir, seed: false });
    const { body: state } = await running.http<RoadmapState>('GET', '/api/state');
    expect(state.version).toBe(1);
    expect(state.tickets['PROJ-121']?.summary).toBe('Renamed');
    expect(running.session.getOplog()).toHaveLength(1);
    // Undo still works across the restart, and the next batch id doesn't collide.
    const { status, body } = await running.http<BatchResult>('POST', '/api/undo', { batchId: 'b1', author: { name: 'Sam', kind: 'human' } });
    expect(status).toBe(200);
    expect(body.batchId).toBe('b2');
  });

  it('starts empty without a snapshot', async () => {
    const r = await server({ seed: false, projectKey: 'ABC' });
    const { body } = await r.http<Status>('GET', '/api/status');
    expect(body.snapshot).toMatchObject({ pulledAt: null, epics: 0 });
  });

  it('appends every applied batch to oplog.jsonl', async () => {
    const r = await server();
    await r.http('POST', '/api/batch', { author: agent, reason: 'x', askedBy: 'Shaun', ops: [{ type: 'ticket.transition', id: 'PROJ-121', status: 'Done' }] });
    await r.session.flush();
    const lines = (await readFile(join(r.dir, 'oplog.jsonl'), 'utf8')).trim().split('\n');
    const entry = JSON.parse(lines[0] ?? '') as OplogEntry;
    expect(entry.batch).toMatchObject({ id: 'b1', reason: 'x', askedBy: 'Shaun', author: agent });
  });
});

describe('websocket collaboration', () => {
  it('sends welcome before anything else on connect', async () => {
    const r = await server();
    const priya = await client(r, 'Priya');
    expect(priya.messages[0]?.type).toBe('welcome');
  });

  it('broadcasts applied batches to everyone and results to the sender', async () => {
    const r = await server();
    const priya = await client(r, 'Priya');
    const james = await client(r, 'James');
    const requestId = priya.batch([{ type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-44' }]);
    const result = await priya.next('batch.result', (m) => m.requestId === requestId);
    expect(result.results.applied).toHaveLength(1);
    expect((await priya.next('batch.applied')).version).toBe(1);
    const seen = await james.next('batch.applied');
    expect(seen.batch.author.name).toBe('Priya');
    expect(seen.results.applied[0]?.op).toEqual({ type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-44' });
  });

  it('reports rejected ops to the sender only, for optimistic rollback', async () => {
    const r = await server();
    const priya = await client(r, 'Priya');
    const james = await client(r, 'James');
    const bad = priya.batch([{ type: 'ticket.transition', id: 'PROJ-121', status: 'Shipped' }]);
    const result = await priya.next('batch.result', (m) => m.requestId === bad);
    expect(result.results.rejected.map((x) => x.code)).toEqual(['INVALID_STATUS']);
    // James's next batch.applied is the following valid batch, not the rejected one.
    priya.batch([{ type: 'ticket.update', id: 'PROJ-121', fields: { labels: ['ok'] } }]);
    expect((await james.next('batch.applied')).results.applied[0]?.op.type).toBe('ticket.update');
  });

  it('shows agent batches with their captured request to browsers', async () => {
    const r = await server();
    const shaun = await client(r, 'Shaun');
    await r.http('POST', '/api/batch', {
      author: agent, reason: 'add a dry-run ticket under data migration', askedBy: 'Shaun',
      ops: [{ type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'Dry run' } }],
    });
    const m = await shaun.next('batch.applied');
    expect(m.batch).toMatchObject({ author: agent, reason: 'add a dry-run ticket under data migration', askedBy: 'Shaun' });
    expect(m.results.applied[0]?.createdId).toBe('NEW-1');
  });

  it('protects newer human edits from agent batches (STALE_FIELD)', async () => {
    const r = await server();
    const james = await client(r, 'James');
    james.batch([{ type: 'ticket.update', id: 'PROJ-127', fields: { summary: 'James edit' } }]);
    await james.next('batch.applied');
    const { body } = await r.http<BatchResult>('POST', '/api/batch', {
      author: agent, baseVersion: 0, ops: [{ type: 'ticket.update', id: 'PROJ-127', fields: { summary: 'Agent edit' } }],
    });
    expect(body.skipped[0]).toMatchObject({ code: 'STALE_FIELD' });
    expect(body.skipped[0]?.message).toContain('James');
  });

  it('validates messages and requires hello first', async () => {
    const r = await server();
    const c = await client(r, 'Priya');
    c.send({ type: 'batch', requestId: 'x', batch: { author: { name: 'P', kind: 'human' }, ops: [{ type: 'nope' }] } });
    expect((await c.next('error')).code).toBe('INVALID_MESSAGE');
    c.ws.send('not json');
    expect((await c.next('error')).code).toBe('INVALID_JSON');

    const { WebSocket } = await import('ws');
    const raw = new WebSocket(r.wsUrl);
    await new Promise((res) => raw.once('open', res));
    const reply = new Promise<string>((res) => raw.once('message', (d: Buffer) => { res(d.toString()); }));
    raw.send(JSON.stringify({ type: 'presence', selection: [] }));
    expect(JSON.parse(await reply)).toMatchObject({ type: 'error', code: 'HELLO_REQUIRED' });
    raw.close();
  });
});

describe('presence and claims', () => {
  it('lists websocket clients and CLI agents holding claims', async () => {
    const r = await server();
    const priya = await client(r, 'Priya');
    await r.http('POST', '/api/claims', { ids: ['PROJ-121'], holder: 'Claude Code', note: 'splitting' });
    const p = await priya.next('presence', (m) => m.clients.some((c) => c.via === 'http'));
    expect(p.clients.map((c) => [c.name, c.via])).toEqual([['Priya', 'ws'], ['Claude Code', 'http']]);
  });

  it('locks claimed items for everyone else until released', async () => {
    const r = await server();
    const priya = await client(r, 'Priya');
    expect((await r.http('POST', '/api/claims', { ids: ['PROJ-121'], holder: 'Claude Code' })).status).toBe(200);
    const id = priya.batch([{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'x' } }]);
    expect((await priya.next('batch.result', (m) => m.requestId === id)).results.rejected[0]?.code).toBe('LOCKED');
    // The holder itself can still write.
    const own = await r.http<BatchResult>('POST', '/api/batch', { author: agent, ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'y' } }] });
    expect(own.body.applied).toHaveLength(1);
    // A second claimant is refused.
    expect((await r.http('POST', '/api/claims', { ids: ['PROJ-121'], holder: 'Copilot' })).status).toBe(409);
    await r.http('DELETE', '/api/claims', { ids: ['PROJ-121'], holder: 'Claude Code' });
    const again = priya.batch([{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'z' } }]);
    expect((await priya.next('batch.result', (m) => m.requestId === again)).results.applied).toHaveLength(1);
  });

  it('treats dragging as a short soft lock', async () => {
    const r = await server({ dragTtlSec: 0.3 });
    const priya = await client(r, 'Priya');
    priya.send({ type: 'presence', dragging: 'PROJ-121' });
    await priya.next('claims', (m) => m.claims.some((c) => c.id === 'PROJ-121' && c.kind === 'drag'));
    const blocked = await r.http<BatchResult>('POST', '/api/batch', { author: agent, ops: [{ type: 'ticket.move', id: 'PROJ-121', epicId: 'PROJ-42' }] });
    expect(blocked.body.rejected[0]).toMatchObject({ code: 'LOCKED', message: expect.stringContaining('Priya') });
    // Priya's own drop goes through.
    const drop = priya.batch([{ type: 'ticket.move', id: 'PROJ-121', epicId: 'PROJ-42' }]);
    expect((await priya.next('batch.result', (m) => m.requestId === drop)).results.applied).toHaveLength(1);
    // And the lock expires on its own.
    await priya.next('claims', (m) => m.claims.length === 0, 2000);
  });

  it('releases a client’s claims when it disconnects', async () => {
    const r = await server();
    const priya = await client(r, 'Priya');
    const james = await client(r, 'James');
    priya.send({ type: 'claim', ids: ['PROJ-140', 'PROJ-141'] });
    await james.next('claims', (m) => m.claims.length === 2);
    await priya.close();
    expect((await james.next('presence', (m) => m.clients.length === 1)).clients[0]?.name).toBe('James');
    await james.next('claims', (m) => m.claims.length === 0);
  });
});

describe('freeze and changeset', () => {
  it('freezes: writes .lock and changeset.json, rejects edits, unfreezes', async () => {
    const r = await server();
    const shaun = await client(r, 'Shaun');
    await r.http('POST', '/api/batch', { author: agent, ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'Changed' } }] });
    const preview = await r.http<Changeset>('GET', '/api/changeset');
    expect(preview.body.ops).toHaveLength(1);

    const frozen = await r.http<{ changeset: Changeset }>('POST', '/api/freeze', { by: 'Shaun' });
    expect(frozen.body.changeset.ops[0]).toMatchObject({ kind: 'field.update', target: 'PROJ-121' });
    expect((await shaun.next('freeze')).frozen?.by).toBe('Shaun');
    expect(await exists(join(r.dir, '.lock'))).toBe(true);
    const onDisk = JSON.parse(await readFile(join(r.dir, 'changeset.json'), 'utf8')) as Changeset;
    expect(onDisk.id).toBe(frozen.body.changeset.id);

    const blocked = await r.http<BatchResult>('POST', '/api/batch', { author: agent, ops: [{ type: 'ticket.update', id: 'PROJ-122', fields: { summary: 'x' } }] });
    expect(blocked.body.rejected[0]?.code).toBe('FROZEN');
    expect((await r.http('POST', '/api/freeze', { by: 'Shaun' })).status).toBe(409);

    await r.http('POST', '/api/unfreeze');
    expect(await exists(join(r.dir, '.lock'))).toBe(false);
    expect((await shaun.next('freeze', (m) => m.frozen === null)).frozen).toBeNull();
  });
});

describe('undo', () => {
  it('undoes a batch as a new batch, and refuses when later edits overlap', async () => {
    const r = await server();
    await r.http('POST', '/api/batch', { author: agent, ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'A' } }] });
    await r.http('POST', '/api/batch', { author: { name: 'James', kind: 'human' }, ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'B' } }] });
    const refused = await r.http<{ error: string; message: string }>('POST', '/api/undo', { batchId: 'b1', author: { name: 'Shaun', kind: 'human' } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'UNDO_CONFLICT', message: expect.stringContaining('PROJ-121.summary (b2)') });

    const ok = await r.http<BatchResult>('POST', '/api/undo', { batchId: 'b2', author: { name: 'Shaun', kind: 'human' } });
    expect(ok.status).toBe(200);
    expect(r.session.getState().tickets['PROJ-121']?.summary).toBe('A');
    expect((await r.http('POST', '/api/undo', { batchId: 'b99', author: { name: 'Shaun', kind: 'human' } })).status).toBe(404);
  });
});

describe('HTTP reads and validation', () => {
  it('serves epics with their tickets in order, and single tickets', async () => {
    const r = await server();
    const epic = await r.http<{ epic: { id: string; ticketOrder: string[] }; tickets: { id: string }[] }>('GET', '/api/epics/PROJ-41');
    expect(epic.body.tickets.map((t) => t.id)).toEqual(epic.body.epic.ticketOrder);
    expect((await r.http('GET', '/api/tickets/PROJ-121')).status).toBe(200);
    expect((await r.http('GET', '/api/tickets/PROJ-999')).status).toBe(404);
    expect((await r.http('GET', '/api/epics/PROJ-999')).status).toBe(404);
  });

  it('rejects malformed batches with a readable message', async () => {
    const r = await server();
    const res = await r.http<{ error: string; message: string }>('POST', '/api/batch', { author: agent, ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { sumary: 'typo' } }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
    expect(res.body.message).toMatch(/sumary/);
  });
});

describe('snapshot reload and file watching', () => {
  async function writeSnapshot(dir: string, edit: (s: Snapshot) => void): Promise<void> {
    const s = (await readFixture()) as unknown as Snapshot;
    s.pulledAt = new Date().toISOString();
    edit(s);
    await writeFile(join(dir, 'snapshot.json.tmp'), JSON.stringify(s));
    const { rename } = await import('node:fs/promises');
    await rename(join(dir, 'snapshot.json.tmp'), join(dir, 'snapshot.json')); // atomic replace, like pull
  }

  it('offers a newer snapshot while live, and merges it on reload keeping Trellis edits', async () => {
    const r = await server();
    const shaun = await client(r, 'Shaun');
    await r.http('POST', '/api/batch', { author: agent, ops: [{ type: 'ticket.update', id: 'PROJ-122', fields: { summary: 'Trellis edit' } }] });
    await writeSnapshot(r.dir, (s) => {
      s.tickets['PROJ-121']!.summary = 'Jira edit';
      s.tickets['PROJ-122']!.summary = 'Jira edit too';
    });
    const offer = await shaun.next('snapshot.available');
    expect(offer.summary.newerAvailable).toBe(true);
    expect(r.session.getState().tickets['PROJ-121']?.summary).not.toBe('Jira edit'); // not auto-merged

    const { body } = await r.http<{ keptEdits: string[] }>('POST', '/api/snapshot/reload');
    expect(body.keptEdits).toEqual(['PROJ-122.summary']);
    const reloaded = await shaun.next('snapshot.reloaded');
    expect(reloaded.state.tickets['PROJ-121']?.summary).toBe('Jira edit');
    expect(reloaded.state.tickets['PROJ-122']?.summary).toBe('Trellis edit');
  });

  it('after apply while frozen: streams the apply log, then re-pulls and empties the changeset', async () => {
    const r = await server();
    const shaun = await client(r, 'Shaun');
    await r.http('POST', '/api/batch', { author: agent, ops: [{ type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'Dry run' } }] });
    await r.http('POST', '/api/freeze', { by: 'Shaun' });

    const log = [{ changesetId: 'x', index: 0, kind: 'ticket.create', target: 'NEW-1', status: 'done', createdKey: 'PROJ-400' }];
    await writeFile(join(r.dir, 'apply-log.json'), JSON.stringify(log));
    expect((await shaun.next('apply.progress')).log).toEqual(log);

    await writeSnapshot(r.dir, (s) => {
      s.tickets['PROJ-400'] = { ...s.tickets['PROJ-45']!, id: 'PROJ-400', epicId: 'PROJ-41', summary: 'Dry run', issueType: 'Task', status: 'To Do', links: [] };
      s.epics['PROJ-41']!.ticketOrder.push('PROJ-400');
    });
    const reloaded = await shaun.next('snapshot.reloaded');
    expect(reloaded.state.tickets['NEW-1']).toBeUndefined();
    expect(reloaded.state.tickets['PROJ-400']?.summary).toBe('Dry run');
    const cs = JSON.parse(await readFile(join(r.dir, 'changeset.json'), 'utf8')) as Changeset;
    expect(cs.ops).toEqual([]);
    expect((await r.http<Status>('GET', '/api/status')).body).toMatchObject({ pendingChanges: 0, frozen: { by: 'Shaun' } });
  });

  it('polls instead of watching when WATCH_POLL is set', async () => {
    const r = await server({ watchPoll: true });
    const shaun = await client(r, 'Shaun');
    await sleep(600); // let the first poll record the baseline
    await writeFile(join(r.dir, 'apply-log.json'), JSON.stringify([{ index: 0, status: 'done' }]));
    expect((await shaun.next('apply.progress', () => true, 4000)).log).toEqual([{ index: 0, status: 'done' }]);
  });
});

describe('apply hand-off', () => {
  it('streams the dry-run plan, records drift decisions, and includes both in welcome', async () => {
    const r = await server();
    const shaun = await client(r, 'Shaun');
    await r.http('POST', '/api/batch', { author: agent, ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'x' } }] });
    expect((await r.http('POST', '/api/drift', { stepId: '0', decision: 'keep' })).status).toBe(409); // not frozen
    const { body: frozen } = await r.http<{ changeset: Changeset }>('POST', '/api/freeze', { by: 'Shaun' });
    const plan = { changesetId: frozen.changeset.id, steps: [{ id: '0', drift: { field: 'summary' } }] };
    await writeFile(join(r.dir, 'apply-plan.json'), JSON.stringify(plan));
    expect((await shaun.next('apply.plan')).plan).toEqual(plan);

    const d = await r.http<{ decisions: Record<string, string> }>('POST', '/api/drift', { stepId: '0', decision: 'overwrite' });
    expect(d.body.decisions).toEqual({ '0': 'overwrite' });
    expect((await shaun.next('drift.decisions')).decisions).toEqual({ changesetId: frozen.changeset.id, decisions: { '0': 'overwrite' } });
    expect(JSON.parse(await readFile(join(r.dir, 'drift-decisions.json'), 'utf8'))).toMatchObject({ changesetId: frozen.changeset.id });

    const late = await client(r, 'Priya');
    const welcome = late.messages[0];
    expect(welcome?.type === 'welcome' && welcome.apply).toMatchObject({ plan, decisions: { decisions: { '0': 'overwrite' } } });
    expect((await r.http('POST', '/api/drift', { stepId: '0', decision: 'maybe' })).status).toBe(400);
  });

  it('marks commented changes as told on the post-apply re-pull, so the changeset empties', async () => {
    const r = await server();
    const shaun = await client(r, 'Shaun');
    await r.http('POST', '/api/batch', { author: agent, ops: [
      { type: 'epic.setDates', id: 'PROJ-43', startDate: null, dueDate: '2027-06-30' },
      { type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-44' },
    ] });
    await r.http('POST', '/api/freeze', { by: 'Shaun' });
    const cs = (await r.http<Changeset>('GET', '/api/changeset')).body;
    expect(cs.ops.map((o) => o.kind).sort()).toEqual(['epic.dates', 'ticket.move']);
    await writeFile(join(r.dir, 'apply-log.json'), JSON.stringify([
      { changesetId: cs.id, step: '0', status: 'commented', target: 'PROJ-126', acknowledge: 'PROJ-126.epicId' },
      { changesetId: cs.id, step: '1', status: 'commented', target: 'PROJ-43', acknowledge: 'PROJ-43.dates' },
    ]));
    // Jira unchanged (comments only): re-pull the same issues.
    const s = await readFixture();
    s['pulledAt'] = new Date().toISOString();
    await writeFile(join(r.dir, 'snapshot.json'), JSON.stringify(s));
    const reloaded = await shaun.next('snapshot.reloaded');
    expect(reloaded.state.epics['PROJ-43']?.dueDate).toBe('2027-06-30');
    expect(reloaded.state.tickets['PROJ-126']?.epicId).toBe('PROJ-44');
    expect((await r.http<Status>('GET', '/api/status')).body.pendingChanges).toBe(0);
  });
});

describe('tempIdsFromApplyLog / toldFromApplyLog', () => {
  it('reads acknowledged keys from commented entries', () => {
    expect(toldFromApplyLog([{ status: 'commented', acknowledge: 'PROJ-1.dates' }, { status: 'done', acknowledge: 'x' }])).toEqual(['PROJ-1.dates']);
  });

  it('reads NEW-* → key pairs from loosely shaped logs', () => {
    expect(tempIdsFromApplyLog([{ target: 'NEW-1', createdKey: 'PROJ-9' }, { target: 'PROJ-1', status: 'done' }])).toEqual({ 'NEW-1': 'PROJ-9' });
    expect(tempIdsFromApplyLog({ entries: [{ tempId: 'NEW-2', key: 'PROJ-10' }] })).toEqual({ 'NEW-2': 'PROJ-10' });
    expect(tempIdsFromApplyLog(null)).toEqual({});
  });
});
