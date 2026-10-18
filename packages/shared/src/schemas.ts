// Data model (docs/PLAN.md §3–4). Types are inferred from these schemas so there is one source.
// Snapshot schemas strip unknown keys (Jira-derived data varies by project); op/batch schemas are
// strict so a typo from an agent is an error, not a silent no-op.
import { z } from 'zod';

export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'not a real date');

/** A Jira key (`PROJ-123`) or a temp id for an item not yet in Jira (`NEW-7`). */
export const IssueId = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/, 'expected an issue key like PROJ-123 or NEW-1');
export type IssueId = z.infer<typeof IssueId>;

export const isTempId = (id: string): boolean => /^NEW-\d+$/.test(id);

export const Person = z.object({ accountId: z.string().min(1), displayName: z.string() });
export type Person = z.infer<typeof Person>;

/** Name of the Jira link type Trellis edits in v1. Other link types are kept read-only. */
export const BLOCKS = 'Blocks';

/**
 * A Jira link as seen from the issue that holds it. `outward` means "this <type> target"
 * (for Blocks: this blocks target); `inward` means "target <type> this".
 */
export const Link = z.object({
  type: z.string().min(1),
  direction: z.enum(['outward', 'inward']),
  target: IssueId,
  jiraLinkId: z.string().optional(),
});
export type Link = z.infer<typeof Link>;

export const Epic = z.object({
  id: IssueId,
  summary: z.string().min(1),
  description: z.string().optional(),
  status: z.string().min(1),
  startDate: IsoDate.nullable(), // Trellis-owned (docs/jira-mapping.md)
  dueDate: IsoDate.nullable(),
  ticketOrder: z.array(IssueId),
  color: z.string().optional(),
  /** In the Deliver later tray: no dates in Trellis. In Jira, the `deliver-later` label. */
  deferred: z.boolean().default(false),
});
export type Epic = z.infer<typeof Epic>;

export const Ticket = z.object({
  id: IssueId,
  epicId: IssueId.nullable(),
  issueType: z.string().min(1),
  summary: z.string().min(1),
  description: z.string().optional(),
  status: z.string().min(1),
  assignee: Person.nullable(),
  labels: z.array(z.string()),
  storyPoints: z.number().nonnegative().nullable(), // Trellis-owned
  links: z.array(Link),
  /** Deferred on its own (its epic may still be scheduled). */
  deferred: z.boolean().default(false),
});
export type Ticket = z.infer<typeof Ticket>;

/** A delivery date on the timeline: work lands on or before `date`. Lives in Trellis only. */
export const Milestone = z.object({ id: z.string().min(1), label: z.string().min(1), date: IsoDate });
export type Milestone = z.infer<typeof Milestone>;

export const TimelineConfig = z
  .object({
    scale: z.enum(['milestones', 'weeks', 'months', 'quarters', 'custom']),
    start: IsoDate,
    /** Last visible date. The milestones scale ends at the last milestone instead, when there is one. */
    end: IsoDate,
    customRanges: z.array(z.object({ label: z.string(), start: IsoDate, end: IsoDate })).optional(),
    /** Sorted by date (the reducer sorts them). */
    milestones: z.array(Milestone).default([]),
    showLater: z.boolean().default(true),
    /** Display name of the tray. */
    laterLabel: z.string().min(1).default('Deliver later'),
  })
  .refine((t) => t.start <= t.end, 'timeline start must be on or before end');
export type TimelineConfig = z.infer<typeof TimelineConfig>;

export const Project = z.object({ key: z.string().min(1), name: z.string() });

export const FieldMeta = z.object({ version: z.number().int(), author: z.string() });

export const RoadmapState = z.object({
  project: Project,
  epics: z.record(z.string(), Epic),
  tickets: z.record(z.string(), Ticket),
  epicOrder: z.array(IssueId),
  timeline: TimelineConfig,
  /** `${id}.${field}` → who last changed it, at which state version. Not written to Jira. */
  meta: z.record(z.string(), FieldMeta),
  /**
   * What Jira has been told about changes it can't store (acli can't edit due date or parent):
   * `${epicId}.dates` → { startDate, dueDate }, `${ticketId}.epicId` → epic key. Apply posts these as
   * comments; once acknowledged they no longer count as changes (docs/jira-mapping.md).
   */
  acknowledged: z.record(z.string(), z.unknown()).default({}),
  version: z.number().int().nonnegative(),
  frozen: z.object({ by: z.string(), at: z.string() }).nullable(),
});
export type RoadmapState = z.infer<typeof RoadmapState>;

export const StatusInfo = z.object({
  name: z.string().min(1),
  /** Jira status category key: `new`, `indeterminate` or `done`. Unknown values are kept. */
  category: z.string(),
});
export type StatusInfo = z.infer<typeof StatusInfo>;

export const Workflow = z.object({
  /** Issue type name used for epics in this project (the type at hierarchy level 1). */
  epicIssueType: z.string().default('Epic'),
  /** Known statuses per issue type, in display order. */
  statuses: z.record(z.string(), z.array(StatusInfo)),
  /** type → from-status → allowed to-statuses. `null` when Jira can't tell us (acli gap). */
  transitions: z.record(z.string(), z.record(z.string(), z.array(z.string()))).nullable().default(null),
  assignableUsers: z.array(Person).default([]),
});
export type Workflow = z.infer<typeof Workflow>;

export const Snapshot = z.object({
  pulledAt: z.string(),
  project: Project.extend({ site: z.string().optional() }),
  epics: z.record(z.string(), Epic),
  tickets: z.record(z.string(), Ticket),
  workflow: Workflow,
});
export type Snapshot = z.infer<typeof Snapshot>;

// --- operations (§4)

const EpicCreateFields = z.strictObject({
  summary: z.string().min(1),
  description: z.string().optional(),
  status: z.string().min(1).optional(),
  startDate: IsoDate.nullable().optional(),
  dueDate: IsoDate.nullable().optional(),
  color: z.string().optional(),
});

const TicketCreateFields = z.strictObject({
  summary: z.string().min(1),
  issueType: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.string().min(1).optional(),
  assignee: Person.nullable().optional(),
  labels: z.array(z.string()).optional(),
  storyPoints: z.number().nonnegative().nullable().optional(),
});

/** Fields an update can set. An empty string clears `description` / `color`. */
const EpicUpdateFields = z.strictObject({
  summary: z.string().min(1).optional(),
  description: z.string().optional(),
  color: z.string().optional(),
});

const TicketUpdateFields = z.strictObject({
  summary: z.string().min(1).optional(),
  description: z.string().optional(),
  assignee: Person.nullable().optional(),
  labels: z.array(z.string()).optional(),
  storyPoints: z.number().nonnegative().nullable().optional(),
  issueType: z.string().min(1).optional(),
});

export const Op = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('epic.create'), tempId: IssueId.optional(), fields: EpicCreateFields }),
  z.strictObject({ type: z.literal('epic.update'), id: IssueId, fields: EpicUpdateFields }),
  z.strictObject({ type: z.literal('epic.setDates'), id: IssueId, startDate: IsoDate.nullable(), dueDate: IsoDate.nullable() }),
  z.strictObject({ type: z.literal('epic.transition'), id: IssueId, status: z.string().min(1) }),
  z.strictObject({ type: z.literal('epic.reorder'), id: IssueId, index: z.number().int().nonnegative() }),
  /** Only for NEW-* epics with no tickets. Needed so `epic.create` can be undone. */
  z.strictObject({ type: z.literal('epic.discardNew'), id: IssueId }),
  /** Into the Deliver later tray (clears the epic's dates) or back out. */
  z.strictObject({ type: z.literal('epic.defer'), id: IssueId, deferred: z.boolean() }),
  z.strictObject({ type: z.literal('ticket.create'), tempId: IssueId.optional(), epicId: IssueId.nullable(), fields: TicketCreateFields }),
  z.strictObject({ type: z.literal('ticket.update'), id: IssueId, fields: TicketUpdateFields }),
  z.strictObject({ type: z.literal('ticket.move'), id: IssueId, epicId: IssueId.nullable(), index: z.number().int().nonnegative().optional() }),
  z.strictObject({ type: z.literal('ticket.transition'), id: IssueId, status: z.string().min(1) }),
  z.strictObject({ type: z.literal('ticket.discardNew'), id: IssueId }),
  z.strictObject({ type: z.literal('ticket.defer'), id: IssueId, deferred: z.boolean() }),
  z.strictObject({ type: z.literal('link.add'), from: IssueId, to: IssueId, linkType: z.literal('blocks') }),
  z.strictObject({ type: z.literal('link.remove'), from: IssueId, to: IssueId, linkType: z.literal('blocks') }),
  z.strictObject({ type: z.literal('timeline.set'), timeline: TimelineConfig }),
]);
export type Op = z.infer<typeof Op>;
export type OpType = Op['type'];
export type OpOf<T extends OpType> = Extract<Op, { type: T }>;

export const Author = z.strictObject({ name: z.string().min(1), kind: z.enum(['human', 'agent']) });
export type Author = z.infer<typeof Author>;

export const Batch = z.strictObject({
  id: z.string().optional(), // server-assigned
  author: Author,
  baseVersion: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
  askedBy: z.string().optional(),
  atomic: z.boolean().optional(),
  ops: z.array(Op).min(1),
});
export type Batch = z.infer<typeof Batch>;

// --- results

export const ERROR_CODES = [
  'FROZEN', 'INVALID', 'NOT_FOUND', 'DUPLICATE_ID', 'NOT_NEW', 'NOT_EMPTY', 'INVALID_STATUS',
  'INVALID_TRANSITION', 'INVALID_DATES', 'DEFERRED', 'SELF_LINK', 'DUPLICATE_LINK', 'LOCKED', 'STALE_FIELD',
  'BATCH_REJECTED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface OpError {
  index: number;
  op: Op;
  code: ErrorCode;
  message: string;
}

export interface AppliedOp {
  index: number;
  op: Op;
  /** Id the op created (temp id for creates), if any. */
  createdId?: IssueId;
  /** `${id}.${field}` keys this op changed (used for conflicts and undo). */
  touched: string[];
  /** Ops that undo this one, in the order they should run. */
  inverse: Op[];
}

export interface BatchResult {
  batchId: string;
  version: number;
  applied: AppliedOp[];
  rejected: OpError[];
  skipped: OpError[];
}

/** One line of `workspace/oplog.jsonl`. */
export interface OplogEntry {
  batch: Batch & { id: string };
  result: BatchResult;
  at: string;
}
