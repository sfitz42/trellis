<script lang="ts">
  import type { Live } from '../lib/live.svelte.js';
  import ChangesTable from './ChangesTable.svelte';

  let { live }: { live: Live } = $props();

  /** Apply-log entries come from Phase 5's script; show only primitive values as text. */
  const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

  const frozen = $derived(live.roadmap.frozen ?? { by: '?', at: new Date(0).toISOString() });
  const cs = $derived(live.frozenChangeset ?? live.changeset);
  const log = $derived(Array.isArray(live.applyLog) ? (live.applyLog as Record<string, unknown>[]) : []);
  interface PlanStepView { id: string; kind: string; target: string; summary: string; run: boolean; drift?: { field: string; snapshot: unknown; jira: unknown; trellis: unknown } }
  const planSteps = $derived.by((): PlanStepView[] => {
    const p = live.applyPlan as { changesetId?: unknown; steps?: unknown } | null;
    return p && p.changesetId === cs?.id && Array.isArray(p.steps) ? (p.steps as PlanStepView[]) : [];
  });
  const drift = $derived(planSteps.filter((s) => s.drift));
  const val = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : JSON.stringify(v));
  const pulledAt = $derived(live.summary?.pulledAt ? new Date(live.summary.pulledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
  const step = $derived(live.repulledAt ? 5 : log.length > 0 ? 4 : 3);
  const steps = ['Frozen', 'Changeset written', 'Waiting for agent to apply', 'Re-pull snapshot', 'Unfrozen'];

  const prompt = $derived(`The Trellis session is frozen for apply. In this repo:
1. Run \`pnpm jira:apply --dry-run\` and show me the plan and any drift.
2. After I confirm, run \`pnpm jira:apply --yes\`${live.state?.project.key ? ` --confirm-project ${live.state.project.key}` : ''}.
3. Then run \`pnpm jira:pull\` so Trellis re-pulls the snapshot.
Never run --yes before I have confirmed the dry run.`);

  let copied = $state(false);
  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(prompt);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  async function unfreeze(): Promise<void> {
    if (step < 5 && !confirm('Unfreeze without applying? Editing reopens and nothing is written to Jira.')) return;
    await live.unfreeze();
  }
</script>

<header class="frozen">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
  <div>
    <strong>Session frozen for apply</strong>
    <span>Frozen by {frozen.by} at {new Date(frozen.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · editing locked in the app and the trellis CLI</span>
  </div>
  <button class="btn outline" onclick={unfreeze}>{step === 5 ? 'Unfreeze' : 'Unfreeze without applying'}</button>
</header>

<ol class="steps" aria-label="Apply progress">
  {#each steps as s, i (s)}
    {@const n = i + 1}
    <li class:done={n < step} class:active={n === step} aria-current={n === step ? 'step' : undefined}>
      {n} · {s}{n < step ? ' (done)' : ''}
    </li>
  {/each}
</ol>

<div class="body">
  <main>
    <h1>Changeset · {cs?.ops.length ?? 0} operations <span>roadmap v{live.state?.version} vs Jira snapshot {pulledAt}</span></h1>
    {#if drift.length}
      <div class="drift" role="alert">
        <p><strong>{drift.length} drift conflict{drift.length === 1 ? '' : 's'}.</strong> Jira changed after the snapshot; the changeset would overwrite it. Your choice is used when the agent runs <code>jira:apply --yes</code> (undecided: keep Jira's value).</p>
        {#each drift as d (d.id)}
          {@const choice = live.driftDecisions.decisions[d.id]}
          <div class="conflict">
            <p><code>{d.target}</code> {d.drift?.field}: Jira now <strong>{val(d.drift?.jira)}</strong> (was {val(d.drift?.snapshot)}); roadmap wants <strong>{val(d.drift?.trellis)}</strong>.</p>
            <div class="choices" role="group" aria-label="Resolve drift on {d.target}">
              <button class="btn small" aria-pressed={choice !== 'overwrite'} class:on={choice !== 'overwrite'} onclick={() => { void live.decideDrift(d.id, 'keep'); }}>Keep Jira value</button>
              <button class="btn small" aria-pressed={choice === 'overwrite'} class:on={choice === 'overwrite'} onclick={() => { void live.decideDrift(d.id, 'overwrite'); }}>Overwrite with roadmap</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
    <div class="panel"><ChangesTable ops={cs?.ops ?? []} /></div>
  </main>

  <aside class="panel hand" aria-label="Hand off to your agent">
    <h2>Hand off to your agent</h2>
    <p>Open Claude Code or Copilot in the repo. It reads the changeset, runs a dry run for you to check, then applies it through the Atlassian CLI and re-pulls.</p>
    <span class="label">Files</span>
    <pre class="files"><code>workspace/changeset.json · {cs?.ops.length ?? 0} ops
workspace/roadmap.json · v{live.state?.version}
workspace/snapshot.json · {pulledAt}
workspace/.lock · frozen</code></pre>
    <span class="label">Commands</span>
    <pre class="cmds"><code>pnpm jira:apply --dry-run
pnpm jira:apply --yes --confirm-project {live.state?.project.key ?? 'KEY'}
pnpm jira:pull</code></pre>
    <span class="label">Apply log</span>
    {#if log.length}
      <ol class="log">
        {#each log as e, i (i)}
          <li class={str(e['status'])}><code>{str(e['kind'] ?? e['op'])} {str(e['target'])}{str(e['createdKey']) ? ` → ${str(e['createdKey'])}` : ''}</code> <span>{str(e['status'])}</span></li>
        {/each}
      </ol>
    {:else}
      <p class="waiting"><span class="dot" aria-hidden="true"></span> Watching apply-log.json · nothing yet</p>
    {/if}
    <div class="actions">
      <button class="btn primary" onclick={copy}>{copied ? 'Copied' : 'Copy agent prompt'}</button>
      <a class="btn" href="/api/changeset" download="changeset.json">Download changeset</a>
    </div>
  </aside>
</div>

<style>
  .frozen { display: flex; align-items: center; gap: 14px; padding: 14px 24px; background: var(--structure); color: var(--structure-ink); }
  .frozen div { display: grid; flex: 1; }
  .frozen span { font-size: 12.5px; opacity: 0.85; }
  .outline { background: transparent; color: var(--structure-ink); border-color: rgb(255 251 246 / 0.7); }
  .steps { display: flex; gap: 8px; list-style: none; margin: 0; padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--surface); flex-wrap: wrap; }
  .steps li { padding: 6px 12px; border-radius: 999px; background: var(--changed-tint); color: var(--ink-muted); font-size: 13px; }
  .steps li.done { background: #e2e2d6; color: var(--structure); }
  .steps li.active { background: var(--warn); color: #fff; font-weight: 600; }
  .body { display: grid; grid-template-columns: minmax(0, 1fr) 416px; gap: 16px; padding: 20px 24px; align-items: start; }
  h1 { font-size: 20px; margin: 0 0 14px; }
  h1 span { font-size: 13px; font-weight: 400; color: var(--ink-muted); }
  .drift { padding: 12px 16px; background: var(--warn-tint); border: 1px solid var(--warn); border-radius: 8px; color: var(--warn-text); margin-bottom: 14px; }
  .drift p { margin: 0 0 8px; }
  .conflict { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 8px 0; border-top: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); flex-wrap: wrap; }
  .conflict p { margin: 0; flex: 1; }
  .choices { display: flex; gap: 6px; }
  .choices .on { background: var(--surface); border-color: var(--warn-text); font-weight: 600; }
  .hand { padding: 18px; display: grid; gap: 10px; }
  h2 { margin: 0; font-size: 16px; }
  .hand p { margin: 0; font-size: 13.5px; color: var(--ink-muted); }
  .label { font-size: 12px; color: var(--ink-muted); margin-top: 4px; }
  pre { margin: 0; padding: 12px; border-radius: var(--radius); font-size: 12px; }
  .files { background: var(--bg); }
  .cmds { background: #2f3128; color: #f2e1d2; }
  .log { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 12.5px; max-height: 220px; overflow: auto; }
  .log li { display: flex; justify-content: space-between; gap: 8px; padding: 4px 8px; border-radius: 4px; background: var(--bg); }
  .log li.failed { background: var(--error-tint); color: var(--error-text); }
  .log li.drift, .log li.skipped { background: var(--warn-tint); color: var(--warn-text); }
  .waiting { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px dashed var(--border); border-radius: var(--radius); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  a.btn { display: inline-flex; align-items: center; text-decoration: none; color: var(--ink); }
  @media (max-width: 1100px) { .body { grid-template-columns: minmax(0, 1fr); } }
</style>
