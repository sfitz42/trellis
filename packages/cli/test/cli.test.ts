import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { BatchResult, OplogEntry, RoadmapState, ServerMessage, Status } from '@trellis/shared';
import { parseShift, parseTtl, shiftDate } from '../src/args.js';
import { startServer, stable, trellis } from './helpers.js';
import type { Server } from './helpers.js';

let server: Server;
beforeEach(async () => { server = await startServer(); });
afterEach(async () => { await server.stop(); });

const t = (args: string[], opts?: Parameters<typeof trellis>[2]) => trellis(server.url, args, opts);
const state = (): RoadmapState => server.session.getState();

describe('reads', () => {
  it('status: text and JSON', async () => {
    const text = await t(['status']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('Trellis · PROJ Platform Rebuild · v0 · live');
    expect(text.out).toContain('Changes vs Jira: 0');
    const json = await t(['status', '--json']);
    expect(stable(json.json())).toMatchSnapshot();
  });

  it('status exits 4 when frozen', async () => {
    await t(['freeze']);
    const r = await t(['status']);
    expect(r.code).toBe(4);
    expect(r.out).toContain('FROZEN by Shaun');
  });

  it('get epic / ticket, auto-detecting the kind', async () => {
    const epic = await t(['get', 'PROJ-41']);
    expect(epic.out).toMatch(/^PROJ-41 · Epic · To Do · — → 2027-02-28/);
    expect(epic.out).toContain('tickets (9):');
    const ticket = await t(['get', 'ticket', 'PROJ-121']);
    expect(ticket.out).toContain('links: is blocked by PROJ-120; blocks PROJ-122');
    expect(stable((await t(['get', 'PROJ-121', '--json'])).json())).toMatchSnapshot();
    const missing = await t(['get', 'PROJ-999']);
    expect(missing.code).toBe(3);
    expect(missing.err).toContain('ticket PROJ-999 not found');
  });

  it('lists epics and filtered tickets', async () => {
    expect((await t(['list', 'epics'])).out.split('\n')).toHaveLength(5);
    const billing = await t(['list', 'tickets', '--epic', 'PROJ-42']);
    expect(billing.out.split('\n')).toHaveLength(8);
    const filtered = await t(['list', 'tickets', '--filter', 'webhook', '--json']);
    expect((filtered.json() as { id: string }[]).map((x) => x.id)).toEqual(['PROJ-142']);
    expect((await t(['list', 'tickets', '--epic', 'none'])).out).toContain('PROJ-45');
  });

  it('snapshot-diff for everything or one item', async () => {
    expect((await t(['snapshot-diff'])).out).toContain('no changes');
    await t(['ticket', 'transition', 'PROJ-121', 'Done']);
    const one = await t(['snapshot-diff', 'PROJ-121']);
    expect(one.out).toContain('PROJ-121: 1 change(s) vs Jira');
    expect(one.out).toMatch(/transition\s+PROJ-121\s+status To Do → Done {2}\(by Claude Code\)/);
  });
});

describe('writes', () => {
  it('creates tickets, resolving assignees by name, with reason and asker captured', async () => {
    const r = await t(['ticket', 'create', '--summary', 'Dry run', '--epic', 'PROJ-41', '--type', 'Story', '--assignee', 'casey', '--labels', 'migration,qa', '--points', '3', '--reason', 'add a dry-run ticket']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('✓ ticket.create under PROJ-41 "Dry run" → NEW-1');
    expect(state().tickets['NEW-1']).toMatchObject({ issueType: 'Story', assignee: { displayName: 'Casey Moor' }, labels: ['migration', 'qa'], storyPoints: 3 });
    const entry = server.session.getOplog().at(-1) as OplogEntry;
    expect(entry.batch).toMatchObject({ author: { name: 'Claude Code', kind: 'agent' }, reason: 'add a dry-run ticket', askedBy: 'Shaun' });
  });

  it('rejects unknown assignees with the list of people', async () => {
    const r = await t(['ticket', 'update', 'PROJ-121', '--assignee', 'Nobody']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown assignee "Nobody". Known people: Avery Stone (acc-0001)');
  });

  it('updates labels incrementally and clears assignee', async () => {
    await t(['ticket', 'update', 'PROJ-121', '--add-label', 'x', '--assignee', 'none']);
    await t(['ticket', 'update', 'PROJ-121', '--remove-label', 'x']);
    expect(state().tickets['PROJ-121']).toMatchObject({ assignee: null, labels: ['frontend'] });
  });

  it('moves, transitions and discards tickets', async () => {
    expect((await t(['ticket', 'move', 'PROJ-126', '--epic', 'PROJ-44', '--index', '0'])).code).toBe(0);
    expect(state().epics['PROJ-44']?.ticketOrder[0]).toBe('PROJ-126');
    const bad = await t(['ticket', 'transition', 'PROJ-126', 'Shipped']);
    expect(bad.code).toBe(3);
    expect(bad.out).toContain('✗ ticket.transition PROJ-126 → Shipped: "Shipped" is not a status of');
    await t(['ticket', 'create', '--summary', 'tmp']);
    expect((await t(['ticket', 'discard', 'NEW-1'])).code).toBe(0);
    expect((await t(['ticket', 'discard', 'PROJ-126'])).code).toBe(3);
  });

  it('shifts epic dates, keeping month ends', async () => {
    const r = await t(['epic', 'dates', 'PROJ-43', '--shift', '1m', '--reason', 'push Notifications back a month']);
    expect(r.code).toBe(0);
    expect(state().epics['PROJ-43']).toMatchObject({ startDate: null, dueDate: '2027-06-30' });
    await t(['epic', 'dates', 'PROJ-43', '--start', '2027-03-01']);
    expect(state().epics['PROJ-43']).toMatchObject({ startDate: '2027-03-01', dueDate: '2027-06-30' });
    expect((await t(['epic', 'dates', 'PROJ-43', '--start', '2027-09-01'])).code).toBe(3); // after due
    expect((await t(['epic', 'dates', 'PROJ-43'])).code).toBe(1);
  });

  it('creates, updates, transitions and reorders epics', async () => {
    await t(['epic', 'create', '--summary', 'Reporting', '--due', '2027-06-30', '--temp-id', 'NEW-5']);
    await t(['epic', 'update', 'NEW-5', '--summary', 'Reporting v1']);
    await t(['epic', 'transition', 'NEW-5', 'In Progress']);
    await t(['epic', 'reorder', 'NEW-5', '0']);
    expect(state().epics['NEW-5']).toMatchObject({ summary: 'Reporting v1', status: 'In Progress', dueDate: '2027-06-30' });
    expect(state().epicOrder[0]).toBe('NEW-5');
  });

  it('adds and removes blocks links', async () => {
    expect((await t(['link', 'add', 'PROJ-126', 'blocks', 'PROJ-127'])).code).toBe(0);
    expect((await t(['link', 'add', 'PROJ-126', 'blocks', 'PROJ-127'])).code).toBe(3);
    expect((await t(['link', 'remove', 'PROJ-126', 'blocks', 'PROJ-127'])).code).toBe(0);
    expect((await t(['link', 'add', 'PROJ-126', 'relates', 'PROJ-127'])).code).toBe(1);
  });
});

describe('batch', () => {
  // The Phase 4 acceptance request, as an agent would send it: one batch, reason captured.
  const split = {
    reason: 'Split PROJ-140 into three tickets and push Notifications back a month',
    ops: [
      { type: 'ticket.create', tempId: 'NEW-1', epicId: 'PROJ-42', fields: { summary: 'Provider sandbox account', issueType: 'Task' } },
      { type: 'ticket.create', tempId: 'NEW-2', epicId: 'PROJ-42', fields: { summary: 'Provider API keys in the vault', issueType: 'Task' } },
      { type: 'ticket.create', tempId: 'NEW-3', epicId: 'PROJ-42', fields: { summary: 'Sandbox smoke test', issueType: 'Task' } },
      { type: 'link.add', from: 'NEW-3', to: 'PROJ-141', linkType: 'blocks' },
      { type: 'link.remove', from: 'PROJ-140', to: 'PROJ-141', linkType: 'blocks' },
      { type: 'ticket.transition', id: 'PROJ-140', status: 'Done' },
      { type: 'epic.setDates', id: 'PROJ-43', startDate: null, dueDate: '2027-06-30' },
    ],
  };

  it('applies a whole request as one batch, live for browsers', async () => {
    const browser = new WebSocket(`${server.url.replace('http', 'ws')}/ws`);
    const seen = new Promise<Extract<ServerMessage, { type: 'batch.applied' }>>((resolve) => {
      browser.on('message', (d: Buffer) => {
        const m = JSON.parse(d.toString()) as ServerMessage;
        if (m.type === 'batch.applied') resolve(m);
      });
    });
    await new Promise((r) => browser.once('open', r));
    browser.send(JSON.stringify({ type: 'hello', name: 'Shaun', kind: 'human', clientId: 'browser' }));

    const r = await t(['batch', '--base', '0'], { stdin: JSON.stringify(split) });
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[0]).toBe('batch b1 · v1 · 7 applied, 0 rejected, 0 kept');
    const live = await seen;
    expect(live.batch).toMatchObject({ reason: split.reason, askedBy: 'Shaun', author: { kind: 'agent' }, baseVersion: 0 });
    expect(live.results.applied).toHaveLength(7);
    browser.close();
    expect(state().epics['PROJ-42']?.ticketOrder.slice(-3)).toEqual(['NEW-1', 'NEW-2', 'NEW-3']);
  });

  it('accepts a bare JSON array, and flags override the input', async () => {
    const r = await t(['batch', '--reason', 'from flag', '--json'], { stdin: JSON.stringify([{ type: 'ticket.transition', id: 'PROJ-121', status: 'Done' }]) });
    expect(stable(r.json())).toMatchSnapshot();
    expect(server.session.getOplog().at(-1)?.batch.reason).toBe('from flag');
  });

  it('atomic by default: one bad op rejects the batch (exit 3); --non-atomic applies the rest (exit 2)', async () => {
    const ops = [{ type: 'ticket.transition', id: 'PROJ-121', status: 'Done' }, { type: 'ticket.move', id: 'PROJ-126', epicId: 'PROJ-99' }];
    const atomic = await t(['batch'], { stdin: JSON.stringify(ops) });
    expect(atomic.code).toBe(3);
    expect(atomic.out).toContain('epic PROJ-99 not found [NOT_FOUND]');
    const partial = await t(['batch', '--non-atomic'], { stdin: JSON.stringify(ops) });
    expect(partial.code).toBe(2);
    expect(state().tickets['PROJ-121']?.status).toBe('Done');
  });

  it('keeps newer human edits (exit 2, reported as kept)', async () => {
    server.session.submit({ author: { name: 'James', kind: 'human' }, ops: [{ type: 'ticket.update', id: 'PROJ-127', fields: { summary: 'James' } }] });
    const r = await t(['batch', '--base', '0'], { stdin: JSON.stringify([
      { type: 'ticket.update', id: 'PROJ-127', fields: { summary: 'Agent' } },
      { type: 'ticket.transition', id: 'PROJ-127', status: 'Done' },
    ]) });
    expect(r.code).toBe(2);
    expect(r.out).toContain('• ticket.update PROJ-127 summary: PROJ-127 summary edited by James at v1 [STALE_FIELD] (kept the newer edit)');
  });

  it('explains malformed input', async () => {
    const r = await t(['batch'], { stdin: '{"ops":[{"type":"ticket.update","id":"PROJ-1","fields":{"sumary":"x"}}]}' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('invalid ops');
    expect((await t(['batch'], { stdin: 'nope' })).code).toBe(1);
  });
});

describe('claims, undo, freeze', () => {
  it('claims show the agent as present and lock items for others', async () => {
    await t(['claim', 'PROJ-121', 'PROJ-122', '--note', 'splitting', '--ttl', '2m']);
    const s = (await t(['status', '--json'])).json() as Status;
    expect(s.claims.map((c) => [c.id, c.holder, c.note])).toEqual([['PROJ-121', 'Claude Code', 'splitting'], ['PROJ-122', 'Claude Code', 'splitting']]);
    expect(s.clients).toContainEqual(expect.objectContaining({ name: 'Claude Code', kind: 'agent', via: 'http' }));
    const other = server.session.submit({ author: { name: 'Priya', kind: 'human' }, ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'x' } }] });
    expect(other.rejected[0]?.code).toBe('LOCKED');
    await t(['release', 'PROJ-121', 'PROJ-122']);
    expect(((await t(['status', '--json'])).json() as Status).claims).toEqual([]);
    expect((await t(['claim', 'PROJ-1', '--ttl', 'soon'])).code).toBe(1);
  });

  it('undoes a batch, and refuses when later edits overlap', async () => {
    await t(['ticket', 'update', 'PROJ-121', '--summary', 'A']);
    await t(['ticket', 'update', 'PROJ-121', '--summary', 'B']);
    const refused = await t(['undo', 'b1']);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain('UNDO_CONFLICT');
    expect((await t(['undo', 'b2'])).code).toBe(0);
    expect(state().tickets['PROJ-121']?.summary).toBe('A');
  });

  it('freeze writes the changeset; writes then exit 4; unfreeze reopens', async () => {
    await t(['ticket', 'transition', 'PROJ-121', 'Done']);
    const f = await t(['freeze']);
    expect(f.out).toMatch(/^frozen · changeset \w+ · 1 op\(s\)/);
    expect(JSON.parse(await readFile(join(server.dir, 'changeset.json'), 'utf8'))).toMatchObject({ ops: [{ kind: 'transition', target: 'PROJ-121' }] });
    const blocked = await t(['ticket', 'transition', 'PROJ-122', 'Done']);
    expect(blocked.code).toBe(4);
    expect((await t(['changeset', '--json'])).json()).toMatchObject({ ops: [{ kind: 'transition' }] });
    expect((await t(['unfreeze'])).code).toBe(0);
    expect((await t(['ticket', 'transition', 'PROJ-122', 'Done'])).code).toBe(0);
  });
});

describe('watch', () => {
  it('streams the next change as text or NDJSON', async () => {
    const text = t(['watch', '--limit', '1']);
    const json = t(['watch', '--json', '--limit', '1']);
    await new Promise((r) => setTimeout(r, 300));
    server.session.submit({ author: { name: 'Priya', kind: 'human' }, ops: [{ type: 'ticket.transition', id: 'PROJ-121', status: 'Done' }] });
    const [a, b] = await Promise.all([text, json]);
    expect(a.code).toBe(0);
    expect(a.err).toContain('watching');
    expect(a.out).toContain('v1 b1 Priya: ticket.transition PROJ-121 → Done');
    const types = b.out.split('\n').map((l) => (JSON.parse(l) as ServerMessage).type);
    expect(types.at(-1)).toBe('batch.applied');
  });
});

describe('errors and exit codes', () => {
  it('exits 5 when the server is unreachable', async () => {
    const r = await trellis('http://127.0.0.1:1', ['status']);
    expect(r.code).toBe(5);
    expect(r.err).toContain("Can't reach the Trellis server at http://127.0.0.1:1");
  });

  it('exits 1 on usage errors, 0 for help', async () => {
    expect((await t(['nonsense'])).code).toBe(1);
    expect((await t(['ticket', 'create'])).code).toBe(1); // missing --summary
    const help = await t(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: trellis');
  });

  it('prints errors as JSON with --json', async () => {
    const r = await t(['get', 'PROJ-999', '--json']);
    expect(r.code).toBe(3);
    expect(r.json()).toMatchObject({ error: 'NOT_FOUND: ticket PROJ-999 not found' });
  });
});

describe('argument helpers', () => {
  it('shifts dates, keeping month ends', () => {
    expect(shiftDate('2027-02-28', parseShift('1m'))).toBe('2027-03-31');
    expect(shiftDate('2027-01-31', parseShift('+1m'))).toBe('2027-02-28');
    expect(shiftDate('2027-03-15', parseShift('-1q'))).toBe('2026-12-15');
    expect(shiftDate('2027-03-15', parseShift('2w'))).toBe('2027-03-29');
  });

  it('parses ttls', () => {
    expect(parseTtl('30s')).toBe(30);
    expect(parseTtl('5m')).toBe(300);
    expect(parseTtl('1h')).toBe(3600);
    expect(parseTtl('45')).toBe(45);
  });
});

// Keep the BatchResult type import meaningful for readers of the snapshots.
export type { BatchResult };
