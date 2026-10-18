<script lang="ts">
  import type { Claim, Ticket } from '@trellis/shared';
  import TrayIcon from './TrayIcon.svelte';

  let {
    ticket, category, changed, movedFrom, isNew, agent, lock, selected = false, blocks, dragging = false, offset, compact = false,
    later = false, deferredBy, warning, onopen, onpointerdown, onkeydown,
  }: {
    ticket: Ticket;
    category: string;
    changed: boolean;
    movedFrom?: string | null | undefined;
    isNew: boolean;
    agent: boolean;
    lock: Claim | undefined;
    selected?: boolean;
    blocks: string[];
    dragging?: boolean;
    offset?: { x: number; y: number } | undefined;
    compact?: boolean;
    /** In Deliver later (itself or through its epic). */
    later?: boolean;
    /** Who deferred it, when known. */
    deferredBy?: string | undefined;
    /** A milestone or deferral warning to flag on the card. */
    warning?: { short: string; message: string } | undefined;
    onopen: () => void;
    onpointerdown?: ((e: PointerEvent) => void) | undefined;
    onkeydown?: ((e: KeyboardEvent) => void) | undefined;
  } = $props();

  const label = $derived(
    `${ticket.id} ${ticket.summary}, ${ticket.status}${ticket.storyPoints !== null ? `, ${ticket.storyPoints} points` : ''}${changed ? ', changed from Jira' : ''}${isNew ? ', new' : ''}${agent ? ', added or changed by agent' : ''}${later ? ', in Deliver later' : ''}${warning ? `, warning: ${warning.message}` : ''}${lock ? `, ${lock.holder} is ${lock.kind === 'drag' ? 'moving' : 'editing'} it` : ''}`,
  );
</script>

<button
  type="button"
  class="card"
  class:changed
  class:new={isNew}
  class:agent
  class:locked={!!lock}
  class:selected
  class:dragging
  class:compact
  class:later
  data-card={ticket.id}
  style:transform={offset ? `translate(${offset.x}px, ${offset.y}px)` : undefined}
  aria-label={label}
  aria-keyshortcuts="Enter Alt+ArrowUp Alt+ArrowDown L"
  onclick={onopen}
  {onpointerdown}
  {onkeydown}
>
  <span class="head">
    <span class="key">{ticket.id}</span>
    <span class="tag status {category}">{ticket.status}</span>
    {#if ticket.storyPoints !== null}<span class="pts">{ticket.storyPoints} pts</span>{/if}
  </span>
  <span class="summary">{ticket.summary}</span>
  {#if !compact}
    <span class="foot">
      {#if ticket.assignee}<span class="who" title={ticket.assignee.displayName}>{ticket.assignee.displayName.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()}</span>{/if}
      {#if lock}
        <span class="tag people">{lock.holder} {lock.kind === 'drag' ? 'moving' : 'editing'}</span>
      {:else if agent}
        <span class="tag agent">{isNew ? 'Added by agent' : 'Changed by agent'}</span>
      {:else if movedFrom}
        <span class="tag changed">Moved from {movedFrom}</span>
      {/if}
      {#if ticket.deferred}<span class="tag later"><TrayIcon size={13} />{deferredBy ? `Deferred by ${deferredBy}` : 'Deliver later'}</span>{/if}
      {#if warning}<span class="tag warn" title={warning.message}>⚠ {warning.short}</span>{/if}
      {#each blocks as b (b)}<span class="tag link">→ blocks {b}</span>{/each}
    </span>
  {/if}
</button>

<style>
  .card {
    display: grid;
    gap: 6px;
    text-align: left;
    width: 220px;
    min-height: var(--touch);
    padding: 10px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    touch-action: none;
    position: relative;
  }
  .card.compact { width: auto; }
  .card:hover { border-color: var(--changed-border); }
  .card.changed { box-shadow: inset 3px 0 0 var(--changed); }
  .card.new { border-style: dashed; border-color: var(--changed-border); }
  .card.agent { outline: 2px dotted var(--agent); outline-offset: -1px; border-color: transparent; }
  .card.locked { outline: 2px solid var(--people); outline-offset: -1px; }
  .card.selected { outline: 2px solid var(--people); outline-offset: -1px; background: var(--people-tint); }
  .card.later { box-shadow: inset 3px 0 0 var(--later-ink); }
  .card.dragging { z-index: 20; pointer-events: none; box-shadow: 0 10px 24px rgb(47 49 40 / 0.2); cursor: grabbing; }
  .head { display: flex; align-items: center; gap: 8px; }
  .pts { margin-left: auto; font-size: 12px; color: var(--ink-muted); }
  .summary { line-height: 1.35; }
  .foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .foot:empty { display: none; }
  .who {
    display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%;
    background: var(--line); font-size: 10px; font-weight: 600; color: var(--ink-muted);
  }
  .tag.link { border: 1px solid var(--border); color: var(--ink-muted); }
</style>
