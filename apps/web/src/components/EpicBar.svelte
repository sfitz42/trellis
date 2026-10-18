<script lang="ts">
  import type { Claim, Epic } from '@trellis/shared';
  import { barGeometry, dragDates, fmtRange } from '../lib/timeline.js';
  import type { Column, DragMode, Scale, Span } from '../lib/timeline.js';

  let {
    epic, cols, colW, scale, fill, count, changed, isNew, agent, lock, ondates, ondrag, ontoggle,
  }: {
    epic: Epic;
    cols: Column[];
    colW: number;
    scale: Scale;
    fill: number;
    count: number;
    changed: boolean;
    isNew: boolean;
    agent: boolean;
    lock: Claim | undefined;
    ondates: (span: Span) => void;
    ondrag: (dragging: boolean) => void;
    ontoggle: () => void;
  } = $props();

  let drag = $state<{ mode: DragMode; x0: number; units: number } | null>(null);

  const span = $derived(drag ? dragDates(epic, drag.mode, drag.units, scale) : { startDate: epic.startDate, dueDate: epic.dueDate });
  const geo = $derived(barGeometry(span, cols, scale));

  function down(e: PointerEvent, mode: DragMode): void {
    if (lock || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { mode, x0: e.clientX, units: 0 };
    ondrag(true);
  }
  function move(e: PointerEvent): void {
    if (drag) drag.units = Math.round((e.clientX - drag.x0) / colW);
  }
  function up(): void {
    if (!drag) return;
    const next = dragDates(epic, drag.mode, drag.units, scale);
    const moved = drag.units !== 0;
    drag = null;
    ondrag(false);
    if (moved) ondates(next);
  }

  function key(e: KeyboardEvent): void {
    if (lock) return;
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (dir !== 0) {
      e.preventDefault();
      ondates(dragDates(epic, e.shiftKey ? 'end' : e.altKey ? 'start' : 'move', dir, scale));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      ontoggle();
    }
  }

  const label = $derived(
    `${epic.summary}, ${fmtRange(span)}, ${count} tickets${changed ? ', changed from Jira' : ''}${isNew ? ', new' : ''}${agent ? ', changed by agent' : ''}${lock ? `, ${lock.holder} is ${lock.kind === 'drag' ? 'moving' : 'editing'} it` : ''}. Arrow keys move by one unit; Shift+arrows change the end, Alt+arrows the start; Enter shows tickets.`,
  );
</script>

{#if geo}
  <div
    class="bar fill-{fill}"
    class:changed
    class:new={isNew}
    class:agent
    class:locked={!!lock}
    class:dragging={!!drag}
    class:open-start={!geo.hasStart}
    style:left="{geo.left * colW}px"
    style:width="{geo.width * colW}px"
    role="slider"
    tabindex="0"
    aria-label={label}
    aria-valuetext={fmtRange(span)}
    aria-valuenow={geo.left}
    onpointerdown={(e) => { down(e, 'move'); }}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onkeydown={key}
    ondblclick={ontoggle}
  >
    <span class="handle start" aria-hidden="true" onpointerdown={(e) => { down(e, 'start'); }}></span>
    <span class="name">{epic.summary}</span>
    {#if lock}
      <span class="tag people">{lock.holder} {lock.kind === 'drag' ? 'moving' : 'editing'}</span>
    {:else if agent}
      <span class="tag agent">agent</span>
    {:else if isNew}
      <span class="tag changed">new</span>
    {/if}
    {#if drag}
      <span class="when">{fmtRange(span)}</span>
    {:else}
      <span class="count">{count} tickets</span>
    {/if}
    <span class="handle end" aria-hidden="true" onpointerdown={(e) => { down(e, 'end'); }}></span>
  </div>
{/if}

<style>
  .bar {
    position: absolute;
    top: 10px;
    height: 36px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    cursor: grab;
    touch-action: none;
    user-select: none;
    min-width: 24px;
    overflow: hidden;
    z-index: 2;
  }
  .bar.dragging { cursor: grabbing; box-shadow: 0 6px 16px rgb(47 49 40 / 0.18); z-index: 5; }
  .fill-0 { background: var(--epic-1); color: var(--epic-1-ink); }
  .fill-1 { background: var(--epic-2); color: var(--epic-2-ink); }
  .fill-2 { background: var(--epic-3); color: var(--epic-3-ink); }
  .fill-3 { background: var(--epic-4); color: var(--epic-4-ink); }
  .fill-4 { background: var(--epic-5); color: var(--epic-5-ink); }
  .bar.changed { box-shadow: inset 0 0 0 1px var(--surface); border: 2px solid var(--changed); }
  .bar.new { border: 1px dashed var(--changed-border); }
  .bar.agent { outline: 2px dotted var(--agent); outline-offset: 2px; }
  .bar.locked { outline: 2px solid var(--people); outline-offset: 2px; cursor: not-allowed; }
  .bar.open-start { border-left: 2px dashed currentColor; }
  .name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .count, .when { margin-left: auto; font-size: 12px; white-space: nowrap; opacity: 0.85; }
  .handle { position: absolute; top: 0; bottom: 0; width: 10px; cursor: ew-resize; }
  .handle.start { left: 0; }
  .handle.end { right: 0; }
</style>
