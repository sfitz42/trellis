<script lang="ts">
  // Popover for one milestone's label and date (toolbar chip or "+ Milestone"). Milestones are part
  // of the timeline config, so every save is one timeline.set carrying the whole list.
  import { untrack } from 'svelte';
  import type { Milestone } from '@trellis/shared';
  import type { Live } from '../lib/live.svelte.js';
  import { addDays } from '../lib/timeline.js';
  import { todayIso } from '../lib/view.js';

  let { live, milestone, onclose }: { live: Live; milestone: Milestone | null; onclose: () => void } = $props();

  const tl = $derived(live.roadmap.timeline);
  // Starting values only: others' edits while this is open must not reset what's being typed.
  // A new milestone defaults to four weeks after the last one (or today).
  let label = $state(untrack(() => milestone?.label ?? 'Milestone'));
  let date = $state(untrack(() => milestone?.date ?? addDays(tl.milestones.at(-1)?.date ?? todayIso(), 28)));

  function save(list: Milestone[]): void {
    live.submit([{ type: 'timeline.set', timeline: { ...tl, milestones: list } }]);
    onclose();
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const name = label.trim();
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (milestone) {
      save(tl.milestones.map((m) => (m.id === milestone.id ? { ...m, label: name, date } : m)));
    } else {
      let n = 1;
      while (tl.milestones.some((m) => m.id === `m${n}`)) n++;
      save([...tl.milestones, { id: `m${n}`, label: name, date }]);
    }
  }

  function remove(): void {
    if (milestone && confirm(`Remove the milestone "${milestone.label}"?`)) save(tl.milestones.filter((m) => m.id !== milestone.id));
  }

  function autofocus(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }
</script>

<div class="pop panel" role="dialog" aria-label={milestone ? `Edit milestone ${milestone.label}` : 'Add a milestone'}>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form onsubmit={submit} onkeydown={(e) => { if (e.key === 'Escape') onclose(); }}>
  <label class="field">
    <span>Label</span>
    <input class="input" bind:value={label} required use:autofocus />
  </label>
  <label class="field">
    <span>Date · work lands on or before</span>
    <input class="input" type="date" bind:value={date} required />
  </label>
  <p class="note">Milestones live in Trellis only; they are not written to Jira.</p>
  <div class="actions">
    <button class="btn small primary" type="submit">{milestone ? 'Save' : 'Add milestone'}</button>
    <button class="btn small" type="button" onclick={onclose}>Cancel</button>
    {#if milestone}<button class="btn small remove" type="button" onclick={remove}>Remove</button>{/if}
  </div>
</form>
</div>

<style>
  .pop {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 30;
    width: 280px; padding: 14px;
    box-shadow: 0 10px 24px rgb(47 49 40 / 0.18);
  }
  form { display: grid; gap: 10px; }
  .note { margin: 0; font-size: 12px; color: var(--ink-muted); }
  .actions { display: flex; gap: 6px; }
  .remove { margin-left: auto; color: var(--error-text); }
</style>
