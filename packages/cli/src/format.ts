// Human-readable output. `--json` bypasses all of this and prints the API's JSON.
import type { BatchResult, ChangeOp, Changeset, Epic, Op, RoadmapState, ServerMessage, Status, Ticket } from '@trellis/shared';
import { BLOCKS } from '@trellis/shared';

const v = (x: unknown): string => {
  if (x === null || x === undefined || x === '') return '—';
  if (Array.isArray(x)) return x.length ? x.join(', ') : '—';
  if (typeof x === 'object' && 'displayName' in x) return (x as { displayName: string }).displayName;
  return typeof x === 'string' ? x : JSON.stringify(x);
};

function time(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16);
}

export function opSummary(op: Op): string {
  switch (op.type) {
    case 'epic.create': return `epic.create ${op.tempId ?? ''} "${op.fields.summary}"`.replace('  ', ' ');
    case 'ticket.create': return `ticket.create under ${op.epicId ?? 'no epic'} "${op.fields.summary}"`;
    case 'epic.setDates': return `epic.setDates ${op.id} ${v(op.startDate)} → ${v(op.dueDate)}`;
    case 'epic.transition':
    case 'ticket.transition': return `${op.type} ${op.id} → ${op.status}`;
    case 'ticket.move': return `ticket.move ${op.id} → ${op.epicId ?? 'no epic'}${op.index !== undefined ? ` @${op.index}` : ''}`;
    case 'link.add':
    case 'link.remove': return `${op.type} ${op.from} blocks ${op.to}`;
    case 'timeline.set': return `timeline.set ${op.timeline.scale} ${op.timeline.start} → ${op.timeline.end}`;
    case 'epic.reorder': return `epic.reorder ${op.id} @${op.index}`;
    default: return `${op.type} ${op.id}${'fields' in op ? ` ${Object.keys(op.fields).join(',')}` : ''}`;
  }
}

export function batchResult(r: BatchResult): string {
  const lines = [`batch ${r.batchId} · v${r.version} · ${r.applied.length} applied, ${r.rejected.length} rejected, ${r.skipped.length} kept`];
  for (const a of r.applied) lines.push(`  ✓ ${opSummary(a.op)}${a.createdId ? ` → ${a.createdId}` : ''}`);
  for (const s of r.skipped) lines.push(`  • ${opSummary(s.op)}: ${s.message} [${s.code}] (kept the newer edit)`);
  for (const x of r.rejected) lines.push(`  ✗ ${opSummary(x.op)}: ${x.message} [${x.code}]`);
  return lines.join('\n');
}

export function status(s: Status, state: RoadmapState): string {
  const humans = s.clients.filter((c) => c.kind === 'human').map((c) => c.name);
  const agents = s.clients.filter((c) => c.kind === 'agent').map((c) => c.name);
  const lines = [
    `Trellis · ${state.project.key} ${state.project.name} · v${s.version} · ${s.frozen ? `FROZEN by ${s.frozen.by} at ${time(s.frozen.at)} (editing locked)` : 'live'}`,
    `Snapshot: ${s.snapshot.pulledAt ? `pulled ${time(s.snapshot.pulledAt)} · ${s.snapshot.epics} epics · ${s.snapshot.tickets} tickets` : 'none'}${s.snapshot.newerAvailable ? ' · NEWER SNAPSHOT AVAILABLE' : ''}`,
    `People: ${humans.join(', ') || 'none'}${agents.length ? ` · agents: ${agents.join(', ')}` : ''}`,
    `Claims: ${s.claims.length ? s.claims.map((c) => `${c.id} by ${c.holder}${c.kind === 'drag' ? ' (dragging)' : ''}`).join(', ') : 'none'}`,
    `Changes vs Jira: ${s.pendingChanges}`,
  ];
  if (s.projectMismatch) lines.push(`Warning: ${s.projectMismatch}`);
  return lines.join('\n');
}

function links(t: Ticket): string[] {
  // Blockers first, then what this blocks, then other link types.
  const rank = (l: Ticket['links'][number]): number => (l.type !== BLOCKS ? 2 : l.direction === 'inward' ? 0 : 1);
  return [...t.links].sort((a, b) => rank(a) - rank(b) || a.target.localeCompare(b.target, undefined, { numeric: true })).map((l) => {
    if (l.type === BLOCKS) return l.direction === 'outward' ? `blocks ${l.target}` : `is blocked by ${l.target}`;
    return `${l.type.toLowerCase()}${l.direction === 'inward' ? ' (inward)' : ''} ${l.target}`;
  });
}

export function ticket(t: Ticket, state: RoadmapState): string {
  const epic = t.epicId ? state.epics[t.epicId] : undefined;
  return [
    `${t.id} · ${t.issueType} · ${t.status}`,
    `  ${t.summary}`,
    `  epic: ${epic ? `${epic.id} ${epic.summary}` : 'none'}`,
    `  assignee: ${t.assignee ? `${t.assignee.displayName} (${t.assignee.accountId})` : 'unassigned'}`,
    `  labels: ${v(t.labels)} · points: ${v(t.storyPoints)}`,
    `  links: ${links(t).join('; ') || 'none'}`,
    ...(t.description ? [`  description: ${t.description.replace(/\s+/g, ' ').slice(0, 200)}`] : []),
  ].join('\n');
}

export function epic(e: Epic, tickets: Ticket[]): string {
  return [
    `${e.id} · Epic · ${e.status} · ${v(e.startDate)} → ${v(e.dueDate)}`,
    `  ${e.summary}`,
    ...(e.description ? [`  description: ${e.description.replace(/\s+/g, ' ').slice(0, 200)}`] : []),
    `  tickets (${tickets.length}):`,
    ...tickets.map((t) => `    ${t.id.padEnd(9)} ${t.status.padEnd(12)} ${t.summary}`),
  ].join('\n');
}

export function epicList(state: RoadmapState): string {
  return state.epicOrder.flatMap((id) => {
    const e = state.epics[id];
    return e ? [`${e.id.padEnd(9)} ${`${v(e.startDate)} → ${v(e.dueDate)}`.padEnd(25)} ${e.status.padEnd(12)} ${String(e.ticketOrder.length).padStart(3)} tickets  ${e.summary}`] : [];
  }).join('\n');
}

export function ticketList(tickets: Ticket[]): string {
  if (tickets.length === 0) return 'no tickets match';
  return tickets.map((t) => `${t.id.padEnd(9)} ${t.issueType.padEnd(8)} ${t.status.padEnd(12)} ${(t.epicId ?? '—').padEnd(9)} ${t.summary}`).join('\n');
}

export function change(op: ChangeOp): string {
  switch (op.kind) {
    case 'epic.create': return `create epic "${op.after.summary}"${op.after.dueDate ? ` due ${op.after.dueDate}` : ''}`;
    case 'ticket.create': return `create ${op.after.issueType} under ${op.after.epicId ?? 'no epic'}: "${op.after.summary}"`;
    case 'ticket.move': return `epic ${v(op.before)} → ${v(op.after)} (comment in Jira)`;
    case 'field.update': return `${op.field} ${v(op.before)} → ${v(op.after)}`;
    case 'transition': return `status ${v(op.before)} → ${op.after}`;
    case 'epic.dates': return `dates ${v(op.before.startDate)}..${v(op.before.dueDate)} → ${v(op.after.startDate)}..${v(op.after.dueDate)} (comment in Jira)`;
    case 'link.add': return `+ ${op.linkType.toLowerCase()} ${op.to}`;
    case 'link.remove': return `− ${op.linkType.toLowerCase()} ${op.to}`;
  }
}

export function changeset(cs: Changeset, only?: string): string {
  const ops = only ? cs.ops.filter((o) => o.target === only || ('to' in o && o.to === only)) : cs.ops;
  if (ops.length === 0) return only ? `${only} matches the Jira snapshot` : 'no changes: the roadmap matches the Jira snapshot';
  const head = only ? `${only}: ${ops.length} change(s) vs Jira` : `changeset ${cs.id} · ${ops.length} op(s) · roadmap v${cs.base.version} vs snapshot ${cs.base.pulledAt || '(none)'}`;
  return [head, ...ops.map((o) => `  ${String(o.index).padStart(3)}  ${o.kind.padEnd(13)} ${o.target.padEnd(9)} ${change(o)}${o.by.length ? `  (by ${o.by.join(', ')})` : ''}`)].join('\n');
}

export function watchEvent(m: ServerMessage): string | null {
  switch (m.type) {
    case 'batch.applied': return `v${m.version} ${m.batch.id} ${m.batch.author.name}${m.batch.reason ? ` "${m.batch.reason}"` : ''}: ${m.results.applied.map((a) => opSummary(a.op)).join('; ')}`;
    case 'presence': return `presence: ${m.clients.map((c) => `${c.name}${c.dragging ? ` (moving ${c.dragging})` : ''}`).join(', ')}`;
    case 'claims': return `claims: ${m.claims.map((c) => `${c.id} by ${c.holder}`).join(', ') || 'none'}`;
    case 'freeze': return m.frozen ? `FROZEN by ${m.frozen.by}` : 'unfrozen';
    case 'snapshot.available': return `newer Jira snapshot available (${m.summary.pulledAt ?? ''})`;
    case 'snapshot.reloaded': return `snapshot reloaded (${m.summary.pulledAt ?? ''})`;
    case 'apply.progress': return 'apply log updated';
    case 'error': return `error ${m.code}: ${m.message}`;
    default: return null;
  }
}
