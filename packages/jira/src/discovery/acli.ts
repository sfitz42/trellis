import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Phase 0 is strictly read-only. Every acli invocation must match one of these
 * subcommand prefixes, or be a `--help` call. Anything else throws before spawning.
 */
const READ_ONLY_PREFIXES: readonly string[][] = [
  ['--version'],
  ['jira', 'auth', 'status'],
  ['jira', 'project', 'list'],
  ['jira', 'project', 'view'],
  ['jira', 'workitem', 'search'],
  ['jira', 'workitem', 'view'],
  ['jira', 'workitem', 'link', 'list'],
  ['jira', 'workitem', 'link', 'type'],
  ['jira', 'workitem', 'comment', 'list'],
  ['jira', 'field', 'list'],
  ['jira', 'filter', 'list'],
];

export class WriteBlockedError extends Error {
  constructor(args: readonly string[]) {
    super(`Blocked non-read-only acli call in Phase 0: acli ${args.join(' ')}`);
  }
}

export function assertReadOnly(args: readonly string[]): void {
  if (args.includes('--help') || args.includes('-h')) return;
  const ok = READ_ONLY_PREFIXES.some((prefix) => prefix.every((part, i) => args[i] === part));
  if (!ok) throw new WriteBlockedError(args);
}

export interface AcliResult {
  stdout: string;
  stderr: string;
}

/** Run acli with execFile (never a shell). Throws on non-zero exit with stderr attached. */
export async function acli(args: readonly string[]): Promise<AcliResult> {
  assertReadOnly(args);
  try {
    const { stdout, stderr } = await run('acli', [...args], { maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`acli ${args.join(' ')} failed: ${e.stderr?.trim() || e.stdout?.trim() || e.message}`, { cause: err });
  }
}

/** Run a read-only acli command that supports `--json` and parse the result. */
export async function acliJson<T = unknown>(args: readonly string[]): Promise<T> {
  const { stdout } = await acli([...args, '--json']);
  return JSON.parse(stdout) as T;
}
