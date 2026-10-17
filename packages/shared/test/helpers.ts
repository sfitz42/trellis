import { readFileSync } from 'node:fs';
import { applyBatch, fromSnapshot, Snapshot } from '../src/index.js';
import type { ApplyContext, Batch, BatchResult, Op, OplogEntry, RoadmapState } from '../src/index.js';

const fixturePath = new URL('../fixtures/snapshot.sample.json', import.meta.url);

export function loadSnapshot(): Snapshot {
  return Snapshot.parse(JSON.parse(readFileSync(fixturePath, 'utf8')));
}

export const TODAY = '2026-10-17';

export function freshState(snapshot = loadSnapshot()): RoadmapState {
  return fromSnapshot(snapshot, { today: TODAY });
}

let batchCounter = 0;

/** Apply ops as one batch. Defaults: human author "Sam", atomic. */
export function apply(
  state: RoadmapState,
  ops: Op[],
  opts: Partial<Omit<Batch, 'ops'>> & { ctx?: Partial<ApplyContext>; snapshot?: Snapshot } = {},
): { state: RoadmapState; result: BatchResult; entry: OplogEntry } {
  const { ctx, snapshot = loadSnapshot(), ...batchOpts } = opts;
  const batchId = `b${++batchCounter}`;
  const batch: Batch & { id: string } = { author: { name: 'Sam', kind: 'human' }, ops, ...batchOpts, id: batchId };
  const out = applyBatch(state, batch, { workflow: snapshot.workflow, ...ctx, batchId });
  return { ...out, entry: { batch, result: out.result, at: '2026-10-17T10:00:00Z' } };
}

/** Item data only: drops version/meta bookkeeping so states can be compared. */
export function items(s: RoadmapState): Pick<RoadmapState, 'epics' | 'tickets' | 'epicOrder' | 'timeline'> {
  return { epics: s.epics, tickets: s.tickets, epicOrder: s.epicOrder, timeline: s.timeline };
}
