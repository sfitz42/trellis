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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal}: saving state and shutting down`);
    close().then(() => process.exit(0), (err: unknown) => {
      app.log.error(err);
      process.exit(1);
    });
  });
}
