export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || 'Request failed');
    this.status = status;
    this.code = body.code || 'ERROR';
    this.details = body.details;
  }
}

type Options = RequestInit & { skipAuthRedirect?: boolean };

const listeners: Array<() => void> = [];

export function onUnauthorized(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const { skipAuthRedirect, headers, ...rest } = options;
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      Accept: 'application/json',
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {}),
    },
  });

  if (res.status === 204) return undefined as T;

  let payload: any = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !skipAuthRedirect) {
      listeners.forEach((fn) => fn());
    }
    throw new ApiError(res.status, payload?.error ?? { code: 'ERROR', message: `Request failed (${res.status})` });
  }

  return payload as T;
}

export function get<T>(path: string): Promise<T> {
  return api<T>(path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) });
}

export function del<T>(path: string): Promise<T> {
  return api<T>(path, { method: 'DELETE' });
}

export interface ListResponse<T> {
  data: T[];
  meta?: { page: number; limit: number; total: number; total_pages: number; [k: string]: unknown };
}

export function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
