<script lang="ts">
  import type { Op } from '@trellis/shared';
  import { backwardsWarnings, changesByItem, dependenciesOf, epicOf, isNew, scheduleEpicOps, warningsByItem } from '../lib/items.js';
  import type { Live } from '../lib/live.svelte.js';
  import { fmtMonth, fmtRange } from '../lib/timeline.js';
  import { ui } from '../lib/ui.svelte.js';
  import { statusCategory, todayIso } from '../lib/view.js';
  import TicketCard from './TicketCard.svelte';
  import TrayIcon from './TrayIcon.svelte';

  let { live }: { live: Live } = $props();

  const rm = $derived(live.roadmap);
  const epic = $derived(ui.epic ? rm.epics[ui.epic] : undefined);
  const jiraEpic = $derived(epic ? live.snapshot?.epics[epic.id] : undefined);
  const changes = $derived(changesByItem(live.changeset));
  const selected = $derived(ui.ticket);
  const deps = $derived(selected ? dependenciesOf(rm, selected) : null);
  const warnings = $derived(selected ? backwardsWarnings(rm, selected) : []);
  const scoped = $derived(warningsByItem(rm, todayIso()));
  /** Milestone and deferral warnings for the epic and the selected ticket. */
  const scopeNotes = $derived([...(epic ? (scoped.get(epic.id) ?? []) : []), ...(selected ? (scoped.get(selected) ?? []) : [])]);
  const tickets = $derived(epic ? epic.ticketOrder.flatMap((id) => (rm.tickets[id] ? [rm.tickets[id]] : [])) : Object.values(rm.tickets).filter((t) => t.epicId === null));

  function epicName(id: string): string {
    return epicOf(rm, id)?.summary ?? 'No epic';
  }

  function setDate(which: 'startDate' | 'dueDate', value: string): void {
    if (!epic) return;
    const next = { startDate: epic.startDate, dueDate: epic.dueDate, [which]: value || null };
    if (next.startDate && next.dueDate && next.startDate > next.dueDate) {
      live.notify('error', 'Start date must be on or before the due date');
      return;
    }
    // A date on a deferred epic schedules it again: undefer first, in the same batch.
    const ops: Op[] = epic.deferred ? [{ type: 'epic.defer', id: epic.id, deferred: false }] : [];
    ops.push({ type: 'epic.setDates', id: epic.id, startDate: next.startDate, dueDate: next.dueDate });
    live.submit(ops, { atomic: true });
  }

  function toggleLater(): void {
    if (!epic) return;
    const ops = epic.deferred
      ? scheduleEpicOps(rm, epic.id, rm.timeline.scale, { today: todayIso(), oplog: live.oplog })
      : [{ type: 'epic.defer' as const, id: epic.id, deferred: true }];
    live.submit(ops, { atomic: true });
  }
</script>

<nav class="crumbs" aria-label="Breadcrumb">
  <button class="link" onclick={() => { ui.closeDetail(); }}>Trellis</button>
  <span aria-hidden="true">/</span>
  <span><span class="key">{epic?.id ?? '—'}</span> {epic?.summary ?? 'No epic'}</span>
</nav>

<header class="title">
  <h1>{epic?.summary ?? 'Tickets without an epic'}</h1>
  {#if epic}
    {#if epic.deferred}
      <span class="chip later"><TrayIcon size={14} /> {rm.timeline.laterLabel}</span>
    {:else}
      <span class="chip people">{fmtRange(epic)}</span>
    {/if}
    <button class="btn small later-btn" onclick={toggleLater}><TrayIcon size={14} />{epic.deferred ? 'Schedule again' : `Move to ${rm.timeline.laterLabel}`}</button>
    {#if jiraEpic && !epic.deferred && jiraEpic.dueDate !== epic.dueDate}
      <span class="chip changed">Jira: due {fmtMonth(jiraEpic.dueDate)}</span>
    {/if}
    <div class="dates">
      <label>Start <input class="input" type="date" value={epic.startDate ?? ''} onchange={(e) => { setDate('startDate', e.currentTarget.value); }} /></label>
      <label>Due <input class="input" type="date" value={epic.dueDate ?? ''} onchange={(e) => { setDate('dueDate', e.currentTarget.value); }} /></label>
    </div>
  {/if}
</header>

{#if selected && deps}
  <section class="panel box" aria-label="Dependency chain">
    <div class="box-head"><h2>Dependency chain</h2><span>across epics</span></div>
    <div class="chain">
      {#if deps.blockedBy.length}
        <div class="stack">
          {#each deps.blockedBy as b (b)}
            <button class="node" class:changed={changes.has(b)} onclick={() => { ui.openTicket(b, rm.tickets[b]?.epicId ?? null); }}>
              <span class="key">{b} · {epicName(b)}</span><span>{rm.tickets[b]?.summary}</span>
            </button>
          {/each}
        </div>
        <span class="arrow" aria-hidden="true">⟶</span>
      {/if}
      <div class="node sel"><span class="key">{selected} · selected</span><span>{rm.tickets[selected]?.summary}</span></div>
      {#if deps.blocks.length}
        <span class="arrow" aria-hidden="true">⟶</span>
        <div class="stack">
          {#each deps.blocks as b (b)}
            <button class="node" class:changed={changes.has(b)} onclick={() => { ui.openTicket(b, rm.tickets[b]?.epicId ?? null); }}>
              <span class="key">{b} · {epicName(b)}</span><span>{rm.tickets[b]?.summary}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if !deps.blockedBy.length && !deps.blocks.length}<p class="none">No “blocks” links yet. Add one from the panel.</p>{/if}
    </div>
    {#each warnings as w (w.blocker + w.blocked)}
      <p class="warn" role="alert">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></svg>
        {w.message}
      </p>
    {/each}
  </section>
{/if}

{#each scopeNotes as w, i (i)}
  <p class="warn scope-note" role="note"><span aria-hidden="true">⚠</span> {w.message}</p>
{/each}

<section class="panel box" aria-label="Tickets in this epic">
  <h2>Tickets in this epic</h2>
  <div class="grid">
    {#each tickets as t (t.id)}
      <TicketCard
        ticket={t}
        category={statusCategory(live.snapshot, t.issueType, t.status)}
        changed={changes.has(t.id)}
        isNew={isNew(t.id)}
        agent={live.isAgentTouched(t.id)}
        lock={live.lockedBy(t.id)}
        selected={t.id === selected}
        blocks={[]}
        compact
        onopen={() => { ui.openTicket(t.id, t.epicId); }}
      />
    {/each}
  </div>
</section>

<style>
  .crumbs { display: flex; gap: 8px; align-items: center; color: var(--ink-muted); font-size: 13.5px; margin-bottom: 12px; }
  .link { border: 0; background: none; padding: 0; text-decoration: underline; color: var(--ink-muted); min-height: 32px; }
  .title { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
  h1 { font-size: 24px; margin: 0; }
  .chip { padding: 3px 10px; border-radius: 999px; font-size: 13px; }
  .chip.people { background: var(--people-tint); color: var(--people-text); }
  .chip.changed { background: var(--changed-tint); color: var(--changed-text); }
  .chip.later { display: inline-flex; align-items: center; gap: 6px; background: var(--later-tint); color: var(--later-ink); }
  .later-btn { display: inline-flex; align-items: center; gap: 6px; }
  .scope-note { margin-bottom: 16px; }
  .dates { display: flex; gap: 10px; margin-left: auto; }
  .dates label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-muted); }
  .dates .input { width: 160px; color: var(--ink); }
  .box { padding: 16px; margin-bottom: 16px; }
  .box-head { display: flex; justify-content: space-between; align-items: baseline; }
  .box-head span { font-size: 12px; color: var(--ink-muted); }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .chain { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 12px; }
  .stack { display: grid; gap: 8px; }
  .node { display: grid; gap: 2px; text-align: left; width: 222px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); min-height: var(--touch); }
  .node.changed { box-shadow: inset 3px 0 0 var(--changed); }
  .node.sel { border: 2px solid var(--people); background: var(--people-tint); }
  .arrow { font-size: 22px; color: var(--ink-muted); }
  .none { margin: 0; color: var(--ink-muted); font-size: 13px; }
  .warn { display: flex; gap: 10px; align-items: center; margin: 0; padding: 10px 14px; background: var(--warn-tint); border: 1px solid var(--warn); border-radius: var(--radius); color: var(--warn-text); font-size: 13.5px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; }
</style>
