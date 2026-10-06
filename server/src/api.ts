import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';

await migrate();
await seed();

const app = createApp();

export default app;
