<script lang="ts">
  import type { IssueId, Ticket } from '@trellis/shared';
  import { changesByItem, dependenciesOf, isNew } from '../lib/items.js';
  import type { Live } from '../lib/live.svelte.js';
  import { barGeometry, columnIndex, columns } from '../lib/timeline.js';
  import type { Span } from '../lib/timeline.js';
  import { ui } from '../lib/ui.svelte.js';
  import { epicFill, matches, statusCategory, todayIso } from '../lib/view.js';
  import EpicBar from './EpicBar.svelte';
  import TicketCard from './TicketCard.svelte';

  let { live }: { live: Live } = $props();

  const rm = $derived(live.roadmap);
  const cols = $derived(columns(rm.timeline));
  let width = $state(1000);
  const colW = $derived(Math.max(96, (width - 250) / Math.max(cols.length, 1)));
  const nowIdx = $derived(columnIndex(todayIso(), cols));
  const changes = $derived(changesByItem(live.changeset));
  const NO_EPIC = '__none__';

  const rows = $derived.by(() => {
    const out = rm.epicOrder.flatMap((id) => (rm.epics[id] ? [rm.epics[id]] : [])).map((epic) => {
      const tickets = epic.ticketOrder.flatMap((t) => (rm.tickets[t] ? [rm.tickets[t]] : []));
      return { id: epic.id, epic, tickets, shown: tickets.filter((t) => matches(t, ui.filter)) };
    });
    return out;
  });
  const loose = $derived(Object.values(rm.tickets).filter((t) => t.epicId === null));
  const filtering = $derived(ui.filter.trim() !== '');

  // --- card drag between epics (pointer events; drop target found under the pointer)
  let drag = $state<{ id: IssueId; x0: number; y0: number; dx: number; dy: number; started: boolean } | null>(null);

  function cardDown(e: PointerEvent, t: Ticket): void {
    if (e.button !== 0 || live.lockedBy(t.id)) return;
    drag = { id: t.id, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, started: false };
    window.addEventListener('pointermove', cardMove);
    window.addEventListener('pointerup', cardUp, { once: true });
  }
  function cardMove(e: PointerEvent): void {
    if (!drag) return;
    drag.dx = e.clientX - drag.x0;
    drag.dy = e.clientY - drag.y0;
    if (!drag.started && Math.hypot(drag.dx, drag.dy) > 5) {
      drag.started = true;
      live.setDragging(drag.id);
    }
  }
  function cardUp(e: PointerEvent): void {
    window.removeEventListener('pointermove', cardMove);
    const d = drag;
    drag = null;
    if (!d?.started) return;
    live.setDragging(null);
    suppressClick = true;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const row = el?.closest<HTMLElement>('[data-epic-row]');
    if (!row) return;
    const epicId = row.dataset['epicRow'] === NO_EPIC ? null : (row.dataset['epicRow'] ?? null);
    const before = el?.closest<HTMLElement>('[data-card]')?.dataset['card'];
    const order = epicId ? (rm.epics[epicId]?.ticketOrder ?? []).filter((x) => x !== d.id) : [];
    const index = before ? Math.max(0, order.indexOf(before)) : order.length;
    const t = rm.tickets[d.id];
    if (!t || (t.epicId === epicId && (rm.epics[epicId ?? '']?.ticketOrder.indexOf(d.id) ?? -1) === index)) return;
    live.submit([{ type: 'ticket.move', id: d.id, epicId, ...(epicId ? { index } : {}) }]);
    if (epicId && !ui.expanded.includes(epicId)) ui.toggle(epicId);
  }
  let suppressClick = false;
  function openTicket(t: Ticket): void {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    ui.openTicket(t.id, t.epicId);
  }

  function cardKey(e: KeyboardEvent, t: Ticket): void {
    if (!e.altKey || !t.epicId || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const order = rm.epics[t.epicId]?.ticketOrder ?? [];
    const i = order.indexOf(t.id) + (e.key === 'ArrowUp' ? -1 : 1);
    if (i >= 0 && i < order.length) live.submit([{ type: 'ticket.move', id: t.id, epicId: t.epicId, index: i }]);
  }

  function movedFrom(t: Ticket): string | null {
    const mv = changes.get(t.id)?.find((c) => c.kind === 'ticket.move' && c.target === t.id);
    return mv && mv.kind === 'ticket.move' ? mv.before : null;
  }
</script>

<div class="frame panel" bind:clientWidth={width}>
  <div class="grid" style:--cols={cols.length} style:--colw="{colW}px">
    <div class="head label-col">Epic</div>
    {#each cols as c, i (c.start)}
      <div class="head col" class:now={i === nowIdx}>
        <strong>{c.label}</strong>
        <span>{c.sublabel}{i === nowIdx ? ' · now' : ''}</span>
      </div>
    {/each}

    {#each rows as r (r.id)}
      {@const open = ui.expanded.includes(r.id) || (filtering && r.shown.length > 0)}
      {@const geo = barGeometry(r.epic, cols, rm.timeline.scale)}
      {#if !filtering || r.shown.length > 0 || r.epic.summary.toLowerCase().includes(ui.filter.toLowerCase())}
        <div class="label-col row-label" class:open data-epic-row={r.id}>
          <button class="toggle" aria-expanded={open} aria-label="{open ? 'Hide' : 'Show'} tickets in {r.epic.summary}" onclick={() => { ui.toggle(r.id); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} /></svg>
          </button>
          <span class="who">
            <span class="key">{r.id}</span>
            <span class="title">{r.epic.summary}</span>
          </span>
          {#if changes.has(r.id)}<span class="dot" title="Differs from Jira" aria-label="differs from Jira"></span>{/if}
        </div>
        <div class="track" class:open data-epic-row={r.id} style:grid-column="2 / span {cols.length}">
          {#if nowIdx >= 0}<div class="now-col" style:left="{nowIdx * colW}px" style:width="{colW}px"></div>{/if}
          {#if geo}
            <EpicBar
              epic={r.epic}
              {cols}
              {colW}
              scale={rm.timeline.scale}
              fill={epicFill(rm, r.id)}
              count={r.tickets.length}
              changed={changes.has(r.id)}
              isNew={isNew(r.id)}
              agent={live.isAgentTouched(r.id)}
              lock={live.lockedBy(r.id)}
              ondates={(s: Span) => { live.submit([{ type: 'epic.setDates', id: r.id, startDate: s.startDate, dueDate: s.dueDate }]); }}
              ondrag={(d: boolean) => { live.setDragging(d ? r.id : null); }}
              ontoggle={() => { ui.toggle(r.id); }}
            />
          {:else}
            <span class="undated">No dates yet · open the epic to set them</span>
          {/if}
          {#if open}
            <div class="cards" style:margin-left="{Math.max(0, (geo?.left ?? 0) * colW)}px">
              {#each r.shown as t (t.id)}
                <TicketCard
                  ticket={t}
                  category={statusCategory(live.snapshot, t.issueType, t.status)}
                  changed={changes.has(t.id)}
                  movedFrom={movedFrom(t)}
                  isNew={isNew(t.id)}
                  agent={live.isAgentTouched(t.id)}
                  lock={live.lockedBy(t.id)}
                  blocks={dependenciesOf(rm, t.id).blocks}
                  dragging={drag?.started === true && drag.id === t.id}
                  offset={drag?.started && drag.id === t.id ? { x: drag.dx, y: drag.dy } : undefined}
                  onopen={() => { openTicket(t); }}
                  onpointerdown={(e: PointerEvent) => { cardDown(e, t); }}
                  onkeydown={(e: KeyboardEvent) => { cardKey(e, t); }}
                />
              {/each}
              <button class="add" onclick={() => (ui.create = { kind: 'ticket', epicId: r.id })}>+ Add ticket</button>
            </div>
          {/if}
        </div>
      {/if}
    {/each}

    {#if loose.length > 0}
      {@const open = ui.expanded.includes(NO_EPIC) || filtering}
      <div class="label-col row-label" data-epic-row={NO_EPIC}>
        <button class="toggle" aria-expanded={open} aria-label="{open ? 'Hide' : 'Show'} tickets without an epic" onclick={() => { ui.toggle(NO_EPIC); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} /></svg>
        </button>
        <span class="who"><span class="key">—</span><span class="title">No epic · {loose.length}</span></span>
      </div>
      <div class="track" data-epic-row={NO_EPIC} style:grid-column="2 / span {cols.length}">
        {#if open}
          <div class="cards">
            {#each loose.filter((t) => matches(t, ui.filter)) as t (t.id)}
              <TicketCard
                ticket={t}
                category={statusCategory(live.snapshot, t.issueType, t.status)}
                changed={changes.has(t.id)}
                isNew={isNew(t.id)}
                agent={live.isAgentTouched(t.id)}
                lock={live.lockedBy(t.id)}
                blocks={dependenciesOf(rm, t.id).blocks}
                dragging={drag?.started === true && drag.id === t.id}
                offset={drag?.started && drag.id === t.id ? { x: drag.dx, y: drag.dy } : undefined}
                onopen={() => { openTicket(t); }}
                onpointerdown={(e: PointerEvent) => { cardDown(e, t); }}
              />
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .frame { overflow: auto; max-height: calc(100vh - 150px); }
  .grid {
    display: grid;
    grid-template-columns: var(--label-col) repeat(var(--cols), var(--colw));
    min-width: max-content;
  }
  .head {
    position: sticky; top: 0; z-index: 6;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 10px 12px;
    min-height: 52px;
  }
  .head.label-col { font-family: var(--mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-muted); left: 0; z-index: 7; display: flex; align-items: center; padding-left: 16px; }
  .col { display: grid; align-content: center; border-left: 1px solid var(--line); }
  .col strong { font-weight: 600; font-size: 13px; }
  .col span { font-size: 12px; color: var(--ink-muted); }
  .col.now { background: var(--warn-tint); box-shadow: inset 0 -3px 0 var(--warn); }
  .label-col { position: sticky; left: 0; z-index: 4; background: var(--surface); }
  .row-label {
    display: flex; align-items: flex-start; gap: 6px; padding: 10px 12px 10px 8px;
    border-bottom: 1px solid var(--line); border-right: 1px solid var(--line);
    min-height: 57px;
  }
  .toggle { border: 0; background: none; min-width: 32px; min-height: 36px; display: grid; place-items: center; color: var(--ink-muted); border-radius: 4px; }
  .who { display: grid; flex: 1; min-width: 0; }
  .title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--changed); margin-top: 18px; flex: none; }
  .track { position: relative; border-bottom: 1px solid var(--line); min-height: 57px; }
  .now-col { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--warn-tint) 55%, transparent); pointer-events: none; }
  .cards {
    position: relative;
    display: grid;
    grid-template-columns: repeat(2, 220px);
    gap: 8px;
    padding: 56px 8px 12px 4px;
    width: max-content;
    z-index: 3;
  }
  .undated { position: absolute; top: 18px; left: 12px; font-size: 12.5px; color: var(--ink-muted); font-style: italic; }
  .add {
    width: 96px; min-height: var(--touch); border: 1px dashed var(--border); border-radius: var(--radius);
    background: transparent; color: var(--ink-muted);
  }
</style>
