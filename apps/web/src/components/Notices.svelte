<script lang="ts">
  import type { Live } from '../lib/live.svelte.js';

  let { live }: { live: Live } = $props();
</script>

<div class="notices" role="status" aria-live="polite">
  {#each live.notices as n (n.id)}
    <div class="notice {n.kind}">
      <span class="tag {n.kind === 'error' ? 'error' : 'warn'}">{n.kind === 'error' ? 'Rejected' : 'Note'}</span>
      <span>{n.text}</span>
      <button class="x" aria-label="Dismiss" onclick={() => { live.dismiss(n.id); }}>×</button>
    </div>
  {/each}
</div>

<style>
  .notices { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: grid; gap: 8px; z-index: 50; width: min(560px, calc(100vw - 32px)); }
  .notice {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 6px 20px rgb(47 49 40 / 0.12);
  }
  .notice.error { border-color: var(--error); }
  .notice span:nth-child(2) { flex: 1; }
  .x { border: 0; background: none; font-size: 18px; min-width: 32px; min-height: 32px; color: var(--ink-muted); }
</style>
