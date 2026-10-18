<script lang="ts">
  import type { ChangeOp } from '@trellis/shared';

  let { ops, limit }: { ops: ChangeOp[]; limit?: number } = $props();

  const LABEL: Record<ChangeOp['kind'], string> = {
    'epic.create': 'Create', 'ticket.create': 'Create', 'ticket.move': 'Move', 'field.update': 'Update',
    transition: 'Transition', 'epic.dates': 'Dates', 'link.add': 'Link', 'link.remove': 'Unlink',
  };
  const TONE: Record<ChangeOp['kind'], string> = {
    'epic.create': 'people', 'ticket.create': 'people', 'ticket.move': 'olive', 'field.update': 'warn',
    transition: 'changed', 'epic.dates': 'changed', 'link.add': 'people', 'link.remove': 'error',
  };

  function change(op: ChangeOp): string {
    const v = (x: unknown): string => {
      if (x === null || x === undefined || x === '') return '—';
      if (Array.isArray(x)) return x.join(', ') || '—';
      if (typeof x === 'object' && 'displayName' in x) return (x as { displayName: string }).displayName;
      return typeof x === 'string' ? x : JSON.stringify(x);
    };
    switch (op.kind) {
      case 'epic.create': return `Epic · ${op.after.summary}${op.after.dueDate ? ` · due ${op.after.dueDate}` : ''}`;
      case 'ticket.create': return `${op.after.issueType} under ${op.after.epicId ?? 'no epic'} · ${op.after.summary}`;
      case 'ticket.move': return `Parent ${v(op.before)} → ${v(op.after)} · as a Jira comment`;
      case 'field.update': return `${op.field} ${v(op.before)} → ${v(op.after)}`;
      case 'transition': return `${v(op.before)} → ${op.after}`;
      case 'epic.dates': return `${v(op.after.startDate)} → ${v(op.after.dueDate)} (was ${v(op.before.startDate)} → ${v(op.before.dueDate)}) · as a Jira comment`;
      case 'link.add': return `${op.linkType.toLowerCase()} ${op.to}`;
      case 'link.remove': return `no longer ${op.linkType.toLowerCase()} ${op.to}`;
    }
  }

  const shown = $derived(limit ? ops.slice(0, limit) : ops);
  const rest = $derived(ops.length - shown.length);
</script>

{#if ops.length === 0}
  <p class="empty">No changes: the roadmap matches the Jira snapshot.</p>
{:else}
  <table>
    <thead><tr><th scope="col">Operation</th><th scope="col">Target</th><th scope="col">Change</th><th scope="col">By</th></tr></thead>
    <tbody>
      {#each shown as op, i (i)}
        <tr>
          <td><span class="tag op {TONE[op.kind]}">{LABEL[op.kind]}</span></td>
          <td class="key">{op.target}</td>
          <td>{change(op)}</td>
          <td class="by">{op.by.join(', ') || '—'}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if rest > 0}<p class="more">+ {rest} more</p>{/if}
{/if}

<style>
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-muted); font-weight: 500; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .by { color: var(--ink-muted); white-space: nowrap; }
  .op.people { background: var(--people-tint); color: var(--people-text); }
  .op.olive { background: #e2e2d6; color: var(--structure); }
  .op.warn { background: var(--warn-tint); color: var(--warn-text); }
  .op.changed { background: var(--changed-tint); color: var(--changed-text); }
  .op.error { background: var(--error-tint); color: var(--error-text); }
  .empty, .more { color: var(--ink-muted); margin: 12px 14px; font-size: 13px; }
</style>
