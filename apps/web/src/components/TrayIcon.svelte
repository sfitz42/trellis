<script lang="ts">
  // The Deliver later tray icon (an inbox tray). Decorative: callers always pair it with text.
  let { size = 16 }: { size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 13l2.5-7h13L21 13" />
  <path d="M3 13v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5h-5.5a3.5 3.5 0 0 1-7 0z" />
</svg>
