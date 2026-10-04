import type { Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { badRequest, HttpError } from './errors.js';

export interface ListMeta {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  [key: string]: unknown;
}

export function ok(res: Response, data: unknown): void {
  res.json({ data });
}

export function created(res: Response, data: unknown): void {
  res.status(201).json({ data });
}

export function list(res: Response, rows: unknown[], meta?: ListMeta): void {
  res.json({
    data: rows,
    meta: meta ?? { page: 1, limit: rows.length || 1, total: rows.length, total_pages: 1 },
  });
}

export function meta<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest('Validation failed', formatZodError(result.error));
  }
  return result.data;
}

export function formatZodError(error: ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message }));
}

export function pagination(query: unknown, defaultLimit = 20, maxLimit = 100): { page: number; limit: number; offset: number } {
  const q = (query ?? {}) as Record<string, unknown>;
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(q.limit) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export function buildMeta(page: number, limit: number, total: number): ListMeta {
  return { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) };
}

export function toArray(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export { HttpError };
