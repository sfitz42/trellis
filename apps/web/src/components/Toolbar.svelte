<script lang="ts">
  import type { TimelineConfig } from '@trellis/shared';
  import type { Live } from '../lib/live.svelte.js';
  import { columns, timelineFrom } from '../lib/timeline.js';
  import { ui } from '../lib/ui.svelte.js';
  import type { View } from '../lib/ui.svelte.js';

  let { live }: { live: Live } = $props();

  const views: { id: View; label: string }[] = [
    { id: 'timeline', label: 'Timeline' },
    { id: 'changes', label: 'Changes' },
    { id: 'activity', label: 'Activity' },
  ];
  const DEFAULT_COUNT: Record<TimelineConfig['scale'], number> = { months: 8, quarters: 6, weeks: 16, custom: 8 };

  const timeline = $derived(live.state?.timeline);
  const fromMonth = $derived(timeline?.start.slice(0, 7) ?? '');

  function setScale(scale: TimelineConfig['scale']): void {
    if (!timeline) return;
    live.submit([{ type: 'timeline.set', timeline: timelineFrom(timeline.start, scale, DEFAULT_COUNT[scale], timeline) }]);
  }

  function setFrom(month: string): void {
    if (!timeline || !/^\d{4}-\d{2}$/.test(month)) return;
    const count = Math.max(columns(timeline).length, 1);
    live.submit([{ type: 'timeline.set', timeline: timelineFrom(`${month}-01`, timeline.scale, count, timeline) }]);
  }
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
      <option value="weeks">Weeks</option>
      <option value="months">Months</option>
      <option value="quarters">Quarters</option>
      <option value="custom" disabled={!timeline?.customRanges}>Custom</option>
    </select>
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
  .filter { position: relative; display: inline-flex; align-items: center; flex: 1 1 150px; min-width: 150px; max-width: 280px; }
  .filter svg { position: absolute; left: 12px; color: var(--ink-muted); }
  .filter .input { padding-left: 36px; }
  .spacer { flex: 1; }
</style>
