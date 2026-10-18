<script lang="ts">
  import type { Claim, Epic } from '@trellis/shared';
  import { barGeometry, dragDates, fmtRange } from '../lib/timeline.js';
  import { todayIso } from '../lib/view.js';
  import type { Column, DragMode, Scale, Span } from '../lib/timeline.js';

  let {
    epic, cols, colW, scale, fill, count, laterCount = 0, changed, isNew, agent, lock, ondates, ondefer, ondrag, ontoggle,
  }: {
    epic: Epic;
    cols: Column[];
    colW: number;
    scale: Scale;
    fill: number;
    /** Scheduled tickets. */
    count: number;
    /** Tickets of this epic deferred on their own. */
    laterCount?: number;
    changed: boolean;
    isNew: boolean;
    agent: boolean;
    lock: Claim | undefined;
    ondates: (span: Span) => void;
    /** Move the epic to Deliver later (dropped on the tray, or the L key). */
    ondefer: () => void;
    ondrag: (dragging: boolean) => void;
    ontoggle: () => void;
  } = $props();

  let drag = $state<{ mode: DragMode; x0: number; units: number; overTray: boolean } | null>(null);
  /** Is the pointer over the Deliver later tray? The bar itself may be under it, so look through. */
  const overTray = (e: PointerEvent): boolean => document.elementsFromPoint(e.clientX, e.clientY).some((el) => el.closest('[data-tray]'));
  const counts = $derived(laterCount > 0 ? `${count} + ${laterCount} later` : `${count} tickets`);
  const today = todayIso();

  const span = $derived(drag ? dragDates(epic, drag.mode, drag.units, scale, today) : { startDate: epic.startDate, dueDate: epic.dueDate });
  const geo = $derived(barGeometry(span, cols, scale, today));
  /** Bars stop at the last column (the milestone line, before the tray) and show they run on. */
  const px = $derived(geo ? { left: geo.left * colW, width: Math.max(Math.min(geo.width * colW, cols.length * colW - geo.left * colW), 24) } : null);
  const runsOn = $derived(geo !== null && px !== null && geo.width * colW > px.width + 1);
  /** Too narrow for its name: show the name just outside the bar instead. */
  const narrow = $derived(px !== null && px.width < 150);

  function down(e: PointerEvent, mode: DragMode): void {
    if (lock || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { mode, x0: e.clientX, units: 0, overTray: false };
    ondrag(true);
  }
  function move(e: PointerEvent): void {
    if (!drag) return;
    drag.units = Math.round((e.clientX - drag.x0) / colW);
    drag.overTray = drag.mode === 'move' && overTray(e);
  }
  function up(e: PointerEvent): void {
    if (!drag) return;
    const next = dragDates(epic, drag.mode, drag.units, scale, today);
    const moved = drag.units !== 0;
    const intoTray = drag.mode === 'move' && e.type === 'pointerup' && overTray(e);
    drag = null;
    ondrag(false);
    if (intoTray) ondefer();
    else if (moved) ondates(next);
  }

  function key(e: KeyboardEvent): void {
    if (lock) return;
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (dir !== 0) {
      e.preventDefault();
      ondates(dragDates(epic, e.shiftKey ? 'end' : e.altKey ? 'start' : 'move', dir, scale, today));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      ontoggle();
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      ondefer();
    }
  }

  const label = $derived(
    `${epic.summary}, ${fmtRange(span)}${runsOn ? ', runs past the end of the timeline' : ''}, ${counts}${changed ? ', changed from Jira' : ''}${isNew ? ', new' : ''}${agent ? ', changed by agent' : ''}${lock ? `, ${lock.holder} is ${lock.kind === 'drag' ? 'moving' : 'editing'} it` : ''}. Arrow keys move by one unit; Shift+arrows change the end, Alt+arrows the start; Enter shows tickets; L moves it to Deliver later.`,
  );
</script>

{#if geo && px}
  <div
    class="bar fill-{fill}"
    class:changed
    class:new={isNew}
    class:agent
    class:locked={!!lock}
    class:dragging={!!drag}
    class:open-start={!geo.hasStart}
    class:narrow
    class:runs-on={runsOn}
    style:left="{px.left}px"
    style:width="{px.width}px"
    role="slider"
    tabindex="0"
    aria-label={label}
    aria-valuetext={fmtRange(span)}
    aria-valuenow={geo.left}
    aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Alt+ArrowLeft Alt+ArrowRight Enter L"
    onpointerdown={(e) => { down(e, 'move'); }}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onkeydown={key}
    ondblclick={ontoggle}
  >
    <span class="handle start" aria-hidden="true" onpointerdown={(e) => { down(e, 'start'); }}></span>
    <span class="label">
      <span class="name">{epic.summary}</span>
      {#if lock}
        <span class="tag people">{lock.holder} {lock.kind === 'drag' ? 'moving' : 'editing'}</span>
      {:else if agent}
        <span class="tag agent">agent</span>
      {:else if isNew}
        <span class="tag changed">new</span>
      {/if}
    </span>
    {#if drag?.overTray}
      <span class="when">→ Deliver later</span>
    {:else if drag}
      <span class="when">{fmtRange(span)}</span>
    {:else if !narrow}
      <span class="count">{counts}</span>
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
  .bar.runs-on { border-right: 2px dashed currentColor; border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .label { display: flex; align-items: center; gap: 8px; min-width: 0; }
  /* Too narrow for the name: the label sits just outside the bar, in normal text colour. */
  .bar.narrow { overflow: visible; }
  .bar.narrow .label { position: absolute; left: calc(100% + 10px); color: var(--ink); white-space: nowrap; }
  .bar.narrow .name { overflow: visible; }
  .count, .when { margin-left: auto; font-size: 12px; white-space: nowrap; opacity: 0.85; }
  .handle { position: absolute; top: 0; bottom: 0; width: 10px; cursor: ew-resize; }
  .handle.start { left: 0; }
  .handle.end { right: 0; }
</style>
