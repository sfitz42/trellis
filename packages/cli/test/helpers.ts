import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '@trellis/server/app';
import type { App } from '@trellis/server/app';
import { run } from '../src/program.js';
import type { ExitCode } from '../src/errors.js';

const fixture = new URL('../../shared/fixtures/snapshot.sample.json', import.meta.url);

export interface Server extends App {
  url: string;
  dir: string;
  stop: () => Promise<void>;
}

/** An in-process Trellis server on a random port, seeded with the sanitised fixture. */
export async function startServer(): Promise<Server> {
  const dir = await mkdtemp(join(tmpdir(), 'trellis-cli-'));
  await copyFile(fixture, join(dir, 'snapshot.json'));
  const built = await buildApp({ workspaceDir: dir, mirrorDebounceMs: 20, claimSweepMs: 50 });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return {
    ...built,
    dir,
    url: `http://127.0.0.1:${addr.port}`,
    stop: async () => {
      await built.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface Result {
  code: ExitCode;
  out: string;
  err: string;
  json: () => unknown;
}

/** Run `trellis <args>` against `url` with optional stdin and extra env. */
export async function trellis(url: string, args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    readStdin: () => Promise.resolve(opts.stdin ?? ''),
    env: { TRELLIS_URL: url, TRELLIS_AGENT_NAME: 'Claude Code', TRELLIS_FACILITATOR: 'Shaun', ...opts.env },
  });
  const o = out.join('\n');
  return { code, out: o, err: err.join('\n'), json: () => JSON.parse(o) as unknown };
}

/** Replace volatile values (timestamps) so JSON output can be snapshot-tested. */
export function stable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_k, v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && v !== '2026-10-01T09:42:00.000Z' ? '<time>' : v) as unknown;
}
