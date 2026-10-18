import { defineConfig } from 'vitest/config';

// One test run for the whole monorepo; the web app has its own project (Svelte plugin).
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', include: ['packages/shared/test/**/*.test.ts'] } },
      { test: { name: 'server', include: ['apps/server/test/**/*.test.ts'] } },
      { test: { name: 'cli', include: ['packages/cli/test/**/*.test.ts'] } },
      './apps/web',
    ],
  },
});
