// Optimistic editing (PLAN.md §5). The browser keeps the server-confirmed state and a queue of its
// own batches not yet confirmed; what it shows is confirmed + pending, replayed through the same
// reducer the server uses. Remote batches are applied to the confirmed state in server order.
import { applyBatch } from '@trellis/shared';
import type { Batch, BatchResult, Op, RoadmapState, Workflow } from '@trellis/shared';

export interface Pending {
  requestId: string;
  batch: Batch;
  /** Set once the server has accepted (part of) it; cleared when its batch.applied arrives. */
  batchId?: string;
}

/** Make a confirmed op reproducible: creates carry the id the server allocated. */
function pinIds(op: Op, createdId: string | undefined): Op {
  if (createdId && (op.type === 'epic.create' || op.type === 'ticket.create')) return { ...op, tempId: createdId };
  return op;
}

export class OptimisticModel {
  confirmed: RoadmapState;
  pending: Pending[] = [];

  constructor(state: RoadmapState, private workflow: Workflow | undefined) {
    this.confirmed = state;
  }

  reset(state: RoadmapState, workflow: Workflow | undefined): void {
    this.confirmed = state;
    this.workflow = workflow;
    this.pending = [];
  }

  /** Confirmed state with this client's pending batches replayed on top. */
  view(): RoadmapState {
    let s = this.confirmed;
    for (const p of this.pending) {
      s = applyBatch(s, { ...p.batch, atomic: false }, { batchId: 'local', ...(this.workflow ? { workflow: this.workflow } : {}) }).state;
    }
    return s;
  }

  submit(requestId: string, batch: Batch): void {
    this.pending.push({ requestId, batch });
  }

  /** Our own batch's result. Returns the rejected/skipped ops so the UI can explain the rollback. */
  result(requestId: string, results: BatchResult): BatchResult | null {
    const p = this.pending.find((x) => x.requestId === requestId);
    if (!p) return null;
    if (results.applied.length === 0) this.pending = this.pending.filter((x) => x !== p);
    else p.batchId = results.batchId;
    return results;
  }

  /**
   * A batch the server applied (ours or anyone's). Replays exactly the applied ops onto the
   * confirmed state. Returns false if that didn't reproduce the server's result, meaning this
   * client has drifted and should resync (reconnect for a fresh welcome).
   */
  applyRemote(batch: Batch & { id: string }, results: BatchResult, version: number): boolean {
    const ops = results.applied.map((a) => pinIds(a.op, a.createdId));
    const out = applyBatch(this.confirmed, { author: batch.author, atomic: false, ops }, { batchId: batch.id, ...(this.workflow ? { workflow: this.workflow } : {}) });
    this.pending = this.pending.filter((p) => p.batchId !== batch.id);
    if (out.result.applied.length !== ops.length) return false;
    this.confirmed = { ...out.state, version };
    return true;
  }

  replaceConfirmed(state: RoadmapState, workflow?: Workflow): void {
    this.confirmed = state;
    if (workflow) this.workflow = workflow;
  }
}
