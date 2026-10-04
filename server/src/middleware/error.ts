import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors.js';
import { config } from '../config.js';
import { audit } from '../services/audit.js';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new HttpError(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    if (err.status >= 500) console.error('[error]', err);
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  const anyErr = err as any;
  if (anyErr?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
    return;
  }

  console.error('[unhandled]', anyErr);
  try {
    audit(req, 'REQUEST_FAILED', 'system', String(req.originalUrl).slice(0, 100), {
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
