import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors.js';
import { config } from '../config.js';
import { audit } from '../services/audit.js';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  // Do not echo query strings back (they can carry reflected input).
  const path = String(req.originalUrl ?? '').split('?')[0].slice(0, 200);
  next(new HttpError(404, 'NOT_FOUND', `Route ${req.method} ${path} not found`));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): Promise<void> {
  if (err instanceof HttpError) {
    if (err.status >= 500) console.error('[error]', err);
    // Server-side messages may embed provider/DB details — never leak them in production.
    const message =
      err.status >= 500 && config.isProduction ? 'Something went wrong. Please try again.' : err.message;
    res.status(err.status).json({ error: { code: err.code, message, details: err.status < 500 ? err.details : undefined } });
    return;
  }

  const anyErr = err as any;
  if (anyErr?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
    return;
  }

  console.error('[unhandled]', anyErr);
  try {
    await audit(req, 'REQUEST_FAILED', 'system', String(req.originalUrl).slice(0, 100), {
      message: String(anyErr?.message ?? 'Unknown error').slice(0, 300),
    });
  } catch {
    /* audit must never mask the original error */
  }

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: config.isProduction ? 'Something went wrong. Please try again.' : String(anyErr?.message ?? err),
    },
  });
}
