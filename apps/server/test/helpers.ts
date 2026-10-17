import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { Batch, ClientMessage, Op, ServerMessage } from '@trellis/shared';
import { buildApp } from '../src/app.js';
import type { App, AppOptions } from '../src/app.js';

const fixture = new URL('../../../packages/shared/fixtures/snapshot.sample.json', import.meta.url);

export async function readFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>;
}

export interface Running extends App {
  dir: string;
  url: string;
  wsUrl: string;
  http: <T = unknown>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  stop: () => Promise<void>;
}

/** Start a server on a random port. Seeds snapshot.json from the fixture unless `dir` is given. */
export async function start(opts: Partial<AppOptions> & { dir?: string; seed?: boolean } = {}): Promise<Running> {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), 'trellis-test-')));
  if (opts.seed ?? opts.dir === undefined) await writeFile(join(dir, 'snapshot.json'), JSON.stringify(await readFixture()));
  const built = await buildApp({
    workspaceDir: dir,
    mirrorDebounceMs: 20,
    claimSweepMs: 50,
    now: () => new Date(),
    ...opts,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    ...built,
    dir,
    url,
    wsUrl: `ws://127.0.0.1:${addr.port}/ws`,
    http: async <T,>(method: string, path: string, body?: unknown) => {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { 'content-type': 'application/json' };
      }
      const res = await fetch(`${url}${path}`, init);
      return { status: res.status, body: (await res.json()) as T };
    },
    stop: async () => {
      await built.close();
    },
  };
}

export async function cleanup(r: Running): Promise<void> {
  await r.stop();
  await rm(r.dir, { recursive: true, force: true });
}

/** A websocket client that records every message and can wait for one matching a predicate. */
export class Client {
  readonly messages: ServerMessage[] = [];
  private cursor = 0;
  private waiters: (() => void)[] = [];
  private constructor(readonly ws: WebSocket, readonly name: string, readonly clientId: string) {
    ws.on('message', (raw: Buffer) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      this.waiters.splice(0).forEach((w) => { w(); });
    });
  }

  static async connect(wsUrl: string, name: string, kind: 'human' | 'agent' = 'human'): Promise<Client> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => { resolve(); }); ws.once('error', reject); });
    const c = new Client(ws, name, `${name}-${Math.random().toString(36).slice(2, 8)}`);
    c.send({ type: 'hello', name, kind, clientId: c.clientId });
    await c.next('welcome');
    return c;
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  batch(ops: Op[], extra: Partial<Batch> = {}): string {
    const requestId = Math.random().toString(36).slice(2);
    this.send({ type: 'batch', requestId, batch: { author: { name: this.name, kind: 'human' }, atomic: false, ops, ...extra } });
    return requestId;
  }

  /** The next unseen message of `type` (optionally matching `where`), skipping others. */
  async next<T extends ServerMessage['type']>(type: T, where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = 2000): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.messages.length) {
        const m = this.messages[this.cursor++] as ServerMessage;
        if (m.type === type && where(m as Extract<ServerMessage, { type: T }>)) return m as Extract<ServerMessage, { type: T }>;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${this.name}: timed out waiting for ${type}; got ${this.messages.map((m) => m.type).join(', ')}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }

  async close(): Promise<void> {
    if (this.ws.readyState === this.ws.CLOSED) return;
    await new Promise<void>((resolve) => { this.ws.once('close', () => { resolve(); }); this.ws.close(); });
  }
}

export const agent = { name: 'Claude Code', kind: 'agent' } as const;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
