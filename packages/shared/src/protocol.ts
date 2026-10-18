// Real-time protocol (docs/PLAN.md §5), shared by server, web app and CLI.
import { z } from 'zod';
import type { Changeset } from './changeset.js';
import type { Batch, BatchResult, IssueId, OplogEntry, RoadmapState, Snapshot } from './schemas.js';
import { Batch as BatchSchema, IssueId as IssueIdSchema } from './schemas.js';

export const ClientKind = z.enum(['human', 'agent']);
export type ClientKind = z.infer<typeof ClientKind>;

/** Messages a client sends over `/ws`. */
export const ClientMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), name: z.string().min(1), kind: ClientKind, clientId: z.string().min(1) }),
  z.strictObject({ type: z.literal('batch'), requestId: z.string().min(1), batch: BatchSchema }),
  z.strictObject({
    type: z.literal('presence'),
    selection: z.array(IssueIdSchema).optional(),
    dragging: IssueIdSchema.nullable().optional(),
  }),
  z.strictObject({ type: z.literal('claim'), ids: z.array(IssueIdSchema).min(1), note: z.string().optional(), ttlSec: z.number().positive().optional() }),
  z.strictObject({ type: z.literal('release'), ids: z.array(IssueIdSchema).min(1) }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export interface Claim {
  id: IssueId;
  holder: string;
  /** Set for websocket clients; HTTP (CLI) claims are identified by holder name. */
  clientId?: string;
  note?: string;
  /** `drag` claims come from presence.dragging and expire after 10 s. */
  kind: 'claim' | 'drag';
  expiresAt: string;
}

export interface PresenceClient {
  clientId: string;
  name: string;
  kind: ClientKind;
  via: 'ws' | 'http';
  selection: IssueId[];
  dragging: IssueId | null;
}

export interface SnapshotSummary {
  pulledAt: string | null;
  project: { key: string; name: string; site?: string | undefined } | null;
  epics: number;
  tickets: number;
  /** True when snapshot.json on disk is newer than the one the session is based on. */
  newerAvailable: boolean;
}

export interface Status {
  version: number;
  frozen: RoadmapState['frozen'];
  clients: PresenceClient[];
  claims: Claim[];
  snapshot: SnapshotSummary;
  pendingChanges: number;
  /** Warning when JIRA_PROJECT_KEY and the snapshot's project disagree. */
  projectMismatch?: string;
}

/** Messages the server sends over `/ws`. */
export type ServerMessage =
  | {
      type: 'welcome';
      state: RoadmapState;
      /** The Jira snapshot the session is based on (for "differs from Jira" and valid choices). */
      snapshot: Snapshot | null;
      snapshotSummary: SnapshotSummary;
      /** The most recent applied batches, oldest first (activity feed, undo). */
      recent: OplogEntry[];
      presence: PresenceClient[];
      claims: Claim[];
      version: number;
      /** While frozen: the dry-run plan, apply log and drift decisions so far. */
      apply: ApplyStatus | null;
    }
  | { type: 'batch.applied'; batch: Batch & { id: string }; results: BatchResult; version: number }
  | { type: 'batch.result'; requestId: string; results: BatchResult }
  | { type: 'presence'; clients: PresenceClient[] }
  | { type: 'claims'; claims: Claim[] }
  | { type: 'freeze'; frozen: RoadmapState['frozen']; changeset: Changeset | null }
  | { type: 'snapshot.available'; summary: SnapshotSummary }
  | { type: 'snapshot.reloaded'; summary: SnapshotSummary; state: RoadmapState; snapshot: Snapshot }
  | { type: 'apply.progress'; log: unknown }
  | { type: 'apply.plan'; plan: unknown }
  | { type: 'drift.decisions'; decisions: DriftDecisions }
  | { type: 'error'; code: string; message: string };

/** Keep Jira's value or overwrite it with the roadmap's, per apply-plan step id. */
export interface DriftDecisions {
  changesetId: string | null;
  decisions: Record<string, 'keep' | 'overwrite'>;
}

export interface ApplyStatus {
  /** workspace/apply-plan.json, written by `pnpm jira:apply` (shape owned by @trellis/jira). */
  plan: unknown;
  log: unknown;
  decisions: DriftDecisions;
}

/** HTTP error body. */
export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
