import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  port: number;
  host: string;
  workspaceDir: string;
  /** Optional: only for display and a mismatch warning against the snapshot (PLAN.md §11). */
  projectKey: string | undefined;
  /** Poll files instead of fs.watch (Docker Desktop bind mounts on macOS/Windows). */
  watchPoll: boolean;
  /** Built SPA to serve (apps/web/dist). Skipped if empty (`pnpm dev` sets STATIC_DIR= so a stale build never shadows Vite) or missing. */
  staticDir: string;
}

// src/ and dist/ both sit two levels below the repo root's apps/ folder.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env['PORT'] ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number, got ${env['PORT'] ?? ''}`);
  return {
    port,
    host: env['HOST'] ?? '0.0.0.0',
    workspaceDir: env['WORKSPACE_DIR'] ?? `${repoRoot}workspace`,
    projectKey: env['JIRA_PROJECT_KEY'] || undefined,
    watchPoll: env['WATCH_POLL'] === '1',
    staticDir: env['STATIC_DIR'] ?? `${repoRoot}apps/web/dist`,
  };
}
