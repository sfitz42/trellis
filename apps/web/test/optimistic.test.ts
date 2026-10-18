import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyBatch, fromSnapshot, Snapshot } from '@trellis/shared';
import type { Batch, RoadmapState } from '@trellis/shared';
import { OptimisticModel } from '../src/lib/optimistic.js';

const snapshot = Snapshot.parse(JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/snapshot.sample.json', import.meta.url), 'utf8')));
const fresh = (): RoadmapState => fromSnapshot(snapshot, { today: '2026-10-17' });
const me = { name: 'Priya', kind: 'human' } as const;

/** What the server would do with a batch: returns the broadcast payload. */
function serverApply(state: RoadmapState, batch: Batch, id: string) {
  const out = applyBatch(state, batch, { batchId: id, workflow: snapshot.workflow });
  return { state: out.state, batch: { ...batch, id }, results: out.result, version: out.state.version };
}

describe('OptimisticModel', () => {
  it('shows pending edits immediately, then confirms them without flicker', () => {
    const m = new OptimisticModel(fresh(), snapshot.workflow);
    const batch: Batch = { author: me, ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'Mine' } }] };
    m.submit('r1', batch);
    expect(m.view().tickets['PROJ-121']?.summary).toBe('Mine');

    const server = serverApply(fresh(), batch, 'b1');
    m.result('r1', server.results);
    expect(m.view().tickets['PROJ-121']?.summary).toBe('Mine'); // still shown while awaiting batch.applied
    expect(m.applyRemote(server.batch, server.results, server.version)).toBe(true);
    expect(m.pending).toEqual([]);
    expect(m.view().tickets['PROJ-121']?.summary).toBe('Mine');
    expect(m.view().version).toBe(1);
  });

  it('rolls back a fully rejected batch', () => {
    const m = new OptimisticModel(fresh(), snapshot.workflow);
    const batch: Batch = { author: me, ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'Mine' } }] };
    m.submit('r1', batch);
    m.result('r1', { batchId: 'b1', version: 0, applied: [], skipped: [], rejected: [{ index: 0, op: batch.ops[0]!, code: 'LOCKED', message: 'locked' }] });
    expect(m.view().tickets['PROJ-121']?.summary).not.toBe('Mine');
  });

  it('applies other people’s batches under my pending ones', () => {
    const m = new OptimisticModel(fresh(), snapshot.workflow);
    m.submit('r1', { author: me, ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { labels: ['mine'] } }] });
    const theirs = serverApply(fresh(), { author: { name: 'James', kind: 'human' }, ops: [{ type: 'ticket.update', id: 'PROJ-121', fields: { summary: 'Theirs' } }] }, 'b1');
    expect(m.applyRemote(theirs.batch, theirs.results, theirs.version)).toBe(true);
    expect(m.view().tickets['PROJ-121']).toMatchObject({ summary: 'Theirs', labels: ['mine'] });
  });

  it('reproduces server-allocated temp ids', () => {
    const m = new OptimisticModel(fresh(), snapshot.workflow);
    // The server already had NEW-1 from someone else; our view must use the server's ids.
    const first = serverApply(fresh(), { author: { name: 'Claude Code', kind: 'agent' }, ops: [{ type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'A' } }] }, 'b1');
    m.applyRemote(first.batch, first.results, first.version);
    const second = serverApply(first.state, { author: me, ops: [{ type: 'ticket.create', epicId: 'PROJ-41', fields: { summary: 'B' } }] }, 'b2');
    expect(m.applyRemote(second.batch, second.results, second.version)).toBe(true);
    expect(Object.keys(m.view().tickets).filter((id) => id.startsWith('NEW-')).sort()).toEqual(['NEW-1', 'NEW-2']);
    expect(m.view().tickets['NEW-2']?.summary).toBe('B');
  });

  it('reports drift when a remote batch does not reproduce', () => {
    const m = new OptimisticModel(fresh(), snapshot.workflow);
    const bogus = { author: me, ops: [{ type: 'ticket.update' as const, id: 'PROJ-999', fields: { summary: 'x' } }], id: 'b9' };
    expect(m.applyRemote(bogus, { batchId: 'b9', version: 1, applied: [{ index: 0, op: bogus.ops[0]!, touched: [], inverse: [] }], rejected: [], skipped: [] }, 1)).toBe(false);
  });
});
