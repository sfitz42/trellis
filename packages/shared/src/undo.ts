// Undo (docs/PLAN.md §4): the inverse ops of a logged batch, refused if a later batch touched
// any of the same fields. The caller submits the ops as a new batch by whoever pressed Undo.
import type { Op, OplogEntry } from './schemas.js';

export type UndoPlan =
  | { ok: true; ops: Op[] }
  | { ok: false; reason: 'NOT_FOUND' | 'NOTHING_APPLIED' | 'CONFLICT'; conflicts: { batchId: string; key: string }[] };

/** `PROJ-1.*` (whole item) overlaps any `PROJ-1.<field>` key, and vice versa. */
function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const item = (k: string): string => k.slice(0, k.indexOf('.'));
  return (a.endsWith('.*') || b.endsWith('.*')) && item(a) === item(b);
}

export function planUndo(oplog: readonly OplogEntry[], batchId: string): UndoPlan {
  const at = oplog.findIndex((e) => e.batch.id === batchId);
  const entry = oplog[at];
  if (!entry) return { ok: false, reason: 'NOT_FOUND', conflicts: [] };
  if (entry.result.applied.length === 0) return { ok: false, reason: 'NOTHING_APPLIED', conflicts: [] };

  const mine = entry.result.applied.flatMap((a) => a.touched);
  const conflicts: { batchId: string; key: string }[] = [];
  for (const later of oplog.slice(at + 1)) {
    for (const key of later.result.applied.flatMap((a) => a.touched)) {
      if (mine.some((m) => overlaps(m, key))) conflicts.push({ batchId: later.batch.id, key });
    }
  }
  if (conflicts.length > 0) return { ok: false, reason: 'CONFLICT', conflicts };

  // Undo the last op first; each op's own inverse list is already in run order.
  const ops = [...entry.result.applied].reverse().flatMap((a) => a.inverse);
  return { ok: true, ops };
}
