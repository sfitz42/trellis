<script lang="ts">
  import { Live } from './lib/live.svelte.js';
  import { ui } from './lib/ui.svelte.js';
  import NamePrompt from './components/NamePrompt.svelte';
  import TopBar from './components/TopBar.svelte';
  import Toolbar from './components/Toolbar.svelte';
  import Timeline from './components/Timeline.svelte';
  import ActivityRail from './components/ActivityRail.svelte';
  import ActivityList from './components/ActivityList.svelte';
  import ChangesTable from './components/ChangesTable.svelte';
  import TicketPanel from './components/TicketPanel.svelte';
  import EpicFocus from './components/EpicFocus.svelte';
  import AgentBanner from './components/AgentBanner.svelte';
  import AgentPanel from './components/AgentPanel.svelte';
  import FreezeScreen from './components/FreezeScreen.svelte';
  import CreateDialog from './components/CreateDialog.svelte';
  import Notices from './components/Notices.svelte';

  let live = $state<Live | null>(null);

  function start(name: string): void {
    Live.saveName(name);
    const l = new Live(name);
    l.connect();
    live = l;
  }

  const saved = Live.savedName();
  if (saved) start(saved);

  // Tell others what I'm looking at (shown as "James is also viewing").
  $effect(() => {
    live?.setSelection(ui.ticket ? [ui.ticket] : []);
  });
</script>

{#if !live}
  <NamePrompt onsubmit={start} />
{:else if !live.state}
  <main class="loading" aria-live="polite">
    {live.connection === 'closed' ? 'Can’t reach the Trellis server. Retrying…' : 'Connecting…'}
  </main>
{:else if live.state.frozen}
  <FreezeScreen {live} />
{:else}
  {#if live.agentBatch}
    <AgentBanner {live} batch={live.agentBatch} />
  {/if}
  <TopBar {live} />
  <div class="body" class:detail={ui.ticket !== null}>
    {#if ui.ticket !== null}
      <main class="main">
        <EpicFocus {live} />
      </main>
      <TicketPanel {live} />
    {:else}
      <main class="main">
        <Toolbar {live} />
        {#if ui.view === 'timeline'}
          <Timeline {live} />
        {:else if ui.view === 'changes'}
          <section class="panel pad" aria-label="Changes vs Jira">
            <h2>Changes vs Jira <span class="muted">· {live.changeset?.ops.length ?? 0} operations</span></h2>
            <ChangesTable ops={live.changeset?.ops ?? []} />
          </section>
        {:else}
          <section class="panel pad" aria-label="Activity">
            <h2>Activity <span class="muted">· this session</span></h2>
            <ActivityList {live} limit={500} />
          </section>
        {/if}
      </main>
      {#if ui.agentPanel && live.agentBatch}
        <AgentPanel {live} batch={live.agentBatch} />
      {:else}
        <ActivityRail {live} />
      {/if}
    {/if}
  </div>
  {#if ui.create}
    <CreateDialog {live} />
  {/if}
{/if}
{#if live}
  <Notices {live} />
{/if}

<style>
  .loading { display: grid; place-items: center; min-height: 100vh; color: var(--ink-muted); }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 334px;
    gap: 16px;
    padding: 0 24px 24px;
    align-items: start;
  }
  .body.detail { grid-template-columns: minmax(0, 1fr) 440px; padding: 0; gap: 0; min-height: calc(100vh - 64px); }
  .main { min-width: 0; }
  .body.detail .main { padding: 24px; }
  .pad { padding: 16px 20px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  .muted { color: var(--ink-muted); font-weight: 400; }
  @media (max-width: 1100px) {
    .body, .body.detail { grid-template-columns: minmax(0, 1fr); }
  }
</style>
