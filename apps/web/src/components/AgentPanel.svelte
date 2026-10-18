<script lang="ts">
  import { describeOp } from '../lib/items.js';
  import type { OplogEntry } from '@trellis/shared';
  import type { Live } from '../lib/live.svelte.js';
  import { ui } from '../lib/ui.svelte.js';
  import Avatar from './Avatar.svelte';

  let { live, batch }: { live: Live; batch: OplogEntry } = $props();

  const b = $derived(batch);
  const n = $derived(b.batch.id.replace(/^b/, ''));
  const rejected = $derived(b.result.rejected.filter((r) => r.code !== 'BATCH_REJECTED'));
  const reason = $derived(b.batch.reason ?? '');
  const cli = $derived(
    [
      `$ trellis batch${b.batch.baseVersion !== undefined ? ` --base ${b.batch.baseVersion}` : ''}${b.batch.askedBy ? ` --asked-by ${b.batch.askedBy}` : ''} \\`,
      `    ${reason ? `--reason "${reason.length > 24 ? `${reason.slice(0, 24)}…` : reason}" ` : ''}< ops.json`,
    ].join('\n'),
  );
  let showJson = $state(false);
</script>

<aside class="panel side" aria-label="Agent batch #{n}">
  <header>
    <Avatar name={b.batch.author.name} kind="agent" size={36} />
    <div>
      <h2>Agent batch #{n}</h2>
      <span class="meta">{b.batch.author.name} via trellis CLI · {new Date(b.at).toLocaleTimeString()}{b.batch.baseVersion !== undefined ? ` · based on v${b.batch.baseVersion}` : ''}</span>
    </div>
    <button class="x" aria-label="Close agent batch" onclick={() => (ui.agentPanel = false)}>×</button>
  </header>

  {#if reason}
    <blockquote>
      <span>Request{b.batch.askedBy ? ` from ${b.batch.askedBy} (facilitator)` : ''}</span>
      <p>{reason}</p>
    </blockquote>
  {/if}

  <ul class="results">
    {#each b.result.applied as a (a.index)}
      <li><span class="icon ok" aria-label="applied">✓</span>{live.state ? describeOp(a.op, live.state, a.createdId) : a.op.type}</li>
    {/each}
    {#each b.result.skipped as s (s.index)}
      <li><span class="icon kept" aria-label="kept">◷</span>Not changed: {s.message}. Kept the newer edit.</li>
    {/each}
  </ul>
  {#each rejected as r (r.index)}
    <p class="rejected"><span aria-hidden="true">✕</span> Rejected: {r.message}. Returned to the agent as a CLI error, so it can retry.</p>
  {/each}

  <div class="ran">
    <span>What the agent ran</span>
    <pre><code>{cli}
<span class="ok">✓ {b.result.applied.length} applied</span>  <span class="bad">✗ {rejected.length} rejected</span>  <span class="kp">• {b.result.skipped.length} kept</span></code></pre>
  </div>

  <div class="actions">
    <button class="btn" onclick={() => { void live.undo(b.batch.id).then(() => { live.agentBatch = null; ui.agentPanel = false; }); }}>Undo this batch</button>
    <button class="btn" aria-expanded={showJson} onclick={() => (showJson = !showJson)}>{showJson ? 'Hide' : 'Show'} batch JSON</button>
  </div>
  {#if showJson}<pre class="json"><code>{JSON.stringify(b.batch, null, 2)}</code></pre>{/if}
</aside>

<style>
  .side { padding: 16px; display: grid; gap: 14px; position: sticky; top: 12px; }
  header { display: flex; gap: 12px; align-items: center; }
  h2 { margin: 0; font-size: 16px; }
  .meta { font-size: 12px; color: var(--ink-muted); }
  .x { margin-left: auto; border: 0; background: none; font-size: 20px; min-width: var(--touch); min-height: var(--touch); align-self: start; }
  blockquote { margin: 0; padding: 12px 14px; background: var(--agent-tint); border-left: 3px solid var(--agent); border-radius: 0 var(--radius) var(--radius) 0; }
  blockquote span { font-size: 12px; color: var(--agent-text); }
  blockquote p { margin: 4px 0 0; }
  .results { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; font-size: 13.5px; }
  .results li { display: grid; grid-template-columns: 22px 1fr; }
  .icon.ok { color: var(--structure); }
  .icon.kept { color: var(--people); }
  .rejected { margin: 0; padding: 10px 12px; background: var(--error-tint); border: 1px solid var(--error); border-radius: var(--radius); color: var(--error-text); font-size: 13.5px; }
  .ran span { font-size: 12px; color: var(--ink-muted); }
  pre { margin: 6px 0 0; padding: 12px; background: #2f3128; color: #f2e1d2; border-radius: var(--radius); font-size: 12px; overflow: auto; white-space: pre-wrap; }
  .ok { color: #b9d3c4; }
  .bad { color: #e7a99c; }
  .kp { color: #b7c9cf; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .json { max-height: 300px; }
</style>
