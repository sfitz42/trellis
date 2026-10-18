<script lang="ts">
  import { untrack } from 'svelte';
  import { defaultTicketType } from '@trellis/shared';
  import type { Live } from '../lib/live.svelte.js';
  import { ui } from '../lib/ui.svelte.js';

  let { live }: { live: Live } = $props();

  const kind = $derived(ui.create?.kind ?? 'ticket');
  const epics = $derived(live.state ? live.state.epicOrder.flatMap((id) => (live.state?.epics[id] ? [live.state.epics[id]] : [])) : []);
  const types = $derived(Object.keys(live.snapshot?.workflow.statuses ?? {}).filter((t) => t !== live.snapshot?.workflow.epicIssueType));

  let summary = $state('');
  let epicId = $state<string>(ui.create?.epicId ?? ui.expanded[0] ?? '');
  let issueType = $state(untrack(() => defaultTicketType(live.snapshot?.workflow)));
  let dueDate = $state('');
  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => { dialog?.showModal(); });

  function close(): void {
    ui.create = null;
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    if (!summary.trim()) return;
    if (kind === 'epic') {
      live.submit([{ type: 'epic.create', fields: { summary: summary.trim(), ...(dueDate ? { dueDate } : {}) } }]);
    } else {
      live.submit([{ type: 'ticket.create', epicId: epicId || null, fields: { summary: summary.trim(), ...(types.length ? { issueType } : {}) } }]);
      if (epicId && !ui.expanded.includes(epicId)) ui.toggle(epicId);
    }
    close();
  }
</script>

<dialog bind:this={dialog} onclose={close} aria-labelledby="create-title">
  <form onsubmit={submit} class="form">
    <h2 id="create-title">{kind === 'epic' ? 'New epic' : 'New ticket'}</h2>
    <label class="field">
      <span>Summary</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="input" bind:value={summary} required autofocus />
    </label>
    {#if kind === 'ticket'}
      <div class="row">
        <label class="field">
          <span>Epic</span>
          <select class="input" bind:value={epicId}>
            <option value="">No epic</option>
            {#each epics as e (e.id)}<option value={e.id}>{e.id} {e.summary}</option>{/each}
          </select>
        </label>
        {#if types.length}
          <label class="field">
            <span>Type</span>
            <select class="input" bind:value={issueType}>
              {#each types as t (t)}<option value={t}>{t}</option>{/each}
            </select>
          </label>
        {/if}
      </div>
    {:else}
      <label class="field">
        <span>Due date (optional)</span>
        <input class="input" type="date" bind:value={dueDate} />
      </label>
    {/if}
    <p class="hint">It gets a temporary id (NEW-…) and a dashed border until it is created in Jira at apply.</p>
    <div class="actions">
      <button class="btn" type="button" onclick={close}>Cancel</button>
      <button class="btn primary" type="submit">Add {kind}</button>
    </div>
  </form>
</dialog>

<style>
  dialog { border: 1px solid var(--border); border-radius: 10px; padding: 0; background: var(--surface); width: min(480px, calc(100vw - 32px)); }
  dialog::backdrop { background: rgb(47 49 40 / 0.35); }
  .form { display: grid; gap: 14px; padding: 20px; }
  h2 { margin: 0; font-size: 18px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .hint { margin: 0; color: var(--ink-muted); font-size: 12.5px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
