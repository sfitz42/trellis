<script lang="ts">
  import { initials } from '../lib/items.js';

  let { name, kind = 'human', size = 32, me = false }: { name: string; kind?: 'human' | 'agent'; size?: number; me?: boolean } = $props();
</script>

<span
  class="avatar"
  class:agent={kind === 'agent'}
  class:me
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{Math.round(size * 0.36)}px"
  title={kind === 'agent' ? `${name} (agent)` : name}
  aria-label={kind === 'agent' ? `${name}, agent` : name}
>{initials(name)}</span>

<style>
  .avatar {
    display: inline-grid;
    place-items: center;
    border-radius: 50%;
    background: var(--people);
    color: #fff;
    font-weight: 600;
    border: 2px solid var(--surface);
    flex: none;
  }
  .avatar.me { background: var(--structure); }
  .avatar.agent {
    background: var(--agent-solid);
    outline: 2px dotted var(--agent);
    outline-offset: 2px;
  }
</style>
