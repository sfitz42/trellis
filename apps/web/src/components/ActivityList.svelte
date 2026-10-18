<script lang="ts">
  import { describeOp } from '../lib/items.js';
  import type { Live } from '../lib/live.svelte.js';
  import { ui } from '../lib/ui.svelte.js';
  import Avatar from './Avatar.svelte';

  let { live, limit = 8 }: { live: Live; limit?: number } = $props();

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => { now = Date.now(); }, 30_000);
    return () => { clearInterval(t); };
  });

  function ago(at: string): string {
    const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const dragging = $derived(live.presence.filter((p) => p.dragging && p.clientId !== live.clientId));
  const entries = $derived([...live.oplog].reverse().slice(0, limit));
</script>

<ol class="list">
  {#each dragging as p (p.clientId)}
    <li>
      <Avatar name={p.name} kind={p.kind} />
      <div><strong>{p.name}</strong> is moving {p.dragging}<span class="when">now</span></div>
    </li>
  {/each}
  {#each entries as e (e.batch.id)}
    {@const first = e.result.applied[0]}
    {@const mine = e.batch.author.name === live.name}
    <li>
      <Avatar name={e.batch.author.name} kind={e.batch.author.kind} me={mine} />
      <div>
        <strong>{mine ? 'You' : e.batch.author.name}</strong>
        {first && live.state ? describeOp(first.op, live.state, first.createdId) : 'made no changes'}
        {#if e.result.applied.length > 1}and {e.result.applied.length - 1} more{/if}
        {#if e.batch.askedBy}(asked by {e.batch.askedBy}){/if}
        {#if e.batch.author.kind === 'agent'}
          <button class="link" onclick={() => { live.agentBatch = e; ui.agentPanel = true; }}>details</button>
        {/if}
        <span class="when">{ago(e.at)}</span>
      </div>
    </li>
  {:else}
    {#if dragging.length === 0}<li class="empty">No changes yet this session.</li>{/if}
  {/each}
</ol>

<style>
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
  li { display: grid; grid-template-columns: 32px 1fr; gap: 10px; align-items: start; font-size: 13.5px; }
  .when { display: block; font-size: 12px; color: var(--ink-muted); }
  .empty { display: block; color: var(--ink-muted); }
  .link { border: 0; background: none; padding: 0; color: var(--agent-text); text-decoration: underline; font-size: 12.5px; min-height: 0; }
</style>
