<script lang="ts">
  let { onsubmit }: { onsubmit: (name: string) => void } = $props();
  let name = $state('');
</script>

<main class="wrap">
  <form
    class="panel card"
    onsubmit={(e) => {
      e.preventDefault();
      if (name.trim()) onsubmit(name.trim());
    }}
  >
    <h1>Trellis</h1>
    <p>Join the live roadmap session. Your name is shown to others next to what you change.</p>
    <label class="field">
      <span>Display name</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="input" bind:value={name} autocomplete="name" required autofocus />
    </label>
    <button class="btn primary" type="submit" disabled={!name.trim()}>Join session</button>
  </form>
</main>

<style>
  .wrap { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
  .card { width: min(400px, 100%); padding: 24px; display: grid; gap: 16px; }
  h1 { margin: 0; font-size: 22px; }
  p { margin: 0; color: var(--ink-muted); }
</style>
