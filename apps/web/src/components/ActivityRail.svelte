<script lang="ts">
  import type { Live } from '../lib/live.svelte.js';
  import ActivityList from './ActivityList.svelte';

  let { live }: { live: Live } = $props();

  const agents = $derived(live.presence.filter((p) => p.kind === 'agent'));
</script>

<aside class="panel rail" aria-label="Activity">
  <div class="head"><h2>Activity</h2><span>this session</span></div>
  <ActivityList {live} />
  <div class="ws">
    <strong>Workspace</strong>
    <code>./workspace/roadmap.json</code>
    <span>Live mirror · v{live.state?.version}</span>
    <span>CLI clients: {agents.length ? agents.map((a) => a.name).join(', ') : 'none'}</span>
  </div>
</aside>

<style>
  .rail { padding: 16px; display: grid; gap: 16px; position: sticky; top: 12px; }
  .head { display: flex; justify-content: space-between; align-items: baseline; }
  h2 { margin: 0; font-size: 16px; }
  .head span { font-size: 12px; color: var(--ink-muted); }
  .ws { display: grid; gap: 4px; padding: 12px; background: var(--bg); border-radius: var(--radius); font-size: 12.5px; color: var(--ink-muted); }
  .ws strong { color: var(--ink); }
  code { font-size: 12px; color: var(--ink); }
</style>
