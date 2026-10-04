export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, HttpError);
  }
}

export const badRequest = (message = 'Invalid request', details?: unknown) =>
  new HttpError(400, 'VALIDATION_ERROR', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have permission to perform this action') =>
  new HttpError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found') => new HttpError(404, 'NOT_FOUND', message);

export const conflict = (message = 'Conflict', details?: unknown) =>
  new HttpError(409, 'CONFLICT', message, details);

export const tooMany = (message = 'Too many requests') => new HttpError(429, 'RATE_LIMITED', message);

/** A third-party integration has not been configured yet (never a fake success). */
export const notConfigured = (message = 'This integration is not configured yet') =>
  new HttpError(409, 'INTEGRATION_NOT_CONFIGURED', message);

/** The upstream provider answered with an error or was unreachable. */
export const upstream = (message = 'The upstream provider could not be reached') =>
  new HttpError(502, 'UPSTREAM_ERROR', message);

