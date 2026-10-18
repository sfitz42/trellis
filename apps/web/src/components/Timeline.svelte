<script lang="ts">
  import type { Epic, IssueId, Op, Ticket } from '@trellis/shared';
  import { changesByItem, dependenciesOf, isNew, scheduleEpicOps, warningsByItem, warningShort } from '../lib/items.js';
  import type { Live } from '../lib/live.svelte.js';
  import { addDays, barGeometry, columnIndex, columns, fmtDay, position } from '../lib/timeline.js';
  import type { Span } from '../lib/timeline.js';
  import { ui } from '../lib/ui.svelte.js';
  import { epicFill, matches, statusCategory, todayIso } from '../lib/view.js';
  import EpicBar from './EpicBar.svelte';
  import TicketCard from './TicketCard.svelte';
  import TrayIcon from './TrayIcon.svelte';

  let { live }: { live: Live } = $props();

  const rm = $derived(live.roadmap);
  const tl = $derived(rm.timeline);
  const cols = $derived(columns(tl));
  const today = todayIso();
  const msScale = $derived(tl.scale === 'milestones');
  const showTray = $derived(tl.showLater);
  let width = $state(1000);
  // Whole pixels: fractional widths add up to more than the frame and force a scrollbar.
  const TRAY = 300;
  const GUTTER = 20;
  const colW = $derived(Math.max(96, Math.floor((width - 250 - (showTray ? TRAY + GUTTER : 0)) / Math.max(cols.length, 1))));
  const nowIdx = $derived(columnIndex(today, cols));
  const changes = $derived(changesByItem(live.changeset));
  const warnings = $derived(warningsByItem(rm, today));
  const NO_EPIC = '__none__';

  /** Milestone lines: x in px from the left of the columns, and the header column that carries the tag. */
  const marks = $derived(
    tl.milestones
      .map((m) => ({ m, x: Math.round(position(m.date, cols) * colW), col: columnIndex(addDays(m.date, -1), cols) }))
      .filter((k) => k.x >= 0 && k.x <= cols.length * colW),
  );
  const lastMilestone = $derived(tl.milestones.at(-1));

  const later = (t: Ticket): boolean => t.deferred || (t.epicId !== null && rm.epics[t.epicId]?.deferred === true);
  const deferredBy = (id: IssueId): string | undefined => rm.meta[`${id}.deferred`]?.author;
  const warningFor = (id: IssueId): { short: string; message: string } | undefined => {
    const w = warnings.get(id)?.[0];
    return w ? { short: warningShort(w), message: w.message } : undefined;
  };

  const rows = $derived.by(() =>
    rm.epicOrder
      .flatMap((id) => (rm.epics[id] ? [rm.epics[id]] : []))
      .filter((epic) => showTray || !epic.deferred)
      .map((epic) => {
        const tickets = epic.ticketOrder.flatMap((t) => (rm.tickets[t] ? [rm.tickets[t]] : []));
        const shown = tickets.filter((t) => matches(t, ui.filter));
        return {
          id: epic.id,
          epic,
          tickets,
          shown,
          // Deferred tickets (or all of a deferred epic's) sit in the tray; hidden with it.
          scheduled: shown.filter((t) => !later(t)),
          inTray: showTray ? shown.filter((t) => later(t)) : [],
          laterCount: epic.deferred ? 0 : tickets.filter((t) => t.deferred).length,
        };
      }),
  );
  const loose = $derived(Object.values(rm.tickets).filter((t) => t.epicId === null && (showTray || !t.deferred)));
  const filtering = $derived(ui.filter.trim() !== '');

  // --- drag: cards between epics and into/out of the tray; deferred epics out of the tray
  let drag = $state<{ kind: 'card' | 'epic'; id: IssueId; x0: number; y0: number; dx: number; dy: number; started: boolean } | null>(null);

  function startDrag(e: PointerEvent, kind: 'card' | 'epic', id: IssueId): void {
    if (e.button !== 0 || live.lockedBy(id)) return;
    drag = { kind, id, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, started: false };
    window.addEventListener('pointermove', dragMove);
    window.addEventListener('pointerup', dragUp, { once: true });
  }
  function dragMove(e: PointerEvent): void {
    if (!drag) return;
    drag.dx = e.clientX - drag.x0;
    drag.dy = e.clientY - drag.y0;
    if (!drag.started && Math.hypot(drag.dx, drag.dy) > 5) {
      drag.started = true;
      live.setDragging(drag.id);
    }
  }
  function dragUp(e: PointerEvent): void {
    window.removeEventListener('pointermove', dragMove);
    const d = drag;
    drag = null;
    if (!d?.started) return;
    live.setDragging(null);
    suppressClick = true;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (d.kind === 'epic') dropEpic(d.id, el, e.clientX);
    else dropCard(d.id, el);
  }

  const rowEpic = (value: string | undefined): IssueId | null => (value === undefined || value === NO_EPIC ? null : value);

  /** A deferred epic dropped on a row's timeline: schedule it from the column under the pointer. */
  function dropEpic(id: IssueId, el: Element | null, x: number): void {
    const track = el?.closest<HTMLElement>('.track');
    if (!track || cols.length === 0) return;
    const i = Math.min(cols.length - 1, Math.max(0, Math.floor((x - track.getBoundingClientRect().left) / colW)));
    live.submit(scheduleEpicOps(rm, id, tl.scale, { at: cols[i]?.start ?? today, today, oplog: live.oplog }), { atomic: true });
  }

  function dropCard(id: IssueId, el: Element | null): void {
    const t = rm.tickets[id];
    if (!t) return;
    const tray = el?.closest<HTMLElement>('[data-tray]');
    const row = el?.closest<HTMLElement>('[data-epic-row]');
    const ops: Op[] = [];
    if (tray) {
      // Into the tray: on its own epic's row it just defers; on another row it moves there too.
      const epicId = rowEpic(tray.dataset['tray']);
      if (t.epicId !== epicId) ops.push({ type: 'ticket.move', id, epicId });
      // Moving into a deferred epic is enough: the ticket is later through it.
      if (!t.deferred && !(epicId && rm.epics[epicId]?.deferred)) ops.push({ type: 'ticket.defer', id, deferred: true });
    } else if (row) {
      const epicId = rowEpic(row.dataset['epicRow']);
      const before = el?.closest<HTMLElement>('[data-card]')?.dataset['card'];
      const order = epicId ? (rm.epics[epicId]?.ticketOrder ?? []).filter((x) => x !== id) : [];
      const index = before ? Math.max(0, order.indexOf(before)) : order.length;
      const sameSpot = t.epicId === epicId && (rm.epics[epicId ?? '']?.ticketOrder.indexOf(id) ?? -1) === index;
      if (!sameSpot) ops.push({ type: 'ticket.move', id, epicId, ...(epicId ? { index } : {}) });
      // Out of the tray onto the timeline: scheduled again.
      if (t.deferred) ops.push({ type: 'ticket.defer', id, deferred: false });
      if (epicId && !ui.expanded.includes(epicId)) ui.toggle(epicId);
    }
    if (ops.length) live.submit(ops, { atomic: true });
  }

  let suppressClick = false;
  function openTicket(t: Ticket): void {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    ui.openTicket(t.id, t.epicId);
  }

  /** Move to Deliver later, or schedule again (keyboard and the tray's Schedule button). */
  function toggleTicketLater(t: Ticket): void {
    if (!t.deferred && t.epicId && rm.epics[t.epicId]?.deferred) {
      live.notify('info', `${t.id} is in Deliver later with its epic; schedule the epic instead`);
      return;
    }
    live.submit([{ type: 'ticket.defer', id: t.id, deferred: !t.deferred }]);
  }
  function scheduleEpic(e: Epic): void {
    live.submit(scheduleEpicOps(rm, e.id, tl.scale, { today, oplog: live.oplog }), { atomic: true });
  }

  function cardKey(e: KeyboardEvent, t: Ticket): void {
    if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      toggleTicketLater(t);
      return;
    }
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

{#snippet card(t: Ticket)}
  <TicketCard
    ticket={t}
    category={statusCategory(live.snapshot, t.issueType, t.status)}
    changed={changes.has(t.id)}
    movedFrom={movedFrom(t)}
    isNew={isNew(t.id)}
    agent={live.isAgentTouched(t.id)}
    lock={live.lockedBy(t.id)}
    blocks={dependenciesOf(rm, t.id).blocks}
    later={later(t)}
    deferredBy={deferredBy(t.id)}
    warning={warningFor(t.id)}
    dragging={drag?.started === true && drag.id === t.id}
    offset={drag?.started && drag.id === t.id ? { x: drag.dx, y: drag.dy } : undefined}
    onopen={() => { openTicket(t); }}
    onpointerdown={(e: PointerEvent) => { startDrag(e, 'card', t.id); }}
    onkeydown={(e: KeyboardEvent) => { cardKey(e, t); }}
  />
{/snippet}

{#snippet lines()}
  {#each marks as k (k.m.id)}<div class="ms-line" style:left="{k.x}px" aria-hidden="true"></div>{/each}
{/snippet}

{#snippet trayCell(rowId: string, open: boolean, epic: Epic | null, inTray: Ticket[])}
  {#if showTray}
    <div class="gutter" aria-hidden="true"></div>
    <div class="tray" data-tray={rowId}>
      {#if epic?.deferred}
        {@const lockedBy = live.lockedBy(epic.id)}
        <div
          class="later-bar fill-{epicFill(rm, epic.id)}"
          class:changed={changes.has(epic.id)}
          class:agent={live.isAgentTouched(epic.id)}
          class:locked={!!lockedBy}
          class:dragging={drag?.started === true && drag.id === epic.id}
          style:transform={drag?.started && drag.id === epic.id ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined}
          role="group"
          aria-label="{epic.summary}, in {tl.laterLabel}, {epic.ticketOrder.length} tickets. Drag it onto the timeline to schedule it."
          onpointerdown={(e) => { startDrag(e, 'epic', epic.id); }}
        >
          <TrayIcon />
          <button class="later-name" aria-expanded={open} onclick={() => { if (!suppressClick) ui.toggle(epic.id); suppressClick = false; }}>{epic.summary}</button>
          {#if lockedBy}<span class="tag people">{lockedBy.holder} {lockedBy.kind === 'drag' ? 'moving' : 'editing'}</span>{/if}
          <span class="later-count">{epic.ticketOrder.length} tickets</span>
          <button class="schedule" onclick={() => { scheduleEpic(epic); }}>Schedule</button>
        </div>
      {/if}
      {#if open && inTray.length > 0}
        <div class="tray-cards" class:below={epic?.deferred}>
          {#each inTray as t (t.id)}{@render card(t)}{/each}
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

<div class="frame panel" bind:clientWidth={width}>
  <div class="grid" class:with-tray={showTray} style:--cols={cols.length} style:--colw="{colW}px" style:--tray-w="{TRAY}px" style:--tray-gutter="{GUTTER}px">
    <div class="head label-col">Epic</div>
    {#each cols as c, i (c.start)}
      {@const now = i === nowIdx}
      <div class="head col" class:now class:week={msScale && now} class:has-ms={marks.some((k) => k.col === i)}>
        <strong>{c.label}</strong>
        <span>{msScale && now ? 'this week' : `${c.sublabel}${now ? ' · now' : ''}`}</span>
        {#each marks.filter((k) => k.col === i) as k (k.m.id)}
          <span class="ms-tag" title="{k.m.label} · {fmtDay(k.m.date)}"><span aria-hidden="true">◆</span> {fmtDay(k.m.date)}<span class="sr-only"> {k.m.label} milestone</span></span>
        {/each}
        {#each marks.filter((k) => k.col === i) as k (k.m.id)}<div class="ms-line" style:left="{k.x - i * colW}px" aria-hidden="true"></div>{/each}
      </div>
    {/each}
    {#if showTray}
      <div class="head gutter" aria-hidden="true"></div>
      <div class="head tray-head">
        <TrayIcon size={18} />
        <span class="tray-title">
          <strong>{tl.laterLabel}</strong>
          <span>no date{lastMilestone ? ` · after ${lastMilestone.label}` : ''}</span>
        </span>
      </div>
    {/if}

    {#each rows as r (r.id)}
      {@const open = ui.expanded.includes(r.id) || (filtering && r.shown.length > 0)}
      {@const geo = r.epic.deferred ? null : barGeometry(r.epic, cols, tl.scale, today)}
      {@const warn = warningFor(r.id)}
      {#if !filtering || r.shown.length > 0 || r.epic.summary.toLowerCase().includes(ui.filter.toLowerCase())}
        <div class="label-col row-label" class:open data-epic-row={r.id}>
          <button class="toggle" aria-expanded={open} aria-label="{open ? 'Hide' : 'Show'} tickets in {r.epic.summary}" onclick={() => { ui.toggle(r.id); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} /></svg>
          </button>
          <span class="who">
            <span class="key">{r.id}</span>
            <span class="title">{r.epic.summary}</span>
          </span>
          {#if r.epic.deferred}<span class="row-later" title="In {tl.laterLabel}"><TrayIcon size={14} /><span class="sr-only">in {tl.laterLabel}</span></span>{/if}
          {#if warn}<span class="row-warn" title={warn.message} role="img" aria-label="Warning: {warn.message}">⚠</span>{/if}
          {#if changes.has(r.id)}<span class="dot" title="Differs from Jira" aria-label="differs from Jira"></span>{/if}
        </div>
        <div class="track" class:open data-epic-row={r.id} style:grid-column="2 / span {cols.length}">
          {#if nowIdx >= 0}<div class="now-col" class:week={msScale} style:left="{nowIdx * colW}px" style:width="{colW}px"></div>{/if}
          {@render lines()}
          {#if geo}
            <EpicBar
              epic={r.epic}
              {cols}
              {colW}
              scale={tl.scale}
              fill={epicFill(rm, r.id)}
              count={r.tickets.length - r.laterCount}
              laterCount={r.laterCount}
              changed={changes.has(r.id)}
              isNew={isNew(r.id)}
              agent={live.isAgentTouched(r.id)}
              lock={live.lockedBy(r.id)}
              ondates={(s: Span) => { live.submit([{ type: 'epic.setDates', id: r.id, startDate: s.startDate, dueDate: s.dueDate }]); }}
              ondefer={() => { live.submit([{ type: 'epic.defer', id: r.id, deferred: true }]); }}
              ondrag={(d: boolean) => { live.setDragging(d ? r.id : null); }}
              ontoggle={() => { ui.toggle(r.id); }}
            />
          {:else if !r.epic.deferred}
            <span class="undated">No dates yet · open the epic to set them</span>
          {/if}
          {#if open && !r.epic.deferred}
            <!-- Under the bar, but kept inside the grid so the two columns of cards are never clipped. -->
            <div class="cards" style:margin-left="{Math.max(0, Math.min((geo?.left ?? 0) * colW, cols.length * colW - 470))}px">
              {#each r.scheduled as t (t.id)}{@render card(t)}{/each}
              <button class="add" onclick={() => (ui.create = { kind: 'ticket', epicId: r.id })}>+ Add ticket</button>
            </div>
          {/if}
        </div>
        {@render trayCell(r.id, open, r.epic, r.inTray)}
      {/if}
    {/each}

    {#if loose.length > 0}
      {@const open = ui.expanded.includes(NO_EPIC) || filtering}
      {@const shown = loose.filter((t) => matches(t, ui.filter))}
      <div class="label-col row-label" data-epic-row={NO_EPIC}>
        <button class="toggle" aria-expanded={open} aria-label="{open ? 'Hide' : 'Show'} tickets without an epic" onclick={() => { ui.toggle(NO_EPIC); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} /></svg>
        </button>
        <span class="who"><span class="key">—</span><span class="title">No epic · {loose.length}</span></span>
      </div>
      <div class="track" data-epic-row={NO_EPIC} style:grid-column="2 / span {cols.length}">
        {@render lines()}
        {#if open}
          <div class="cards">
            {#each shown.filter((t) => !t.deferred) as t (t.id)}{@render card(t)}{/each}
          </div>
        {/if}
      </div>
      {@render trayCell(NO_EPIC, open, null, shown.filter((t) => t.deferred))}
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
  .grid.with-tray { grid-template-columns: var(--label-col) repeat(var(--cols), var(--colw)) var(--tray-gutter) var(--tray-w); }
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
  .col.now.week { background: var(--this-week); box-shadow: none; }
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
  .row-later { color: var(--later-ink); margin-top: 14px; flex: none; }
  .row-warn { color: var(--warn-text); margin-top: 12px; flex: none; cursor: help; }
  .track { position: relative; border-bottom: 1px solid var(--line); min-height: 57px; }
  .now-col { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--warn-tint) 55%, transparent); pointer-events: none; }
  .now-col.week { background: var(--this-week); }
  .ms-line { position: absolute; top: 0; bottom: 0; width: 3px; margin-left: -2px; background: var(--milestone); pointer-events: none; z-index: 3; }
  /* The tag sits above the column's own label, so narrow week columns never overlap it. */
  .col.has-ms { padding-top: 32px; }
  .ms-tag {
    position: absolute; right: 8px; top: 7px;
    background: var(--milestone); color: #2f2410; font-weight: 600; font-size: 12px;
    padding: 1px 8px; border-radius: 4px; white-space: nowrap;
  }
  .col .ms-tag { color: #2f2410; }
  .gutter { background: var(--surface); border-bottom: 1px solid var(--line); }
  .head.gutter { border-bottom-color: var(--border); }
  .tray { position: relative; background: var(--later-hatch); border-bottom: 1px solid var(--line); min-height: 57px; padding: 8px 12px; }
  .tray-head { display: flex; align-items: center; gap: 10px; background: var(--later-tint); color: var(--later-ink); }
  .tray-title { display: grid; }
  .tray-title strong { font-size: 13px; font-weight: 600; }
  .tray-title span { font-size: 12px; }
  .later-bar {
    display: flex; align-items: center; gap: 8px;
    min-height: 40px; padding: 0 6px 0 12px;
    border-radius: var(--radius); border: 1px solid transparent;
    cursor: grab; touch-action: none; user-select: none; position: relative; z-index: 2;
  }
  .later-bar.changed { border: 2px solid var(--changed); }
  .later-bar.agent { outline: 2px dotted var(--agent); outline-offset: 2px; }
  .later-bar.locked { outline: 2px solid var(--people); outline-offset: 2px; cursor: not-allowed; }
  .later-bar.dragging { pointer-events: none; z-index: 20; box-shadow: 0 10px 24px rgb(47 49 40 / 0.2); cursor: grabbing; }
  .fill-0 { background: var(--epic-1); color: var(--epic-1-ink); }
  .fill-1 { background: var(--epic-2); color: var(--epic-2-ink); }
  .fill-2 { background: var(--epic-3); color: var(--epic-3-ink); }
  .fill-3 { background: var(--epic-4); color: var(--epic-4-ink); }
  .fill-4 { background: var(--epic-5); color: var(--epic-5-ink); }
  .later-name { flex: 1; min-width: 0; border: 0; background: none; padding: 0; text-align: left; font-weight: 500; color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 36px; cursor: inherit; }
  .later-count { font-size: 12px; white-space: nowrap; opacity: 0.85; }
  /* Shown on hover or keyboard focus: the design's bar is name + count only. */
  .schedule { border: 1px solid currentColor; border-radius: 4px; background: var(--surface); font-size: 12px; min-height: 28px; padding: 0 8px; opacity: 0; width: 0; padding-inline: 0; overflow: hidden; }
  .later-bar:hover .schedule, .schedule:focus { opacity: 1; width: auto; padding-inline: 8px; }
  .tray-cards { display: grid; gap: 8px; padding-top: 0; }
  .tray-cards.below { padding-top: 8px; }
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
