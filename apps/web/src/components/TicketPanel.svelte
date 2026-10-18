<script lang="ts">
  import type { IssueId, Person } from '@trellis/shared';
  import { changesByItem, dependenciesOf, describeChange, isNew, revertOps } from '../lib/items.js';
  import type { Live } from '../lib/live.svelte.js';
  import { ui } from '../lib/ui.svelte.js';
  import Avatar from './Avatar.svelte';

  let { live }: { live: Live } = $props();

  const rm = $derived(live.roadmap);
  const t = $derived(ui.ticket ? rm.tickets[ui.ticket] : undefined);
  const snap = $derived(t ? live.snapshot?.tickets[t.id] : undefined);
  const changes = $derived(t ? (changesByItem(live.changeset).get(t.id) ?? []) : []);
  const changedFields = $derived(new Set(changes.flatMap((c) => (c.target !== t?.id ? [] : c.kind === 'field.update' ? [c.field] : c.kind === 'transition' ? ['status'] : c.kind === 'ticket.move' ? ['epic'] : c.kind.startsWith('link') ? ['links'] : []))));
  const viewers = $derived(t ? live.viewersOf(t.id) : []);
  const deps = $derived(t ? dependenciesOf(rm, t.id) : { blockedBy: [], blocks: [], other: [] });
  const wf = $derived(live.snapshot?.workflow);
  const statuses = $derived.by(() => {
    if (!t) return [];
    const known = wf?.statuses[t.issueType]?.map((s) => s.name) ?? [];
    const allowed = wf?.transitions?.[t.issueType]?.[t.status];
    const list = allowed ? [t.status, ...allowed] : known;
    return list.includes(t.status) ? list : [t.status, ...list];
  });
  const people = $derived.by(() => {
    const map = new Map<string, Person>();
    for (const p of wf?.assignableUsers ?? []) map.set(p.accountId, p);
    for (const x of Object.values(rm.tickets)) if (x.assignee) map.set(x.assignee.accountId, x.assignee);
    return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  });
  const epics = $derived(rm.epicOrder.flatMap((id) => (rm.epics[id] ? [rm.epics[id]] : [])));
  const snapLinks = $derived.by(() => {
    const out = new Set<string>();
    for (const x of Object.values(live.snapshot?.tickets ?? {})) for (const l of x.links) if (l.type === 'Blocks') out.add(l.direction === 'outward' ? `${x.id}>${l.target}` : `${l.target}>${x.id}`);
    return out;
  });

  let label = $state('');
  let linkOpen = $state(false);
  let linkDir = $state<'blocks' | 'blockedBy'>('blocks');
  let linkTarget = $state('');

  function update(fields: Record<string, unknown>): void {
    if (!t) return;
    live.submit([{ type: 'ticket.update', id: t.id, fields }]);
  }

  function addLabel(): void {
    const v = label.trim();
    if (!t || !v || t.labels.includes(v)) return;
    update({ labels: [...t.labels, v] });
    label = '';
  }

  function addLink(): void {
    if (!t || !linkTarget) return;
    const [from, to] = linkDir === 'blocks' ? [t.id, linkTarget] : [linkTarget, t.id];
    live.submit([{ type: 'link.add', from, to, linkType: 'blocks' }]);
    linkOpen = false;
    linkTarget = '';
  }

  function removeLink(from: IssueId, to: IssueId): void {
    live.submit([{ type: 'link.remove', from, to, linkType: 'blocks' }]);
  }

  function revert(): void {
    if (!t || !live.snapshot) return;
    live.submit(revertOps(t.id, live.snapshot, rm));
  }

  function discard(): void {
    if (!t || !confirm(`Discard ${t.id}? It only exists in Trellis.`)) return;
    const id = t.id;
    ui.closeDetail();
    live.submit([{ type: 'ticket.discardNew', id }]);
  }

  const name = (id: IssueId): string => rm.tickets[id]?.summary ?? '';
</script>

<aside class="panel-side" aria-label="Ticket detail">
  {#if !t}
    <div class="missing">
      <p>That ticket is no longer in the roadmap.</p>
      <button class="btn" onclick={() => { ui.closeDetail(); }}>Back to timeline</button>
    </div>
  {:else}
    <header>
      <span class="key">{t.id}</span>
      {#each viewers as v (v.clientId)}
        <span class="viewing"><Avatar name={v.name} kind={v.kind} size={20} /> {v.name} is also viewing</span>
      {/each}
      <button class="close" aria-label="Close ticket detail" onclick={() => { ui.closeDetail(); }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </header>

    <label class="field" class:changed={changedFields.has('summary')}>
      <span>Summary{changedFields.has('summary') ? ' · changed' : ''}</span>
      <input class="input" value={t.summary} onchange={(e) => { if (e.currentTarget.value.trim()) update({ summary: e.currentTarget.value.trim() }); }} />
    </label>

    <div class="two">
      <label class="field" class:changed={changedFields.has('epic')}>
        <span>Epic{changedFields.has('epic') ? ' · changed' : ''}</span>
        <select class="input" value={t.epicId ?? ''} onchange={(e) => { live.submit([{ type: 'ticket.move', id: t.id, epicId: e.currentTarget.value || null }]); ui.epic = e.currentTarget.value || null; }}>
          <option value="">No epic</option>
          {#each epics as e (e.id)}<option value={e.id}>{e.id} {e.summary}</option>{/each}
        </select>
      </label>
      <label class="field" class:changed={changedFields.has('status')}>
        <span>Status{changedFields.has('status') ? ' · changed' : ''}</span>
        <select class="input" value={t.status} onchange={(e) => { live.submit([{ type: 'ticket.transition', id: t.id, status: e.currentTarget.value }]); }}>
          {#each statuses as s (s)}<option value={s}>{s}</option>{/each}
        </select>
      </label>
      <label class="field" class:changed={changedFields.has('assignee')}>
        <span>Assignee{changedFields.has('assignee') ? ' · changed' : ''}</span>
        <select class="input" value={t.assignee?.accountId ?? ''} onchange={(e) => { update({ assignee: people.find((p) => p.accountId === e.currentTarget.value) ?? null }); }}>
          <option value="">Unassigned</option>
          {#each people as p (p.accountId)}<option value={p.accountId}>{p.displayName}</option>{/each}
        </select>
      </label>
      <label class="field">
        <span>Story points <em>· Trellis only</em></span>
        <input class="input" type="number" min="0" step="0.5" value={t.storyPoints ?? ''} onchange={(e) => { update({ storyPoints: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) }); }} />
      </label>
    </div>

    <div class="field" class:changed={changedFields.has('labels')}>
      <span>Labels{changedFields.has('labels') ? ' · changed' : ''}</span>
      <div class="labels">
        {#each t.labels as l (l)}
          <span class="chip">{l}<button aria-label="Remove label {l}" onclick={() => { update({ labels: t.labels.filter((x) => x !== l) }); }}>×</button></span>
        {/each}
        <form class="add-label" onsubmit={(e) => { e.preventDefault(); addLabel(); }}>
          <label class="sr-only" for="new-label">Add label</label>
          <input id="new-label" placeholder="+ Label" bind:value={label} />
        </form>
      </div>
    </div>

    <label class="field" class:changed={changedFields.has('description')}>
      <span>Description{changedFields.has('description') ? ' · changed' : ''}</span>
      <textarea class="input" value={t.description ?? ''} onchange={(e) => { update({ description: e.currentTarget.value }); }}></textarea>
    </label>

    <div class="field">
      <span>Dependencies</span>
      <ul class="deps">
        {#each deps.blockedBy as b (b)}
          {@const fresh = !snapLinks.has(`${b}>${t.id}`)}
          <li class:new={fresh}>
            <span class="rel">is blocked by{fresh ? ' · new' : ''}</span>
            <button class="dep" onclick={() => { ui.openTicket(b, rm.tickets[b]?.epicId ?? null); }}><span class="key">{b}</span> {name(b)}</button>
            <button class="rm" aria-label="Remove: {t.id} is blocked by {b}" onclick={() => { removeLink(b, t.id); }}>×</button>
          </li>
        {/each}
        {#each deps.blocks as b (b)}
          {@const fresh = !snapLinks.has(`${t.id}>${b}`)}
          <li class:new={fresh}>
            <span class="rel">blocks{fresh ? ' · new' : ''}</span>
            <button class="dep" onclick={() => { ui.openTicket(b, rm.tickets[b]?.epicId ?? null); }}><span class="key">{b}</span> {name(b)}</button>
            <button class="rm" aria-label="Remove: {t.id} blocks {b}" onclick={() => { removeLink(t.id, b); }}>×</button>
          </li>
        {/each}
        {#each deps.other as o (o.type + o.target)}
          <li class="other"><span class="rel">{o.type.toLowerCase()}{o.direction === 'inward' ? ' (in)' : ''}</span><span class="dep"><span class="key">{o.target}</span> {name(o.target)}</span></li>
        {/each}
      </ul>
      {#if linkOpen}
        <form class="link-form" onsubmit={(e) => { e.preventDefault(); addLink(); }}>
          <select class="input" bind:value={linkDir} aria-label="Link direction">
            <option value="blocks">blocks</option>
            <option value="blockedBy">is blocked by</option>
          </select>
          <select class="input" bind:value={linkTarget} aria-label="Ticket to link" required>
            <option value="">Choose a ticket…</option>
            {#each Object.values(rm.tickets).filter((x) => x.id !== t.id) as x (x.id)}<option value={x.id}>{x.id} {x.summary}</option>{/each}
          </select>
          <button class="btn small primary" type="submit">Add</button>
          <button class="btn small" type="button" onclick={() => (linkOpen = false)}>Cancel</button>
        </form>
      {:else}
        <button class="btn small add" onclick={() => (linkOpen = true)}>+ Add link</button>
      {/if}
    </div>

    <section class="differs" class:same={!isNew(t.id) && changes.length === 0} aria-label="Differs from Jira snapshot">
      {#if isNew(t.id)}
        <strong>New ticket</strong>
        <p>Only in Trellis so far. It is created in Jira at apply.</p>
        <button class="btn" onclick={discard}>Discard ticket</button>
      {:else if changes.length > 0 && snap}
        <strong>Differs from Jira snapshot</strong>
        <ul>{#each changes as c, i (i)}<li><code>{describeChange(c, t.id)}</code></li>{/each}</ul>
        <button class="btn" onclick={revert}>Revert to Jira values</button>
      {:else}
        <strong>Matches the Jira snapshot</strong>
      {/if}
    </section>
  {/if}
</aside>

<style>
  .panel-side {
    background: var(--surface);
    border-left: 1px solid var(--border);
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: calc(100vh - 64px);
    position: sticky;
    top: 0;
    max-height: 100vh;
    overflow: auto;
  }
  header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .viewing { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px 2px 3px; background: var(--people-tint); color: var(--people-text); border-radius: 999px; font-size: 12px; }
  .close { margin-left: auto; border: 0; background: none; min-width: var(--touch); min-height: var(--touch); display: grid; place-items: center; border-radius: var(--radius); }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
  em { font-style: normal; color: var(--ink-muted); }
  .labels { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 2px; padding: 4px 4px 4px 10px; background: var(--line); border-radius: 999px; font-size: 13px; }
  .chip button { border: 0; background: none; min-width: 24px; min-height: 24px; border-radius: 50%; color: var(--ink-muted); }
  .add-label input { border: 1px dashed var(--border); border-radius: 999px; padding: 4px 12px; width: 96px; background: transparent; min-height: 32px; }
  .deps { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .deps li { display: grid; grid-template-columns: 110px 1fr auto; align-items: center; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 4px 0 10px; min-height: var(--touch); }
  .deps li.new { background: var(--changed-tint); border-color: var(--changed-border); }
  .deps li.new .rel { color: var(--changed-text); }
  .deps li.other { grid-template-columns: 110px 1fr; color: var(--ink-muted); }
  .rel { font-size: 13px; color: var(--ink-muted); }
  .dep { border: 0; background: none; text-align: left; padding: 6px 0; min-height: 36px; }
  .rm { border: 0; background: none; min-width: 36px; min-height: 36px; color: var(--ink-muted); font-size: 16px; }
  .add { justify-self: start; border-style: dashed; }
  .link-form { display: grid; grid-template-columns: 130px 1fr auto auto; gap: 6px; }
  .differs { margin-top: auto; background: var(--changed-tint); border-radius: 8px; padding: 14px; display: grid; gap: 8px; }
  .differs.same { background: var(--line); }
  .differs ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 12.5px; }
  .differs p { margin: 0; color: var(--ink-muted); font-size: 13px; }
  .differs .btn { justify-self: start; }
  .missing { display: grid; gap: 12px; }
</style>
