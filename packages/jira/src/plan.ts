// Changeset → apply plan (PLAN.md §6 step 3). Each changeset op becomes a step; the targets'
// current Jira values are fetched and compared with the snapshot (`before`) to find drift.
// Changes acli can't make (epic dates, moving an existing ticket to another epic) become notes
// that apply posts as one comment per issue, together with the captured requests.
import { COMMENT_ONLY, isTempId } from '@trellis/shared';
import type { ChangeOp, Changeset, IssueId, Reason, Snapshot } from '@trellis/shared';
import { markdownToAdf } from './adf.js';
import type { CreateInput, JiraAdapter, RawIssue, UpdateInput } from './adapter.js';
import { deferredOf, descriptionOf, LATER_LABEL, labelsOf, linksOf, personOf, statusOf, typeName } from './normalize.js';

export type Note =
  | { kind: 'dates'; before: { startDate: string | null; dueDate: string | null }; after: { startDate: string | null; dueDate: string | null } }
  | { kind: 'move'; from: IssueId | null; to: IssueId | null; toName: string | null }
  | { kind: 'start'; startDate: string }
  /** Into or out of Deliver later; `epic` because a deferred epic's planned dates are cleared. */
  | { kind: 'defer'; deferred: boolean; epic: boolean };

export type StepAction =
  | { do: 'create'; input: CreateInput }
  | { do: 'update'; fields: UpdateInput }
  | { do: 'transition'; status: string }
  | { do: 'link.add'; from: IssueId; to: IssueId; type: string }
  | { do: 'link.remove'; linkId: string }
  /** A line in the issue's comment step. Comment-only changes are then acknowledged under that key. */
  | { do: 'note'; note: Note; acknowledge?: string }
  | { do: 'comment'; reasons: Reason[] };

export interface Drift {
  field: string;
  snapshot: unknown;
  jira: unknown;
  trellis: unknown;
}

export interface PlanStep {
  /** Changeset op index as a string, or `comment:<target>`. Apply resumes by (changesetId, id). */
  id: string;
  index: number | null;
  kind: ChangeOp['kind'] | 'comment';
  target: IssueId;
  summary: string;
  action: StepAction;
  /** False when skipped: drift kept as Jira's value, or the change is already in Jira. */
  run: boolean;
  skipReason?: string;
  drift?: Drift;
  decision?: DriftDecision;
}

export type DriftDecision = 'keep' | 'overwrite';

export interface ApplyPlan {
  changesetId: string;
  project: string;
  createdAt: string;
  steps: PlanStep[];
}

export interface PlanOptions {
  projectKey: string;
  /** Per step id: keep Jira's value (skip) or overwrite. From the Freeze screen. */
  decisions?: Record<string, DriftDecision>;
  /** For drift without a decision. Default: skip. */
  onDrift?: 'skip' | 'overwrite';
  now?: () => Date;
}

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (typeof v === 'object' && 'displayName' in v) return String((v).displayName);
  return typeof v === 'string' ? v : JSON.stringify(v);
};
const sorted = (a: readonly string[]): string[] => [...a].sort();
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The comparable live value of a field, normalised like the snapshot. */
function liveValue(raw: RawIssue, field: string): unknown {
  switch (field) {
    case 'summary': return typeof raw.fields['summary'] === 'string' ? raw.fields['summary'] : '';
    case 'description': return descriptionOf(raw);
    case 'assignee': return personOf(raw.fields['assignee'])?.accountId ?? null;
    case 'labels': return sorted(labelsOf(raw));
    case 'issueType': return typeName(raw);
    case 'status': return statusOf(raw).name;
    default: return undefined;
  }
}

function comparable(field: string, v: unknown): unknown {
  if (field === 'assignee') return (v as { accountId?: string } | null)?.accountId ?? null;
  if (field === 'labels') return sorted((v as string[] | null) ?? []);
  if (field === 'description') return v ?? '';
  return v;
}

function hasLink(raw: RawIssue | undefined, type: string, from: IssueId, to: IssueId): { yes: boolean; id?: string } {
  if (!raw) return { yes: false };
  for (const l of linksOf(raw)) {
    if (l.type !== type) continue;
    const pair = l.direction === 'outward' ? [raw.key, l.target] : [l.target, raw.key];
    if (pair[0] === from && pair[1] === to) return l.jiraLinkId !== undefined ? { yes: true, id: l.jiraLinkId } : { yes: true };
  }
  return { yes: false };
}

function describe(op: ChangeOp): string {
  switch (op.kind) {
    case 'epic.create': return `create epic "${op.after.summary}"${op.after.dueDate ? ` due ${op.after.dueDate}` : ''}`;
    case 'ticket.create': return `create ${op.after.issueType} "${op.after.summary}" under ${op.after.epicId ?? 'no epic'}`;
    case 'ticket.move': return `epic ${show(op.before)} → ${show(op.after)} (as a comment: acli can't change the parent)`;
    case 'field.update': return `${op.field}: ${show(op.before)} → ${show(op.after)}`;
    case 'transition': return `status ${show(op.before)} → ${op.after}`;
    case 'defer': return op.after ? `move to Deliver later (add label ${LATER_LABEL})` : `schedule again (remove label ${LATER_LABEL})`;
    case 'epic.dates': return `dates ${show(op.before.startDate)} … ${show(op.before.dueDate)} → ${show(op.after.startDate)} … ${show(op.after.dueDate)} (as a comment)`;
    case 'link.add': return `link: ${op.target} ${op.linkType.toLowerCase()} ${op.to}`;
    case 'link.remove': return `unlink: ${op.target} ${op.linkType.toLowerCase()} ${op.to}`;
  }
}

export async function buildPlan(cs: Changeset, snapshot: Snapshot, jira: JiraAdapter, opts: PlanOptions): Promise<ApplyPlan> {
  const decisions = opts.decisions ?? {};
  // Live Jira values for every existing issue the changeset touches.
  const existing = [...new Set(cs.ops.flatMap((o) => [o.target, ...('to' in o ? [o.to] : [])]))].filter((id) => !isTempId(id));
  const live = new Map<IssueId, RawIssue>();
  for (const id of existing) {
    try {
      live.set(id, await jira.getIssue(id));
    } catch {
      // Missing in Jira (deleted, moved project): the step will fail clearly when run.
    }
  }

  const epicName = (id: IssueId | null): string | null => {
    if (!id) return null;
    const created = cs.ops.find((o): o is Extract<Changeset['ops'][number], { kind: 'epic.create' }> => o.kind === 'epic.create' && o.target === id);
    return snapshot.epics[id]?.summary ?? created?.after.summary ?? null;
  };
  const steps: PlanStep[] = [];
  const commentTargets = new Map<IssueId, Reason[]>();
  const addReasons = (id: IssueId, reasons: Reason[]): void => {
    const list = commentTargets.get(id) ?? [];
    for (const r of reasons) if (!list.some((x) => x.batchId === r.batchId)) list.push(r);
    commentTargets.set(id, list);
  };

  for (const op of cs.ops) {
    const base = { id: String(op.index), index: op.index, kind: op.kind, target: op.target, summary: describe(op) } as const;
    const raw = live.get(op.target);
    let step: PlanStep;
    switch (op.kind) {
      case 'epic.create': {
        const input: CreateInput = { projectKey: opts.projectKey, type: snapshot.workflow.epicIssueType, summary: op.after.summary };
        if (op.after.description) input.description = markdownToAdf(op.after.description);
        if (op.after.dueDate) input.dueDate = op.after.dueDate;
        step = { ...base, action: { do: 'create', input }, run: true };
        steps.push(step);
        if (op.after.startDate) {
          steps.push({ ...base, id: `${op.index}:start`, summary: `planned start ${op.after.startDate} (as a comment)`, action: { do: 'note', note: { kind: 'start', startDate: op.after.startDate }, acknowledge: `${op.target}.dates` }, run: true });
        }
        addReasons(op.target, op.reasons);
        continue;
      }
      case 'ticket.create': {
        const input: CreateInput = { projectKey: opts.projectKey, type: op.after.issueType, summary: op.after.summary };
        if (op.after.description) input.description = markdownToAdf(op.after.description);
        if (op.after.labels.length) input.labels = op.after.labels;
        if (op.after.assignee) input.assigneeId = op.after.assignee.accountId;
        if (op.after.epicId) input.parentKey = op.after.epicId;
        step = { ...base, action: { do: 'create', input }, run: true };
        break;
      }
      case 'ticket.move':
        step = { ...base, action: { do: 'note', note: { kind: 'move', from: op.before, to: op.after, toName: epicName(op.after) }, acknowledge: `${op.target}.epicId` }, run: true };
        break;
      case 'epic.dates':
        step = { ...base, action: { do: 'note', note: { kind: 'dates', before: op.before, after: op.after }, acknowledge: `${op.target}.dates` }, run: true };
        break;
      case 'field.update': {
        const fields: UpdateInput = {};
        if (op.field === 'summary') fields.summary = op.after as string;
        else if (op.field === 'description') fields.description = markdownToAdf((op.after as string | null) ?? '');
        else if (op.field === 'assignee') fields.assigneeId = (op.after as { accountId: string } | null)?.accountId ?? null;
        else if (op.field === 'issueType') fields.type = op.after as string;
        else {
          const before = (op.before as string[] | null) ?? [];
          const after = (op.after as string[] | null) ?? [];
          fields.labelsToAdd = after.filter((l) => !before.includes(l));
          fields.labelsToRemove = before.filter((l) => !after.includes(l));
        }
        step = { ...base, action: { do: 'update', fields }, run: true };
        if (raw) checkDrift(step, op.field, liveValue(raw, op.field), comparable(op.field, op.before), comparable(op.field, op.after));
        break;
      }
      case 'transition':
        step = { ...base, action: { do: 'transition', status: op.after }, run: true };
        if (raw && op.before !== null) checkDrift(step, 'status', liveValue(raw, 'status'), op.before, op.after);
        break;
      case 'defer': {
        // The label is the field; the note tells people why in the issue's one comment.
        const fields: UpdateInput = op.after ? { labelsToAdd: [LATER_LABEL] } : { labelsToRemove: [LATER_LABEL] };
        step = { ...base, action: { do: 'update', fields }, run: true };
        if (raw) checkDrift(step, 'deferred', deferredOf(raw), op.before, op.after);
        const isEpic = snapshot.epics[op.target] !== undefined || cs.ops.some((o) => o.kind === 'epic.create' && o.target === op.target);
        steps.push(step);
        steps.push({ ...base, id: `${op.index}:note`, summary: 'note in the issue comment', action: { do: 'note', note: { kind: 'defer', deferred: op.after, epic: isEpic } }, run: step.run, ...(step.skipReason ? { skipReason: step.skipReason } : {}) });
        if (step.run) addReasons(op.target, op.reasons);
        continue;
      }
      case 'link.add': {
        step = { ...base, action: { do: 'link.add', from: op.target, to: op.to, type: op.linkType }, run: true };
        if (hasLink(raw, op.linkType, op.target, op.to).yes || hasLink(live.get(op.to), op.linkType, op.target, op.to).yes) {
          step.run = false;
          step.skipReason = 'already in Jira';
        }
        break;
      }
      case 'link.remove': {
        const found = hasLink(raw, op.linkType, op.target, op.to);
        const other = found.yes ? found : hasLink(live.get(op.to), op.linkType, op.target, op.to);
        const linkId = op.jiraLinkId ?? other.id;
        step = { ...base, action: { do: 'link.remove', linkId: linkId ?? '' }, run: true };
        if (raw && !other.yes) {
          step.run = false;
          step.skipReason = 'already removed in Jira';
        } else if (!linkId) {
          step.run = false;
          step.skipReason = 'no Jira link id; remove it in Jira';
        }
        break;
      }
    }
    steps.push(step);
    if (step.run) addReasons(op.target, op.reasons);
    if (COMMENT_ONLY.has(op.kind)) addReasons(op.target, []);
  }

  // One comment per issue that changed or has notes: "Changed in Trellis…", with captured requests.
  for (const [target, reasons] of commentTargets) {
    const hasWork = steps.some((s) => s.target === target && s.run && s.kind !== 'comment');
    if (!hasWork) continue;
    steps.push({ id: `comment:${target}`, index: null, kind: 'comment', target, summary: `comment on ${target}${reasons.length ? ` with ${reasons.length} captured request(s)` : ''}`, action: { do: 'comment', reasons }, run: true });
  }

  return { changesetId: cs.id, project: opts.projectKey, createdAt: (opts.now ?? (() => new Date()))().toISOString(), steps };

  function checkDrift(step: PlanStep, field: string, jira: unknown, before: unknown, after: unknown): void {
    if (same(jira, after)) {
      step.run = false;
      step.skipReason = 'already in Jira';
      return;
    }
    if (same(jira, before)) return;
    step.drift = { field, snapshot: before, jira, trellis: after };
    const decision = decisions[step.id] ?? (opts.onDrift === 'overwrite' ? 'overwrite' : 'keep');
    step.decision = decision;
    if (decision === 'keep') {
      step.run = false;
      step.skipReason = 'drift: kept the Jira value';
    }
  }
}
