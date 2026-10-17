import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', 'workspace/**', 'pnpm-lock.yaml'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
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
    },
  },
  {
    files: ['**/test/**/*.ts'],
    rules: {
      // Fixture lookups like `s.tickets['PROJ-1']!` are the clearest way to write test expectations.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // vitest's asymmetric matchers (`expect.any`) are typed `any`.
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  { files: ['eslint.config.ts'], extends: [tseslint.configs.disableTypeChecked] },
);
