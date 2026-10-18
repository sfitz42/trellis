<script lang="ts">
  import { scopeSummary } from '@trellis/shared';
  import type { Milestone, TimelineConfig } from '@trellis/shared';
  import type { Live } from '../lib/live.svelte.js';
  import { columns, fmtDay, timelineFrom } from '../lib/timeline.js';
  import { ui } from '../lib/ui.svelte.js';
  import type { View } from '../lib/ui.svelte.js';
  import MilestoneEditor from './MilestoneEditor.svelte';

  let { live }: { live: Live } = $props();

  const views: { id: View; label: string }[] = [
    { id: 'timeline', label: 'Timeline' },
    { id: 'changes', label: 'Changes' },
    { id: 'activity', label: 'Activity' },
  ];
  const DEFAULT_COUNT: Record<TimelineConfig['scale'], number> = { milestones: 8, months: 8, quarters: 6, weeks: 16, custom: 8 };

  const timeline = $derived(live.state?.timeline);
  const fromMonth = $derived(timeline?.start.slice(0, 7) ?? '');
  const scope = $derived(live.state ? scopeSummary(live.state) : null);
  /** Which milestone popover is open: an id, "new", or none. */
  let editing = $state<string | null>(null);

  function setScale(scale: TimelineConfig['scale']): void {
    if (!timeline) return;
    live.submit([{ type: 'timeline.set', timeline: timelineFrom(timeline.start, scale, DEFAULT_COUNT[scale], timeline) }]);
  }

  function setFrom(month: string): void {
    if (!timeline || !/^\d{4}-\d{2}$/.test(month)) return;
    const count = Math.max(columns(timeline).length, 1);
    live.submit([{ type: 'timeline.set', timeline: timelineFrom(`${month}-01`, timeline.scale, count, timeline) }]);
  }

  function setShowLater(show: boolean): void {
    if (timeline) live.submit([{ type: 'timeline.set', timeline: { ...timeline, showLater: show } }]);
  }

  const n = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
  const editTarget = (id: string | null): Milestone | null => timeline?.milestones.find((m) => m.id === id) ?? null;
</script>

<div class="bar" role="toolbar" aria-label="Roadmap tools">
  <div class="seg" role="tablist" aria-label="View">
    {#each views as v (v.id)}
      <button role="tab" aria-selected={ui.view === v.id} class:on={ui.view === v.id} onclick={() => (ui.view = v.id)}>{v.label}</button>
    {/each}
  </div>
  <label class="inline">
    <span>Scale</span>
    <select class="input" value={timeline?.scale} onchange={(e) => { setScale(e.currentTarget.value as TimelineConfig['scale']); }}>
      <option value="milestones">Milestones</option>
      <option value="weeks">Weeks</option>
      <option value="months">Months</option>
      <option value="quarters">Quarters</option>
      <option value="custom" disabled={!timeline?.customRanges}>Custom</option>
    </select>
  </label>
  {#each timeline?.milestones ?? [] as m (m.id)}
    <span class="anchor">
      <button class="chip milestone" aria-haspopup="dialog" aria-expanded={editing === m.id} onclick={() => (editing = editing === m.id ? null : m.id)}>
        <span class="diamond" aria-hidden="true">◆</span> {m.label} · {fmtDay(m.date)}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
        <span class="sr-only">edit</span>
      </button>
      {#if editing === m.id}<MilestoneEditor {live} milestone={editTarget(m.id)} onclose={() => (editing = null)} />{/if}
    </span>
  {/each}
  <span class="anchor">
    <button class="chip add" aria-haspopup="dialog" aria-expanded={editing === 'new'} onclick={() => (editing = editing === 'new' ? null : 'new')}>+ Milestone</button>
    {#if editing === 'new'}<MilestoneEditor {live} milestone={null} onclose={() => (editing = null)} />{/if}
  </span>
  <label class="check">
    <input type="checkbox" checked={timeline?.showLater ?? true} onchange={(e) => { setShowLater(e.currentTarget.checked); }} />
    Show {timeline?.laterLabel ?? 'Deliver later'}
  </label>
  <label class="inline">
    <span>From</span>
    <input class="input from" type="month" value={fromMonth} onchange={(e) => { setFrom(e.currentTarget.value); }} />
  </label>
  <label class="filter">
    <span class="sr-only">Filter tickets</span>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
    <input class="input" type="search" placeholder="Filter tickets, people, labels" bind:value={ui.filter} />
  </label>
  <span class="spacer"></span>
  {#if scope}
    <span class="scope" aria-label="Scope summary">
      {#if scope.milestone}
        <span class="chip stat"><strong>By {fmtDay(scope.milestone.date)}</strong> {n(scope.by.epics.length, 'epic')} · {n(scope.by.tickets.length, 'ticket')}</span>
      {/if}
      <span class="chip stat"><strong>Later</strong> {n(scope.later.epics.length, 'epic')} · {n(scope.later.tickets.length, 'ticket')}</span>
    </span>
  {/if}
  <button class="btn" onclick={() => (ui.create = { kind: 'ticket' })}>+ Ticket</button>
  <button class="btn" onclick={() => (ui.create = { kind: 'epic' })}>+ Epic</button>
</div>

<style>
  .bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--surface); }
  .seg button { min-height: var(--touch); padding: 0 14px; border: 0; background: transparent; }
  .seg button.on { background: var(--structure); color: var(--structure-ink); font-weight: 600; }
  .inline { display: inline-flex; align-items: center; gap: 8px; color: var(--ink-muted); font-size: 13px; }
  .inline .input { width: auto; min-width: 110px; color: var(--ink); }
  .from { min-width: 140px; }
  .anchor { position: relative; display: inline-flex; }
  .chip {
    display: inline-flex; align-items: center; gap: 8px; min-height: var(--touch); padding: 0 14px;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); white-space: nowrap;
  }
  .chip.milestone { background: var(--warn-tint); border-color: var(--milestone); color: var(--warn-text); font-weight: 500; }
  .diamond { color: var(--milestone); }
  .chip.add { border-style: dashed; color: var(--ink-muted); background: transparent; }
  .check { display: inline-flex; align-items: center; gap: 8px; min-height: var(--touch); font-size: 14px; }
  .check input { width: 18px; height: 18px; accent-color: var(--structure); }
  .filter { position: relative; display: inline-flex; align-items: center; flex: 1 1 150px; min-width: 150px; max-width: 280px; }
  .filter svg { position: absolute; left: 12px; color: var(--ink-muted); }
  .filter .input { padding-left: 36px; }
  .spacer { flex: 1; }
  .scope { display: inline-flex; gap: 8px; flex-wrap: wrap; }
  .chip.stat { cursor: default; }
  .chip.stat strong { font-weight: 600; }
</style>
