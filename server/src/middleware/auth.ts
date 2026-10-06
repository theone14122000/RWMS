import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import { config } from '../config.js';
import { all, get, run, nowISO } from '../db/database.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/password.js';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  phone?: string | null;
  role: 'ADMIN' | 'WORKER';
  status: string;
  last_login_at?: string | null;
  created_at: string;
  permissions: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
    }
  }
}

let permissionCache: Map<string, Set<string>> | null = null;

async function rolePermissions(roleId: number): Promise<Set<string>> {
  if (!permissionCache) {
    permissionCache = new Map();
    const rows = await all<{ role_id: number; code: string }>(
      'SELECT rp.role_id, p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id',
    );
    for (const row of rows) {
      if (!permissionCache.has(String(row.role_id))) permissionCache.set(String(row.role_id), new Set());
      permissionCache.get(String(row.role_id))!.add(String(row.code));
    }
  }
  return permissionCache.get(String(roleId)) ?? new Set();
}

export function invalidatePermissionCache(): void {
  permissionCache = null;
}

interface SessionRow {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface UserRow {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  role_id: number;
  role_code: string;
  last_login_at: string | null;
  created_at: string;
}

export async function createSession(userId: number, req: Request): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken();
  const hash = sha256(token);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  await run(
    'INSERT INTO sessions (id, user_id, ip, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [hash, userId, req.ip ?? null, (req.headers['user-agent'] ?? '').slice(0, 300) || null, now.toISOString(), expires.toISOString()],
  );
  return { token, expiresAt: expires.toISOString() };
}

export async function revokeSession(token: string): Promise<void> {
  await run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [await nowISO(), sha256(token)]);
}

export async function revokeAllSessions(userId: number): Promise<void> {
  await run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [await nowISO(), userId]);
}

export function setSessionCookie(res: Response, token: string): void {
  res.append(
    'Set-Cookie',
    serializeCookie(config.sessionCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: config.sessionTtlDays * 24 * 60 * 60,
    }),
  );
}

export function clearSessionCookie(res: Response): void {
  res.append(
    'Set-Cookie',
    serializeCookie(config.sessionCookieName, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: 0,
    }),
  );
}

/** Resolves the session cookie into `req.user` (does not enforce authentication). */
export const sessionLoader: RequestHandler = async (req, _res, next) => {
  try {
    const cookies = parseCookie(req.headers.cookie ?? '');
    const token = cookies[config.sessionCookieName];
    if (!token) return next();

    const session = await get<SessionRow>('SELECT id, user_id, created_at, expires_at, revoked_at FROM sessions WHERE id = ?', [
      sha256(token),
    ]);
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) return next();

    // Absolute lifetime: an active session can never outlive this cap, even
    // with sliding renewal (bounds the value of a stolen cookie).
    const absoluteMax =
      new Date(session.created_at).getTime() + config.sessionAbsoluteTtlDays * 24 * 60 * 60 * 1000;
    if (absoluteMax <= Date.now()) {
      await run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [await nowISO(), session.id]);
      return next();
    }

    const user = await get<UserRow>(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.role_id, u.last_login_at, u.created_at, r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      [session.user_id],
    );
    if (!user) return next();
    if (user.status !== 'ACTIVE') {
      (req as any).blockedReason = user.status;
      return next();
    }

    const permissions = Array.from(await rolePermissions(user.role_id));
    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role_code as 'ADMIN' | 'WORKER',
      status: user.status,
      last_login_at: user.last_login_at,
      created_at: user.created_at,
      permissions,
    };
    req.sessionId = session.id;

    // sliding session renewal (capped by the absolute lifetime)
    const remaining = new Date(session.expires_at).getTime() - Date.now();
    if (remaining < (config.sessionTtlDays * 24 * 60 * 60 * 1000) / 2) {
      const expires = Math.min(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000, absoluteMax);
      await run('UPDATE sessions SET expires_at = ? WHERE id = ?', [new Date(expires).toISOString(), session.id]);
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (req.user) return next();
  const blocked = (req as any).blockedReason;
  if (blocked === 'INACTIVE' || blocked === 'SUSPENDED') {
    return next(unauthorized('This account has been disabled. Contact the administrator.'));
  }
  return next(unauthorized());
};

export function requireRole(...roles: Array<'ADMIN' | 'WORKER'>): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden('Your account role does not allow this action.'));
    next();
  };
}

export function requirePermission(code: string): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!req.user.permissions.includes(code)) {
      return next(forbidden('Your account does not have permission to perform this action.'));
    }
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function can(req: Request, code: string): boolean {
  return Boolean(req.user?.permissions.includes(code));
}

/**
 * Rejects state-changing requests whose Origin does not match the host
 * (CSRF hardening on top of SameSite=Lax cookies).
 */
export const originGuard: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  const host = req.headers.host;
  try {
    if (!host || new URL(origin).host === host) return next();
  } catch {
    /* invalid origin header */
  }
  return next(forbidden('Cross-origin request blocked.'));
};
