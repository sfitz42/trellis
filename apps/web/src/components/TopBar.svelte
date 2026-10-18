<script lang="ts">
  import type { Live } from '../lib/live.svelte.js';
  import { ui } from '../lib/ui.svelte.js';
  import Avatar from './Avatar.svelte';

  let { live }: { live: Live } = $props();

  const pulled = $derived(live.summary?.pulledAt ? new Date(live.summary.pulledAt) : null);
  const changes = $derived(live.changeset?.ops.length ?? 0);
  const others = $derived(live.presence.filter((p) => p.clientId !== live.clientId));
  let freezing = $state(false);

  async function freeze(): Promise<void> {
    if (!confirm(`Freeze the session for apply? Editing locks for everyone until it is unfrozen.\n\n${changes} change(s) will go into the changeset.`)) return;
    freezing = true;
    try {
      await live.freeze();
    } finally {
      freezing = false;
    }
  }
</script>

<header class="top">
  <div class="brand" aria-hidden="true">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M4 4l16 16M20 4L4 20M12 3v18M3 12h18" />
    </svg>
    <span>Trellis</span>
  </div>
  <div class="project">
    <span class="key">{live.state?.project.key}</span>
    <span>{live.state?.project.name || 'Roadmap'}</span>
  </div>
  <p class="snap">
    {#if pulled}
      Jira snapshot pulled {pulled.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      · {live.summary?.epics} epics · {live.summary?.tickets} tickets
    {:else}
      No Jira snapshot yet
    {/if}
  </p>
  {#if live.snapshotAvailable}
    <button class="btn small newer" onclick={() => void live.reloadSnapshot()}>New Jira snapshot · reload</button>
  {/if}
  <span class="spacer"></span>
  <span class="live" class:off={live.connection !== 'open'} role="status">
    <span class="dot" aria-hidden="true"></span>
    {live.connection === 'open' ? 'Live session' : 'Reconnecting…'}
  </span>
  <div class="people" aria-label="People in this session">
    <Avatar name={live.name} me />
    {#each others as p (p.clientId)}
      <Avatar name={p.name} kind={p.kind} />
    {/each}
  </div>
  <button class="btn changes" onclick={() => (ui.view = 'changes')} aria-label="{changes} changes vs Jira">
    <span class="count">{changes}</span> Changes vs Jira
  </button>
  <button class="btn primary" onclick={freeze} disabled={freezing}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
    Freeze for apply
  </button>
</header>

<style>
  .top {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 16px; color: var(--structure); }
  .brand span { color: var(--ink); }
  .project {
    display: flex; gap: 8px; align-items: center;
    padding: 8px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  }
  .snap { margin: 0; color: var(--ink-muted); font-size: 13px; }
  .newer { background: var(--warn-tint); border-color: var(--warn); color: var(--warn-text); }
  .spacer { flex: 1; }
  .live {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 12px; border-radius: 999px; background: var(--people-tint); color: var(--people-text); font-size: 13px;
  }
  .live .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--people); }
  .live.off { background: var(--warn-tint); color: var(--warn-text); }
  .live.off .dot { background: var(--warn); }
  .people { display: flex; }
  .people :global(.avatar + .avatar) { margin-left: -6px; }
  .changes { background: var(--changed-tint); border-color: var(--changed-border); color: var(--changed-text); display: inline-flex; gap: 8px; align-items: center; }
  .count { background: var(--changed); color: #fff; border-radius: 999px; padding: 0 7px; font-size: 12px; line-height: 20px; }
  .primary { display: inline-flex; gap: 8px; align-items: center; }
</style>
