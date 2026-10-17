import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerHttp } from './http.js';
import { Session } from './session.js';
import type { SessionOptions } from './session.js';
import { watchWorkspace } from './watch.js';
import { FILES } from './workspace.js';
import { registerWs } from './ws.js';

export interface AppOptions extends SessionOptions {
  watchPoll?: boolean;
  logger?: boolean;
  /** How often expired claims are swept and announced. */
  claimSweepMs?: number;
}

export interface App {
  app: FastifyInstance;
  session: Session;
  /** Stops watchers and timers, closes sockets and flushes state to disk. */
  close: () => Promise<void>;
}

export async function buildApp(opts: AppOptions): Promise<App> {
  const session = await Session.load(opts);
  const app = Fastify({ logger: opts.logger ?? false });
  await registerWs(app, session);
  registerHttp(app, session);

  const stopWatching = watchWorkspace(opts.workspaceDir, [FILES.snapshot, FILES.applyLog], (name) => {
    session.onFileChanged(name).catch((err: unknown) => { app.log.error(err); });
  }, { poll: opts.watchPoll ?? false });
  const sweep = setInterval(() => { session.expireClaims(); }, opts.claimSweepMs ?? 1000);

  return {
    app,
    session,
    close: async () => {
      clearInterval(sweep);
      stopWatching();
      await app.close();
      await session.flush();
    },
  };
}
