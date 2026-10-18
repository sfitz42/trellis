import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { configFromEnv } from './config.js';

const config = configFromEnv();
const { app, close } = await buildApp({
  workspaceDir: config.workspaceDir,
  projectKey: config.projectKey,
  watchPoll: config.watchPoll,
  staticDir: config.staticDir,
  logger: true,
});

await app.listen({ port: config.port, host: config.host });
app.log.info(`workspace: ${config.workspaceDir}`);

// Tells `pnpm session:new/restore` that a server is using THIS workspace (they probe the port;
// a file left behind by a crash is ignored because nothing answers there).
const marker = join(config.workspaceDir, '.server.json');
await writeFile(marker, `${JSON.stringify({ port: config.port, pid: process.pid, startedAt: new Date().toISOString() })}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal}: saving state and shutting down`);
    close()
      .then(() => rm(marker, { force: true }))
      .then(() => process.exit(0), (err: unknown) => {
        app.log.error(err);
        process.exit(1);
      });
  });
}
