import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const EnvSchema = z.object({
  JIRA_SITE: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+\.atlassian\.net$/i, 'expected e.g. your-site.atlassian.net (no https://)'),
  JIRA_PROJECT_KEY: z.string().regex(/^[A-Z][A-Z0-9_]+$/, 'expected an uppercase Jira project key'),
});

export type JiraEnv = z.infer<typeof EnvSchema>;

/** Load JIRA_* from the process env or the repo-root `.env`. Exits with a clear message if missing. */
export function loadJiraEnv(): JiraEnv {
  config({ path: `${repoRoot}.env`, quiet: true });
  const parsed = EnvSchema.safeParse({
    JIRA_SITE: process.env['JIRA_SITE'] || undefined,
    JIRA_PROJECT_KEY: process.env['JIRA_PROJECT_KEY'] || undefined,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`Jira environment is not configured (see .env.example):\n${problems}`);
    process.exit(1);
  }
  return parsed.data;
}

/** The workspace folder; read after loadJiraEnv() so WORKSPACE_DIR may come from .env. */
export function workspacePath(): string {
  return process.env['WORKSPACE_DIR'] ?? `${repoRoot}workspace`;
}
export { repoRoot };
