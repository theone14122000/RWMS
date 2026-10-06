import type { Request, Response } from 'express';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';

/** Strip credentials from an error message before surfacing it to a client. */
function redact(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://[REDACTED]')
    .replace(/([?&](?:password|pwd)=)[^\s&]+/gi, '$1[REDACTED]')
    .replace(/\b(password|pwd)(["'\s:=]+)[^\s,'"]+/gi, '$1$2[REDACTED]');
}

/**
 * Vercel entrypoint. Boot failures (missing env, unreachable database) must
 * surface as a JSON 500 with a redacted reason instead of a generic
 * FUNCTION_INVOCATION_FAILED, so the cause is visible from the public URL.
 */
async function boot(): Promise<(req: Request, res: Response) => unknown> {
  await migrate();
  await seed();
  return createApp();
}

const app = await boot().catch((err: unknown): ((req: Request, res: Response) => unknown) => {
  const detail = redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  const stack = err instanceof Error && err.stack ? redact(err.stack) : undefined;
  console.error('[crm] FATAL boot failure:', detail, stack ?? '');
  return (req: Request, res: Response): unknown =>
    res.status(500).json({ ok: false, error: 'BOOT_FAILED', detail, ...(stack ? { stack } : {}) });
});

export default app;
