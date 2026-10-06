import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';

async function main(): Promise<void> {
  await migrate();
  await seed();

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`[crm] API server listening on http://localhost:${config.port}`);
    console.log(`[crm] environment: ${config.nodeEnv}`);
    if (config.nodeEnv === 'development') {
      console.log(`[crm] admin login: ${config.admin.email} (set ADMIN_PASSWORD to change the password)`);
    }
  });

  const shutdown = (signal: string) => {
    console.log(`[crm] ${signal} received, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

await main();
