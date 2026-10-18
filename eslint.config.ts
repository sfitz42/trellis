import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', 'workspace/**', 'pnpm-lock.yaml'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  svelte.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.ts', 'vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.svelte'],
      },
    },
    rules: {
      // Template literals with numbers/booleans are fine in messages.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // PLAN.md §2: no `any` without a comment; the disable comment is that explanation.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      // State is Record<IssueId, …> by design (PLAN.md §3); removing an entry means `delete`.
      '@typescript-eslint/no-dynamic-delete': 'off',
      // The web app replaces $state.raw / $derived values wholesale with fresh Map/Set/Date objects
      // (immutable updates), so Svelte's reactive collection classes aren't needed.
      'svelte/prefer-svelte-reactivity': 'off',
    },
  },
  {
    files: ['**/test/**/*.ts'],
    rules: {
      // Fixture lookups like `s.tickets['PROJ-1']!` are the clearest way to write test expectations.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // vitest's asymmetric matchers (`expect.any`) are typed `any`.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // `http<T>()`-style helpers that type a parsed response body.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, svelteFeatures: { experimentalGenerics: true } },
      globals: { window: 'readonly', document: 'readonly', location: 'readonly', navigator: 'readonly', WebSocket: 'readonly', fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', confirm: 'readonly', MessageEvent: 'readonly', HTMLElement: 'readonly', HTMLDialogElement: 'readonly', PointerEvent: 'readonly', KeyboardEvent: 'readonly', SubmitEvent: 'readonly', Storage: 'readonly', RequestInit: 'readonly' },
    },
  },
  { files: ['eslint.config.ts', 'vitest.config.ts'], extends: [tseslint.configs.disableTypeChecked] },
);
