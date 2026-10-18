<script lang="ts">
  import type { OplogEntry } from '@trellis/shared';
  import type { Live } from '../lib/live.svelte.js';
  import { ui } from '../lib/ui.svelte.js';

  let { live, batch }: { live: Live; batch: OplogEntry } = $props();

  const b = $derived(batch);
  const n = $derived(b.batch.id.replace(/^b/, ''));
  const kept = $derived([...new Set(b.result.skipped.map((s) => /edited by (.+?) at/.exec(s.message)?.[1] ?? 'someone'))]);
  const rejected = $derived(b.result.rejected.filter((r) => r.code !== 'BATCH_REJECTED').length);

  async function undo(): Promise<void> {
    await live.undo(b.batch.id);
    live.agentBatch = null;
    ui.agentPanel = false;
  }
</script>

<div class="banner" role="status">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>
  <p>
    <strong>{b.batch.author.name} applied batch #{n}</strong>
    {#if b.batch.askedBy}· asked by {b.batch.askedBy}{/if}
    · {b.result.applied.length} change{b.result.applied.length === 1 ? '' : 's'} applied{#if rejected}, {rejected} rejected{/if}{#if kept.length}, {b.result.skipped.length} kept for {kept.join(', ')}{/if}
  </p>
  <button class="btn ghost-light" onclick={undo}>Undo agent batch</button>
  <button class="btn light" onclick={() => (ui.agentPanel = true)}>Review changes</button>
  <button class="x" aria-label="Dismiss" onclick={() => { live.agentBatch = null; ui.agentPanel = false; }}>×</button>
</div>

<style>
  .banner {
    display: flex; align-items: center; gap: 14px;
    padding: 10px 24px; background: var(--agent-solid); color: #fff;
  }
  p { margin: 0; flex: 1; }
  .ghost-light { background: transparent; color: #fff; border-color: rgb(255 255 255 / 0.6); }
  .light { background: var(--surface); color: var(--agent-text); border-color: var(--surface); }
  .x { border: 0; background: none; color: #fff; font-size: 20px; min-width: var(--touch); min-height: var(--touch); }
</style>
